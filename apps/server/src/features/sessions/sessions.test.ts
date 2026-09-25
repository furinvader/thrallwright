import { BehaviorSubject, Subject } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Integration, Session } from '@thrallwright/contracts';
import type {
  CodexAdapter,
  HarnessEvent,
  HarnessRequest,
} from '../../integrations/codex.js';
import { createSessionService, type SessionService } from './sessions.js';
import { activityKey, MAX_TEXT_BYTES } from './normalize.js';

const cwd = '/workspace/example';
const now = () => '2026-09-25T00:00:00.000Z';
const thread = (id = 'thread-1', type: 'notLoaded' | 'idle' = 'notLoaded') => ({
  id,
  cwd,
  ephemeral: false,
  name: `Session ${id}`,
  parentThreadId: null,
  status: { type },
  turns: [] as unknown[],
});
const message = (id: string, text: string) => ({
  type: 'agentMessage',
  id,
  text,
});
const turn = (id: string, items: unknown[], status = 'completed') => ({
  id,
  status,
  itemsView: 'full',
  items,
});
function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<unknown>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

class FakeCodex implements CodexAdapter {
  state$ = new BehaviorSubject<Integration>({
    state: 'connecting',
    detail: 'Fixture',
  });
  events$ = new Subject<HarnessEvent>();
  requests$ = new Subject<HarnessRequest>();
  rows = [thread()];
  loaded: string[] = [];
  histories = new Map<string, unknown>();
  historyResult?: Promise<unknown>;
  start = vi.fn(async () => {});
  close = vi.fn(async () => {});
  respond = vi.fn();
  request = vi.fn(
    async (method: string, params?: unknown): Promise<unknown> => {
      if (method === 'thread/loaded/list')
        return { data: this.loaded, nextCursor: null };
      if (method === 'thread/list')
        return { data: this.rows, nextCursor: null };
      if (method === 'thread/read') {
        if (this.historyResult) return this.historyResult;
        const id = (params as { threadId: string }).threadId;
        return (
          this.histories.get(id) ?? {
            thread: this.rows.find((row) => row.id === id),
          }
        );
      }
      throw new Error(`Unexpected RPC ${method}`);
    },
  );
  event(method: string, params: unknown) {
    this.events$.next({ method, params });
  }
}

const services: SessionService[] = [];
afterEach(() => {
  for (const service of services.splice(0)) service.close();
});
async function fixture(
  initialSessions?: Session[],
  configure?: (codex: FakeCodex) => void,
) {
  const codex = new FakeCodex();
  configure?.(codex);
  const service = createSessionService({
    codex,
    workspace: cwd,
    initialSessions,
    now,
  });
  services.push(service);
  codex.state$.next({ state: 'available', detail: 'Ready' });
  await service.refresh();
  return {
    service,
    codex,
    session: () =>
      service.getSnapshot().sessions.find((value) => value.id === 'thread-1')!,
  };
}

