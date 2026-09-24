import { Injectable, OnDestroy, signal } from '@angular/core';
import {
  clientMessageSchema,
  serverMessageSchema,
  startCommandSchema,
  type SnapshotMessage,
} from '@thrallwright/contracts';

export type BackendState = 'connecting' | 'connected' | 'unavailable';
export type LocalStart = {
  id: string;
  phase: 'sending' | 'uncertain' | 'rejected';
  detail?: string;
};

@Injectable({ providedIn: 'root' })
export class WorkbenchConnection implements OnDestroy {
  readonly state = signal<BackendState>('connecting');
  readonly snapshot = signal<SnapshotMessage | null>(null);
  readonly problem = signal<string | null>(null);
  readonly localStarts = signal<LocalStart[]>([]);

  private socket: WebSocket | null = null;
  private reconnectTimer: number | null = null;
  private destroyed = false;
  private selectedSessionId: string | null = null;
  private inspectedOnSocket: string | null = null;

  constructor() {
    this.connect();
  }

  retry(): void {
    if (this.socket) return;
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.connect();
  }

  inspect(sessionId: string | null): void {
    this.selectedSessionId = sessionId;
    if (!sessionId || !this.socket || this.state() !== 'connected') return;
    if (this.inspectedOnSocket === sessionId) return;
    const command = clientMessageSchema.safeParse({
      type: 'inspect',
      sessionId,
    });
    if (!command.success) return;
    this.socket.send(JSON.stringify(command.data));
    this.inspectedOnSocket = sessionId;
  }

  refresh(): void {
    if (!this.socket || this.state() !== 'connected') return;
    this.socket.send(JSON.stringify({ type: 'refresh' }));
    this.inspectedOnSocket = null;
    this.inspect(this.selectedSessionId);
  }

  start(prompt: string): string | null {
    if (!this.socket || this.state() !== 'connected') return null;
    if (!this.snapshot()?.capabilities.startSession) return null;
    if (this.localStarts().some((start) => start.phase === 'sending'))
      return null;
    const command = startCommandSchema.safeParse({
      type: 'command',
      id: crypto.randomUUID(),
      operation: 'start',
      prompt,
    });
    if (!command.success) return null;
    this.localStarts.update((starts) => [
      ...starts,
      { id: command.data.id, phase: 'sending' },
    ]);
    try {
      this.socket.send(JSON.stringify(command.data));
      return command.data.id;
    } catch {
      this.localStarts.update((starts) =>
        starts.map((start) =>
          start.id === command.data.id
            ? { ...start, phase: 'uncertain' }
            : start,
        ),
      );
      return command.data.id;
    }
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
    this.socket?.close();
    this.socket = null;
  }

  private connect(): void {
    if (this.destroyed || this.socket) return;
    this.state.set('connecting');
    this.problem.set(null);
    const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(`${scheme}//${window.location.host}/ws`);
    this.socket = socket;

    // A transport connection alone does not prove the backend has supplied fresh state.
    socket.onmessage = (event: MessageEvent) => {
      let decoded: unknown;
      try {
        decoded = JSON.parse(String(event.data));
      } catch {
        this.problem.set('The local service sent an unreadable update.');
        socket.close();
        return;
      }
      const parsed = serverMessageSchema.safeParse(decoded);
      if (!parsed.success) {
        this.problem.set(
          'The local service sent an update this app cannot display.',
        );
        socket.close();
        return;
      }
      if (parsed.data.type === 'snapshot') {
        const current = parsed.data;
        this.snapshot.set(current);
        this.state.set('connected');
        this.problem.set(null);
        this.localStarts.update((starts) =>
          starts.filter(
            (start) =>
              !current.commands.some((command) => command.id === start.id),
          ),
        );
        this.inspect(this.selectedSessionId);
      } else if (parsed.data.type === 'error') {
        this.problem.set(parsed.data.message);
        if (parsed.data.commandId) {
          const { commandId, disposition, message } = parsed.data;
          this.localStarts.update((starts) =>
            starts.map((start) =>
              start.id === commandId
                ? {
                    ...start,
                    phase: disposition ?? 'uncertain',
                    detail: message,
                  }
                : start,
            ),
          );
        }
      }
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.inspectedOnSocket = null;
      if (this.destroyed) return;
      this.state.set('unavailable');
      this.localStarts.update((starts) =>
        starts.map((start) =>
          start.phase === 'sending' ? { ...start, phase: 'uncertain' } : start,
        ),
      );
      this.problem.set(
        this.problem() ?? 'The local service is unavailable. Reconnecting…',
      );
      this.reconnectTimer = window.setTimeout(() => {
        this.reconnectTimer = null;
        this.connect();
      }, 2000);
    };
    socket.onerror = () => socket.close();
  }
}
