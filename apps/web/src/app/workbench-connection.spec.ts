import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkbenchConnection } from './workbench-connection';

class FakeSocket {
  static instances: FakeSocket[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readonly sent: string[] = [];

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }
  close(): void {
    this.onclose?.();
  }
  send(message: string): void {
    this.sent.push(message);
  }
  receive(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) } as MessageEvent);
  }
}

describe('WorkbenchConnection', () => {
  beforeEach(() => {
    FakeSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeSocket);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('accepts a validated snapshot without sending a command', () => {
    const connection = new WorkbenchConnection();
    const socket = FakeSocket.instances[0]!;
    expect(connection.state()).toBe('connecting');

    socket.receive({
      type: 'snapshot',
      revision: 1,
      workspace: '/work',
      integration: { state: 'unavailable', detail: 'Codex was not found' },
    });

    expect(connection.state()).toBe('connected');
    expect(connection.snapshot()?.workspace).toBe('/work');
    expect(connection.snapshot()?.integration.state).toBe('unavailable');
    expect(socket.sent).toEqual([]);
    connection.ngOnDestroy();
  });

  it('marks the snapshot stale after disconnect and rejects malformed updates', () => {
    const connection = new WorkbenchConnection();
    const socket = FakeSocket.instances[0]!;
    socket.receive({
      type: 'snapshot',
      revision: 1,
      workspace: '/work',
      integration: { state: 'available', detail: 'Ready' },
    });
    socket.receive({
      type: 'snapshot',
      revision: 'bad',
      workspace: '/wrong',
      integration: { state: 'available', detail: 'Ready' },
    });
    expect(connection.problem()).toContain('cannot display');
    expect(connection.state()).toBe('unavailable');
    expect(connection.snapshot()?.workspace).toBe('/work');

    socket.close();
    expect(connection.state()).toBe('unavailable');
    expect(connection.snapshot()?.workspace).toBe('/work');

    connection.retry();
    const replacement = FakeSocket.instances[1]!;
    replacement.receive({
      type: 'snapshot',
      revision: 2,
      workspace: '/work',
      integration: { state: 'unavailable', detail: 'Codex disconnected' },
    });
    expect(connection.state()).toBe('connected');
    expect(connection.snapshot()?.integration.state).toBe('unavailable');
    expect(replacement.sent).toEqual([]);
    connection.ngOnDestroy();
  });

  it('inspects selection read-only and never resends a start after reconnect', () => {
    const connection = new WorkbenchConnection();
    const first = FakeSocket.instances[0]!;
    connection.inspect('session-1');
    expect(first.sent).toEqual([]);
    first.receive({
      type: 'snapshot',
      revision: 1,
      workspace: '/work',
      integration: { state: 'available', detail: 'Ready' },
      capabilities: { startSession: true },
    });
    expect(first.sent.map((message) => JSON.parse(message).type)).toEqual([
      'inspect',
    ]);
    first.receive({
      type: 'snapshot',
      revision: 2,
      workspace: '/work',
      integration: { state: 'available', detail: 'Ready' },
      capabilities: { startSession: true },
    });
    expect(first.sent).toHaveLength(1);
    connection.refresh();
    expect(first.sent.map((message) => JSON.parse(message).type)).toEqual([
      'inspect',
      'refresh',
      'inspect',
    ]);

    const requestId = connection.start('Investigate the failing test');
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/i);
    const start = JSON.parse(first.sent[3]!);
    expect(start.id).toBe(requestId);
    expect(start).toMatchObject({
      type: 'command',
      operation: 'start',
      prompt: 'Investigate the failing test',
    });
    expect(connection.localStarts()).toEqual([
      { id: start.id, phase: 'sending' },
    ]);

    first.close();
    expect(connection.localStarts()).toEqual([
      { id: start.id, phase: 'uncertain' },
    ]);
    connection.retry();
    const replacement = FakeSocket.instances[1]!;
    replacement.receive({
      type: 'snapshot',
      revision: 3,
      workspace: '/work',
      integration: { state: 'available', detail: 'Ready' },
      capabilities: { startSession: true },
    });
    expect(replacement.sent.map((message) => JSON.parse(message).type)).toEqual(
      ['inspect'],
    );
    expect(connection.localStarts()).toHaveLength(1);
    replacement.receive({
      type: 'snapshot',
      revision: 4,
      workspace: '/work',
      integration: { state: 'available', detail: 'Ready' },
      capabilities: { startSession: true },
      commands: [
        {
          id: start.id,
          operation: 'start',
          targetId: null,
          phase: 'uncertain',
          detail: 'Outcome not confirmed',
          createdAt: '2026-09-25T00:00:00Z',
          updatedAt: '2026-09-25T00:00:01Z',
          resultSessionId: null,
          turnId: null,
        },
      ],
    });
    expect(connection.localStarts()).toEqual([]);
    connection.ngOnDestroy();
  });

  it('retains a correlated start error when a later snapshot clears the banner', () => {
    const connection = new WorkbenchConnection();
    const socket = FakeSocket.instances[0]!;
    socket.receive({
      type: 'snapshot',
      revision: 1,
      workspace: '/work',
      integration: { state: 'available', detail: 'Ready' },
      capabilities: { startSession: true },
    });
    const requestId = connection.start('Inspect this workspace')!;
    socket.receive({
      type: 'error',
      commandId: requestId,
      disposition: 'rejected',
      message: 'Cannot save command intent. Nothing was sent.',
    });
    expect(connection.localStarts()).toEqual([
      {
        id: requestId,
        phase: 'rejected',
        detail: 'Cannot save command intent. Nothing was sent.',
      },
    ]);
    socket.receive({
      type: 'snapshot',
      revision: 2,
      workspace: '/work',
      integration: { state: 'available', detail: 'Ready' },
      capabilities: { startSession: true },
    });
    expect(connection.problem()).toBeNull();
    expect(connection.localStarts()[0]?.phase).toBe('rejected');
    expect(connection.start('Try another explicit request')).toBeTruthy();
    connection.ngOnDestroy();
  });
});
