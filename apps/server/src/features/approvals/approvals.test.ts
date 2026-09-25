import { BehaviorSubject, Subject } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Approval, Integration } from '@thrallwright/contracts';
import type { HarnessEvent, HarnessRequest } from '../../integrations/codex.js';
import {
  createApprovalService,
  type ApprovalService,
  type ApprovalResolution,
} from './approvals.js';

const method = 'item/commandExecution/requestApproval';
const params = {
  threadId: 'thread-1',
  turnId: 'turn-1',
  itemId: 'item-1',
  kind: 'command',
  startedAtMs: 0,
  environmentId: null,
  command: 'echo example',
  reason: 'Needs approval',
};
const services: ApprovalService[] = [];
afterEach(() => {
  for (const service of services.splice(0)) service.close();
});

function fixture(initialApprovals?: Approval[]) {
  const codex = {
    state$: new BehaviorSubject<Integration>({
      state: 'available',
      detail: 'Fixture',
    }),
    events$: new Subject<HarnessEvent>(),
    requests$: new Subject<HarnessRequest>(),
    request: vi.fn(async () => undefined),
    respond: vi.fn(),
    start: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
  const controls = new Map<
    string,
    { owned: boolean; connected: boolean; activeTurnId: string | null }
  >([['thread-1', { owned: true, connected: true, activeTurnId: 'turn-1' }]]);
  const outcomes = new Map<string, string>();
  const sessions = {
    state$: new BehaviorSubject(0),
    getControlState: (id: string) => controls.get(id),
    getTurnOutcome: (id: string, turnId: string) =>
      outcomes.get(JSON.stringify([id, turnId])),
  };
  const service = createApprovalService({
    codex,
    sessions,
    initialApprovals,
    now: () => '2026-09-25T00:00:00.000Z',
  });
  services.push(service);
  const resolutions: ApprovalResolution[] = [];
  service.resolutions$.subscribe((value) => resolutions.push(value));
  const receive = (
    id: string | number = 1,
    changes: object = {},
    requestMethod = method,
  ) => {
    codex.requests$.next({
      id,
      method: requestMethod,
      params: { ...params, ...changes },
    });
    return service.getSnapshot().at(-1)!;
  };
  const resolve = (requestId: string | number = 1, threadId = 'thread-1') => {
    codex.events$.next({
      method: 'serverRequest/resolved',
      params: { threadId, requestId },
    });
  };
  const control = (value: {
    owned: boolean;
    connected: boolean;
    activeTurnId: string | null;
  }) => {
    controls.set('thread-1', value);
    sessions.state$.next(sessions.state$.value + 1);
  };
  return {
    service,
    codex,
    controls,
    sessions,
    outcomes,
    resolutions,
    receive,
    resolve,
    control,
    latest: () => service.getSnapshot().at(-1)!,
  };
}

describe('approval ownership and source lifecycle', () => {
  it('claims one live request once, preserves the typed RPC ID, and waits for source clearance', () => {
    const f = fixture();
    const approval = f.receive('wire-1');
    expect(approval).toMatchObject({
      kind: 'command',
      status: 'pending',
      actionable: true,
      sessionId: 'thread-1',
      turnId: 'turn-1',
    });
    expect(f.service.claim(approval.id, 'decline', 'command-1')).toEqual({
      rpcId: 'wire-1',
      response: { decision: 'decline' },
      threadId: 'thread-1',
      turnId: 'turn-1',
    });
    expect(f.latest()).toMatchObject({
      status: 'submitting',
      actionable: false,
      commandId: 'command-1',
    });
    expect(() => f.service.claim(approval.id, 'accept', 'command-2')).toThrow();
    expect(f.service.validateClaim(approval.id, 'command-1').rpcId).toBe(
      'wire-1',
    );
    expect(() => f.service.validateClaim(approval.id, 'command-2')).toThrow();
    expect(f.resolutions).toEqual([]);
    f.resolve('wire-1');
    expect(f.latest()).toMatchObject({ status: 'resolved', actionable: false });
    expect(f.latest().detail).toContain('underlying action outcome');
    expect(f.resolutions).toEqual([
      { approvalId: approval.id, commandId: 'command-1', reason: 'resolved' },
    ]);
    f.resolve('wire-1');
    expect(f.resolutions).toHaveLength(1);
    expect(f.codex.respond).not.toHaveBeenCalled();
    expect(f.codex.request).not.toHaveBeenCalled();
  });

  it('routes numeric and string request IDs separately and checks the thread scope', () => {
    const f = fixture();
    const numeric = f.receive(1);
    const string = f.receive('1');
    expect(numeric.id).not.toBe(string.id);
    f.resolve(1, 'another-thread');
    expect(f.resolutions).toHaveLength(0);
    f.resolve('1');
    expect(f.service.getSnapshot().map((value) => value.status)).toEqual([
      'pending',
      'resolved',
    ]);
    expect(f.service.claim(numeric.id, 'accept', 'one').rpcId).toBe(1);
  });

  it('never resurrects a cached request and uses different IDs after service restart', () => {
    const first = fixture();
    const cached = first.receive();
    const second = fixture([cached]);
    expect(second.latest()).toMatchObject({
      status: 'stale',
      actionable: false,
    });
    expect(() => second.service.claim(cached.id, 'accept', 'one')).toThrow();
    const fresh = second.receive();
    expect(fresh.id).not.toBe(cached.id);
    expect(fresh.actionable).toBe(true);
    second.resolve();
    expect(second.service.getSnapshot().map((value) => value.status)).toEqual([
      'stale',
      'resolved',
    ]);
  });

  it('waits for explicit ownership and an exact active turn when requests arrive first', () => {
    const f = fixture();
    f.controls.clear();
    const approval = f.receive();
    expect(approval).toMatchObject({ status: 'pending', actionable: false });
    expect(() => f.service.claim(approval.id, 'accept', 'one')).toThrow();
    f.control({ owned: false, connected: true, activeTurnId: 'turn-1' });
    expect(f.latest().actionable).toBe(false);
    f.control({ owned: true, connected: true, activeTurnId: null });
    expect(f.latest().status).toBe('pending');
    f.control({ owned: true, connected: true, activeTurnId: 'turn-1' });
    expect(f.latest().actionable).toBe(true);
  });

  it('does not let a request for another or terminal turn become actionable', () => {
    const f = fixture();
    f.receive(1, { turnId: 'older-turn' });
    expect(f.latest()).toMatchObject({ status: 'stale', actionable: false });
    f.control({ owned: true, connected: true, activeTurnId: 'older-turn' });
    expect(f.latest().status).toBe('stale');
    f.outcomes.set(JSON.stringify(['thread-1', 'older-turn']), 'completed');
    f.receive(2, { turnId: 'older-turn' });
    expect(f.latest().status).toBe('stale');
  });

  it('invalidates a claim when the turn ends during an asynchronous journal write', async () => {
    const f = fixture();
    const approval = f.receive();
    f.service.claim(approval.id, 'accept', 'one');
    await Promise.resolve();
    f.control({ owned: true, connected: true, activeTurnId: null });
    expect(() => f.service.validateClaim(approval.id, 'one')).toThrow();
    f.service.releaseBeforeWrite(approval.id, 'one');
    expect(f.latest()).toMatchObject({ status: 'stale', actionable: false });
    expect(f.resolutions).toEqual([
      { approvalId: approval.id, commandId: 'one', reason: 'stale' },
    ]);
  });

  it('revalidates directly before sending even if no sessions notification was emitted', () => {
    const f = fixture();
    const approval = f.receive();
    f.service.claim(approval.id, 'accept', 'one');
    f.controls.clear();
    expect(() => f.service.validateClaim(approval.id, 'one')).toThrow();
    f.service.releaseBeforeWrite(approval.id, 'one');
    expect(f.latest().status).toBe('stale');
  });

  it('releases only the matching claim after a guaranteed pre-write failure', () => {
    const f = fixture();
    const approval = f.receive();
    f.service.claim(approval.id, 'accept', 'one');
    f.service.releaseBeforeWrite(approval.id, 'other');
    expect(f.latest().status).toBe('submitting');
    f.service.releaseBeforeWrite(approval.id, 'one');
    expect(f.latest()).toMatchObject({
      status: 'pending',
      actionable: true,
      commandId: null,
    });
    expect(f.service.claim(approval.id, 'decline', 'two').response).toEqual({
      decision: 'decline',
    });
  });

  it('does not release uncertain writes or replay duplicates, but accepts late exact clearance', () => {
    const f = fixture();
    const approval = f.receive();
    f.service.claim(approval.id, 'accept', 'one');
    f.receive();
    expect(f.latest().status).toBe('submitting');
    f.service.markUncertain(approval.id, 'one');
    f.service.releaseBeforeWrite(approval.id, 'one');
    f.receive();
    expect(f.service.getSnapshot()).toHaveLength(1);
    expect(f.latest().status).toBe('stale');
    expect(() => f.service.claim(approval.id, 'decline', 'two')).toThrow();
    f.resolve();
    expect(f.latest().status).toBe('resolved');
    expect(f.resolutions.at(-1)).toEqual({
      approvalId: approval.id,
      commandId: 'one',
      reason: 'resolved',
    });
  });

  it('fails closed when a source reuses a request ID for conflicting data', () => {
    const f = fixture();
    const approval = f.receive();
    f.service.claim(approval.id, 'accept', 'one');
    f.receive(1, { command: 'different command' });
    expect(f.service.getSnapshot()).toHaveLength(1);
    expect(f.latest().status).toBe('stale');
    f.resolve();
    expect(f.latest().status).toBe('stale');
    expect(f.resolutions).toEqual([
      { approvalId: approval.id, commandId: 'one', reason: 'stale' },
    ]);
  });

  it('invalidates all live claims on disconnect and separates the next connection generation', () => {
    const f = fixture();
    const old = f.receive();
    f.service.claim(old.id, 'accept', 'one');
    f.codex.state$.next({ state: 'unavailable', detail: 'Disconnected' });
    expect(() => f.service.validateClaim(old.id, 'one')).toThrow();
    expect(f.latest().status).toBe('stale');
    f.codex.state$.next({ state: 'available', detail: 'New connection' });
    const next = f.receive();
    expect(next.id).not.toBe(old.id);
    f.resolve();
    expect(f.service.getSnapshot().map((value) => value.status)).toEqual([
      'stale',
      'resolved',
    ]);
  });

  it.each(['thread/closed', 'thread/archived'])(
    'invalidates unowned pending requests on %s too',
    (event) => {
      const f = fixture();
      f.controls.clear();
      f.receive();
      f.codex.events$.next({ method: event, params: { threadId: 'thread-1' } });
      expect(f.latest().status).toBe('stale');
    },
  );

  it('purges source summaries on deletion while preserving command uncertainty evidence', () => {
    const f = fixture();
    const approval = f.receive(1, { command: 'SENSITIVE-PROPOSAL' });
    f.service.claim(approval.id, 'accept', 'one');
    f.codex.events$.next({
      method: 'thread/deleted',
      params: { threadId: 'thread-1' },
    });
    expect(f.service.getSnapshot()).toEqual([]);
    expect(f.resolutions).toEqual([
      { approvalId: approval.id, commandId: 'one', reason: 'stale' },
    ]);
    f.receive(1, { command: 'SENSITIVE-PROPOSAL' });
    f.receive(2);
    f.resolve(1);
    expect(f.service.getSnapshot()).toEqual([]);
    expect(f.resolutions).toHaveLength(1);
  });

  it('bounds settled history without evicting pending claims or reviving evicted IDs', () => {
    const f = fixture();
    const pending = f.receive('pending');
    const submitting = f.receive('submitting');
    f.service.claim(submitting.id, 'accept', 'one');
    for (let index = 0; index < 110; index++) {
      f.receive(index);
      f.resolve(index);
    }
    expect(f.service.getSnapshot()).toHaveLength(102);
    expect(
      f.service.getSnapshot().find((value) => value.id === pending.id)
        ?.actionable,
    ).toBe(true);
    expect(f.service.validateClaim(submitting.id, 'one').rpcId).toBe(
      'submitting',
    );
    f.receive(0);
    expect(f.service.getSnapshot()).toHaveLength(102);
    expect(
      f.service.getSnapshot().filter((value) => value.status === 'pending'),
    ).toHaveLength(1);
  });

  it('retains minimal command clearance correlation after evicting an uncertain proposal', () => {
    const f = fixture();
    const approval = f.receive('uncertain');
    f.service.claim(approval.id, 'accept', 'one');
    f.service.markUncertain(approval.id, 'one');
    for (let index = 0; index < 101; index++) {
      f.receive(index);
      f.resolve(index);
    }
    expect(
      f.service.getSnapshot().some((value) => value.id === approval.id),
    ).toBe(false);
    f.resolve('uncertain', 'other-thread');
    expect(
      f.resolutions.filter((value) => value.commandId === 'one'),
    ).toHaveLength(1);
    f.resolve('uncertain');
    expect(f.resolutions.at(-1)).toEqual({
      approvalId: approval.id,
      commandId: 'one',
      reason: 'resolved',
    });
    const count = f.resolutions.length;
    f.resolve('uncertain');
    expect(f.resolutions).toHaveLength(count);
  });

  it('expires only matching terminal turn notifications before ownership is established', () => {
    const f = fixture();
    f.controls.clear();
    f.receive();
    f.codex.events$.next({
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: { id: 'another-turn', status: 'completed' },
      },
    });
    expect(f.latest().status).toBe('pending');
    f.codex.events$.next({
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: { id: 'turn-1', status: 'interrupted' },
      },
    });
    expect(f.latest().status).toBe('stale');
  });

  it('closes its observations without closing or writing to the shared adapter', () => {
    const f = fixture();
    const approval = f.receive();
    f.service.close();
    expect(() => f.service.claim(approval.id, 'accept', 'one')).toThrow();
    f.receive(2);
    expect(f.service.getSnapshot()).toHaveLength(1);
    expect(f.codex.close).not.toHaveBeenCalled();
    expect(f.codex.respond).not.toHaveBeenCalled();
  });
});

