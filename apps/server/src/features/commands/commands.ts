import { BehaviorSubject, Subscription, type Observable } from 'rxjs';
import { z } from 'zod';
import type {
  Approval,
  CommandRecord,
  ExecutionCommand,
  Session,
} from '@thrallwright/contracts';
import { CodexRpcError, type CodexAdapter } from '../../integrations/codex.js';
import type { CommandJournal } from './journal.js';
import { sessionCapabilities, outcomeTransition } from './policy.js';

interface SessionCommands {
  acceptStartedThread(thread: unknown): unknown;
  acceptTurn(threadId: string, turn: unknown): unknown;
  state$?: Observable<unknown>;
  getSnapshot?(): { sessions: Session[] };
  getTurnOutcome?(threadId: string, turnId: string): string | null | undefined;
  readHistory?(sessionId: string): Promise<void>;
}
interface ApprovalCommands {
  getSnapshot(): Approval[];
  resolutions$: Observable<{
    approvalId: string;
    commandId?: string;
    reason: 'resolved' | 'stale';
  }>;
  claim(
    approvalId: string,
    decision: 'accept' | 'decline',
    commandId: string,
  ): {
    rpcId: string | number;
    response: { decision: 'accept' | 'decline' };
    threadId: string;
    turnId: string;
  };
  validateClaim(approvalId: string, commandId: string): unknown;
  releaseBeforeWrite(approvalId: string, commandId: string): void;
  markUncertain(approvalId: string, commandId: string): void;
}
interface Options {
  workspace: string;
  codex: CodexAdapter;
  journal: CommandJournal;
  sessions: SessionCommands;
  initial: CommandRecord[];
  approvals?: ApprovalCommands;
  authenticated?(): boolean;
  confirmationMs?: number;
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
  turn: z.object({
    id: z.string(),
    status: z.enum(['completed', 'interrupted', 'failed']),
  }),
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
  const targetLocks = new Set<string>();
  const confirmationTimers = new Map<string, NodeJS.Timeout>();
  const approvalResolutions = new Map<string, 'resolved' | 'stale'>();
  const reconciling = new Set<string>();
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
  function reconcile() {
    for (const record of records.values()) {
      const threadId = record.resultSessionId ?? record.targetId;
      if (
        !threadId ||
        !record.turnId ||
        !['start', 'input', 'interrupt'].includes(record.operation) ||
        !['accepted', 'uncertain'].includes(record.phase) ||
        reconciling.has(record.id)
      )
        continue;
      const outcome =
        terminal.get(JSON.stringify([threadId, record.turnId])) ??
        options.sessions.getTurnOutcome?.(threadId, record.turnId);
      if (!outcome || outcome === 'inProgress') continue;
      reconciling.add(record.id);
      clearTimeout(confirmationTimers.get(record.id));
      confirmationTimers.delete(record.id);
      void change(record.id, (current) => ({
        ...current,
        ...outcomeTransition(current.operation, outcome),
      }))
        .catch(() => {})
        .finally(() => reconciling.delete(record.id));
    }
  }
  if (options.sessions.state$)
    subscriptions.add(options.sessions.state$.subscribe(reconcile));
  if (options.approvals)
    subscriptions.add(
      options.approvals.resolutions$.subscribe((event) => {
        if (!event.commandId) return;
        approvalResolutions.set(event.commandId, event.reason);
        if (approvalResolutions.size > 500)
          approvalResolutions.delete(approvalResolutions.keys().next().value!);
        const record = records.get(event.commandId);
        if (!record || record.operation !== 'approval') return;
        clearTimeout(confirmationTimers.get(record.id));
        confirmationTimers.delete(record.id);
        void change(record.id, (current) => ({
          ...current,
          phase: event.reason === 'resolved' ? 'completed' : 'uncertain',
          detail:
            event.reason === 'resolved'
              ? 'Codex cleared the approval request. The underlying action outcome is shown separately in Activity.'
              : 'The approval request is no longer current. Delivery is uncertain; nothing will be resent.',
        })).catch(() => {});
      }),
    );
  const awaitConfirmation = (id: string) => {
    confirmationTimers.set(
      id,
      setTimeout(() => {
        confirmationTimers.delete(id);
        const record = records.get(id);
        if (record?.phase !== 'accepted') return;
        if (record.approvalId)
          options.approvals?.markUncertain(record.approvalId, id);
        void change(id, (current) => ({
          ...current,
          phase: 'uncertain',
          detail:
            'Codex did not confirm the operation in time. Inspect current activity; nothing will be resent.',
        })).catch(() => {});
      }, options.confirmationMs ?? 30_000),
    );
    confirmationTimers.get(id)!.unref();
  };
  subscriptions.add(
    options.codex.state$.subscribe((integration) => {
      available = integration.state === 'available';
      if (available) {
        const targets = new Set(
          [...records.values()]
            .filter((record) => record.phase === 'uncertain' && record.turnId)
            .map((record) => record.resultSessionId ?? record.targetId)
            .filter((id): id is string => !!id),
        );
        for (const target of targets)
          void options.sessions.readHistory?.(target).catch(() => {});
      }
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
      reconcile();
    }),
  );

