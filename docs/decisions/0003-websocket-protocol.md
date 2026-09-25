# ADR 0003: WebSockets and shared browser-service contracts

Status: Accepted, 2026-09-24. Implemented for the first slice; see the [workbench guide](../workbench.md) and [integration evidence](../integration/codex.md).

## Context

Thrallwright's Angular interface observes live activity and sends explicit commands to its local Node service. [ADR 0001](0001-typescript-and-event-architecture.md) defines execution and effect ownership; [ADR 0002](0002-angular-ui.md) defines presentation boundaries. Product scope remains defined in the [product specification](../product-spec.md) and [first implementation slice](../first-slice.md).

Both WebSockets and HTTP commands with Server-Sent Events can support this interaction. Shared TypeScript contracts are possible with either transport. The preference for WebSockets is a unified bidirectional message channel, while accepting that application-level recovery is required with either choice.

## Decision

Use WebSockets for live browser-service communication, with a small, explicitly typed protocol. One browser connection adapter owns the connection, request correlation, and reconnect behavior for its application instance. Feature clients expose named command methods and read-only observations to the UI.

| Message category | Purpose |
| --- | --- |
| Commands | Request operations such as sending input or answering an approval. |
| Command responses | Correlate acceptance, rejection, or a defined result with the originating request. |
| Snapshots | Establish current service state when opening or reconnecting. |
| Events | Report subsequent activity and state changes. |

Organize shared public contracts by feature. Share browser-facing command, response, snapshot, and event definitions between frontend and backend, with runtime validation at the wire boundary. [ADR 0005](0005-backend-libraries.md) selects Zod for validation; the implemented envelopes are defined in [packages/contracts/src/index.ts](../../packages/contracts/src/index.ts).

The message categories above describe responsibilities, not four required wire variants. The first slice accepts `refresh`, `inspect`, and execution `command` messages. The service sends complete revisioned `snapshot` messages and explicit `error` messages. Snapshots include command records and observed activity, so command progress and state updates currently travel within snapshots rather than separate response or event envelopes. This deliberately small protocol has no incremental replay or negotiated protocol version.

Internal backend events and raw harness messages remain implementation details unless deliberately included in the public contract. A browser may request an approval response; it cannot publish authoritative approval resolution. A shared wire connection does not introduce a globally writable application event bus.

## Synchronization and reconnect

Begin with snapshot-based recovery. After connecting, establish a fresh snapshot of the service's knowledge and load available activity history as needed. Preserve distinctions between verified live state, historical state, and unknown or disconnected state. An open browser socket alone does not establish a live harness connection.

The snapshot and subsequent updates must have an explicit consistency boundary so activity cannot disappear between snapshot construction and observation. Sending both through one socket does not establish that boundary automatically. The implementation must order or buffer updates around snapshot delivery and prevent duplicate application when history overlaps live activity.

On disconnect, mark affected projections as stale and reconcile before enabling controls that require current capabilities or pending approvals. Preserve browser-owned drafts and navigation where appropriate. Reopening or reconnecting the browser must not implicitly start, resume, interrupt, or stop agent work.

Incremental replay, resume cursors, and durable event-log infrastructure are deferred until their value is demonstrated. Snapshot recovery must still retain access to available activity history and show recovery failures explicitly.

[ADR 0004](0004-persistence-and-workflow-sources.md) defines persisted metadata, cached activity, and command records used during recovery.

## Commands and uncertain outcomes

Give commands correlation identifiers and explicit response semantics. Transport delivery, service acceptance, and a harness-confirmed outcome are distinct. Correlation identifiers alone do not guarantee deduplication or exactly-once execution.

A disconnect after sending a command may leave its outcome uncertain. Surface that uncertainty and reconcile with service or harness evidence before retrying. Reconnection must not automatically resend approvals, interrupts, or other execution-changing commands. Retain the approval validation and in-flight ownership rules from ADR 0001.

Keep long-running effects asynchronous so the connection remains able to process observations and responsive controls. Socket message order does not imply that asynchronous operations complete in that order.

## Alternatives and consequences

HTTP commands plus SSE would provide ordinary request/response semantics and browser-assisted stream reconnection. SSE also defines last-event IDs, but recovering application state still requires server behavior. [SSE specification](https://html.spec.whatwg.org/multipage/server-sent-events.html)

WebSockets provide a coherent channel for commands and observations while requiring explicit request correlation and recovery behavior. The browser API's `send()` does not acknowledge server receipt or execution. [WebSocket specification](https://websockets.spec.whatwg.org/)

[ADR 0005](0005-backend-libraries.md) selects Fastify, its WebSocket plugin, and Zod. Frontend and service are released together; protocol negotiation remains deferred. HTTP serves the browser assets, while the WebSocket carries the validated workbench messages.

## Verification

Exercise activity arriving during snapshot loading, disconnects around command submission, and reconnects after service restart. Verify that recovery neither loses available activity at the snapshot boundary nor duplicates it, stale approvals stay non-actionable, uncertain commands remain visible, and reconnecting or changing UI observers causes no implicit execution commands.

The [service transport tests](../../apps/server/src/app.test.ts), [browser connection tests](../../apps/web/src/app/workbench-connection.spec.ts), and [browser workflows](../../tests/e2e) cover these boundaries. Keep this behavior when extending the shared contracts.
