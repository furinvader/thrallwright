import { BehaviorSubject, Subscription } from 'rxjs';
import { z } from 'zod';
import type {
  Activity,
  Discovery,
  Integration,
  Session,
} from '@thrallwright/contracts';
import type { CodexAdapter, HarnessEvent } from '../../integrations/codex.js';
import {
  activityKey,
  clipText,
  MAX_ACTIVITIES,
  normalizeHistory,
  normalizeItem,
  presentStatus,
  sourceId,
  statusSchema,
  threadSchema,
  turnSchema,
  type SourceThread,
} from './normalize.js';

export interface SessionsState {
  sessions: Session[];
  discovery: Discovery;
}
export type TurnOutcome = 'completed' | 'interrupted' | 'failed';
interface Options {
  workspace: string;
  codex: CodexAdapter;
  initialSessions?: Session[];
  now?: () => string;
}
interface Entry {
  session: Session;
  itemRevisions: Map<string, number>;
  statusRevision: number;
  historyToken: number;
  ownedEpoch: number | null;
  terminalTurns: Map<string, { outcome: TurnOutcome; revision: number }>;
}
const MAX_SESSIONS = 100;
const threadIdParams = z.object({ threadId: sourceId });
const itemParams = threadIdParams.extend({
  turnId: sourceId,
  item: z.unknown(),
});
const deltaParams = threadIdParams.extend({
  turnId: sourceId,
  itemId: sourceId,
  delta: z.string(),
});
const sources = [
  'cli',
  'vscode',
  'exec',
  'appServer',
  'subAgent',
  'subAgentReview',
  'subAgentCompact',
  'subAgentThreadSpawn',
  'subAgentOther',
  'unknown',
];

export function createSessionService(options: Options) {
  return new SessionService(options);
}

/** Observes one app-server generation; command execution remains a separate owner. */
export class SessionService {
  private readonly entries = new Map<string, Entry>();
  private readonly subscriptions = new Subscription();
  private readonly state = new BehaviorSubject<SessionsState>({
    sessions: [],
    discovery: { state: 'loading', detail: 'Discovering Codex sessions.' },
  });
  readonly state$ = this.state.asObservable();
  private connected = false;
  private closed = false;
  private epoch = 0;
  private revision = 0;
  private discovery: Discovery = {
    state: 'loading',
    detail: 'Discovering Codex sessions.',
  };
  private refreshInFlight?: { epoch: number; promise: Promise<void> };
  private readonly now: () => string;

  constructor(private readonly options: Options) {
    this.now = options.now ?? (() => new Date().toISOString());
    for (const cached of (options.initialSessions ?? []).slice(
      0,
      MAX_SESSIONS,
    )) {
      if (cached.ephemeral) continue;
      const deleted = cached.history.state === 'deleted';
      this.entries.set(
        cached.id,
        this.entry({
          ...cached,
          controllable: false,
          status: 'historical',
          freshness: 'cached',
          activeTurnId: null,
          activities: deleted
            ? []
            : cached.activities.slice(-MAX_ACTIVITIES).map((activity) => {
                const bounded = clipText(activity.text);
                return {
                  ...activity,
                  text: bounded.text,
                  complete: activity.complete && !bounded.truncated,
                  origin: 'cache' as const,
                };
              }),
          history: deleted
            ? cached.history
            : {
                state: 'unread',
                complete: false,
                detail: 'Cached activity; refresh to verify source history.',
              },
        }),
      );
    }
    this.publish();
    this.subscriptions.add(
      options.codex.events$.subscribe((event) => this.observe(event)),
    );
    this.subscriptions.add(
      options.codex.state$.subscribe((state) => this.integrationChanged(state)),
    );
  }

  getSnapshot(): SessionsState {
    return this.state.value;
  }

