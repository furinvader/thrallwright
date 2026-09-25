import { createHash, randomUUID } from 'node:crypto';
import { BehaviorSubject, Subject, Subscription, type Observable } from 'rxjs';
import { z } from 'zod';
import type { Approval, Integration } from '@thrallwright/contracts';
import type {
  CodexAdapter,
  HarnessEvent,
  HarnessRequest,
} from '../../integrations/codex.js';

type Decision = 'accept' | 'decline';
export interface ApprovalClaim {
  rpcId: string | number;
  response: { decision: Decision };
  threadId: string;
  turnId: string;
}
export interface ApprovalResolution {
  approvalId: string;
  commandId?: string;
  reason: 'resolved' | 'stale';
}
interface Sessions {
  readonly state$: Observable<unknown>;
  getControlState(
    id: string,
  ):
    | { owned: boolean; connected: boolean; activeTurnId: string | null }
    | undefined;
  getTurnOutcome(id: string, turnId: string): string | undefined;
}
interface Options {
  codex: CodexAdapter;
  sessions: Sessions;
  initialApprovals?: Approval[];
  now?: () => string;
}
interface Entry {
  approval: Approval;
  rpcId?: string | number;
  epoch: number | null;
  fingerprint: string;
  decision?: Decision;
  everActionable: boolean;
}
const sourceId = z.string().min(1).max(256);
const rpcId = z.union([z.string(), z.number()]);
const identity = z.object({
  threadId: sourceId,
  turnId: sourceId,
  itemId: sourceId,
});
const common = identity.extend({ reason: z.string().nullable().optional() });
const command = common.extend({
  kind: z.enum(['command', 'writeStdin']).default('command'),
  command: z.string().nullable().optional(),
  networkApprovalContext: z
    .object({
      host: z.string().min(1),
      protocol: z.enum(['http', 'https', 'socks5Tcp', 'socks5Udp']),
    })
    .nullable()
    .optional(),
});
const fileChange = common.extend({
  grantRoot: z.string().nullable().optional(),
});
const commandMethod = 'item/commandExecution/requestApproval';
const fileMethod = 'item/fileChange/requestApproval';

function text(value: string): string {
  const bytes = Buffer.from(value);
  return bytes.length <= 8192
    ? value
    : bytes.subarray(0, 8176).toString('utf8') + '\n[Truncated]';
}
function optionalId(value: unknown): string | null {
  const parsed = sourceId.safeParse(value);
  return parsed.success ? parsed.data : null;
}
function normalize(
  request: HarnessRequest,
): Omit<Approval, 'id' | 'observedAt'> {
  const params: Record<string, unknown> =
    typeof request.params === 'object' && request.params !== null
      ? (request.params as Record<string, unknown>)
      : {};
  const base: Omit<Approval, 'id' | 'observedAt'> = {
    sessionId: optionalId(params.threadId),
    turnId: optionalId(params.turnId),
    itemId: optionalId(params.itemId),
    kind: 'unsupported',
    method: text(request.method),
    summary: 'Unsupported Codex request.',
    reason: null,
    status: 'unsupported',
    actionable: false,
    detail: 'This request cannot be answered through Thrallwright.',
    commandId: null,
  };
  if (request.method !== commandMethod && request.method !== fileMethod)
    return base;
  const parsed = (
    request.method === commandMethod ? command : fileChange
  ).safeParse(params);
  if (!parsed.success) {
    base.summary = 'Unsupported approval request format.';
    return base;
  }
  base.reason = parsed.data.reason == null ? null : text(parsed.data.reason);
  if (request.method === commandMethod) {
    const value = command.parse(params);
    base.summary = text(
      value.networkApprovalContext
        ? `Network access: ${value.networkApprovalContext.protocol} ${value.networkApprovalContext.host}${value.command ? `\nCommand: ${value.command}` : ''}`
        : value.kind === 'writeStdin'
          ? `Terminal input approval${value.command ? `: ${value.command}` : '. Codex did not include the terminal input in this request; review related activity.'}`
          : `Command approval${value.command ? `: ${value.command}` : '. Codex did not include a command in this request; review related activity.'}`,
    );
  } else {
    const value = fileChange.parse(params);
    base.summary =
      'File changes awaiting approval. Codex did not include change details in this request; review related activity.';
    if (value.grantRoot != null) {
      base.summary = text(
        `File changes requesting session write access: ${value.grantRoot}`,
      );
      base.detail =
        'Session-wide write grants are unsupported. Use Codex to review this request.';
      return base;
    }
  }
  // The UI offers one-time accept and decline only. Never widen a restricted
  // source decision set or translate a policy/session grant into one-time accept.
  if (params.availableDecisions !== undefined) {
    const choices = z.array(z.unknown()).safeParse(params.availableDecisions);
    if (
      !choices.success ||
      !choices.data.includes('accept') ||
      !choices.data.includes('decline')
    ) {
      base.detail = 'Codex did not offer both supported one-time decisions.';
      return base;
    }
  }
  if (Buffer.byteLength(base.summary) >= 8176) {
    base.detail =
      'The proposal is too long to display completely. Review it in Codex.';
    return base;
  }
  return {
    ...base,
    kind: request.method === commandMethod ? 'command' : 'fileChange',
    status: 'pending',
    detail: 'Waiting for current session and turn control to be verified.',
  };
}

