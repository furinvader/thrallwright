import { afterEach, describe, expect, it } from 'vitest';
import { BehaviorSubject, Subject } from 'rxjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'kysely';
import type { Integration, StartCommand } from '@thrallwright/contracts';
import {
  CodexRpcError,
  type CodexAdapter,
  type HarnessEvent,
  type HarnessRequest,
} from '../../integrations/codex.js';
import { openDatabase } from '../../storage/database.js';
import { createCommandService } from './commands.js';
import { commandJournal } from './journal.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const command = (
  id = '00000000-0000-4000-8000-000000000001',
  prompt = 'Start here',
): StartCommand => ({
  type: 'command',
  id,
  operation: 'start',
  prompt,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

class FakeCodex implements CodexAdapter {
  state$ = new BehaviorSubject<Integration>({
    state: 'available',
    detail: 'Fixture Codex.',
  });
  events$ = new Subject<HarnessEvent>();
  requests$ = new Subject<HarnessRequest>();
  calls: Array<{ method: string; params: unknown }> = [];
  reply: (method: string, params: unknown) => Promise<unknown> | unknown = (
    method,
  ) =>
    method === 'thread/start'
      ? { thread: { id: 'thread-1' } }
      : { turn: { id: 'turn-1' } };
  async start() {}
  request(method: string, params: unknown = {}) {
    this.calls.push({ method, params });
    return Promise.resolve().then(() => this.reply(method, params));
  }
  respond() {}
  async close() {}
}

async function fixture(codex = new FakeCodex()) {
  const directory = await mkdtemp(join(tmpdir(), 'thrallwright-commands-'));
  const filename = join(directory, 'application.sqlite');
  let db = await openDatabase(filename);
  let service: ReturnType<typeof createCommandService> | undefined;
  const workspace = '/project';
  await db
    .insertInto('workspaces')
    .values({ path: workspace, last_opened_at: '2026-09-25T00:00:00Z' })
    .execute();
  cleanups.push(async () => {
    await service?.close();
    await db.destroy();
    await rm(directory, { recursive: true, force: true });
  });
  const sessions: {
    acceptStartedThread(thread: unknown): unknown;
    acceptTurn(threadId: string, turn: unknown): unknown;
  } = {
    acceptStartedThread: (thread) => thread,
    acceptTurn: (_threadId: string, _turn: unknown) => {},
  };
  const saved: string[] = [];
  const failures: string[] = [];
  async function start(adapter = codex) {
    const journal = commandJournal(db, workspace);
    const initial = await journal.load();
    service = createCommandService({
      workspace,
      codex: adapter,
      journal,
      sessions,
      initial,
      saveSessions: async () => {
        saved.push('saved');
      },
      storageFailure: (detail) => {
        failures.push(detail);
      },
    });
    return service;
  }
  return {
    get db() {
      return db;
    },
    codex,
    sessions,
    workspace,
    saved,
    failures,
    start,
    async restart(adapter = new FakeCodex()) {
      await service?.close();
      await db.destroy();
      db = await openDatabase(filename);
      return start(adapter);
    },
  };
}

describe('command dispatch journal', () => {
  it('does not dispatch when intent insertion fails', async () => {
    const context = await fixture();
    await sql`CREATE TRIGGER fail_intent BEFORE INSERT ON commands BEGIN SELECT RAISE(FAIL, 'disk unavailable'); END`.execute(
      context.db,
    );
    const service = await context.start();
    await expect(service.handle(command())).rejects.toThrow(
      'Cannot save command intent',
    );
    expect(context.codex.calls).toEqual([]);
    expect(service.getSnapshot()).toEqual([]);
    expect(
      await context.db.selectFrom('commands').selectAll().execute(),
    ).toEqual([]);
  });

  it('does not dispatch when the dispatching state cannot be persisted', async () => {
    const context = await fixture();
    await sql`CREATE TRIGGER fail_dispatch BEFORE UPDATE ON commands WHEN json_extract(NEW.record, '$.phase') = 'dispatching' BEGIN SELECT RAISE(FAIL, 'disk unavailable'); END`.execute(
      context.db,
    );
    const service = await context.start();
    await expect(service.handle(command())).rejects.toThrow(
      'could not be saved',
    );
    expect(context.codex.calls).toEqual([]);
    expect(service.getSnapshot()[0]?.phase).toBe('uncertain');
    expect(context.failures).toHaveLength(1);
    const [row] = await context.db.selectFrom('commands').selectAll().execute();
    expect(JSON.parse(row!.record).phase).toBe('intent');
  });

  it('stops before turn/start when the returned thread cannot be ingested', async () => {
    const context = await fixture();
    context.sessions.acceptStartedThread = () => null;
    const service = await context.start();
    await service.handle(command());
    expect(context.codex.calls.map((call) => call.method)).toEqual([
      'thread/start',
    ]);
    expect(context.saved).toEqual([]);
    expect(service.getSnapshot()[0]?.phase).toBe('uncertain');
  });

  it('coalesces a concurrent command and never resends a completed ID', async () => {
    const context = await fixture();
    const thread = deferred<unknown>();
    context.codex.reply = (method) =>
      method === 'thread/start' ? thread.promise : { turn: { id: 'turn-1' } };
    const service = await context.start();
    const input = command();
    const first = service.handle(input);
    const second = service.handle(input);
    expect(second).toBe(first);
    await expect(
      service.handle(command(input.id, 'Different input')),
    ).rejects.toThrow('different input');
    thread.resolve({ thread: { id: 'thread-1' } });
    await Promise.all([first, second]);
    expect(context.codex.calls.map((call) => call.method)).toEqual([
      'thread/start',
      'turn/start',
    ]);
    expect(context.codex.calls[0]?.params).toEqual({ cwd: context.workspace });
    expect(context.codex.calls[1]?.params).toEqual({
      threadId: 'thread-1',
      input: [{ type: 'text', text: input.prompt }],
    });
    expect(service.getSnapshot()[0]).toMatchObject({
      phase: 'accepted',
      resultSessionId: 'thread-1',
      turnId: 'turn-1',
    });
    expect(context.saved).toEqual(['saved']);
    await service.handle(input);
    expect(context.codex.calls).toHaveLength(2);
    await expect(
      service.handle(command(input.id, 'Different input')),
    ).rejects.toThrow('different input');
    expect(context.codex.calls).toHaveLength(2);
    expect(
      await context.db.selectFrom('commands').selectAll().execute(),
    ).toHaveLength(1);
  });

  it.each([
    [
      'explicit rejection',
      new CodexRpcError(-32000, 'Denied by Codex.'),
      'rejected',
    ],
    ['lost response', new Error('Codex request timed out.'), 'uncertain'],
  ] as const)(
    'classifies %s without resending after restart',
    async (_description, failure, phase) => {
      const context = await fixture();
      context.codex.reply = (method) => {
        if (method === 'turn/start') throw failure;
        return { thread: { id: 'thread-1' } };
      };
      const service = await context.start();
      await service.handle(command());
      expect(service.getSnapshot()[0]).toMatchObject({
        phase,
        resultSessionId: 'thread-1',
        turnId: null,
      });
      expect(context.codex.calls.map((call) => call.method)).toEqual([
        'thread/start',
        'turn/start',
      ]);
      const replacement = new FakeCodex();
      const restarted = await context.restart(replacement);
      expect(restarted.getSnapshot()[0]?.phase).toBe(phase);
      await restarted.handle(command());
      expect(replacement.calls).toEqual([]);
    },
  );

  it('marks accepted commands uncertain on restart and does not replay them', async () => {
    const context = await fixture();
    const service = await context.start();
    await service.handle(command());
    expect(service.getSnapshot()[0]?.phase).toBe('accepted');
    const replacement = new FakeCodex();
    const restarted = await context.restart(replacement);
    expect(restarted.getSnapshot()[0]).toMatchObject({
      phase: 'uncertain',
      resultSessionId: 'thread-1',
      turnId: 'turn-1',
    });
    await restarted.handle(command());
    expect(replacement.calls).toEqual([]);
    const [row] = await context.db.selectFrom('commands').selectAll().execute();
    expect(JSON.parse(row!.record).phase).toBe('uncertain');
  });

  it('never replays a persisted dispatching state after a restart', async () => {
    const context = await fixture();
    const journal = commandJournal(context.db, context.workspace);
    const { record } = await journal.begin(command());
    await journal.update({ ...record, phase: 'dispatching' });

    const replacement = new FakeCodex();
    const restarted = await context.restart(replacement);
    expect(restarted.getSnapshot()[0]?.phase).toBe('uncertain');
    await restarted.handle(command());
    expect(replacement.calls).toEqual([]);
  });

  it('retains completion received before the turn/start response', async () => {
    const codex = new FakeCodex();
    codex.reply = (method) => {
      if (method === 'thread/start') return { thread: { id: 'thread-1' } };
      codex.events$.next({
        method: 'turn/completed',
        params: {
          threadId: 'thread-1',
          turn: { id: 'turn-1', status: 'completed' },
        },
      });
      return { turn: { id: 'turn-1' } };
    };
    const context = await fixture(codex);
    const service = await context.start();
    await service.handle(command());
    expect(service.getSnapshot()[0]).toMatchObject({
      phase: 'completed',
      resultSessionId: 'thread-1',
      turnId: 'turn-1',
    });
    const [row] = await context.db.selectFrom('commands').selectAll().execute();
    expect(JSON.parse(row!.record).phase).toBe('completed');
  });
});
