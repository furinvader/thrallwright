# Architecture decisions

These records capture the accepted implementation direction for Thrallwright. All eight decisions are accepted. The selected stack and ownership boundaries are in place for the first slice; the records also contain design guidance for further development. Each record's implementation notes and linked code establish which patterns are currently present. See the [workbench guide](../workbench.md) for supported behavior and the [Codex integration evidence](../integration/codex.md) for verified boundaries.

The [product specification](../product-spec.md), [feature requirements](../features.md), [conceptual model](../domain-model.md), and [first implementation slice](../first-slice.md) define the product's behavior and capability boundaries. The decisions below describe the architecture used by the initial implementation. They do not turn implementation choices into permanent product requirements.

| Decision | Accepted direction |
| --- | --- |
| [0001: TypeScript and event/effect ownership](0001-typescript-and-event-architecture.md) | Strict TypeScript and Node.js; Codex first; feature services, explicit effects, and RxJS at reactive I/O boundaries. |
| [0002: Angular UI](0002-angular-ui.md) | Standalone, zoneless Angular; signals for view state and RxJS at observation boundaries. |
| [0003: WebSocket protocol](0003-websocket-protocol.md) | Shared, validated commands, responses, snapshots, and events; explicit snapshot-based recovery. |
| [0004: Persistence and workflow sources](0004-persistence-and-workflow-sources.md) | SQLite for application records, command evidence, and bounded history caching; an independent read-only JSON workflow source. |
| [0005: Backend libraries](0005-backend-libraries.md) | Fastify, `@fastify/websocket`, Zod, better-sqlite3, and Kysely. |
| [0006: Minimal UI and Angular Material](0006-angular-material-and-minimal-ui.md) | Material controls, a simple theme, and ordinary CSS layout for the first useful workbench. |
| [0007: Linux packaging and storage](0007-linux-packaging-and-storage.md) | Linux-only initially; Nix runtime package and development environment; a `thrallwright` command; XDG storage and an optional isolated development profile. |
| [0008: Repository and developer tooling](0008-repository-and-developer-tooling.md) | Three pnpm workspace packages; `just` as the developer interface; Angular CLI, TypeScript, Vitest, Playwright, ESLint, and Prettier. |

Concrete versions are pinned in the Nix flake and lockfile, exact package manifests, and pnpm lockfile. Routine Node dependency installs use a frozen lockfile, with exact-version policy checks in setup, CI, and packaging. The [database migrations](../../apps/server/src/storage/database.ts) and [shared contracts](../../packages/contracts/src/index.ts) define the initial schema and protocol. The [development guide](../development.md) documents the working commands; automated tests and sanitized real-Codex smoke reports record verification. The decisions describe architectural intent, while those implementation artifacts establish the tested details.

When implementation evidence requires a material change, explicitly amend or supersede the relevant decision and explain the consequence. Update product documentation in the same change when user-visible requirements change.
