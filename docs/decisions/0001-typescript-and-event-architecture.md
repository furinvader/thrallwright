# ADR 0001: TypeScript and explicit event and effect ownership

Status: Accepted, 2026-09-24. Applied to the first slice with the implementation scope below; see the [workbench guide](../workbench.md) and [integration evidence](../integration/codex.md).

## Context

Thrallwright combines observable agent activity with persistent workflow state. The product scope is defined in the [product specification](../product-spec.md) and [first implementation slice](../first-slice.md). The first implementation uses Codex and a local service with a browser interface.

The architecture should let a developer or coding agent understand one behavior by reading its feature and explicit dependency contracts. Important consequences should be discoverable without loading the whole application into context. This is a design objective, not a claim about measured agent performance or model training data.

## Decision

Use TypeScript with strict checking and Node.js for the local service. Organize substantial behavior into scoped services with pure state transitions, explicit effect handlers, and adapters for I/O. Use RxJS where event composition and reactive I/O are useful.

| Part | Responsibility |
| --- | --- |
| Feature service | Own current application state and the lifecycle of its resources and subscriptions. |
| Pure transition | Interpret a command or observed event and return the next state plus any required effect descriptions. |
| Effect handler | Execute a typed effect through an explicitly supplied adapter and return a result to the owning service. |
| Adapter | Communicate with Codex, files, persistence, or transport; preserve source semantics and validate external data. |
| RxJS pipeline | Compose observations, timing, connection changes, and derived updates with explicit error and cancellation behavior. |
| Shared observation feed | Expose read-only events to activity views, diagnostics, and other consumers. |

Apply this structure proportionately. Session lifecycle and approval handling warrant explicit transitions and effects. A straightforward file read or history query can remain an ordinary async function. Effect handlers can be plain functions or exhaustive switches; begin with concrete operations rather than a generalized effect framework.

Implementation note, 2026-09-25: the first slice uses concrete lifecycle-owning services with explicit adapter calls, subscriptions, and persisted command evidence. [Command policy](../../apps/server/src/features/commands/policy.ts) contains pure capability and operation checks; [commands](../../apps/server/src/features/commands/commands.ts) and [approvals](../../apps/server/src/features/approvals/approvals.ts) coordinate effects through service methods. Not every lifecycle update is expressed as a separate pure transition and effect description. The table guides further extraction as state-handling complexity grows, while ownership and explicit dependencies remain required.

## Ownership and authority

The Node service owns live harness connections and coordinates commands. Codex remains authoritative about agent capabilities, execution, and approvals, including its authentication and permission mechanisms. Workflow state remains authoritative in its configured external source; arbitrary valid JSON must stay inspectable.

A browser store holds a projection of service state and browser-owned state such as selection and draft input. Subscribing, navigating, or closing a browser view does not implicitly start, resume, interrupt, or stop agent work. Full service restart does not guarantee process survival; saved runtime metadata must be reconciled with fresh evidence.

Each process, watcher, and subscription has an explicit lifecycle owner. Share an adapter connection where appropriate and route its events to the relevant feature; a session controller does not imply a separate Codex process per session.

Commands request an operation and have one responsible handler. Events report observations and may have many consumers. Command acknowledgement and confirmed execution outcome are separate concepts. Failed or uncertain delivery remains visible.

## RxJS boundaries

- Keep writable subjects private. Expose observable events and current snapshots separately so late subscribers do not need the entire history to understand current state.
- Construct and connect services explicitly at startup. Resource creation and teardown must be visible, rather than incidental consequences of imports or the number of UI subscribers.
- Scope errors and cancellation to the affected operation or integration. A workflow parse error or failed tool call is domain information, not a reason to terminate unrelated observation.
- Declare ordering, buffering, and retry policies where pipelines coordinate effects. Coalesce presentation updates only after preserving the observations needed for correct state and history.
- Process state transitions serially within their owner while keeping long-running effects asynchronous. Approval responses and interrupts must remain actionable while a turn runs.
- History replay reconstructs projections without access to effect adapters. An RxJS replay buffer is not durable storage, and replay must never resend commands.

## Example: responding to an approval

Names below are illustrative application messages, not a proposed Codex wire protocol.

```text
AnswerApproval command
  -> session service
  -> pure transition validates known request and capability
  -> submitting state + AnswerHarnessApproval effect
  -> explicit effect handler calls Codex adapter
  -> result or subsequent harness event returns to the service
  -> updated snapshot and observable event
```

The command identifies the session, approval, decision, and command correlation ID. An invalid, resolved, or already-submitting request produces no additional harness write. The service records an in-flight response before executing its effect.

Restored approval history is not actionable unless the current integration confirms that the request remains pending and can be answered. After a disconnect or restart, reconcile pending requests before allowing responses.

The adapter sends only a response permitted by the harness. Local validation cannot prevent the request from expiring concurrently, so the service also handles rejection and resolution reported by the harness. A successful transport write alone does not prove approval resolution or subsequent action completion. If delivery becomes uncertain, report that uncertainty and reconcile before retrying.

The transition can be tested with ordinary values. The effect handler can be tested against a fake adapter. Other observers do not independently send the approval response.

## Local understanding and verification

Keep a feature's state, messages, transition rules, effect mapping, and behavioral tests close enough to inspect together. Prefer meaningful feature boundaries over a fixed file count or many tiny layers. Dependencies should be constructor or function parameters, and typed effects should lead directly to their handlers.

Document lifecycle and failure semantics beside the relevant contracts, with a short application map for navigation. The current [code map](../development.md#code-map) identifies feature owners, adapters, storage, and browser boundaries. Use exhaustive handling for internal effect unions and runtime validation at external boundaries.

Implementation checks should demonstrate that:

- adding or removing observers does not change execution or duplicate authoritative state processing;
- replay performs no harness writes;
- duplicate submission of a pending approval causes no second concurrent write;
- interrupts and approval responses remain responsive during active execution;
- workflow failures leave session observation usable;
- restart and reconnect do not present stale state as verified live state.

These checks reduce hidden coupling; they do not eliminate the need for integration tests across feature boundaries.

## Tradeoffs and alternatives

This design adds explicit message and effect types and some lifecycle wiring. It makes resource ownership and the consequences of a decision easier to inspect and test locally.

A globally writable bus or application-wide network of epics can scatter control across distant subscribers. A shared read-only feed retains the observation benefits. Cycle-style drivers inform the I/O boundaries without requiring a full Cycle application. Redux-observable is not part of the initial service core; it remains an option if a later browser-store decision warrants it. State-machine libraries can be evaluated if concrete lifecycle complexity justifies them.

TypeScript was selected for the maintainer's experience, direct ecosystem integration, and flexibility for future collaborators. ClojureScript remains technically viable; the decision does not depend on an unverifiable claim about agent training coverage.

The UI framework and presentation-state direction are recorded in [ADR 0002](0002-angular-ui.md), browser-service communication in [ADR 0003](0003-websocket-protocol.md), persistence ownership in [ADR 0004](0004-persistence-and-workflow-sources.md), and backend libraries in [ADR 0005](0005-backend-libraries.md). Linux support, packaging, and storage locations are recorded in [ADR 0007](0007-linux-packaging-and-storage.md). Additional store libraries require a separate decision. This ADR records an implementation direction and does not change the product's feature requirements.
