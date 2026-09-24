import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Integration } from '@thrallwright/contracts';
import { CodexProcess, type HarnessRequest } from './codex.js';

interface WireMessage {
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
}

class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  sent: WireMessage[] = [];
  exitOnEof = true;
  exitOnKill = true;
  kill = vi.fn((signal?: NodeJS.Signals | number) => {
    if (this.exitOnKill)
      this.exit(null, typeof signal === 'string' ? signal : 'SIGTERM');
    return true;
  });

  constructor() {
    super();
    this.stdin.on('data', (chunk: Buffer) =>
      this.sent.push(JSON.parse(chunk.toString()) as WireMessage),
    );
    this.stdin.on('finish', () => {
      if (this.exitOnEof) this.exit(0, null);
    });
  }

  exit(code: number | null, signal: NodeJS.Signals | null) {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('exit', code, signal);
  }

  send(value: unknown) {
    this.stdout.write(`${JSON.stringify(value)}\n`);
  }
}

const cleanups: CodexProcess[] = [];
afterEach(async () => {
  for (const client of cleanups.splice(0)) {
    const closing = client.close();
    if (vi.isFakeTimers()) await vi.runAllTimersAsync();
    await closing;
  }
  vi.useRealTimers();
});

function fixture() {
  const child = new FakeChild();
  const createProcess = vi.fn(() => child);
  const client = new CodexProcess('fixture-codex', '/workspace/example', {
    createProcess,
    requestTimeoutMs: 100,
    shutdownGraceMs: 50,
    maxLineBytes: 1024,
  });
  const states: Integration[] = [];
  client.state$.subscribe((state) => states.push(state));
  cleanups.push(client);
  return { child, client, states, createProcess };
}

async function ready() {
  const value = fixture();
  const startup = value.client.start();
  value.child.send({
    id: value.child.sent[0]?.id,
    result: { platformOs: 'linux' },
  });
  await startup;
  return value;
}

describe('Codex process ownership and protocol', () => {
  it('initializes once and accepts public requests only after the handshake', async () => {
    const { client, child, states, createProcess } = fixture();
    const startup = client.start();
    expect(client.start()).toBe(startup);
    await expect(client.request('thread/list')).rejects.toThrow('unavailable');
    expect(child.sent).toEqual([
      {
        id: 1,
        method: 'initialize',
        params: {
          clientInfo: {
            name: 'thrallwright',
            title: 'Thrallwright',
            version: '0.1.0',
          },
          capabilities: null,
        },
      },
    ]);
    child.send({ id: 1, result: { platformOs: 'linux' } });
    await startup;
    expect(child.sent[1]).toEqual({ method: 'initialized', params: {} });
    expect(states.at(-1)?.state).toBe('available');
    expect(createProcess).toHaveBeenCalledTimes(1);
  });

  it('routes server requests before matching client response ids and handles split frames', async () => {
    const { client, child } = await ready();
    const requests: HarnessRequest[] = [];
    client.requests$.subscribe((request) => requests.push(request));
    const pending = client.request('thread/read', {
      threadId: 'thread-example',
    });
    const id = child.sent.at(-1)?.id;
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    child.send({
      id,
      method: 'item/fileChange/requestApproval',
      params: { threadId: 'thread-example' },
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(requests).toHaveLength(1);
    client.respond(requests[0]!.id, { decision: 'decline' });
    expect(child.sent.at(-1)).toEqual({ id, result: { decision: 'decline' } });
    const response = JSON.stringify({
      id,
      result: { thread: { id: 'thread-example' } },
    });
    child.stdout.write(response.slice(0, 10));
    child.stdout.write(`${response.slice(10)}\n`);
    await expect(pending).resolves.toEqual({
      thread: { id: 'thread-example' },
    });
  });

  it('invalid protocol fails pending work, suppresses late events, and forbids subsequent writes', async () => {
    const { client, child, states } = await ready();
    const onEvent = vi.fn();
    client.events$.subscribe(onEvent);
    const pending = client.request('thread/read');
    const rejected = expect(pending).rejects.toThrow('invalid protocol');
    child.stdout.write('{broken\n');
    await rejected;
    const sentCount = child.sent.length;
    await expect(client.request('turn/start')).rejects.toThrow('unavailable');
    expect(() => client.respond('expired', { decision: 'accept' })).toThrow(
      'unavailable',
    );
    child.send({ method: 'turn/started', params: {} });
    expect(onEvent).not.toHaveBeenCalled();
    expect(child.sent).toHaveLength(sentCount);
    expect(states.at(-1)?.state).toBe('unavailable');
    await client.close();
    expect(child.stdin.writableEnded).toBe(true);
  });

  it.each(['', '\n'])(
    'bounds oversized protocol frames, including unterminated input (%j)',
    async (ending) => {
      const { client, child, states } = await ready();
      child.stdout.write(`${'x'.repeat(1025)}${ending}`);
      expect(states.at(-1)?.state).toBe('unavailable');
      expect(states.at(-1)?.detail).toContain('size');
      await expect(client.request('thread/list')).rejects.toThrow(
        'unavailable',
      );
      await client.close();
    },
  );

  it('rejects pending requests and closes promptly after an already-observed signal exit', async () => {
    const { client, child } = await ready();
    const pending = client.request('thread/list');
    const rejected = expect(pending).rejects.toThrow('closed');
    child.exit(null, 'SIGTERM');
    await rejected;
    await client.close();
    expect(child.exitCode).toBeNull();
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('uses stdin EOF for normal shutdown and rejects outstanding work', async () => {
    const { client, child } = await ready();
    const pending = client.request('thread/list');
    const rejected = expect(pending).rejects.toThrow('closed');
    const closing = client.close();
    expect(client.close()).toBe(closing);
    await rejected;
    await closing;
    expect(child.stdin.writableEnded).toBe(true);
    expect(child.exitCode).toBe(0);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('bounds shutdown when EOF and both termination signals produce no exit event', async () => {
    vi.useFakeTimers();
    const { client, child } = await ready();
    child.exitOnEof = false;
    child.exitOnKill = false;
    const closing = client.close();
    await vi.advanceTimersByTimeAsync(150);
    await closing;
    expect(child.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']]);
    expect(child.stdin.destroyed).toBe(true);
    expect(child.stdout.destroyed).toBe(true);
  });

  it('invalidates and closes an app-server that never completes initialization', async () => {
    vi.useFakeTimers();
    const { client, child, states } = fixture();
    const startup = client.start();
    await vi.advanceTimersByTimeAsync(100);
    await startup;
    expect(states.at(-1)?.state).toBe('unavailable');
    await expect(client.request('thread/list')).rejects.toThrow('unavailable');
    expect(child.stdin.writableEnded).toBe(true);
  });
});