export function createApprovalService(options: Options) {
  return new ApprovalService(options);
}

/** Owns approval observations and claims; only the command owner writes replies. */
export class ApprovalService {
  private readonly generation = randomUUID();
  private readonly entries = new Map<string, Entry>();
  // Null tombstones prevent evicted requests being revived by a duplicate.
  // They retain no source proposal text and are cleared at connection changes.
  private readonly wireEntries = new Map<string, Entry | null>();
  private readonly pendingClearances = new Map<
    string,
    { approvalId: string; commandId: string; threadId: string }
  >();
  private readonly deletedSessions = new Set<string>();
  private readonly state = new BehaviorSubject<Approval[]>([]);
  private readonly resolutions = new Subject<ApprovalResolution>();
  private readonly subscriptions = new Subscription();
  readonly state$ = this.state.asObservable();
  readonly resolutions$ = this.resolutions.asObservable();
  private readonly now: () => string;
  private connected = false;
  private closed = false;
  private epoch = 0;

  constructor(private readonly options: Options) {
    this.now = options.now ?? (() => new Date().toISOString());
    for (const cached of options.initialApprovals ?? []) {
      this.entries.set(cached.id, {
        approval: {
          ...cached,
          summary: text(cached.summary),
          reason: cached.reason == null ? null : text(cached.reason),
          status: 'stale',
          actionable: false,
          detail:
            'Cached request; a saved observation cannot authorize a response.',
        },
        epoch: null,
        fingerprint: '',
        everActionable: false,
      });
    }
    this.publish();
    this.subscriptions.add(
      options.codex.state$.subscribe((value) => this.connection(value)),
    );
    this.subscriptions.add(
      options.codex.requests$.subscribe((value) => this.receive(value)),
    );
    this.subscriptions.add(
      options.codex.events$.subscribe((value) => this.observe(value)),
    );
    this.subscriptions.add(
      options.sessions.state$.subscribe(() => this.revalidate()),
    );
  }

  getSnapshot(): Approval[] {
    return this.state.value;
  }

  private wireKey(id: string | number) {
    return JSON.stringify([this.epoch, typeof id, id]);
  }

  private publish() {
    if (!this.closed) {
      const settled = [...this.entries.values()].filter(
        (entry) =>
          entry.approval.status !== 'pending' &&
          entry.approval.status !== 'submitting',
      );
      for (const entry of settled.slice(0, Math.max(0, settled.length - 100))) {
        this.entries.delete(entry.approval.id);
        if (entry.rpcId !== undefined && entry.epoch === this.epoch) {
          const key = this.wireKey(entry.rpcId);
          if (this.wireEntries.get(key) !== entry) continue;
          this.wireEntries.set(key, null);
          if (
            entry.approval.status === 'stale' &&
            entry.approval.commandId &&
            entry.approval.sessionId
          )
            this.pendingClearances.set(key, {
              approvalId: entry.approval.id,
              commandId: entry.approval.commandId,
              threadId: entry.approval.sessionId,
            });
        }
      }
      this.state.next(
        [...this.entries.values()].map((entry) => entry.approval),
      );
    }
  }

  private connection(integration: Integration) {
    const available = integration.state === 'available';
    if (available === this.connected || this.closed) return;
    this.connected = available;
    this.epoch++;
    this.wireEntries.clear();
    this.pendingClearances.clear();
    for (const entry of this.entries.values())
      this.stale(
        entry,
        'Codex connection changed; this request cannot be answered.',
      );
    this.publish();
  }

