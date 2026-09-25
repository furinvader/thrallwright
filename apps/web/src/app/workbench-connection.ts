import { Injectable, OnDestroy, signal } from '@angular/core';
import {
  clientMessageSchema,
  executionCommandSchema,
  serverMessageSchema,
  type Approval,
  type ExecutionCommand,
  type Session,
  type SnapshotMessage,
} from '@thrallwright/contracts';

export type BackendState = 'connecting' | 'connected' | 'unavailable';
export type LocalCommand = {
  id: string;
  operation: ExecutionCommand['operation'];
  targetId?: string;
  approvalId?: string;
  turnId?: string;
  phase: 'sending' | 'uncertain' | 'rejected';
  detail?: string;
};

@Injectable({ providedIn: 'root' })
export class WorkbenchConnection implements OnDestroy {
  readonly state = signal<BackendState>('connecting');
  readonly snapshot = signal<SnapshotMessage | null>(null);
  readonly problem = signal<string | null>(null);
  readonly localCommands = signal<LocalCommand[]>([]);

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
    if (
      this.snapshot()?.integration.state !== 'available' ||
      !this.snapshot()?.capabilities.startSession ||
      !this.authReady()
    )
      return null;
    return this.submit({
      type: 'command',
      id: crypto.randomUUID(),
      operation: 'start',
      prompt,
    });
  }

  resume(sessionId: string): string | null {
    if (!this.authReady() || !this.sessionCan(sessionId, 'resume')) return null;
    return this.submit({
      type: 'command',
      id: crypto.randomUUID(),
      operation: 'resume',
      targetId: sessionId,
    });
  }

  input(sessionId: string, prompt: string): string | null {
    if (!this.authReady() || !this.sessionCan(sessionId, 'input')) return null;
    return this.submit({
      type: 'command',
      id: crypto.randomUUID(),
      operation: 'input',
      targetId: sessionId,
      prompt,
    });
  }

  interrupt(sessionId: string, turnId: string): string | null {
    if (!this.sessionCan(sessionId, 'interrupt')) return null;
    if (
      this.snapshot()?.sessions.find((session) => session.id === sessionId)
        ?.activeTurnId !== turnId
    )
      return null;
    return this.submit({
      type: 'command',
      id: crypto.randomUUID(),
      operation: 'interrupt',
      targetId: sessionId,
      turnId,
    });
  }

  answerApproval(
    approval: Approval,
    decision: 'accept' | 'decline',
  ): string | null {
    if (
      this.snapshot()?.integration.state !== 'available' ||
      !approval.actionable ||
      approval.status !== 'pending' ||
      !['command', 'fileChange'].includes(approval.kind) ||
      !approval.sessionId ||
      this.hasUnresolved('approval', approval.sessionId, approval.id) ||
      !this.snapshot()?.approvals.some(
        (current) =>
          current.id === approval.id &&
          current.actionable &&
          current.status === 'pending' &&
          current.kind === approval.kind &&
          current.sessionId === approval.sessionId,
      )
    )
      return null;
    return this.submit({
      type: 'command',
      id: crypto.randomUUID(),
      operation: 'approval',
      targetId: approval.sessionId,
      approvalId: approval.id,
      decision,
    });
  }

  private authReady(): boolean {
    return this.snapshot()?.auth.state === 'ready';
  }

  hasUnresolved(
    operation: ExecutionCommand['operation'],
    targetId: string,
    approvalId?: string,
    includeUncertain = true,
  ): boolean {
    const matches = (item: {
      operation: ExecutionCommand['operation'];
      targetId?: string | null;
      approvalId?: string | null;
    }) =>
      item.operation === operation &&
      item.targetId === targetId &&
      (approvalId === undefined || item.approvalId === approvalId);
    return (
      this.localCommands().some(
        (item) =>
          matches(item) &&
          (item.phase === 'sending' ||
            (includeUncertain && item.phase === 'uncertain')),
      ) ||
      (this.snapshot()?.commands.some(
        (item) =>
          matches(item) &&
          (['intent', 'dispatching', 'accepted'].includes(item.phase) ||
            (includeUncertain && item.phase === 'uncertain')),
      ) ??
        false)
    );
  }

  hasInFlight(
    operation: ExecutionCommand['operation'],
    targetId: string,
  ): boolean {
    return this.hasUnresolved(operation, targetId, undefined, false);
  }

  private sessionCan(
    sessionId: string,
    capability: keyof NonNullable<Session['capabilities']>,
  ): boolean {
    return (
      this.snapshot()?.integration.state === 'available' &&
      this.snapshot()?.sessions.find((session) => session.id === sessionId)
        ?.capabilities?.[capability] === true
    );
  }

  private submit(raw: ExecutionCommand): string | null {
    if (!this.socket || this.state() !== 'connected') return null;
    if (this.localCommands().some((item) => item.phase === 'sending'))
      return null;
    const command = executionCommandSchema.safeParse(raw);
    if (!command.success) return null;
    this.localCommands.update((commands) => [
      ...commands,
      {
        id: command.data.id,
        operation: command.data.operation,
        ...(command.data.operation !== 'start'
          ? { targetId: command.data.targetId }
          : {}),
        ...(command.data.operation === 'approval'
          ? { approvalId: command.data.approvalId }
          : {}),
        ...(command.data.operation === 'interrupt'
          ? { turnId: command.data.turnId }
          : {}),
        phase: 'sending',
      },
    ]);
    try {
      this.socket.send(JSON.stringify(command.data));
      return command.data.id;
    } catch {
      this.localCommands.update((commands) =>
        commands.map((item) =>
          item.id === command.data.id ? { ...item, phase: 'uncertain' } : item,
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
        this.localCommands.update((commands) =>
          commands.filter(
            (item) =>
              !current.commands.some((command) => command.id === item.id),
          ),
        );
        this.inspect(this.selectedSessionId);
      } else if (parsed.data.type === 'error') {
        this.problem.set(parsed.data.message);
        if (parsed.data.commandId) {
          const { commandId, disposition, message } = parsed.data;
          this.localCommands.update((commands) =>
            commands.map((item) =>
              item.id === commandId
                ? {
                    ...item,
                    phase: disposition ?? 'uncertain',
                    detail: message,
                  }
                : item,
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
      this.localCommands.update((commands) =>
        commands.map((item) =>
          item.phase === 'sending' ? { ...item, phase: 'uncertain' } : item,
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