  async function run(command: ExecutionCommand) {
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
    if (command.operation !== 'start') {
      await runTarget(command);
      return;
    }
    if (options.authenticated && !options.authenticated()) {
      await change(record.id, (current) => ({
        ...current,
        phase: 'rejected',
        detail: 'Codex authentication is not ready. Nothing was sent.',
      }));
      return;
    }
    // If this persistence fails, the harness call below is never reached.
    await change(record.id, (current) => ({
      ...current,
      phase: 'dispatching',
      detail: 'Creating a Codex session.',
    }));
    if (
      !available ||
      closed ||
      (options.authenticated && !options.authenticated())
    ) {
      await change(record.id, (current) => ({
        ...current,
        phase: 'rejected',
        detail:
          'Codex availability or authentication changed before dispatch. Nothing was sent.',
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
      try {
        await options.saveSessions();
      } catch (error) {
        options.storageFailure(
          'Session metadata could not be saved. Check application storage.',
        );
        throw error;
      }
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
      reconcile();
    } catch (error) {
      await change(record.id, (current) => ({
        ...current,
        phase: error instanceof CodexRpcError ? 'rejected' : 'uncertain',
        detail: `${current.resultSessionId ? 'Session ' + current.resultSessionId + ' was created. ' : ''}${error instanceof CodexRpcError ? 'Codex rejected the operation: ' : 'The outcome is uncertain: '}${error instanceof Error ? error.message : 'connection failed'}. Nothing will be resent automatically.`,
      }));
    }
  }
  function verifyTarget(
    command: Exclude<ExecutionCommand, { operation: 'start' }>,
  ) {
    if (!available || closed)
      throw new Error('Codex is unavailable. Nothing was sent.');
    const session = options.sessions
      .getSnapshot?.()
      .sessions.find((item) => item.id === command.targetId);
    if (!session)
      throw new Error('The target session is unknown. Nothing was sent.');
    const caps = sessionCapabilities(
      session,
      available,
      options.authenticated?.() ?? true,
    );
    if (command.operation === 'resume' && !caps.resume)
      throw new Error('This conversation cannot currently be resumed.');
    if (command.operation === 'input' && !caps.input)
      throw new Error(
        'Input requires an idle session controlled by this connection.',
      );
    if (
      command.operation === 'interrupt' &&
      (!caps.interrupt || command.turnId !== session.activeTurnId)
    )
      throw new Error(
        'The target turn is no longer the active, controllable turn.',
      );
    if (
      command.operation === 'approval' &&
      options.approvals
        ?.getSnapshot()
        .find((item) => item.id === command.approvalId)?.sessionId !==
        command.targetId
    )
      throw new Error('The approval does not belong to this target session.');
    return session;
  }
  async function runTarget(
    command: Exclude<ExecutionCommand, { operation: 'start' }>,
  ) {
    let dispatched = false;
    let locked = false;
    let claimed = false;
    try {
      verifyTarget(command);
      if (command.operation === 'input' || command.operation === 'resume') {
        if (targetLocks.has(command.targetId))
          throw new Error(
            'Another session operation is still being submitted.',
          );
        targetLocks.add(command.targetId);
        locked = true;
      }
      let claim: ReturnType<ApprovalCommands['claim']> | undefined;
      if (command.operation === 'approval') {
        if (!options.approvals)
          throw new Error('Approval responses are unavailable.');
        claim = options.approvals.claim(
          command.approvalId,
          command.decision,
          command.id,
        );
        claimed = true;
      }
      await change(command.id, (current) => ({
        ...current,
        phase: 'dispatching',
        detail: `Submitting ${command.operation} to the selected Codex session.`,
        resultSessionId: command.targetId,
        turnId: claim?.turnId ?? current.turnId,
      }));
      verifyTarget(command);
      if (command.operation === 'approval') {
        if (!options.approvals!.validateClaim(command.approvalId, command.id))
          throw new Error(
            'The approval expired before dispatch. Nothing was sent.',
          );
        dispatched = true;
        options.codex.respond(claim!.rpcId, claim!.response);
        await change(command.id, (current) => {
          const resolved = approvalResolutions.get(command.id);
          return {
            ...current,
            phase:
              resolved === 'resolved'
                ? 'completed'
                : resolved === 'stale' || !available
                  ? 'uncertain'
                  : 'accepted',
            detail:
              resolved === 'resolved'
                ? 'Codex cleared the approval request. The underlying action outcome is shown separately in Activity.'
                : 'Approval response written; waiting for Codex to clear the request.',
          };
        });
        if (records.get(command.id)?.phase === 'accepted')
          awaitConfirmation(command.id);
      } else if (command.operation === 'resume') {
        dispatched = true;
        const result = threadResult.parse(
          await options.codex.request('thread/resume', {
            threadId: command.targetId,
          }),
        );
        if (
          result.thread.id !== command.targetId ||
          !options.sessions.acceptStartedThread(result.thread)
        )
          throw new Error(
            'The resumed session could not be verified in this workspace.',
          );
        try {
          await options.saveSessions();
        } catch (error) {
          options.storageFailure(
            'Session metadata could not be saved. Check application storage.',
          );
          throw error;
        }
        await change(command.id, (current) => ({
          ...current,
          phase: 'completed',
          detail:
            'Codex resumed the saved conversation. No new input was sent.',
        }));
        void options.sessions.readHistory?.(command.targetId).catch(() => {});
      } else if (command.operation === 'input') {
        dispatched = true;
        const result = turnResult.parse(
          await options.codex.request('turn/start', {
            threadId: command.targetId,
            input: [{ type: 'text', text: command.prompt }],
          }),
        );
        options.sessions.acceptTurn(command.targetId, result.turn);
        await change(command.id, (current) => ({
          ...current,
          turnId: result.turn.id,
          phase: available ? 'accepted' : 'uncertain',
          detail: available
            ? 'Codex accepted the input; execution is not yet confirmed complete.'
            : 'Input may have been accepted; Codex disconnected before confirmation.',
        }));
        reconcile();
      } else {
        dispatched = true;
        await options.codex.request('turn/interrupt', {
          threadId: command.targetId,
          turnId: command.turnId,
        });
        await change(command.id, (current) =>
          current.phase === 'completed'
            ? current
            : {
                ...current,
                phase: available ? 'accepted' : 'uncertain',
                detail:
                  'Codex acknowledged the interrupt request; waiting for the target turn outcome.',
              },
        );
        reconcile();
        if (records.get(command.id)?.phase === 'accepted')
          awaitConfirmation(command.id);
      }
    } catch (error) {
      if (command.operation === 'approval' && claimed) {
        if (dispatched)
          options.approvals?.markUncertain(command.approvalId, command.id);
        else
          options.approvals?.releaseBeforeWrite(command.approvalId, command.id);
      }
      await change(command.id, (current) => ({
        ...current,
        phase:
          !dispatched || error instanceof CodexRpcError
            ? 'rejected'
            : 'uncertain',
        detail: `${!dispatched ? 'Nothing was sent: ' : error instanceof CodexRpcError ? 'Codex rejected the operation: ' : 'The outcome is uncertain: '}${error instanceof Error ? error.message : 'operation failed'}. No automatic retry will occur.`,
      }));
    } finally {
      if (locked) targetLocks.delete(command.targetId);
    }
  }
  return {
    state$: state.asObservable(),
    getSnapshot: () => state.value,
    handle(command: ExecutionCommand) {
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
      for (const timer of confirmationTimers.values()) clearTimeout(timer);
      confirmationTimers.clear();
      await Promise.allSettled(
        [...running.values()].map((item) => item.promise),
      );
      await Promise.allSettled(updates.values());
      subscriptions.unsubscribe();
      state.complete();
    },
  };
}
