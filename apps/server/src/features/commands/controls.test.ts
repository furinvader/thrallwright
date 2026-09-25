import { afterEach, describe, expect, it, vi } from 'vitest';
import { BehaviorSubject, Subject } from 'rxjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  Approval,
  CommandRecord,
  ExecutionCommand,
  Integration,
  Session,
} from '@thrallwright/contracts';
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

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const input = (n: number): ExecutionCommand => ({
  type: 'command',
  id: id(n),
  operation: 'input',
  targetId: 'thread-1',
  prompt: `Input ${n}`,
});
const resume = (n: number): ExecutionCommand => ({
  type: 'command',
  id: id(n),
  operation: 'resume',
  targetId: 'thread-1',
});
const interrupt = (n: number): ExecutionCommand => ({
  type: 'command',
  id: id(n),
  operation: 'interrupt',
  targetId: 'thread-1',
  turnId: 'turn-current',
});
const approvalCommand = (n: number): ExecutionCommand => ({
  type: 'command',
  id: id(n),
  operation: 'approval',
  targetId: 'thread-1',
  approvalId: 'approval-1',
  decision: 'accept',
});

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 'thread-1',
    title: 'Session',
    parentThreadId: null,
    ephemeral: false,
    owned: true,
    controllable: true,
    status: 'idle',
    freshness: 'live',
    activeTurnId: null,
    latestTurnOutcome: null,
    observedAt: '2026-09-25T00:00:00Z',
    history: { state: 'ready', complete: true, detail: 'Read.' },
    activities: [],
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

class FakeCodex implements CodexAdapter {
  state$ = new BehaviorSubject<Integration>({
    state: 'available',
    detail: 'Connected.',
  });
  events$ = new Subject<HarnessEvent>();
  requests$ = new Subject<HarnessRequest>();
  calls: Array<{ method: string; params: unknown }> = [];
  responses: Array<{ id: string | number; result: unknown }> = [];
  onRespond?: () => void;
  reply: (method: string, params: unknown) => Promise<unknown> | unknown = (
    method,
  ) =>
    method === 'thread/start' || method === 'thread/resume'
      ? { thread: { id: 'thread-1' } }
      : method === 'turn/start'
        ? { turn: { id: 'turn-new' } }
        : {};
  async start() {}
  request(method: string, params: unknown = {}) {
    this.calls.push({ method, params });
    return Promise.resolve().then(() => this.reply(method, params));
  }
  respond(id: string | number, result: unknown) {
    this.responses.push({ id, result });
    this.onRespond?.();
  }
  async close() {}
}

class FakeSessions {
  state$ = new BehaviorSubject<{ sessions: Session[] }>({
    sessions: [session()],
  });
  outcomes = new Map<string, string>();
  historyReads: string[] = [];
  onHistoryRead?: () => void;
  getSnapshot() {
    return this.state$.value;
  }
  set(value: Session) {
    this.state$.next({ sessions: [value] });
  }
  acceptStartedThread(thread: unknown) {
    return thread;
  }
  acceptTurn(_threadId: string, _turn: unknown) {}
  getTurnOutcome(threadId: string, turnId: string) {
    return this.outcomes.get(`${threadId}/${turnId}`) ?? null;
  }
  async readHistory(threadId: string) {
    this.historyReads.push(threadId);
    this.onHistoryRead?.();
  }
}