describe('exact terminal turn evidence', () => {
  it('does not use cached latest outcomes or session summaries as terminal evidence', async () => {
    const original = await fixture();
    original.service.acceptTurn('thread-1', turn('saved-turn', []));
    const cached = original.session();
    expect(cached.latestTurnOutcome).toBe('completed');
    const restored = await fixture([cached]);
    expect(
      restored.service.getTurnOutcome('thread-1', 'saved-turn'),
    ).toBeUndefined();
    expect(
      restored.service.getTurnOutcome('unknown-thread', 'saved-turn'),
    ).toBeUndefined();
  });

  it('records exact terminal IDs from a fresh history read without making that session controllable', async () => {
    const { service, codex, session } = await fixture();
    codex.histories.set('thread-1', {
      thread: {
        ...thread(),
        turns: [
          turn('finished', [], 'completed'),
          turn('stopped', [], 'interrupted'),
          turn('broken', [], 'failed'),
          turn('active', [], 'inProgress'),
        ],
      },
    });
    await service.readHistory('thread-1');
    expect(service.getTurnOutcome('thread-1', 'finished')).toBe('completed');
    expect(service.getTurnOutcome('thread-1', 'stopped')).toBe('interrupted');
    expect(service.getTurnOutcome('thread-1', 'broken')).toBe('failed');
    expect(service.getTurnOutcome('thread-1', 'active')).toBeUndefined();
    expect(service.getTurnOutcome('thread-1', 'unseen')).toBeUndefined();
    expect(session().controllable).toBe(false);
  });

  it('preserves newer live outcomes when a history read finishes late', async () => {
    const { service, codex } = await fixture();
    const pending = deferred();
    codex.historyResult = pending.promise;
    const reading = service.readHistory('thread-1');
    service.acceptTurn('thread-1', turn('one', [], 'interrupted'));
    pending.resolve({
      thread: { ...thread(), turns: [turn('one', [], 'completed')] },
    });
    await reading;
    expect(service.getTurnOutcome('thread-1', 'one')).toBe('interrupted');
    service.acceptTurn('thread-1', turn('one', [], 'inProgress'));
    expect(service.getTurnOutcome('thread-1', 'one')).toBe('interrupted');
  });

  it('retains newer live outcome evidence when a delayed history exceeds the cache limit', async () => {
    const { service, codex } = await fixture();
    const pending = deferred();
    codex.historyResult = pending.promise;
    const reading = service.readHistory('thread-1');
    service.acceptTurn('thread-1', turn('new-live-turn', [], 'interrupted'));
    pending.resolve({
      thread: {
        ...thread(),
        turns: Array.from({ length: 120 }, (_, index) =>
          turn(`old-${index}`, []),
        ),
      },
    });
    await reading;
    expect(service.getTurnOutcome('thread-1', 'new-live-turn')).toBe(
      'interrupted',
    );
    expect(service.getTurnOutcome('thread-1', 'old-0')).toBeUndefined();
    expect(service.getTurnOutcome('thread-1', 'old-119')).toBe('completed');
  });

  it('clears evidence on disconnect and rejects reads from the previous connection', async () => {
    const { service, codex } = await fixture();
    service.acceptTurn('thread-1', turn('one', [], 'completed'));
    const pending = deferred();
    codex.historyResult = pending.promise;
    const reading = service.readHistory('thread-1');
    codex.state$.next({ state: 'unavailable', detail: 'Disconnected' });
    expect(service.getTurnOutcome('thread-1', 'one')).toBeUndefined();
    codex.state$.next({ state: 'available', detail: 'Reconnected' });
    await service.refresh();
    pending.resolve({
      thread: { ...thread(), turns: [turn('one', [], 'completed')] },
    });
    await reading;
    expect(service.getTurnOutcome('thread-1', 'one')).toBeUndefined();
    codex.historyResult = undefined;
    codex.histories.set('thread-1', {
      thread: { ...thread(), turns: [turn('one', [], 'completed')] },
    });
    await service.readHistory('thread-1');
    expect(service.getTurnOutcome('thread-1', 'one')).toBe('completed');
  });

  it('removes deleted session evidence and bounds retained terminal IDs', async () => {
    const { service, codex } = await fixture();
    for (let index = 0; index < 101; index++)
      service.acceptTurn('thread-1', turn(`turn-${index}`, [], 'completed'));
    expect(service.getTurnOutcome('thread-1', 'turn-0')).toBeUndefined();
    expect(service.getTurnOutcome('thread-1', 'turn-100')).toBe('completed');
    codex.event('thread/deleted', { threadId: 'thread-1' });
    expect(service.getTurnOutcome('thread-1', 'turn-100')).toBeUndefined();
  });

  it('does not treat failed or mismatched history reads as turn evidence', async () => {
    const { service, codex } = await fixture();
    codex.histories.set('thread-1', {
      thread: { ...thread('other-thread'), turns: [turn('one', [])] },
    });
    await service.readHistory('thread-1');
    expect(service.getTurnOutcome('thread-1', 'one')).toBeUndefined();
    service.close();
    service.acceptTurn('thread-1', turn('one', []));
    expect(service.getTurnOutcome('thread-1', 'one')).toBeUndefined();
  });
});