describe('supported approval forms', () => {
  it.each(['accept', 'decline'] as const)(
    'supports one-time %s for structured file changes',
    (decision) => {
      const f = fixture();
      const approval = f.receive('file', {}, 'item/fileChange/requestApproval');
      expect(approval.kind).toBe('fileChange');
      expect(f.service.claim(approval.id, decision, 'one').response).toEqual({
        decision,
      });
    },
  );

  it('keeps session write-root grants unsupported and displays the broader requested scope', () => {
    const f = fixture();
    const approval = f.receive(
      1,
      { grantRoot: '/extra-root' },
      'item/fileChange/requestApproval',
    );
    expect(approval).toMatchObject({
      status: 'unsupported',
      actionable: false,
    });
    expect(approval.summary).toContain('/extra-root');
    expect(approval.detail).toContain('Session-wide');
    expect(() => f.service.claim(approval.id, 'accept', 'one')).toThrow();
  });

  it('describes terminal input and network access distinctly', () => {
    const f = fixture();
    expect(f.receive(1, { kind: 'writeStdin' }).summary).toContain(
      'Terminal input',
    );
    expect(
      f.receive(2, {
        networkApprovalContext: { host: 'example.test', protocol: 'https' },
      }).summary,
    ).toContain('Network access: https example.test');
  });

  it.each([[], ['acceptForSession'], ['accept'], null, 'accept'])(
    'does not widen restricted decisions %j',
    (availableDecisions) => {
      const f = fixture();
      expect(f.receive(1, { availableDecisions })).toMatchObject({
        status: 'unsupported',
        actionable: false,
      });
    },
  );

  it('allows an explicit decision set containing both supported one-time choices', () => {
    const f = fixture();
    expect(
      f.receive(1, { availableDecisions: ['accept', 'decline', 'cancel'] })
        .actionable,
    ).toBe(true);
  });

  it('does not expose arbitrary private params or offer generic replies for unsupported requests', () => {
    const f = fixture();
    const approval = f.receive(
      1,
      { secret: 'PRIVATE-SECRET', reason: 'PRIVATE-REASON', turnId: 5 },
      'item/tool/requestUserInput',
    );
    expect(approval).toMatchObject({
      kind: 'unsupported',
      status: 'unsupported',
      actionable: false,
      turnId: null,
    });
    expect(JSON.stringify(approval)).not.toContain('PRIVATE');
    expect(approval.method).toBe('item/tool/requestUserInput');
    expect(() => f.service.claim(approval.id, 'accept', 'one')).toThrow();
  });

  it.each([
    { itemId: '' },
    { kind: 'unknown' },
    { reason: {} },
    { networkApprovalContext: { protocol: 'unknown', host: 'example.test' } },
  ])('rejects unsupported known forms %j', (changes) => {
    const f = fixture();
    expect(f.receive(1, changes).status).toBe('unsupported');
  });

  it('bounds displayed text', () => {
    const f = fixture();
    const approval = f.receive(1, {
      command: '🐈'.repeat(9000),
      reason: 'x'.repeat(10000),
    });
    expect(Buffer.byteLength(approval.summary)).toBeLessThanOrEqual(8192);
    expect(Buffer.byteLength(approval.reason!)).toBeLessThanOrEqual(8192);
    expect(approval.summary).toContain('[Truncated]');
  });
});
