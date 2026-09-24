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
import type { CommandRecord, Session } from '@thrallwright/contracts';
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
  protected readonly startError = signal<string | null>(null);
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
      this.prompt().trim().length > 0 &&
      this.prompt().length <= 32000 &&
      !this.connection.localStarts().some((start) => start.phase === 'sending'),
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
    this.preferredSessionId.set(id);
    sessionStorage.setItem(selectionKey, id);
  }

  protected updatePrompt(event: Event): void {
    this.prompt.set((event.target as HTMLTextAreaElement).value);
    this.startError.set(null);
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
        return 'Start requested';
      case 'dispatching':
        return 'Starting';
      case 'accepted':
        return 'Accepted by Codex';
      case 'completed':
        return 'Start completed';
      case 'rejected':
        return 'Start failed';
    }
  }
}
