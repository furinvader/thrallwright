import { BehaviorSubject, Subscription } from 'rxjs';
import { z } from 'zod';
import type { CommandRecord, StartCommand } from '@thrallwright/contracts';
import { CodexRpcError, type CodexAdapter } from '../../integrations/codex.js';
import type { CommandJournal } from './journal.js';

interface SessionCommands {
  acceptStartedThread(thread: unknown): unknown;
  acceptTurn(threadId: string, turn: unknown): unknown;
}
interface Options {
  workspace: string;
  codex: CodexAdapter;
  journal: CommandJournal;
  sessions: SessionCommands;
  initial: CommandRecord[];
  saveSessions(): Promise<void>;
  storageFailure(message: string): void;
}
const threadResult = z.object({
  thread: z.object({ id: z.string() }).passthrough(),
});
const turnResult = z.object({
  turn: z.object({ id: z.string() }).passthrough(),
});
const completed = z.object({
  threadId: z.string(),
  turn: z.object({ id: z.string(), status: z.string() }),
});

/** One command owner. The journal is evidence, never a retry queue. */
export function createCommandService(options: Options) {
  const records = new Map(options.initial.map((record) => [record.id, record]));
  const state = new BehaviorSubject<CommandRecord[]>([]);
  const subscriptions = new Subscription();
  const running = new Map<
    string,
    { fingerprint: string; promise: Promise<void> }
  >();
  const updates = new Map<string, Promise<void>>();
  const terminal = new Map<string, string>();
  let available = false;
  let closed = false;
  const publish = () =>
    state.next(
      [...records.values()]
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .filter(
          (record, index) =>
            index < 100 ||
            ['intent', 'dispatching', 'accepted', 'uncertain'].includes(
              record.phase,
            ),
        ),
    );
  publish();

  async function change(
    id: string,
    transition: (record: CommandRecord) => CommandRecord,
  ) {
    const next = (updates.get(id) ?? Promise.resolve()).then(async () => {
      const prior = records.get(id);
      if (!prior) throw new Error('Command record is missing.');
      const record = {
        ...transition(prior),
        updatedAt: new Date().toISOString(),
      };
      try {
        await options.journal.update(record);
      } catch {
        const detail =
          'The command outcome could not be saved. Inspect Codex before trying again.';
        records.set(id, { ...record, phase: 'uncertain', detail });
        publish();
        options.storageFailure(detail);
        throw new Error(detail);
      }
      records.set(id, record);
      publish();
    });
    updates.set(
      id,
      next.catch(() => {}),
    );
    await next;
  }
  subscriptions.add(
    options.codex.state$.subscribe((integration) => {
      available = integration.state === 'available';
      if (!available)
        for (const record of records.values())
          if (record.phase === 'accepted') {
            void change(record.id, (current) =>
              current.phase === 'completed'
                ? current
                : {
                    ...current,
                    phase: 'uncertain',
                    detail:
                      'Codex disconnected before the turn outcome was confirmed. This command will not be resent.',
                  },
            ).catch(() => {});
          }
    }),
  );
  subscriptions.add(
    options.codex.events$.subscribe((event) => {
      if (event.method !== 'turn/completed') return;
      const parsed = completed.safeParse(event.params);
      if (!parsed.success) return;
      const { threadId, turn } = parsed.data;
      const key = JSON.stringify([threadId, turn.id]);
      terminal.set(key, turn.status);
      if (terminal.size > 500) terminal.delete(terminal.keys().next().value!);
      for (const record of records.values())
        if (
          record.resultSessionId === threadId &&
          record.turnId === turn.id &&
          ['accepted', 'uncertain'].includes(record.phase)
        )
          void change(record.id, (current) => ({
            ...current,
            phase: 'completed',
            detail: `Codex confirmed the initial turn ${turn.status}.`,
          })).catch(() => {});
    }),
  );

  async function run(command: StartCommand) {
    let created: boolean;
    let record: CommandRecord;
    try {
      ({ record, created } = await options.journal.begin(command));
    } catch (error) {
      throw new Error(
        `Cannot save command intent: ${error instanceof Error ? error.message : 'storage unavailable'}`,
        { cause: error },
      );
    }
    records.set(record.id, record);
    publish();
    if (!created) return;
    if (!available || closed) {
      await change(record.id, (current) => ({
        ...current,
        phase: 'rejected',
        detail: 'Codex is unavailable. Nothing was sent.',
      }));
      return;
    }
    // If this persistence fails, the harness call below is never reached.
    await change(record.id, (current) => ({
      ...current,
      phase: 'dispatching',
      detail: 'Creating a Codex session.',
    }));
    if (!available || closed) {
      await change(record.id, (current) => ({
        ...current,
        phase: 'rejected',
        detail: 'Codex disconnected before dispatch. Nothing was sent.',
      }));
      return;
    }
    try {
      const result = threadResult.parse(
        await options.codex.request('thread/start', { cwd: options.workspace }),
      );
      const threadId = result.thread.id;
      await change(record.id, (current) => ({
        ...current,
        resultSessionId: threadId,
        detail: 'Codex created the session. Sending the initial input.',
      }));
      if (!options.sessions.acceptStartedThread(result.thread))
        throw new Error(
          'The created session could not be verified in this workspace. Initial input was not sent.',
        );
      await options.saveSessions();
      if (!available || closed)
        throw new Error('Codex disconnected after creating the session.');
      const response = turnResult.parse(
        await options.codex.request('turn/start', {
          threadId,
          input: [{ type: 'text', text: command.prompt }],
        }),
      );
      options.sessions.acceptTurn(threadId, response.turn);
      await change(record.id, (current) => {
        const outcome = terminal.get(
          JSON.stringify([threadId, response.turn.id]),
        );
        return {
          ...current,
          turnId: response.turn.id,
          phase: outcome ? 'completed' : available ? 'accepted' : 'uncertain',
          detail: outcome
            ? `Codex confirmed the initial turn ${outcome}.`
            : available
              ? 'Codex accepted the initial input; execution is not yet confirmed complete.'
              : 'Input may have been accepted; Codex disconnected before confirmation.',
        };
      });
    } catch (error) {
      await change(record.id, (current) => ({
        ...current,
        phase: error instanceof CodexRpcError ? 'rejected' : 'uncertain',
        detail: `${current.resultSessionId ? 'Session ' + current.resultSessionId + ' was created. ' : ''}${error instanceof CodexRpcError ? 'Codex rejected the operation: ' : 'The outcome is uncertain: '}${error instanceof Error ? error.message : 'connection failed'}. Nothing will be resent automatically.`,
      }));
    }
  }
  return {
    state$: state.asObservable(),
    getSnapshot: () => state.value,
    handle(command: StartCommand) {
      const fingerprint = JSON.stringify(command);
      const active = running.get(command.id);
      if (active)
        return active.fingerprint === fingerprint
          ? active.promise
          : Promise.reject(
              new Error(
                'This command ID is already submitting different input.',
              ),
            );
      const promise = run(command).finally(() => running.delete(command.id));
      running.set(command.id, { fingerprint, promise });
      return promise;
    },
    async close() {
      closed = true;
      await Promise.allSettled(
        [...running.values()].map((item) => item.promise),
      );
      await Promise.allSettled(updates.values());
      subscriptions.unsubscribe();
      state.complete();
    },
  };
}
