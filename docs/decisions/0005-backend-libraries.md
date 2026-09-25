# ADR 0005: Backend server, validation, and SQLite libraries

Status: Accepted, 2026-09-25. Implemented for the first slice; see the [workbench guide](../workbench.md) and [integration evidence](../integration/codex.md).

## Context

Thrallwright uses TypeScript and Node.js, an Angular browser interface, a shared WebSocket protocol, and SQLite persistence. The next implementation choices should support the explicit ownership and feature boundaries in [ADR 0001](0001-typescript-and-event-architecture.md), the protocol in [ADR 0003](0003-websocket-protocol.md), and the storage policy in [ADR 0004](0004-persistence-and-workflow-sources.md).

## Decision

| Concern | Library | Reason |
| --- | --- | --- |
| HTTP server and lifecycle | Fastify | Scoped plugins and lifecycle hooks support a persistent local service. |
| WebSocket server integration | `@fastify/websocket` | Integrates connection handling, shutdown, and WebSocket testing with Fastify. |
| Shared runtime validation | Zod | Readable schemas, inferred TypeScript types, and explicit parse results suit feature-organized contracts. |
| SQLite driver | `better-sqlite3` | Established prepared-statement and transaction APIs with query-builder support. |
| Queries and migrations | Kysely | Type-safe queries close to SQL and explicit migrations support locally inspectable persistence operations. |

Select compatible package versions and the supported Node version when scaffolding the implementation. This decision selects libraries without installing dependencies or implementing behavior.

## Server boundaries

Construct feature services and their dependencies explicitly in application startup. Pass them into a thin transport adapter that routes validated commands to named feature handlers. Keep domain transitions independent of Fastify and keep plugin scopes and registration order easy to find.

Fastify owns HTTP infrastructure and the WebSocket integration. Feature services retain the lifecycle responsibilities from ADR 0001. Coordinate connection closure, outstanding work, and database shutdown deliberately; HTTP shutdown alone does not establish that feature work has finished.

HTTP route validation does not automatically validate messages after a WebSocket upgrade. Parse messages, validate them, and handle message-processing errors explicitly in the connection adapter. [Fastify WebSocket documentation](https://github.com/fastify/fastify-websocket)

## Shared schemas

Put browser-safe Zod schemas in shared contracts organized by feature and derive the corresponding TypeScript message types from them. Validate external inputs before dispatch and retain explicit command, response, snapshot, and event distinctions.

Define unknown-field handling deliberately for each protocol boundary. Keep wire validation easy to inspect, and make any normalization, coercion, or defaults explicit. Zod can represent different input and output types when schemas transform values; protocol types must describe the intended wire representation. [Zod basics](https://zod.dev/basics)

Database row types and internal harness representations remain separate from public protocol contracts. Choosing Zod does not impose a recognized schema on workflow content: arbitrary valid JSON remains inspectable.

## Persistence and responsiveness

Use Kysely through small feature-local persistence operations backed by `better-sqlite3`. Use explicit migrations and keep database type definitions aligned with the actual schema. The precise schema and any type-generation tooling remain implementation details. [Kysely migrations](https://kysely.dev/docs/migrations)

The driver executes synchronously. A Promise-returning query method does not make the underlying database work nonblocking. Keep queries and transactions bounded, keep harness/network operations outside database transactions, and measure responsiveness during activity ingestion and history reads. If database work interferes with streaming or controls, move it behind a dedicated database worker while preserving feature interfaces. A worker is not required by this decision. [better-sqlite3 documentation](https://github.com/WiseLibs/better-sqlite3)

The native driver adds installation and packaging requirements that must be checked on the supported platforms. [ADR 0007](0007-linux-packaging-and-storage.md) selects Linux and Nix-managed packaging and development dependencies. Transactions preserve local database consistency; the command journal still cannot commit atomically with a Codex operation.

## Alternatives

Hono is the closest server alternative, offering a smaller routing layer with more lifecycle coordination in application code. NestJS offers stronger framework conventions at the cost of more concepts and indirection. Express and bare Node HTTP remain viable but offer less benefit for the selected structure.

Valibot is a close validation alternative for functional composition and modularity. TypeBox is attractive if JSON Schema interoperability becomes central. Zod is selected for the readability of shared protocol definitions, without claiming superior coding-agent performance.

Drizzle is the closest persistence alternative when TypeScript table definitions and generated migrations are preferred. Kysely is selected for explicit queries and migrations. Built-in `node:sqlite` remains a possible future driver alternative; adopting it would require checking API maturity, runtime support, and query-layer compatibility.

## Verification during implementation

Exercise malformed WebSocket messages, transport shutdown with active work, and migrations against an existing database. Verify that ordinary feature tests can supply explicit fake dependencies, that shared contracts compile for both browser and service, and that database workloads leave approval and interrupt handling responsive.