describe('session observation and ownership', () => {
  it('discovers and reads external history without pretending to attach or executing commands', async () => {
    const { service, codex, session } = await fixture();
    codex.histories.set('thread-1', {
      thread: {
        ...thread(),
        turns: [turn('turn-1', [message('item-1', 'Saved response')])],
      },
    });
    await service.readHistory('thread-1');
    expect(session()).toMatchObject({
      status: 'historical',
      freshness: 'history',
      controllable: false,
      owned: false,
      activeTurnId: null,
    });
    expect(session().activities[0]).toMatchObject({
      text: 'Saved response',
      origin: 'history',
    });
    expect(new Set(codex.request.mock.calls.map(([method]) => method))).toEqual(
      new Set(['thread/list', 'thread/loaded/list', 'thread/read']),
    );
    expect(codex.start).not.toHaveBeenCalled();
    expect(codex.respond).not.toHaveBeenCalled();
    service.close();
    expect(codex.close).not.toHaveBeenCalled();
  });

  it('requires current explicit ownership even when the app-server reports a loaded thread', async () => {
    const { service, session } = await fixture(undefined, (codex) => {
      codex.rows = [thread('thread-1', 'idle')];
      codex.loaded = ['thread-1'];
    });
    expect(session()).toMatchObject({
      freshness: 'live',
      status: 'idle',
      controllable: false,
    });
    service.acceptStartedThread(thread('thread-1', 'idle'));
    expect(session()).toMatchObject({ owned: true, controllable: true });
    expect(service.getControlState('thread-1')).toMatchObject({
      owned: true,
      connected: true,
    });
  });

  it('restores owned metadata as cached history and removes controls on disconnect', async () => {
    const first = await fixture();
    first.service.acceptStartedThread(thread('thread-1', 'idle'));
    first.service.acceptTurn('thread-1', turn('active-turn', [], 'inProgress'));
    const cached = first.session();
    const codex = new FakeCodex();
    const service = createSessionService({
      codex,
      workspace: cwd,
      initialSessions: [cached],
      now,
    });
    services.push(service);
    expect(service.getSnapshot().sessions[0]).toMatchObject({
      owned: true,
      controllable: false,
      activeTurnId: null,
      freshness: 'cached',
      status: 'historical',
    });
    expect(service.getControlState('thread-1')).toMatchObject({
      owned: false,
      connected: false,
    });
    first.codex.state$.next({ state: 'unavailable', detail: 'Disconnected' });
    expect(first.session()).toMatchObject({
      owned: true,
      controllable: false,
      activeTurnId: null,
      status: 'disconnected',
    });
    first.codex.state$.next({ state: 'available', detail: 'New process' });
    await first.service.refresh();
    expect(first.session()).toMatchObject({
      status: 'historical',
      owned: true,
      controllable: false,
    });
  });

  it('does not infer relationships from labels and ignores unrelated workspace threads', async () => {
    const { service } = await fixture(undefined, (codex) => {
      codex.rows = [
        { ...thread(), name: 'Child of parent-example in title' },
        { ...thread('child'), parentThreadId: 'thread-1' } as ReturnType<
          typeof thread
        >,
        { ...thread('elsewhere'), cwd: '/another/workspace' },
      ];
    });
    expect(
      service
        .getSnapshot()
        .sessions.map((session) => [session.id, session.parentThreadId]),
    ).toEqual([
      ['thread-1', null],
      ['child', 'thread-1'],
    ]);
  });

  it('revalidates missing loaded sessions while preserving activity observed during refresh', async () => {
    const { service, codex, session } = await fixture();
    service.acceptStartedThread(thread('thread-1', 'idle'));
    await service.refresh();
    expect(session().controllable).toBe(false);
    const listed = deferred();
    const original = codex.request.getMockImplementation()!;
    codex.request.mockImplementation((method, params) =>
      method === 'thread/list' ? listed.promise : original(method, params),
    );
    const reading = service.refresh();
    await Promise.resolve();
    service.acceptStartedThread(thread('thread-1', 'idle'));
    service.acceptTurn('thread-1', turn('live-turn', [], 'inProgress'));
    listed.resolve({ data: [thread()], nextCursor: null });
    await reading;
    expect(session()).toMatchObject({
      controllable: true,
      status: 'running',
      activeTurnId: 'live-turn',
    });
  });
});

