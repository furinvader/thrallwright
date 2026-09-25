import { afterEach, describe, expect, it } from 'vitest';
import { BehaviorSubject, Subject } from 'rxjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Integration } from '@thrallwright/contracts';
import { createApplication } from './app.js';
import { storagePaths } from './storage/paths.js';
import type {
  CodexAdapter,
  HarnessEvent,
  HarnessRequest,
} from './integrations/codex.js';
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups.length = 0;
});
class FakeCodex implements CodexAdapter {
  state$ = new BehaviorSubject<Integration>({
    state: 'available',
    detail: 'Fixture integration.',
  });
  events$ = new Subject<HarnessEvent>();
  requests$ = new Subject<HarnessRequest>();
  starts = 0;
  writes = 0;
  closed = false;
  async start() {
    this.starts++;
  }
  async request(method: string) {
    if (method === 'account/read')
      return { account: null, requiresOpenaiAuth: false };
    if (['thread/list', 'thread/loaded/list'].includes(method))
      return { data: [], nextCursor: null };
    this.writes++;
    return {};
  }
  respond() {
    this.writes++;
  }
  async close() {
    this.closed = true;
  }
}
async function fixture(codex = new FakeCodex()) {
  const directory = await mkdtemp(join(tmpdir(), 'thrallwright-app-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const app = await createApplication({
    workspace: directory,
    paths: storagePaths(directory),
    codex,
  });
  cleanups.push(() => app.close());
  await app.ready();
  return { app, codex };
}
describe('local service boundary', () => {
  it('publishes a delayed startup failure to connected browsers', async () => {
    let rejectStart!: (error: Error) => void;
    const startup = new Promise<void>((_resolve, reject) => {
      rejectStart = reject;
    });
    class FailingCodex extends FakeCodex {
      override start() {
        return startup;
      }
    }
    const codex = new FailingCodex();
    codex.state$.next({ state: 'connecting', detail: 'Connecting.' });
    const { app } = await fixture(codex);
    const client = await app.injectWS('/ws', {
      headers: { host: 'localhost' },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const update = new Promise<string>((resolve) =>
      client.once('message', (data) => resolve(data.toString())),
    );
    rejectStart(new Error('Fixture startup failure.'));
    expect(JSON.parse(await update).integration.state).toBe('unavailable');
    client.terminate();
  });
  it('rejects remote origins and rebinding hosts', async () => {
    const { app } = await fixture();
    expect(
      (
        await app.inject({
          url: '/api/health',
          headers: { host: 'evil.example' },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          url: '/api/health',
          headers: { host: 'localhost', origin: 'https://evil.example' },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await app.inject({ url: '/api/health', headers: { host: 'localhost' } }))
        .statusCode,
    ).toBe(200);
  });
  it('serves snapshots and rejects malformed messages without harness writes', async () => {
    const { app, codex } = await fixture();
    const messages: string[] = [];
    const client = await app.injectWS(
      '/ws',
      { headers: { host: 'localhost' } },
      {
        onInit: (socket) =>
          socket.on('message', (data) => messages.push(data.toString())),
      },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(JSON.parse(messages[0] ?? '{}').type).toBe('snapshot');
    client.send('{broken');
    await new Promise<void>((resolve) =>
      client.once('message', () => resolve()),
    );
    expect(JSON.parse(messages.at(-1) ?? '{}').type).toBe('error');
    client.send(JSON.stringify({ type: 'refresh' }));
    await new Promise<void>((resolve) =>
      client.once('message', () => resolve()),
    );
    expect(codex.starts).toBe(1);
    expect(codex.writes).toBe(0);
    client.terminate();
  });
});
