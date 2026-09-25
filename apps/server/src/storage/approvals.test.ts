import { afterEach, describe, expect, it } from 'vitest';
import { BehaviorSubject, Subject } from 'rxjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Approval, Integration } from '@thrallwright/contracts';
import type {
  CodexAdapter,
  HarnessEvent,
  HarnessRequest,
} from '../integrations/codex.js';
import { createApprovalService } from '../features/approvals/approvals.js';
import { openDatabase } from './database.js';
import { approvalStore } from './approvals.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function approval(): Approval {
  return {
    id: 'saved-request',
    sessionId: 'thread-1',
    turnId: 'turn-1',
    itemId: 'item-1',
    kind: 'command',
    method: 'item/commandExecution/requestApproval',
    summary: 'Run command',
    reason: null,
    status: 'pending',
    actionable: true,
    observedAt: '2026-09-25T00:00:00Z',
    detail: 'Waiting for user.',
    commandId: null,
  };
}

class FakeCodex implements CodexAdapter {
  state$ = new BehaviorSubject<Integration>({
    state: 'available',
    detail: 'Connected.',
  });
  events$ = new Subject<HarnessEvent>();
  requests$ = new Subject<HarnessRequest>();
  responses = 0;
  async start() {}
  async request() {
    return {};
  }
  respond() {
    this.responses++;
  }
  async close() {}
}

describe('approval cache after restart', () => {
  it('keeps a saved pending request visible but never restores its response authority', async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'thrallwright-approval-cache-'),
    );
    const filename = join(directory, 'application.sqlite');
    let db = await openDatabase(filename);
    cleanups.push(async () => {
      await db.destroy();
      await rm(directory, { recursive: true, force: true });
    });
    const workspace = '/project';
    await db
      .insertInto('workspaces')
      .values({ path: workspace, last_opened_at: '2026-09-25T00:00:00Z' })
      .execute();
    await approvalStore(db, workspace).save([approval()]);
    await db.destroy();
    db = await openDatabase(filename);

    const cached = await approvalStore(db, workspace).load();
    expect(cached).toMatchObject([
      { id: 'saved-request', status: 'pending', actionable: false },
    ]);
    const codex = new FakeCodex();
    const sessions = {
      state$: new BehaviorSubject({ sessions: [] }),
      getControlState: () => ({
        owned: true,
        connected: true,
        activeTurnId: 'turn-1',
      }),
      getTurnOutcome: () => undefined,
    };
    const service = createApprovalService({
      codex,
      sessions,
      initialApprovals: cached,
    });
    expect(service.getSnapshot()).toMatchObject([
      { id: 'saved-request', status: 'stale', actionable: false },
    ]);
    expect(() => service.claim('saved-request', 'accept', 'command-1')).toThrow(
      'not available',
    );
    expect(codex.responses).toBe(0);
    service.close();
  });
});