describe('history and live activity reconciliation', () => {
  it('retains an active item observed before a read when rollout history lags', async () => {
    const { service, codex, session } = await fixture();
    service.acceptStartedThread(thread('thread-1', 'idle'));
    service.acceptTurn('thread-1', turn('active-turn', [], 'inProgress'));
    codex.event('item/agentMessage/delta', {
      threadId: 'thread-1',
      turnId: 'active-turn',
      itemId: 'active-item',
      delta: 'Live prefix',
    });
    codex.histories.set('thread-1', {
      thread: {
        ...thread(),
        status: { type: 'active', activeFlags: [] },
        turns: [turn('older-turn', [message('old-item', 'Saved history')])],
      },
    });
    await service.readHistory('thread-1');
    expect(session().activities.map((activity) => activity.text)).toEqual([
      'Saved history',
      'Live prefix',
    ]);
    expect(session()).toMatchObject({
      status: 'running',
      activeTurnId: 'active-turn',
      controllable: true,
    });
  });

  it('preserves newer live items and status while a history read is outstanding', async () => {
    const { service, codex, session } = await fixture();
    service.acceptStartedThread(thread('thread-1', 'idle'));
    const response = deferred();
    codex.historyResult = response.promise;
    const reading = service.readHistory('thread-1');
    codex.event('turn/started', {
      threadId: 'thread-1',
      turn: turn('turn-2', [], 'inProgress'),
    });
    codex.event('item/completed', {
      threadId: 'thread-1',
      turnId: 'turn-2',
      item: message('item-2', 'New live text'),
    });
    response.resolve({
      thread: {
        ...thread(),
        turns: [
          turn('turn-1', [message('item-1', 'Earlier history')]),
          turn('turn-2', [message('item-2', 'Old text')]),
        ],
      },
    });
    await reading;
    expect(session().activities.map((activity) => activity.text)).toEqual([
      'Earlier history',
      'New live text',
    ]);
    expect(session()).toMatchObject({
      status: 'running',
      activeTurnId: 'turn-2',
      controllable: true,
    });
  });

  it('ignores a previous connection history response and a superseded request', async () => {
    const { service, codex, session } = await fixture();
    const stale = deferred();
    codex.historyResult = stale.promise;
    const reading = service.readHistory('thread-1');
    const current = deferred();
    codex.historyResult = current.promise;
    const next = service.readHistory('thread-1');
    current.resolve({
      thread: {
        ...thread(),
        turns: [turn('turn-1', [message('item', 'Current')])],
      },
    });
    await next;
    stale.resolve({
      thread: {
        ...thread(),
        turns: [turn('turn-1', [message('item', 'Stale')])],
      },
    });
    await reading;
    expect(session().activities[0]?.text).toBe('Current');
    const disconnected = deferred();
    codex.historyResult = disconnected.promise;
    const pending = service.readHistory('thread-1');
    codex.state$.next({ state: 'unavailable', detail: 'Disconnected' });
    disconnected.resolve({
      thread: {
        ...thread(),
        turns: [turn('turn-1', [message('item', 'Late')])],
      },
    });
    await pending;
    expect(session().activities[0]?.text).toBe('Current');
    expect(session().history.state).toBe('unavailable');
  });

  it('keeps source identities unique across turns and replaces completed items', async () => {
    const { codex, session } = await fixture();
    const event = (turnId: string, text: string) =>
      codex.event('item/completed', {
        threadId: 'thread-1',
        turnId,
        item: message('same-item-id', text),
      });
    event('turn-1', 'First');
    event('turn-1', 'First');
    event('turn-2', 'Second');
    expect(session().activities.map((activity) => activity.id)).toEqual([
      activityKey('turn-1', 'same-item-id'),
      activityKey('turn-2', 'same-item-id'),
    ]);
  });

  it('keeps unknown-item deltas partial and replaces them with full source content', async () => {
    const { service, codex, session } = await fixture();
    const response = deferred();
    codex.historyResult = response.promise;
    const reading = service.readHistory('thread-1');
    const delta = {
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'item-1',
      delta: 'ha',
    };
    codex.event('item/agentMessage/delta', delta);
    codex.event('item/agentMessage/delta', delta);
    response.resolve({
      thread: {
        ...thread(),
        turns: [turn('turn-1', [message('item-1', 'prefix ha')])],
      },
    });
    await reading;
    expect(session().activities[0]).toMatchObject({
      text: 'haha',
      complete: false,
    });
    expect(session().history.complete).toBe(false);
    codex.event('item/completed', {
      ...delta,
      item: message('item-1', 'prefix haha'),
    });
    expect(session().activities[0]).toMatchObject({
      text: 'prefix haha',
      complete: true,
    });
  });

  it('preserves partial source history but removes absent items after a complete reread', async () => {
    const { service, codex, session } = await fixture();
    codex.event('item/completed', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: message('old-item', 'Old content'),
    });
    codex.histories.set('thread-1', {
      thread: {
        ...thread(),
        turns: [{ ...turn('turn-1', []), itemsView: 'summary' }],
      },
    });
    await service.readHistory('thread-1');
    expect(session().activities).toHaveLength(1);
    codex.histories.set('thread-1', {
      thread: { ...thread(), turns: [turn('turn-1', [])] },
    });
    await service.readHistory('thread-1');
    expect(session().activities).toHaveLength(0);
  });

  it('ignores reasoning while retaining supported tool activity and source parent identity', async () => {
    const { service, codex, session } = await fixture();
    codex.histories.set('thread-1', {
      thread: {
        ...thread(),
        parentThreadId: 'parent',
        turns: [
          turn('turn-1', [
            {
              type: 'reasoning',
              id: 'reasoning',
              summary: ['Excluded'],
              content: ['Never exposed'],
            },
            {
              type: 'commandExecution',
              id: 'command',
              command: 'printf example',
              status: 'completed',
              aggregatedOutput: 'example',
            },
            message('answer', 'Public response'),
          ]),
        ],
      },
    });
    await service.readHistory('thread-1');
    codex.event('item/reasoning/textDelta', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'reasoning',
      delta: 'Never exposed',
    });
    expect(session().activities).toHaveLength(2);
    expect(session().activities[0]?.kind).toBe('tool');
    expect(JSON.stringify(session())).not.toContain('Never exposed');
    expect(session().parentThreadId).toBe('parent');
  });

  it('does not resurrect deleted history or controls when an old read completes', async () => {
    const { service, codex, session } = await fixture();
    service.acceptStartedThread(thread('thread-1', 'idle'));
    codex.event('item/completed', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: message('item-1', 'Private source content'),
    });
    const response = deferred();
    codex.historyResult = response.promise;
    const reading = service.readHistory('thread-1');
    codex.event('thread/deleted', { threadId: 'thread-1' });
    response.resolve({
      thread: {
        ...thread(),
        turns: [turn('turn-1', [message('item-1', 'Private source content')])],
      },
    });
    await reading;
    await service.refresh();
    expect(session()).toMatchObject({
      activities: [],
      controllable: false,
      history: { state: 'deleted' },
    });
    expect(service.getControlState('thread-1')?.owned).toBe(false);
  });

  it('does not let a late start acknowledgement or old completion overwrite a newer turn', async () => {
    const { service, session } = await fixture();
    service.acceptStartedThread(thread('thread-1', 'idle'));
    service.acceptTurn('thread-1', turn('turn-1', [], 'completed'));
    service.acceptTurn('thread-1', turn('turn-1', [], 'inProgress'));
    expect(session().status).toBe('idle');
    service.acceptTurn('thread-1', turn('turn-2', [], 'inProgress'));
    service.acceptTurn('thread-1', turn('turn-1', [], 'completed'));
    expect(session()).toMatchObject({
      status: 'running',
      activeTurnId: 'turn-2',
      latestTurnOutcome: 'inProgress',
    });
  });
});