  private receive(request: HarnessRequest) {
    if (this.closed || !this.connected || !rpcId.safeParse(request.id).success)
      return;
    const normalized = normalize(request);
    if (normalized.sessionId && this.deletedSessions.has(normalized.sessionId))
      return;
    const key = this.wireKey(request.id);
    // Keep only a digest of the original request, including policy fields that
    // are not displayed. Conflicting ID reuse must never replace a live claim.
    const fingerprint = createHash('sha256')
      .update(JSON.stringify([request.method, request.params]))
      .digest('hex');
    const previous = this.wireEntries.get(key);
    if (this.wireEntries.has(key)) {
      if (previous && previous.fingerprint !== fingerprint) {
        this.stale(
          previous,
          'Codex reused a request ID with conflicting approval data.',
        );
        // A later clearance cannot distinguish the conflicting meanings.
        this.wireEntries.set(key, null);
        this.pendingClearances.delete(key);
      }
      this.publish();
      return;
    }
    const entry: Entry = {
      approval: {
        ...normalized,
        id: JSON.stringify([
          this.generation,
          this.epoch,
          typeof request.id,
          request.id,
        ]),
        observedAt: this.now(),
      },
      rpcId: request.id,
      epoch: this.epoch,
      fingerprint,
      everActionable: false,
    };
    this.entries.set(entry.approval.id, entry);
    this.wireEntries.set(key, entry);
    this.refresh(entry);
    this.publish();
  }

  private current(entry: Entry): boolean {
    const approval = entry.approval;
    if (
      this.closed ||
      !this.connected ||
      entry.epoch !== this.epoch ||
      !approval.sessionId ||
      !approval.turnId ||
      entry.rpcId === undefined
    )
      return false;
    const control = this.options.sessions.getControlState(approval.sessionId);
    return Boolean(
      control?.owned &&
      control.connected &&
      control.activeTurnId === approval.turnId &&
      !this.options.sessions.getTurnOutcome(
        approval.sessionId,
        approval.turnId,
      ),
    );
  }

  private refresh(entry: Entry) {
    const approval = entry.approval;
    if (approval.status !== 'pending' && approval.status !== 'submitting')
      return;
    const valid = this.current(entry);
    const control = approval.sessionId
      ? this.options.sessions.getControlState(approval.sessionId)
      : undefined;
    const terminal =
      approval.sessionId &&
      approval.turnId &&
      this.options.sessions.getTurnOutcome(approval.sessionId, approval.turnId);
    if (
      !valid &&
      (entry.everActionable ||
        terminal ||
        (control?.activeTurnId && control.activeTurnId !== approval.turnId))
    ) {
      this.stale(
        entry,
        'The requesting turn is no longer available for this approval.',
      );
      return;
    }
    entry.everActionable ||= valid;
    entry.approval = {
      ...approval,
      actionable: valid && approval.status === 'pending',
      detail:
        approval.status === 'submitting'
          ? 'Decision submitted or being recorded; waiting for Codex to clear the request.'
          : valid
            ? 'One-time accept or decline is available for this live request.'
            : 'Waiting for current session and turn control to be verified.',
    };
  }

  private revalidate() {
    if (this.closed) return;
    for (const entry of this.entries.values()) this.refresh(entry);
    this.publish();
  }

  private stale(entry: Entry, detail: string) {
    if (
      entry.approval.status !== 'pending' &&
      entry.approval.status !== 'submitting'
    )
      return;
    entry.approval = {
      ...entry.approval,
      status: 'stale',
      actionable: false,
      detail,
    };
    this.resolutions.next({
      approvalId: entry.approval.id,
      ...(entry.approval.commandId
        ? { commandId: entry.approval.commandId }
        : {}),
      reason: 'stale',
    });
  }