  getControlState(sessionId: string) {
    const entry = this.entries.get(sessionId);
    if (!entry) return undefined;
    return {
      owned: entry.ownedEpoch === this.epoch,
      connected: this.connected && entry.session.controllable,
      activeTurnId: entry.session.activeTurnId,
      status: entry.session.status,
    };
  }

  /** Exact terminal evidence read or received during this connection only. */
  getTurnOutcome(sessionId: string, turnId: string): TurnOutcome | undefined {
    if (this.closed || !this.connected) return undefined;
    return this.entries.get(sessionId)?.terminalTurns.get(turnId)?.outcome;
  }

  private recordOutcome(
    entry: Entry,
    turnId: string,
    outcome: TurnOutcome,
    readRevision?: number,
  ) {
    const previous = entry.terminalTurns.get(turnId);
    if (
      previous &&
      readRevision !== undefined &&
      previous.revision > readRevision
    )
      return;
    entry.terminalTurns.delete(turnId);
    entry.terminalTurns.set(turnId, {
      outcome,
      revision: readRevision ?? ++this.revision,
    });
    if (entry.terminalTurns.size > MAX_ACTIVITIES) {
      // A long, delayed history response must not evict a newer live outcome.
      const oldest = [...entry.terminalTurns].reduce((first, candidate) =>
        candidate[1].revision < first[1].revision ? candidate : first,
      );
      entry.terminalTurns.delete(oldest[0]);
    }
  }

  private entry(session: Session): Entry {
    return {
      session,
      itemRevisions: new Map(),
      statusRevision: 0,
      historyToken: 0,
      ownedEpoch: null,
      terminalTurns: new Map(),
    };
  }
  private publish() {
    if (!this.closed)
      this.state.next({
        sessions: [...this.entries.values()].map((entry) => entry.session),
        discovery: this.discovery,
      });
  }

  private integrationChanged(integration: Integration) {
    if (this.closed) return;
    const available = integration.state === 'available';
    if (available === this.connected) {
      if (!available) {
        this.discovery = {
          state: 'unavailable',
          detail:
            'Codex observation is unavailable; retained sessions are historical.',
        };
        this.publish();
      }
      return;
    }
    this.connected = available;
    this.epoch++;
    if (available) {
      void this.refresh();
      return;
    }
    for (const entry of this.entries.values()) {
      entry.ownedEpoch = null;
      entry.terminalTurns.clear();
      entry.historyToken++;
      entry.session = {
        ...entry.session,
        controllable: false,
        activeTurnId: null,
        status:
          entry.session.freshness === 'live' ? 'disconnected' : 'historical',
        freshness: entry.session.freshness === 'cached' ? 'cached' : 'history',
        history:
          entry.session.history.state === 'loading'
            ? {
                state: 'unavailable',
                complete: false,
                detail: 'Codex disconnected while reading history.',
              }
            : entry.session.history,
      };
    }
    this.discovery = {
      state: 'unavailable',
      detail:
        'Codex disconnected. Live controls and pending reads must be revalidated.',
    };
    this.publish();
  }

  refresh(): Promise<void> {
    if (this.closed || !this.connected) return Promise.resolve();
    if (this.refreshInFlight?.epoch === this.epoch)
      return this.refreshInFlight.promise;
    const epoch = this.epoch;
    const promise = this.discover(epoch);
    this.refreshInFlight = { epoch, promise };
    void promise.finally(() => {
      if (this.refreshInFlight?.promise === promise)
        this.refreshInFlight = undefined;
    });
    return promise;
  }

  private valid(epoch: number) {
    return !this.closed && this.connected && this.epoch === epoch;
  }