class FakeApprovals {
  resolutions$ = new Subject<{
    approvalId: string;
    commandId?: string;
    reason: 'resolved' | 'stale';
  }>();
  current: Approval = {
    id: 'approval-1',
    sessionId: 'thread-1',
    turnId: 'turn-current',
    itemId: 'item-1',
    kind: 'command',
    method: 'item/commandExecution/requestApproval',
    summary: 'Run command',
    reason: null,
    status: 'pending',
    actionable: true,
    observedAt: '2026-09-25T00:00:00Z',
    detail: 'Waiting.',
    commandId: null,
  };
  claims = 0;
  releases = 0;
  getSnapshot() {
    return [this.current];
  }
  claim(
    approvalId: string,
    _decision: 'accept' | 'decline',
    commandId: string,
  ) {
    this.claims++;
    if (approvalId !== this.current.id || this.current.status !== 'pending')
      throw new Error('Already claimed.');
    this.current = { ...this.current, status: 'submitting', commandId };
    return {
      rpcId: 7,
      response: { decision: 'accept' as const },
      threadId: 'thread-1',
      turnId: 'turn-current',
    };
  }
  validateClaim(approvalId: string, commandId: string) {
    return (
      this.current.id === approvalId &&
      this.current.commandId === commandId &&
      this.current.status === 'submitting'
    );
  }
  releaseBeforeWrite(_approvalId: string, commandId: string) {
    this.releases++;
    if (this.current.commandId === commandId)
      this.current = { ...this.current, status: 'pending', commandId: null };
  }
  markUncertain(_approvalId: string, commandId: string) {
    if (this.current.commandId === commandId)
      this.current = { ...this.current, status: 'stale', actionable: false };
  }
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'thrallwright-controls-'));
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
  const codex = new FakeCodex();
  const sessions = new FakeSessions();
  const approvals = new FakeApprovals();
  const failures: string[] = [];
  let authReady = true;
  let journal = commandJournal(db, workspace);
  async function start(adapter = codex) {
    service = createCommandService({
      workspace,
      codex: adapter,
      sessions,
      approvals,
      journal,
      initial: await journal.load(),
      authenticated: () => authReady,
      confirmationMs: 50,
      saveSessions: async () => {},
      storageFailure: (message) => {
        failures.push(message);
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
    approvals,
    failures,
    start,
    setAuth(value: boolean) {
      authReady = value;
    },
    failNextUpdate(phase: CommandRecord['phase']) {
      const original = journal.update.bind(journal);
      let failed = false;
      journal.update = async (record) => {
        if (!failed && record.phase === phase) {
          failed = true;
          throw new Error('Disk unavailable.');
        }
        return original(record);
      };
    },
    afterUpdate(phase: CommandRecord['phase'], action: () => void) {
      const original = journal.update.bind(journal);
      journal.update = async (record) => {
        await original(record);
        if (record.phase === phase) action();
      };
    },
    async restart(adapter = new FakeCodex()) {
      await service?.close();
      await db.destroy();
      db = await openDatabase(filename);
      journal = commandJournal(db, workspace);
      return start(adapter);
    },
  };
}

describe('directed controls', () => {
  it('locks concurrent input and resume submissions per target', async () => {
    const context = await fixture();
    const pending = deferred<unknown>();
    context.codex.reply = (method) =>
      method === 'turn/start'
        ? pending.promise
        : { thread: { id: 'thread-1' } };
    const commands = await context.start();
    const first = commands.handle(input(1));
    await vi.waitFor(() => expect(context.codex.calls).toHaveLength(1));
    await commands.handle(input(2));
    expect(
      commands.getSnapshot().find((record) => record.id === id(2))?.phase,
    ).toBe('rejected');
    expect(context.codex.calls).toHaveLength(1);
    pending.resolve({ turn: { id: 'turn-new' } });
    await first;

    context.sessions.set(
      session({
        freshness: 'history',
        status: 'historical',
        controllable: false,
      }),
    );
    const resumed = deferred<unknown>();
    context.codex.reply = (method) =>
      method === 'thread/resume'
        ? resumed.promise
        : { turn: { id: 'turn-new' } };
    const firstResume = commands.handle(resume(3));
    await vi.waitFor(() => expect(context.codex.calls).toHaveLength(2));
    await commands.handle(resume(4));
    expect(
      commands.getSnapshot().find((record) => record.id === id(4))?.phase,
    ).toBe('rejected');
    expect(context.codex.calls).toHaveLength(2);
    resumed.resolve({ thread: { id: 'thread-1' } });
    await firstResume;
  });

  it('allows interrupt while an input request is slow', async () => {
    const context = await fixture();
    const pending = deferred<unknown>();
    context.codex.reply = (method) =>
      method === 'turn/start' ? pending.promise : {};
    const commands = await context.start();
    const sending = commands.handle(input(5));
    await vi.waitFor(() =>
      expect(context.codex.calls.map((call) => call.method)).toEqual([
        'turn/start',
      ]),
    );
    context.sessions.set(
      session({ status: 'running', activeTurnId: 'turn-current' }),
    );
    await commands.handle(interrupt(6));
    expect(context.codex.calls.map((call) => call.method)).toEqual([
      'turn/start',
      'turn/interrupt',
    ]);
    expect(
      commands.getSnapshot().find((record) => record.id === id(6))?.phase,
    ).toBe('accepted');
    pending.resolve({ turn: { id: 'turn-new' } });
    await sending;
  });

  it('allows interrupt of another active session while thread/start is slow', async () => {
    const context = await fixture();
    context.sessions.set(
      session({ status: 'running', activeTurnId: 'turn-current' }),
    );
    const pending = deferred<unknown>();
    context.codex.reply = (method) =>
      method === 'thread/start'
        ? pending.promise
        : method === 'turn/start'
          ? { turn: { id: 'turn-new' } }
          : {};
    const commands = await context.start();
    const starting = commands.handle({
      type: 'command',
      id: id(7),
      operation: 'start',
      prompt: 'Start.',
    });
    await vi.waitFor(() =>
      expect(context.codex.calls.map((call) => call.method)).toEqual([
        'thread/start',
      ]),
    );
    await commands.handle(interrupt(8));
    expect(context.codex.calls.map((call) => call.method)).toEqual([
      'thread/start',
      'turn/interrupt',
    ]);
    pending.resolve({ thread: { id: 'thread-new' } });
    await starting;
  });

  it('claims a pending approval once and sends only one response', async () => {
    const context = await fixture();
    context.sessions.set(
      session({ status: 'waiting', activeTurnId: 'turn-current' }),
    );
    const commands = await context.start();
    await commands.handle(approvalCommand(9));
    await commands.handle(approvalCommand(10));
    expect(context.approvals.claims).toBe(2);
    expect(context.codex.responses).toEqual([
      { id: 7, result: { decision: 'accept' } },
    ]);
    expect(
      commands.getSnapshot().find((record) => record.id === id(10))?.phase,
    ).toBe('rejected');
  });

  it('retains approval resolution emitted during the response write', async () => {
    const context = await fixture();
    context.sessions.set(
      session({ status: 'waiting', activeTurnId: 'turn-current' }),
    );
    context.codex.onRespond = () =>
      context.approvals.resolutions$.next({
        approvalId: 'approval-1',
        commandId: id(17),
        reason: 'resolved',
      });
    const commands = await context.start();
    await commands.handle(approvalCommand(17));
    expect(context.codex.responses).toHaveLength(1);
    expect(commands.getSnapshot()[0]?.phase).toBe('completed');
  });

  it('releases an approval that expires between journal update and dispatch', async () => {
    const context = await fixture();
    context.sessions.set(
      session({ status: 'waiting', activeTurnId: 'turn-current' }),
    );
    context.afterUpdate('dispatching', () => {
      context.approvals.current = {
        ...context.approvals.current,
        status: 'stale',
        actionable: false,
      };
    });
    const commands = await context.start();
    await commands.handle(approvalCommand(11));
    expect(context.codex.responses).toEqual([]);
    expect(context.approvals.releases).toBe(1);
    expect(commands.getSnapshot()[0]?.phase).toBe('rejected');
  });

  it('marks a dispatched operation uncertain when its outcome cannot be persisted', async () => {
    const context = await fixture();
    context.failNextUpdate('accepted');
    const commands = await context.start();
    await commands.handle(input(12));
    expect(context.codex.calls.map((call) => call.method)).toEqual([
      'turn/start',
    ]);
    expect(commands.getSnapshot()[0]?.phase).toBe('uncertain');
    expect(context.failures).toHaveLength(1);
    await commands.handle(input(12));
    expect(context.codex.calls).toHaveLength(1);
  });

  it('reconciles an exact historical turn after restart without resending input', async () => {
    const context = await fixture();
    const commands = await context.start();
    await commands.handle(input(13));
    expect(commands.getSnapshot()[0]).toMatchObject({
      phase: 'accepted',
      turnId: 'turn-new',
    });
    context.sessions.onHistoryRead = () => {
      context.sessions.outcomes.set('thread-1/turn-new', 'completed');
      context.sessions.state$.next(context.sessions.getSnapshot());
    };
    const replacement = new FakeCodex();
    const restarted = await context.restart(replacement);
    await vi.waitFor(() =>
      expect(restarted.getSnapshot()[0]?.phase).toBe('completed'),
    );
    expect(context.sessions.historyReads).toContain('thread-1');
    await restarted.handle(input(13));
    expect(replacement.calls).toEqual([]);
  });

  it.each(['input', 'interrupt'] as const)(
    'records an explicit Codex rejection for %s',
    async (operation) => {
      const context = await fixture();
      if (operation === 'interrupt')
        context.sessions.set(
          session({ status: 'running', activeTurnId: 'turn-current' }),
        );
      context.codex.reply = () => {
        throw new CodexRpcError(-32000, 'Rejected by Codex.');
      };
      const commands = await context.start();
      await commands.handle(operation === 'input' ? input(14) : interrupt(14));
      expect(commands.getSnapshot()[0]?.phase).toBe('rejected');
    },
  );

  it('blocks unauthenticated input while allowing interruption of active work', async () => {
    const context = await fixture();
    context.setAuth(false);
    const commands = await context.start();
    await commands.handle(input(15));
    expect(commands.getSnapshot()[0]?.phase).toBe('rejected');
    expect(context.codex.calls).toEqual([]);
    context.sessions.set(
      session({ status: 'running', activeTurnId: 'turn-current' }),
    );
    await commands.handle(interrupt(16));
    expect(context.codex.calls.map((call) => call.method)).toEqual([
      'turn/interrupt',
    ]);
  });
});
