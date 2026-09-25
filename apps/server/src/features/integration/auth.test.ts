import { describe, expect, it, vi } from 'vitest';
import { BehaviorSubject, Subject } from 'rxjs';
import type { Integration } from '@thrallwright/contracts';
import type {
  CodexAdapter,
  HarnessEvent,
  HarnessRequest,
} from '../../integrations/codex.js';
import { createAuthService } from './auth.js';

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
    state: 'connecting',
    detail: 'Connecting.',
  });
  events$ = new Subject<HarnessEvent>();
  requests$ = new Subject<HarnessRequest>();
  calls: Array<{ method: string; params: unknown }> = [];
  reply: () => Promise<unknown> | unknown = () => ({
    account: null,
    requiresOpenaiAuth: true,
  });
  async start() {}
  request(method: string, params: unknown = {}) {
    this.calls.push({ method, params });
    return Promise.resolve().then(() => this.reply());
  }
  respond() {}
  async close() {}
  connect() {
    this.state$.next({ state: 'available', detail: 'Connected.' });
  }
  disconnect() {
    this.state$.next({ state: 'unavailable', detail: 'Disconnected.' });
  }
}

describe('Codex authentication status', () => {
  it('reads status only after connection, without exposing account details', async () => {
    const codex = new FakeCodex();
    codex.reply = () => ({
      account: { email: 'private@example.test', accessToken: 'secret' },
      requiresOpenaiAuth: true,
    });
    const auth = createAuthService({ codex });
    expect(auth.getSnapshot().state).toBe('checking');
    expect(codex.calls).toEqual([]);
    codex.connect();
    await vi.waitFor(() => expect(auth.getSnapshot().state).toBe('ready'));
    expect(codex.calls).toEqual([
      { method: 'account/read', params: { refreshToken: false } },
    ]);
    expect(JSON.stringify(auth.getSnapshot())).not.toContain(
      'private@example.test',
    );
    expect(JSON.stringify(auth.getSnapshot())).not.toContain('secret');
    auth.close();
  });

  it('allows a provider that does not require OpenAI auth without an account', async () => {
    const codex = new FakeCodex();
    codex.reply = () => ({ account: null, requiresOpenaiAuth: false });
    const auth = createAuthService({ codex });
    codex.connect();
    await vi.waitFor(() => expect(auth.getSnapshot().state).toBe('ready'));
    auth.close();
  });

  it('reports a required login without initiating an auth mutation', async () => {
    const codex = new FakeCodex();
    const auth = createAuthService({ codex });
    codex.connect();
    await vi.waitFor(() => expect(auth.getSnapshot().state).toBe('required'));
    expect(auth.getSnapshot().detail).toContain('codex login');
    expect(codex.calls.map((call) => call.method)).toEqual(['account/read']);
    auth.close();
  });

  it.each([
    ['missing requirement flag', { account: null }],
    ['wrong requirement type', { account: null, requiresOpenaiAuth: 'yes' }],
    ['invalid account shape', { account: 'private', requiresOpenaiAuth: true }],
  ])(
    'treats %s as unavailable instead of guessing provider policy',
    async (_name, result) => {
      const codex = new FakeCodex();
      codex.reply = () => result;
      const auth = createAuthService({ codex });
      codex.connect();
      await vi.waitFor(() =>
        expect(auth.getSnapshot().state).toBe('unavailable'),
      );
      auth.close();
    },
  );

  it('reports read failures without leaking the error text', async () => {
    const codex = new FakeCodex();
    codex.reply = () => {
      throw new Error('private authentication detail');
    };
    const auth = createAuthService({ codex });
    codex.connect();
    await vi.waitFor(() =>
      expect(auth.getSnapshot().state).toBe('unavailable'),
    );
    expect(auth.getSnapshot().detail).not.toContain(
      'private authentication detail',
    );
    auth.close();
  });

  it('invalidates immediately on disconnect and ignores an old response after reconnect', async () => {
    const codex = new FakeCodex();
    const first = deferred<unknown>();
    let reads = 0;
    codex.reply = () =>
      ++reads === 1
        ? first.promise
        : { account: null, requiresOpenaiAuth: false };
    const auth = createAuthService({ codex });
    codex.connect();
    await vi.waitFor(() => expect(codex.calls).toHaveLength(1));
    codex.disconnect();
    expect(auth.getSnapshot().state).toBe('unavailable');
    first.resolve({ account: null, requiresOpenaiAuth: true });
    await first.promise;
    expect(auth.getSnapshot().state).toBe('unavailable');
    codex.connect();
    await vi.waitFor(() => expect(auth.getSnapshot().state).toBe('ready'));
    expect(codex.calls).toHaveLength(2);
    auth.close();
  });

  it.each(['account/updated', 'account/login/completed'])(
    'refreshes on %s and lets the newest read win',
    async (method) => {
      const codex = new FakeCodex();
      const first = deferred<unknown>();
      const second = deferred<unknown>();
      let reads = 0;
      codex.reply = () => (++reads === 1 ? first.promise : second.promise);
      const auth = createAuthService({ codex });
      codex.connect();
      await vi.waitFor(() => expect(reads).toBe(1));
      codex.events$.next({ method, params: {} });
      await vi.waitFor(() => expect(reads).toBe(2));
      second.resolve({ account: null, requiresOpenaiAuth: false });
      await vi.waitFor(() => expect(auth.getSnapshot().state).toBe('ready'));
      first.resolve({ account: null, requiresOpenaiAuth: true });
      await first.promise;
      expect(auth.getSnapshot().state).toBe('ready');
      auth.close();
    },
  );

  it('supports explicit refresh and ignores events after close', async () => {
    const codex = new FakeCodex();
    const auth = createAuthService({ codex });
    await auth.refresh();
    expect(codex.calls).toEqual([]);
    codex.connect();
    await vi.waitFor(() => expect(auth.getSnapshot().state).toBe('required'));
    codex.reply = () => ({ account: null, requiresOpenaiAuth: false });
    await auth.refresh();
    expect(auth.getSnapshot().state).toBe('ready');
    auth.close();
    codex.events$.next({ method: 'account/updated', params: {} });
    codex.disconnect();
    expect(codex.calls).toHaveLength(2);
    expect(auth.getSnapshot().state).toBe('ready');
  });
});