  private observe(event: HarnessEvent) {
    if (this.closed || !this.connected) return;
    if (event.method === 'serverRequest/resolved') {
      const parsed = z
        .object({ threadId: sourceId, requestId: rpcId })
        .safeParse(event.params);
      if (!parsed.success) return;
      const key = this.wireKey(parsed.data.requestId);
      const entry = this.wireEntries.get(key);
      const pending = this.pendingClearances.get(key);
      if (!entry && pending?.threadId === parsed.data.threadId) {
        this.pendingClearances.delete(key);
        this.resolutions.next({
          approvalId: pending.approvalId,
          commandId: pending.commandId,
          reason: 'resolved',
        });
        return;
      }
      if (
        !entry ||
        entry.approval.sessionId !== parsed.data.threadId ||
        entry.approval.status === 'resolved'
      )
        return;
      entry.approval = {
        ...entry.approval,
        status: 'resolved',
        actionable: false,
        detail:
          'Codex cleared this request. The underlying action outcome is reported separately.',
      };
      this.publish();
      this.resolutions.next({
        approvalId: entry.approval.id,
        ...(entry.approval.commandId
          ? { commandId: entry.approval.commandId }
          : {}),
        reason: 'resolved',
      });
      return;
    }
    if (
      ['thread/closed', 'thread/archived', 'thread/deleted'].includes(
        event.method,
      )
    ) {
      const parsed = z.object({ threadId: sourceId }).safeParse(event.params);
      if (!parsed.success) return;
      const deleted = event.method === 'thread/deleted';
      if (deleted) {
        this.deletedSessions.add(parsed.data.threadId);
        for (const [key, value] of this.pendingClearances)
          if (value.threadId === parsed.data.threadId)
            this.pendingClearances.delete(key);
      }
      for (const entry of this.entries.values()) {
        if (entry.approval.sessionId === parsed.data.threadId) {
          this.stale(entry, 'The requesting session is no longer available.');
          if (deleted) {
            this.entries.delete(entry.approval.id);
            if (entry.rpcId !== undefined && entry.epoch === this.epoch)
              this.wireEntries.delete(this.wireKey(entry.rpcId));
          }
        }
      }
      this.publish();
    }
    if (event.method === 'turn/completed') {
      const parsed = z
        .object({
          threadId: sourceId,
          turn: z.object({
            id: sourceId,
            status: z.enum(['completed', 'interrupted', 'failed']),
          }),
        })
        .safeParse(event.params);
      if (!parsed.success) return;
      for (const entry of this.entries.values())
        if (
          entry.approval.sessionId === parsed.data.threadId &&
          entry.approval.turnId === parsed.data.turn.id
        )
          this.stale(entry, 'The requesting turn has ended.');
      this.publish();
    }
  }

  claim(
    approvalId: string,
    decision: Decision,
    commandId: string,
  ): ApprovalClaim {
    const entry = this.entries.get(approvalId);
    if (!entry || entry.approval.status !== 'pending' || !this.current(entry))
      throw new Error('Approval is not available for this live turn.');
    if (decision !== 'accept' && decision !== 'decline')
      throw new Error('Unsupported approval decision.');
    entry.decision = decision;
    entry.everActionable = true;
    entry.approval = {
      ...entry.approval,
      status: 'submitting',
      actionable: false,
      commandId,
    };
    this.refresh(entry);
    this.publish();
    return this.validateClaim(approvalId, commandId);
  }

  validateClaim(approvalId: string, commandId: string): ApprovalClaim {
    const entry = this.entries.get(approvalId);
    if (
      !entry ||
      entry.approval.status !== 'submitting' ||
      entry.approval.commandId !== commandId ||
      !entry.decision ||
      !this.current(entry)
    )
      throw new Error(
        'The approval claim expired before its response could be sent.',
      );
    return {
      rpcId: entry.rpcId!,
      response: { decision: entry.decision },
      threadId: entry.approval.sessionId!,
      turnId: entry.approval.turnId!,
    };
  }

  releaseBeforeWrite(approvalId: string, commandId: string): void {
    const entry = this.entries.get(approvalId);
    if (
      !entry ||
      entry.approval.status !== 'submitting' ||
      entry.approval.commandId !== commandId
    )
      return;
    if (!this.current(entry)) {
      this.stale(entry, 'Approval expired while recording the decision.');
    } else {
      entry.decision = undefined;
      entry.approval = {
        ...entry.approval,
        status: 'pending',
        commandId: null,
      };
      this.refresh(entry);
    }
    this.publish();
  }

  markUncertain(approvalId: string, commandId: string): void {
    const entry = this.entries.get(approvalId);
    if (!entry || entry.approval.commandId !== commandId) return;
    this.stale(
      entry,
      'The decision may have been sent. It will not be retried automatically.',
    );
    this.publish();
  }

  close(): void {
    if (this.closed) return;
    for (const entry of this.entries.values())
      this.stale(entry, 'Approval observation stopped.');
    this.publish();
    this.closed = true;
    this.subscriptions.unsubscribe();
    this.state.complete();
    this.resolutions.complete();
  }
}
