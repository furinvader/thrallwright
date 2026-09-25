# ADR 0004: SQLite persistence and independent workflow sources

Status: Accepted, 2026-09-24. Implemented for the first slice; see the [workbench guide](../workbench.md) and [integration evidence](../integration/codex.md).

## Context

Thrallwright needs continuity across reopening and enough evidence to show uncertain command outcomes honestly. [ADR 0003](0003-websocket-protocol.md) selects snapshot-based browser recovery. [ADR 0001](0001-typescript-and-event-architecture.md) preserves harness and workflow source authority. Product scope remains defined in the [product specification](../product-spec.md) and [first implementation slice](../first-slice.md).

Workflow complexity can grow through state communication, concurrent changes, and persistence requirements even when individual workflow actions remain simple. The initial JSON source should leave room for later SQL-backed or other sources.

## Decision and ownership

Use SQLite for Thrallwright-owned records and a bounded cache of meaningful session activity. The Node service owns database access. SQLite provides local application storage and atomic transactions without a separate database server. [SQLite use cases](https://www.sqlite.org/whentouse.html), [transactions](https://www.sqlite.org/atomiccommit.html)

| Data | Ownership and persistence |
| --- | --- |
| Workspace configuration, session associations, Thrallwright-specific labels | Thrallwright owns and persists these records. |
| Harness messages and structured activity | Retrieve through the harness integration and cache useful display data. |
| Command attempts and observed outcomes | Persist a Thrallwright command journal. |
| Workflow content | The configured workflow source remains authoritative; persist its reference/configuration. |
| Live status, capabilities, actionable approvals | Revalidate through current integration evidence; saved observations remain historical. |
| Selection, expansion, layout preferences | Lightweight browser preferences where useful. |

Codex continues to own its execution, approvals, and conversation resumption. Its API supports reading stored thread history without resuming it. Read through the integration boundary. [Official OpenAI documentation](https://learn.chatgpt.com/docs/app-server)

## History and retention

Cache meaningful activity for sessions opened or observed: messages, exposed tool activity, and useful lifecycle information. Assemble streaming deltas into current items, periodically checkpoint partial output, and save completed items when available. Exact reconstruction of every transient transport event is not an initial guarantee.

Retain provenance, stable source identities where available, freshness, and completeness information. Reconcile overlapping cached items with fresh source data without assuming that history can only append. If the source is temporarily unavailable, show cached history with its limitations.

Keep the cache bounded with a simple size or age policy selected during implementation. Cache eviction must preserve app-owned metadata, Thrallwright-only records that cannot be reconstructed from the harness, and unresolved command outcomes. Explicit source deletion and non-persistence settings require deliberate retention behavior distinct from temporary unavailability.

This cache supports inspection and continuity; permanent independent archival remains a separate product decision.

## Commands and restart recovery

Persist command intent before attempting its execution-changing effect. Record its correlation ID, target, operation, and enough identity to detect conflicting reuse, then retain observed responses and outcomes. If intent cannot be persisted, report the failure before attempting the effect.

SQLite cannot commit atomically with a harness operation. A crash after dispatch but before recording its result leaves uncertainty. The journal records evidence and does not automatically retry commands. Reconcile unresolved attempts where possible and leave uncertainty visible when evidence is insufficient.

After restart, load metadata and cached history, rediscover sessions, refresh source state, and reconcile command records before publishing verified live state or enabling stale approvals. Follow the snapshot/update boundary in ADR 0003. Restoring records never implicitly starts, resumes, interrupts, or stops agent work.

Use explicit migrations and small feature-local persistence operations. [ADR 0005](0005-backend-libraries.md) selects better-sqlite3 and Kysely, and [ADR 0007](0007-linux-packaging-and-storage.md) selects storage locations. Schema details and exact retention limits remain implementation decisions.

## Workflow source boundary

Start with one read-only JSON source. Preserve arbitrary valid JSON, including scalar values and null, and expose missing, invalid, inaccessible, and stale-source conditions explicitly.

Access workflow content through a small source adapter. It supplies inspectable state with source identity, read status, and freshness. File access, parsing, and source-specific change detection belong behind that boundary. Presentation and session logic consume the resulting state through feature contracts.

Choosing SQLite for Thrallwright records does not choose storage for workflow content. A future SQL-backed source can supply a presentation through the same boundary; its queries, schema, and consistency guarantees need their own concrete design. A general workflow engine or plugin system is unnecessary for the initial adapter.

Revisit workflow persistence before introducing coordinated writers, workflow editing, or a source that requires transactional state transitions. At that point, decide write authority, conflict handling, atomicity, revisions, and how changes reach observers. Until then, SQL workflow support and write coordination are deferred.

## Verification during implementation

Check restart recovery, interrupted command dispatch, incomplete cached history, and cache eviction without loss of app-owned records. Verify that cached state never establishes live execution or approval actionability. Workflow read failures must remain visible while session observation stays usable, and refreshing a workflow must not modify its source.
