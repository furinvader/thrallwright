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
});
