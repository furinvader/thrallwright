import { Injectable, OnDestroy, signal } from '@angular/core';
import {
  serverMessageSchema,
  type SnapshotMessage,
} from '@thrallwright/contracts';

export type BackendState = 'connecting' | 'connected' | 'unavailable';

@Injectable({ providedIn: 'root' })
export class WorkbenchConnection implements OnDestroy {
  readonly state = signal<BackendState>('connecting');
  readonly snapshot = signal<SnapshotMessage | null>(null);
  readonly problem = signal<string | null>(null);

  private socket: WebSocket | null = null;
  private reconnectTimer: number | null = null;
  private destroyed = false;

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
        this.snapshot.set(parsed.data);
        this.state.set('connected');
        this.problem.set(null);
      } else if (parsed.data.type === 'error') {
        this.problem.set(parsed.data.message);
      }
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      if (this.destroyed) return;
      this.state.set('unavailable');
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