  private async discover(epoch: number) {
    this.discovery = {
      state: 'loading',
      detail: 'Reading workspace session summaries.',
    };
    this.publish();
    const revision = this.revision;
    try {
      const loadedSchema = z.object({
        data: z.array(sourceId),
        nextCursor: z.string().nullable().optional(),
      });
      const listedSchema = z.object({
        data: z.array(threadSchema),
        nextCursor: z.string().nullable().optional(),
      });
      const loaded = loadedSchema.parse(
        await this.options.codex.request('thread/loaded/list', {
          limit: MAX_SESSIONS,
        }),
      );
      if (!this.valid(epoch)) return;
      const loadedIds = new Set(loaded.data.slice(0, MAX_SESSIONS));
      let cursor: string | undefined;
      let count = 0;
      let more = false;
      let pages = 0;
      const cursors = new Set<string>();
      do {
        const page = listedSchema.parse(
          await this.options.codex.request('thread/list', {
            cwd: this.options.workspace,
            limit: Math.min(50, MAX_SESSIONS - count),
            cursor,
            useStateDbOnly: true,
            modelProviders: [],
            sourceKinds: sources,
          }),
        );
        if (!this.valid(epoch)) return;
        const remaining = MAX_SESSIONS - count;
        pages++;
        for (const thread of page.data.slice(0, remaining)) {
          count++;
          this.mergeThread(thread, revision, loadedIds.has(thread.id));
        }
        more = page.nextCursor != null || page.data.length > remaining;
        cursor = page.nextCursor ?? undefined;
        if (cursor && cursors.has(cursor))
          throw new Error('Repeated source cursor');
        if (cursor) cursors.add(cursor);
      } while (cursor && count < MAX_SESSIONS && pages < 4);
      if (!this.valid(epoch)) return;
      if (loaded.nextCursor == null && loaded.data.length <= MAX_SESSIONS) {
        for (const entry of this.entries.values())
          if (
            entry.statusRevision <= revision &&
            entry.session.freshness === 'live' &&
            !loadedIds.has(entry.session.id)
          )
            this.applyStatus(entry, { type: 'notLoaded' });
      }
      this.discovery = {
        state: 'ready',
        detail:
          more || loaded.nextCursor != null || loaded.data.length > MAX_SESSIONS
            ? 'Session discovery is limited to 100 results; additional source sessions may exist.'
            : 'Workspace sessions refreshed. Saved history does not establish live control.',
      };
    } catch {
      if (!this.valid(epoch)) return;
      this.discovery = {
        state: 'unavailable',
        detail:
          'Could not refresh Codex sessions. Previously observed data remains visible with its existing freshness.',
      };
    }
    this.publish();
  }

  private mergeThread(
    thread: SourceThread,
    readRevision: number,
    loaded: boolean,
    forceOwned = false,
  ): Entry | undefined {
    if (thread.cwd !== this.options.workspace) return;
    let entry = this.entries.get(thread.id);
    if (entry?.session.history.state === 'deleted') return;
    if (!entry) {
      if (!forceOwned && this.entries.size >= MAX_SESSIONS) return;
      entry = this.entry({
        id: thread.id,
        title: clipText(thread.name || thread.preview || 'Untitled session')
          .text,
        parentThreadId: thread.parentThreadId ?? null,
        ephemeral: thread.ephemeral,
        owned: false,
        controllable: false,
        status: 'historical',
        freshness: 'history',
        activeTurnId: null,
        latestTurnOutcome: null,
        observedAt: this.now(),
        history: {
          state: 'unread',
          complete: false,
          detail: 'History has not been loaded.',
        },
        activities: [],
      });
      this.entries.set(thread.id, entry);
    }
    if (forceOwned) entry.ownedEpoch = this.epoch;
    entry.session = {
      ...entry.session,
      title: clipText(thread.name || thread.preview || entry.session.title)
        .text,
      parentThreadId: thread.parentThreadId ?? null,
      ephemeral: thread.ephemeral,
      owned: entry.session.owned || forceOwned,
    };
    if (entry.statusRevision <= readRevision) {
      const live = loaded && thread.status.type !== 'notLoaded';
      if (!live || thread.status.type === 'systemError')
        entry.ownedEpoch = null;
      entry.session = {
        ...entry.session,
        status: live ? presentStatus(thread.status) : 'historical',
        freshness: live ? 'live' : 'history',
        observedAt: this.now(),
        controllable:
          live &&
          entry.ownedEpoch === this.epoch &&
          thread.status.type !== 'systemError',
        activeTurnId: live ? entry.session.activeTurnId : null,
      };
    } else if (forceOwned) {
      entry.session = {
        ...entry.session,
        controllable:
          this.connected &&
          entry.session.freshness === 'live' &&
          entry.session.status !== 'unknown',
      };
    }
    return entry;
  }