describe('bounds and observation errors', () => {
  it('invalidates controls when a known session reports malformed runtime state', async () => {
    const { service, codex, session } = await fixture();
    service.acceptStartedThread(thread('thread-1', 'idle'));
    codex.event('thread/status/changed', {
      threadId: 'thread-1',
      status: 'unexpected',
    });
    expect(session()).toMatchObject({
      status: 'unknown',
      controllable: false,
      activeTurnId: null,
    });
    expect(session().history.detail).toContain('unsupported runtime');
  });

  it('bounds pagination even when pages are empty and cursors keep changing', async () => {
    const { service, codex } = await fixture();
    const original = codex.request.getMockImplementation()!;
    let page = 0;
    codex.request.mockImplementation((method, params) =>
      method === 'thread/list'
        ? Promise.resolve({ data: [], nextCursor: `cursor-${++page}` })
        : original(method, params),
    );
    await service.refresh();
    expect(page).toBe(4);
    expect(service.getSnapshot().discovery.detail).toContain('limited');
  });

  it('does not regain ownership after unloading merely from a later status event', async () => {
    const { service, codex, session } = await fixture();
    service.acceptStartedThread(thread('thread-1', 'idle'));
    codex.event('thread/status/changed', {
      threadId: 'thread-1',
      status: { type: 'notLoaded' },
    });
    codex.event('thread/status/changed', {
      threadId: 'thread-1',
      status: { type: 'idle' },
    });
    expect(session()).toMatchObject({ owned: true, controllable: false });
    expect(service.getControlState('thread-1')?.owned).toBe(false);
  });

  it('bounds discovery and history and reports text truncation using UTF-8 bytes', async () => {
    const { service, codex, session } = await fixture(undefined, (harness) => {
      harness.rows = Array.from({ length: 105 }, (_, index) =>
        thread(`thread-${index + 1}`),
      );
    });
    expect(service.getSnapshot().sessions).toHaveLength(100);
    expect(service.getSnapshot().discovery.detail).toContain('limited');
    codex.histories.set('thread-1', {
      thread: {
        ...thread(),
        turns: [
          turn(
            'turn-1',
            Array.from({ length: 120 }, (_, index) =>
              message(
                `item-${index}`,
                index === 119 ? '🛠'.repeat(5000) : String(index),
              ),
            ),
          ),
        ],
      },
    });
    await service.readHistory('thread-1');
    expect(session().activities).toHaveLength(100);
    expect(
      Buffer.byteLength(session().activities.at(-1)!.text),
    ).toBeLessThanOrEqual(MAX_TEXT_BYTES);
    expect(session().history.complete).toBe(false);
    expect(session().activities.at(-1)!.text).toContain('[Truncated]');
  });

  it('keeps history failures visible without erasing existing observations', async () => {
    const { service, codex, session } = await fixture();
    codex.event('item/completed', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: message('item', 'Retained'),
    });
    codex.historyResult = Promise.reject(new Error('Harness denied read'));
    await service.readHistory('thread-1');
    expect(session().activities[0]?.text).toBe('Retained');
    expect(session().history.state).toBe('unavailable');
    await expect(service.readHistory('unknown-session')).rejects.toThrow(
      'Unknown session',
    );
    expect(
      codex.request.mock.calls.filter(([method]) => method === 'thread/read'),
    ).toHaveLength(1);
  });

  it('ignores events and does not perform reads after the observation owner closes', async () => {
    const { service, codex } = await fixture();
    const snapshot = service.getSnapshot();
    const calls = codex.request.mock.calls.length;
    service.close();
    codex.event('thread/started', { thread: thread('new-session', 'idle') });
    await service.refresh();
    await service.readHistory('thread-1');
    expect(service.getSnapshot()).toBe(snapshot);
    expect(codex.request).toHaveBeenCalledTimes(calls);
  });
});
