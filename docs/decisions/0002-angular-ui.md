# ADR 0002: Angular for the browser interface

Status: Accepted, 2026-09-24. Implemented for the first slice; see the [workbench guide](../workbench.md) and [integration evidence](../integration/codex.md).

## Context

Thrallwright needs session navigation, streaming activity, explicit approval and interruption controls, and workflow JSON inspection. The product scope remains defined in the [product specification](../product-spec.md) and [first implementation slice](../first-slice.md).

[ADR 0001](0001-typescript-and-event-architecture.md) assigns execution coordination to the Node service and keeps harness authority intact. The browser presents service state and manages user interaction. The UI framework should support those boundaries and let developers and coding agents understand features locally.

The maintainer has the most experience with Angular and substantial experience with React. Review fluency and consistent conventions matter more for this decision than unverified claims about model training coverage or framework performance.

## Decision

Use modern Angular with standalone components and zoneless change detection for the browser interface. Organize UI code by feature, with small presentation services where shared state or stream composition warrants them.

| Concern | Approach |
| --- | --- |
| Service observations | A typed browser client exposes read-only projections and explicit connection freshness. |
| Stream composition | RxJS handles event composition, reconnection, timing, and cancellation where useful. |
| Presentation state | Signals hold current view state; computed values derive presentation without copying state through effects. |
| User commands | Ordinary methods send explicit requests through the browser client to the Node service. |
| Interaction state | Draft input, expanded JSON nodes, selection, and scrolling have explicit browser-side owners. |

Keep service-owned facts distinct from browser-owned interaction state. A pending UI request may indicate submission, but only service evidence confirms its outcome. Components must not turn an approval into a resolved action merely because a request was sent.

The browser client owns its observation connection independently of individual presentation components. Navigation and component teardown may release view resources without implicitly starting, resuming, interrupting, or stopping agent work.

## Reactive boundaries and local understanding

Bridge observation streams into signals at deliberate feature boundaries and reuse those bindings. Angular's `toSignal` subscribes immediately and normally cleans up with its creating component or service. Its sources must have deliberate subscription semantics and must not execute agent commands as a side effect of rendering. [Angular RxJS interop](https://angular.dev/ecosystem/rxjs-interop)

Signals represent current state. Preserve event history separately: `toObservable` emits after signal stabilization and can collapse intermediate updates. Expected disconnection and read failures should become explicit presentation states. [Angular RxJS interop](https://angular.dev/ecosystem/rxjs-interop)

Keep related components, presentation logic, contracts, and tests together. Keep provider scopes easy to locate so resource ownership and service lifetimes are clear. Use component inputs and outputs for presentation boundaries, and keep domain transitions in ordinary TypeScript independent of Angular. These choices follow the feature-oriented direction of the [Angular style guide](https://angular.dev/style-guide).

## Alternatives and consequences

Angular provides an integrated framework and conventions, at the cost of additional framework concepts and tooling. Its official signal/RxJS bridge fits the accepted architecture, and the maintainer's experience supports effective review. Consistent boundaries still require discipline around dependency injection and reactive lifetimes.

React is the strongest alternative. Its [external-store API](https://react.dev/reference/react/useSyncExternalStore) fits immutable projections well, but would require more project-specific conventions. A central UI dependency with a materially better React implementation could justify revisiting this choice.

Vue, Svelte, and Solid can support the architecture. Their presentation models are attractive, but no identified product requirement currently justifies introducing a less familiar framework.

[ADR 0006](0006-angular-material-and-minimal-ui.md) selects Angular Material, a simple theme, and ordinary CSS layout for the first interface. Additional store and virtualization libraries remain open. Browser-service communication is recorded in [ADR 0003](0003-websocket-protocol.md), and repository structure, build tools, and testing tools in [ADR 0008](0008-repository-and-developer-tooling.md). Exact package versions and build configuration will be selected when scaffolding the first implementation.

## Verification during implementation

Check that reopening or navigating the UI does not duplicate sessions or send commands; component subscriptions do not duplicate command execution; and disconnected or stale approvals are not presented as actionable. Exercise a growing transcript while preserving the user's reading position, keyboard access to controls, and workflow error visibility.

These are behavioral checks for the eventual implementation. Recording this decision does not implement the UI or change the product scope.