  async readHistory(sessionId: string): Promise<void> {
    const entry = this.entries.get(sessionId);
    if (!entry) throw new Error('Unknown session.');
    if (this.closed || entry.session.history.state === 'deleted') return;
    if (!this.connected) {
      entry.session = {
        ...entry.session,
        history: {
          state: 'unavailable',
          complete: false,
          detail: 'Codex is unavailable; cached activity may be incomplete.',
        },
      };
      this.publish();
      return;
    }
    const epoch = this.epoch;
    const token = ++entry.historyToken;
    const revision = this.revision;
    entry.session = {
      ...entry.session,
      history: {
        state: 'loading',
        complete: false,
        detail: 'Reading source history.',
      },
    };
    this.publish();
    try {
      const raw = await this.options.codex.request('thread/read', {
        threadId: sessionId,
        includeTurns: true,
      });
      if (
        !this.valid(epoch) ||
        entry.historyToken !== token ||
        entry.session.history.state === 'deleted'
      )
        return;
      const { thread } = z.object({ thread: threadSchema }).parse(raw);
      if (thread.id !== sessionId || thread.cwd !== this.options.workspace)
        throw new Error('Source identity mismatch');
      const normalized = normalizeHistory(thread.turns, this.now());
      for (const rawTurn of thread.turns ?? []) {
        const parsedTurn = turnSchema.safeParse(rawTurn);
        if (parsedTurn.success && parsedTurn.data.status !== 'inProgress')
          this.recordOutcome(
            entry,
            parsedTurn.data.id,
            parsedTurn.data.status,
            revision,
          );
      }
      const changed = new Map(
        entry.session.activities
          .filter(
            (activity) =>
              (entry.itemRevisions.get(activity.id) ?? 0) > revision ||
              (activity.origin === 'live' &&
                (activity.turnId === entry.session.activeTurnId ||
                  !activity.complete)),
          )
          .map((activity) => [activity.id, activity]),
      );
      const activities = normalized.activities.map(
        (activity) => changed.get(activity.id) ?? activity,
      );
      const included = new Set(activities.map((activity) => activity.id));
      for (const activity of changed.values())
        if (!included.has(activity.id)) activities.push(activity);
      // Partial source histories cannot justify deleting unseen cached items.
      if (!normalized.complete) {
        const present = new Set(activities.map((activity) => activity.id));
        activities.unshift(
          ...entry.session.activities.filter(
            (activity) =>
              !present.has(activity.id) && !changed.has(activity.id),
          ),
        );
      }
      this.mergeThread(thread, revision, entry.session.freshness === 'live');
      const complete =
        normalized.complete &&
        activities.length <= MAX_ACTIVITIES &&
        !activities.some((activity) => !activity.complete);
      entry.session = {
        ...entry.session,
        activities: activities.slice(-MAX_ACTIVITIES),
        latestTurnOutcome:
          entry.statusRevision > revision
            ? entry.session.latestTurnOutcome
            : normalized.latestTurnOutcome,
        history: {
          state: 'ready',
          complete,
          detail: complete
            ? 'Source history refreshed.'
            : 'History is partial: active, omitted, or truncated activity may remain. At most 100 items and 8 KiB per item are retained.',
        },
      };
      this.pruneRevisions(entry);
    } catch {
      if (
        !this.valid(epoch) ||
        entry.historyToken !== token ||
        entry.session.history.state === 'deleted'
      )
        return;
      entry.session = {
        ...entry.session,
        history: {
          state: 'unavailable',
          complete: false,
          detail:
            'Could not read Codex history. Retained activity may be stale or incomplete.',
        },
      };
    }
    this.publish();
  }

