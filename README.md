# Thrallwright

**A workbench for your agents.**

Thrallwright is a local Linux workbench for observing and directing AI agents, managing sessions, and tracking persistent workflows. The first implementation supports Codex and a read-only JSON workflow source, with a browser UI backed by a local service.

The product exists to bring two views of agent work together:

1. **What the agents are doing** — sessions, activity, status, relationships, approvals, results, and available controls.
2. **Where the work stands** — durable workflow state that can outlive any one session or conversation.

Thrallwright wraps existing agents and harnesses. Codex retains ownership of execution, authentication, permissions, and conversation history; your workflow file remains the source of truth for work state.

## Run the workbench

Install [Nix](https://nixos.org/download/) with flakes and `nix-command` enabled; see the [setup prerequisite](docs/development.md#prerequisite). Nix supplies the pinned Node runtime, Codex CLI, and native dependencies.

From the project you want to observe:

```sh
nix run github:furinvader/thrallwright -- --workspace "$PWD"
```

To inspect a workflow file too, add `--workflow tasks.json`; its path is relative to the selected workspace. The file must already exist or be created by you or another tool. The service opens the browser at `http://127.0.0.1:4318`. Add `--no-open` for headless use, or `--port PORT` to choose another port. Stop the service with Ctrl+C.

For a persistent `thrallwright` command:

```sh
nix profile add github:furinvader/thrallwright#thrallwright
thrallwright --workspace /path/to/project --workflow tasks.json
```

Codex must be configured for the provider you use before starting model work. The [development and installation guide](docs/development.md) covers login with the managed Codex CLI, storage locations, running from a checkout, and supported Linux targets. The first run may take time while Nix downloads and builds the pinned environment.

## What works today

The initial Codex/JSON slice is implemented and has been exercised against real Codex:

- Discover saved sessions for the selected workspace and inspect available activity.
- Start a conversation, explicitly resume a saved one, send input, and interrupt a turn when the integration exposes those controls.
- Respond to supported command and file-change approval requests. Approval flows are tested with controlled protocol and browser fixtures; the recorded live smoke run did not encounter an approval request.
- Inspect arbitrary JSON alongside session activity, observe external file changes, and see missing, malformed, or unreadable source errors.
- Retain session metadata, bounded activity history, and command evidence across restarts. Uncertain command outcomes remain visible, and recovery never automatically resends work.

Thrallwright currently serves one local user and one workspace per service. It cannot attach to arbitrary externally running Codex CLI processes; saved history is distinct from live control. Workflow editing, a source-control change view, rich subagent graphs, and hosted collaboration are deferred. See [Using the workbench](docs/workbench.md) for controls, retention limits, and recovery behavior, and the [first-slice verification record](docs/first-slice.md#14-verification-record) for evidence.

## Develop

```sh
git clone https://github.com/furinvader/thrallwright.git
cd thrallwright
nix develop
just setup
just dev
```

Open `http://127.0.0.1:4200` for the development UI. `just dev` uses an isolated `.thrallwright-dev/` profile and stops its development processes on Ctrl+C. Use `just dev --workflow tasks.json` to inspect a workflow while developing.

Run `just` to list developer commands. `just check` runs dependency-policy, formatting, lint, build, and fast-test checks; `just test-e2e` exercises browser workflows; `just package-smoke` checks the installed Nix package. Ordinary checks need no Codex credentials or paid model calls.

Node dependency declarations use exact versions, and routine installs require the committed lockfile. Follow the [dependency update procedure](docs/development.md#dependency-versions) for intentional changes. The [development guide](docs/development.md) documents focused tests and the separate real-Codex smoke commands.

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
- [First implementation slice](docs/first-slice.md) — acceptance criteria and verification of the implemented initial milestone.
- [Architecture decisions](docs/decisions/README.md) — accepted stack, boundaries, packaging, and developer tooling.
- [Development guide](docs/development.md) — pinned Linux setup, `just` commands, and packaged launch.
- [Using the workbench](docs/workbench.md) — sessions, activity, workflow sources, and recovery limits.
- [Codex integration](docs/integration/codex.md) — verified capabilities, limitations, and the reproducible probe.
- [AGENTS.md](AGENTS.md) — guidance for implementation agents working in this repository.

## Implementation

The product specification remains technology-neutral. The [architecture decisions](docs/decisions/README.md) record the selected implementation direction: TypeScript and Node.js, Angular and Material, WebSockets, SQLite, a Linux/Nix installation, and a pnpm workspace with `just` as the developer command interface.

The repository contains `apps/server` for the local service and CLI, `apps/web` for the browser UI, and `packages/contracts` for shared validated messages. See the [code map](docs/development.md#code-map) for entry points. Material changes to the accepted direction should be recorded explicitly without silently changing product requirements.
