import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatToolbarModule } from '@angular/material/toolbar';
import type { Approval, CommandRecord, Session } from '@thrallwright/contracts';
import { formatJsonDocument } from './json-format';
import { WorkbenchConnection } from './workbench-connection';

const selectionKey = 'thrallwright.selected-session';

@Component({
  selector: 'app-root',
  imports: [
    MatButtonModule,
    MatCardModule,
    MatFormFieldModule,
    MatInputModule,
    MatToolbarModule,
  ],
  templateUrl: './app.html',
  styleUrl: './app.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class App {
  protected readonly connection = inject(WorkbenchConnection);
  protected readonly snapshot = this.connection.snapshot;
  protected readonly backendState = this.connection.state;
  protected readonly problem = this.connection.problem;
  protected readonly prompt = signal('');
  protected readonly inputPrompt = signal('');
  protected readonly startError = signal<string | null>(null);
  protected readonly actionError = signal<string | null>(null);
  private readonly startedRequestId = signal<string | null>(null);
  private readonly preferredSessionId = signal(
    sessionStorage.getItem(selectionKey),
  );
  protected readonly selectedSessionId = computed(() => {
    const current = this.snapshot();
    const sessions = current?.sessions ?? [];
    const startedId = this.startedRequestId();
    const startedSessionId = current?.commands.find(
      (command) => command.id === startedId,
    )?.resultSessionId;
    if (
      startedSessionId &&
      sessions.some((session) => session.id === startedSessionId)
    )
      return startedSessionId;
    const preferred = this.preferredSessionId();
    return preferred && sessions.some((session) => session.id === preferred)
      ? preferred
      : (sessions[0]?.id ?? null);
  });
  protected readonly selectedSession = computed(
    () =>
      this.snapshot()?.sessions.find(
        (session) => session.id === this.selectedSessionId(),
      ) ?? null,
  );
  protected readonly integrationLabel = computed(() => {
    if (this.backendState() !== 'connected')
      return 'Unknown while disconnected';
    const state = this.snapshot()?.integration.state;
    switch (state) {
      case 'available':
        return 'Available';
      case 'unavailable':
        return 'Unavailable';
      case 'connecting':
        return 'Connecting';
      default:
        return 'Checking';
    }
  });
  protected readonly canStart = computed(
    () =>
      this.backendState() === 'connected' &&
      this.snapshot()?.integration.state === 'available' &&
      this.snapshot()?.capabilities.startSession === true &&
      this.snapshot()?.auth.state === 'ready' &&
      this.prompt().trim().length > 0 &&
      this.prompt().length <= 32000 &&
      !this.commandPending(),
  );
  protected readonly commandPending = computed(() =>
    this.connection
      .localCommands()
      .some((command) => command.phase === 'sending'),
  );
  protected readonly canResume = computed(
    () =>
      this.canControlSelected('resume') &&
      this.snapshot()?.auth.state === 'ready' &&
      !this.connection.hasInFlight('resume', this.selectedSessionId() ?? '') &&
      !this.commandPending(),
  );
  protected readonly canInput = computed(
    () =>
      this.canControlSelected('input') &&
      this.snapshot()?.auth.state === 'ready' &&
      this.inputPrompt().trim().length > 0 &&
      this.inputPrompt().length <= 32000 &&
      !this.connection.hasInFlight('input', this.selectedSessionId() ?? '') &&
      !this.connection.hasInFlight('resume', this.selectedSessionId() ?? '') &&
      !this.commandPending(),
  );
  protected readonly canInterrupt = computed(
    () =>
      this.canControlSelected('interrupt') &&
      this.selectedSession()?.activeTurnId !== null &&
      !this.connection.hasInFlight(
        'interrupt',
        this.selectedSessionId() ?? '',
      ) &&
      !this.commandPending(),
  );
  protected readonly workflowText = computed(() => {
    const workflow = this.snapshot()?.workflow;
    return workflow?.state === 'ready'
      ? workflow.document !== undefined
        ? formatJsonDocument(workflow.document)
        : JSON.stringify(workflow.value, null, 2)
      : null;
  });
  protected readonly visibleCommands = computed(() => {
    const commands = this.snapshot()?.commands ?? [];
    const unresolved = commands.filter((command) =>
      ['intent', 'dispatching', 'accepted', 'uncertain'].includes(
        command.phase,
      ),
    );
    const recent = commands
      .filter(
        (command) =>
          !['intent', 'dispatching', 'accepted', 'uncertain'].includes(
            command.phase,
          ),
      )
      .slice(0, 3);
    return [...unresolved, ...recent].sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt),
    );
  });

  constructor() {
    effect(() => {
      const id = this.selectedSessionId();
      untracked(() => {
        if (id) sessionStorage.setItem(selectionKey, id);
        this.connection.inspect(id);
      });
    });
  }

  protected selectSession(id: string): void {
    this.startedRequestId.set(null);
    if (id !== this.selectedSessionId()) this.inputPrompt.set('');
    this.actionError.set(null);
    this.preferredSessionId.set(id);
    sessionStorage.setItem(selectionKey, id);
  }

  protected updatePrompt(event: Event): void {
    this.prompt.set((event.target as HTMLTextAreaElement).value);
    this.startError.set(null);
  }

  protected updateInputPrompt(event: Event): void {
    this.inputPrompt.set((event.target as HTMLTextAreaElement).value);
    this.actionError.set(null);
  }

  protected start(event: Event): void {
    event.preventDefault();
    if (!this.canStart()) return;
    const requestId = this.connection.start(this.prompt());
    if (requestId) {
      this.startedRequestId.set(requestId);
      this.prompt.set('');
      this.startError.set(null);
    } else {
      this.startError.set(
        'Delivery could not be confirmed. Check Sessions before starting again.',
      );
    }
  }

  protected resume(): void {
    const session = this.selectedSession();
    if (!session || !this.canResume()) return;
    if (!this.connection.resume(session.id))
      this.actionError.set(
        'Resume could not be submitted. Refresh the session state.',
      );
  }

  protected sendInput(event: Event): void {
    event.preventDefault();
    const session = this.selectedSession();
    if (!session || !this.canInput()) return;
    if (this.connection.input(session.id, this.inputPrompt())) {
      this.inputPrompt.set('');
      this.actionError.set(null);
    } else {
      this.actionError.set(
        'Input could not be submitted. Refresh the session state.',
      );
    }
  }

  protected interrupt(): void {
    const session = this.selectedSession();
    if (!session?.activeTurnId || !this.canInterrupt()) return;
    if (!this.connection.interrupt(session.id, session.activeTurnId))
      this.actionError.set(
        'Interrupt could not be submitted. Refresh the session state.',
      );
  }

  protected canAnswer(approval: Approval): boolean {
    return (
      this.backendState() === 'connected' &&
      this.snapshot()?.integration.state === 'available' &&
      !this.commandPending() &&
      approval.actionable &&
      approval.status === 'pending' &&
      approval.sessionId !== null &&
      !this.connection.hasUnresolved(
        'approval',
        approval.sessionId,
        approval.id,
      ) &&
      (approval.kind === 'command' || approval.kind === 'fileChange')
    );
  }

  protected canInspectApproval(approval: Approval): boolean {
    return (
      approval.sessionId !== null &&
      (this.snapshot()?.sessions.some(
        (session) => session.id === approval.sessionId,
      ) ??
        false)
    );
  }

  protected answer(approval: Approval, decision: 'accept' | 'decline'): void {
    if (!this.canAnswer(approval)) return;
    if (!this.connection.answerApproval(approval, decision))
      this.actionError.set(
        'Approval response could not be submitted. Refresh the request.',
      );
  }

  private canControlSelected(
    capability: keyof NonNullable<Session['capabilities']>,
  ): boolean {
    return (
      this.backendState() === 'connected' &&
      this.selectedSession()?.capabilities?.[capability] === true
    );
  }

  protected statusLabel(session: Session): string {
    if (this.backendState() !== 'connected')
      return `Last reported: ${session.status}`;
    if (session.freshness !== 'live' && session.status === 'running')
      return 'Status unknown';
    return session.status;
  }

  protected commandLabel(command: CommandRecord): string {
    if (command.phase === 'uncertain') return 'Outcome unknown';
    if (
      this.backendState() !== 'connected' &&
      (command.phase === 'intent' || command.phase === 'dispatching')
    )
      return 'Outcome unknown after disconnection';
    switch (command.phase) {
      case 'intent':
        return `${this.operationLabel(command.operation)} requested`;
      case 'dispatching':
        return `${this.operationLabel(command.operation)} in progress`;
      case 'accepted':
        return command.operation === 'approval'
          ? 'Response written; awaiting confirmation'
          : `${this.operationLabel(command.operation)} accepted by Codex`;
      case 'completed':
        return command.operation === 'approval'
          ? 'Approval request cleared'
          : command.operation === 'interrupt'
            ? 'Target turn finished'
            : `${this.operationLabel(command.operation)} outcome confirmed`;
      case 'rejected':
        return `${this.operationLabel(command.operation)} failed`;
    }
  }

  protected operationLabel(operation: CommandRecord['operation']): string {
    switch (operation) {
      case 'start':
        return 'Start';
      case 'resume':
        return 'Resume';
      case 'input':
        return 'Send input';
      case 'interrupt':
        return 'Interrupt';
      case 'approval':
        return 'Approval response';
    }
  }
}