  acceptStartedThread(rawThread: unknown): Session | null {
    if (!this.connected || this.closed) return null;
    const parsed = threadSchema.safeParse(rawThread);
    if (!parsed.success) return null;
    const entry = this.mergeThread(parsed.data, -1, true, true);
    if (!entry) return null;
    if (entry.statusRevision === 0) this.applyStatus(entry, parsed.data.status);
    this.publish();
    return entry.session;
  }

  acceptTurn(threadId: string, rawTurn: unknown): void {
    if (!this.connected || this.closed) return;
    const entry = this.entries.get(threadId);
    const parsed = turnSchema.safeParse(rawTurn);
    if (!entry || !parsed.success || entry.session.history.state === 'deleted')
      return;
    const turn = parsed.data;
    if (entry.terminalTurns.has(turn.id) && turn.status === 'inProgress')
      return;
    if (turn.status !== 'inProgress') {
      this.recordOutcome(entry, turn.id, turn.status);
    }
    if (
      turn.status === 'inProgress' ||
      entry.session.activeTurnId === null ||
      entry.session.activeTurnId === turn.id
    ) {
      entry.statusRevision = ++this.revision;
      entry.session = {
        ...entry.session,
        freshness: 'live',
        status: turn.status === 'inProgress' ? 'running' : 'idle',
        observedAt: this.now(),
        activeTurnId: turn.status === 'inProgress' ? turn.id : null,
        latestTurnOutcome: turn.status,
        controllable: entry.ownedEpoch === this.epoch,
      };
    }
    for (const rawItem of turn.items ?? [])
      this.putItem(entry, rawItem, turn.id, turn.status !== 'inProgress');
    this.publish();
  }

  private applyStatus(entry: Entry, status: z.infer<typeof statusSchema>) {
    entry.statusRevision = ++this.revision;
    const live = status.type !== 'notLoaded';
    if (!live || status.type === 'systemError') entry.ownedEpoch = null;
    entry.session = {
      ...entry.session,
      status: presentStatus(status),
      freshness: live ? 'live' : 'history',
      observedAt: this.now(),
      controllable:
        live &&
        status.type !== 'systemError' &&
        entry.ownedEpoch === this.epoch,
      activeTurnId:
        status.type === 'idle' || !live ? null : entry.session.activeTurnId,
    };
  }

  private putItem(
    entry: Entry,
    rawItem: unknown,
    turnId: string,
    complete: boolean,
  ) {
    const result = normalizeItem(rawItem, turnId, 'live', this.now(), complete);
    if (result.unsupported) {
      entry.session = {
        ...entry.session,
        history: {
          ...entry.session.history,
          complete: false,
          detail:
            'Some source activity is unsupported and could not be displayed.',
        },
      };
    }
    if (!result.activity) return;
    this.putActivity(entry, result.activity, result.truncated);
  }

  private putActivity(entry: Entry, activity: Activity, truncated: boolean) {
    const index = entry.session.activities.findIndex(
      (item) => item.id === activity.id,
    );
    const activities = [...entry.session.activities];
    if (index < 0) activities.push(activity);
    else activities[index] = activity;
    entry.itemRevisions.set(activity.id, ++this.revision);
    entry.session = {
      ...entry.session,
      activities: activities.slice(-MAX_ACTIVITIES),
      observedAt: this.now(),
      history:
        truncated || activities.length > MAX_ACTIVITIES
          ? {
              state: entry.session.history.state,
              complete: false,
              detail: 'Activity is truncated to 100 items and 8 KiB per item.',
            }
          : entry.session.history,
    };
    this.pruneRevisions(entry);
  }

