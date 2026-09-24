# Thrallwright

**A workbench for your agents.**

Thrallwright is a local workbench for observing and directing AI agents, managing sessions, and tracking persistent workflows.

The product exists to bring two views of agent work together:

1. **What the agents are doing** — sessions, activity, status, relationships, approvals, results, and available controls.
2. **Where the work stands** — durable workflow state that can outlive any one session or conversation.

Thrallwright is intended to wrap existing agents and harnesses rather than replace them. It is not an agent framework, a model runtime, or a general-purpose orchestration platform.

## Product shape

The core experience has three responsibilities:

- **Observe agents.** Show the sessions that exist, what they are working on, what activity their harness exposes, and whether they are running, waiting, finished, or disconnected.
- **Understand workflows.** Show persistent task or workflow state alongside live activity so progress does not have to be reconstructed from terminal output or conversation history.
- **Direct work.** Expose controls that a connected harness genuinely supports, such as starting a session, sending input, responding to an approval request, or interrupting execution.

The interface should be explicit about the difference between observing a saved session, resuming a conversation, and controlling a process that is currently running.

## Initial product goal

The first useful version should be small enough to build and understand, but useful enough that Thrallwright can be used while developing Thrallwright itself.

A narrow integration with one agent harness and one persistent workflow format is sufficient. Breadth should come after the central loop is useful.

## Product principles

- **Capability truth over simulated completeness.** If a harness does not expose a fact or control, the interface must not imply that it does.
- **Persistent work state matters as much as live agent output.** The relationship between agent activity and workflow state is the center of the product.
- **Clear operational language.** Use labels such as Agents, Sessions, Workflows, Approvals, Activity, and Artifacts.
- **Fantasy in the identity, clarity in the interface.** The visual character may reference craftsmanship, workshops, constructs, magical tools, and specialized companions, but controls should remain ordinary and unambiguous.
- **Local-first scope.** The initial product is for a user working with agents in their own development environment.
- **Small before abstract.** Prefer one working integration over a generalized integration architecture that has not yet been proven necessary.

## Documentation

- [Product specification](docs/product-spec.md) — goals, scope, product rules, and user-facing behavior.
- [Feature requirements](docs/features.md) — detailed functional requirements and acceptance conditions.
- [Conceptual model](docs/domain-model.md) — entities, states, capabilities, and relationships without prescribing implementation technology.
- [First implementation slice](docs/first-slice.md) — the smallest end-to-end version an independent implementation agent should build first.
- [Architecture decisions](docs/decisions/README.md) — accepted stack, boundaries, packaging, and developer tooling; implementation is pending.
- [AGENTS.md](AGENTS.md) — guidance for implementation agents working in this repository.

## Implementation direction

The product specification remains technology-neutral. The [architecture decisions](docs/decisions/README.md) record the selected implementation direction: TypeScript and Node.js, Angular and Material, WebSockets, SQLite, a Linux/Nix installation, and a pnpm workspace with `just` as the developer command interface.

These choices are accepted, but implementation is pending. Concrete versions and remaining implementation details should follow the smallest practical path to the first slice. Material changes to the accepted direction should be recorded explicitly without silently changing product requirements.