  private pruneRevisions(entry: Entry) {
    const retained = new Set(
      entry.session.activities.map((activity) => activity.id),
    );
    for (const id of entry.itemRevisions.keys())
      if (!retained.has(id)) entry.itemRevisions.delete(id);
  }

  private invalidateRuntime(entry: Entry) {
    entry.ownedEpoch = null;
    entry.statusRevision = ++this.revision;
    entry.session = {
      ...entry.session,
      status: 'unknown',
      freshness: 'history',
      controllable: false,
      activeTurnId: null,
      history: {
        state: 'unavailable',
        complete: false,
        detail:
          'Codex sent unsupported runtime state. Controls require fresh source verification.',
      },
    };
  }

  private observe(event: HarnessEvent) {
    if (!this.connected || this.closed) return;
    if (event.method === 'thread/started') {
      const parsed = z.object({ thread: threadSchema }).safeParse(event.params);
      if (!parsed.success) return;
      const entry = this.mergeThread(parsed.data.thread, this.revision, true);
      if (entry) this.applyStatus(entry, parsed.data.thread.status);
      this.publish();
      return;
    }
    const identity = threadIdParams.safeParse(event.params);
    if (!identity.success) return;
    const entry = this.entries.get(identity.data.threadId);
    if (!entry || entry.session.history.state === 'deleted') return;
    switch (event.method) {
      case 'thread/deleted':
        entry.historyToken++;
        entry.ownedEpoch = null;
        entry.itemRevisions.clear();
        entry.terminalTurns.clear();
        entry.session = {
          ...entry.session,
          status: 'historical',
          freshness: 'history',
          controllable: false,
          activeTurnId: null,
          activities: [],
          history: {
            state: 'deleted',
            complete: true,
            detail:
              'The harness deleted this session. Cached activity was removed.',
          },
        };
        break;
      case 'thread/closed':
      case 'thread/archived':
        entry.historyToken++;
        entry.ownedEpoch = null;
        this.applyStatus(entry, { type: 'notLoaded' });
        break;
      case 'thread/status/changed': {
        const parsed = threadIdParams
          .extend({ status: statusSchema })
          .safeParse(event.params);
        if (parsed.success) this.applyStatus(entry, parsed.data.status);
        else this.invalidateRuntime(entry);
        break;
      }
      case 'turn/started':
      case 'turn/completed': {
        const parsed = threadIdParams
          .extend({ turn: turnSchema })
          .safeParse(event.params);
        if (parsed.success)
          this.acceptTurn(identity.data.threadId, parsed.data.turn);
        else {
          this.invalidateRuntime(entry);
          this.publish();
        }
        return;
      }
      case 'item/started':
      case 'item/completed': {
        const parsed = itemParams.safeParse(event.params);
        if (parsed.success)
          this.putItem(
            entry,
            parsed.data.item,
            parsed.data.turnId,
            event.method === 'item/completed',
          );
        break;
      }
      case 'item/agentMessage/delta':
      case 'item/commandExecution/outputDelta': {
        const parsed = deltaParams.safeParse(event.params);
        if (!parsed.success) break;
        const { turnId, itemId, delta } = parsed.data;
        const key = activityKey(turnId, itemId);
        const existing = entry.session.activities.find(
          (item) => item.id === key,
        );
        if (existing?.complete) break;
        const bounded = clipText((existing?.text ?? '') + delta);
        this.putActivity(
          entry,
          {
            id: key,
            turnId,
            kind:
              event.method === 'item/agentMessage/delta' ? 'assistant' : 'tool',
            text: bounded.text,
            complete: false,
            origin: 'live',
            observedAt: this.now(),
          },
          bounded.truncated,
        );
        break;
      }
      default:
        return;
    }
    this.publish();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.epoch++;
    this.subscriptions.unsubscribe();
    this.state.complete();
  }
}
