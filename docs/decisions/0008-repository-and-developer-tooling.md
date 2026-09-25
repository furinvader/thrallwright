# ADR 0008: Repository structure and a just-based developer interface

Status: Accepted, 2026-09-25. Implemented for the first slice; see the [workbench guide](../workbench.md) and [integration evidence](../integration/codex.md).

## Context

The runtime, UI, protocol, persistence, and Linux packaging choices are recorded in ADRs 0001 through 0007. Repository boundaries and development commands should make those choices easy to navigate and verify, including for coding agents with limited context.

The maintainer wants `just` to provide the main developer command interface so changes to package managers, script locations, or build tools do not require developers to rediscover routine commands.

## Repository and package boundaries

Use one repository with three private pnpm workspace packages, released together as one application:

```text
apps/
  web/                  Angular application
  server/               Node service and CLI entry point
packages/
  contracts/            Browser-safe Zod schemas and protocol types
tests/
  e2e/                  Tests spanning browser and service
docs/
  decisions/            Architectural decisions
justfile                Main developer command interface
flake.nix               Runtime package and development environment
```

Both applications depend on `contracts`; neither imports the other application's implementation. Contracts do not depend on either application, Angular, Node-only APIs, database rows, or raw harness representations. Organize public schemas by feature, following [ADR 0003](0003-websocket-protocol.md).

Organize each application's implementation by feature. Keep related state, transitions, effect handling, and tests close together. Dependencies on shared infrastructure have named contracts and explicit startup wiring, following [ADR 0001](0001-typescript-and-event-architecture.md). Feature folders do not each need a separately built package. Add shared packages only when concrete boundaries justify them.

Enforce the intended import boundaries with lint rules and maintain a short repository map. Folder layout and workspace linking alone do not enforce architecture.

Use one pnpm workspace lockfile and explicit `workspace:` dependencies for local packages. Pin pnpm in the Nix-managed toolchain. The workspace protocol requires a local package rather than silently resolving that dependency from the registry. [pnpm workspaces](https://pnpm.io/workspaces)

Pin every direct dependency declaration to an exact version, including development, optional, and peer dependencies. Local references use `workspace:<exact version>`. Save exact versions by default, enforce declarations before setup and in CI, and use frozen lockfiles for routine installs. Dependency updates explicitly opt into changing the lockfile and receive review of the complete dependency diff. The lockfile pins the transitive graph and integrity hashes; exact direct versions alone do not freeze transitive dependencies. See the [dependency update procedure](../development.md#dependency-versions).

## Developer command interface

Use a root `justfile` as the documented entry point for development and CI tasks. Begin with one file and concise recipe descriptions; split into included files only when its size warrants it. Configure bare `just` to list available commands. `just` provides recipe discovery and parameterized commands. [Just manual](https://just.systems/man/en/), [listing recipes](https://just.systems/man/en/listing-available-recipes.html)

The root `justfile` provides:

| Command | Purpose |
| --- | --- |
| `just setup` | Check dependency declarations, install the frozen lockfile, prepare native dependencies, and build contracts. |
| `just dev [CLI options]` | Start contracts, service, and browser watch processes; pass options such as `--workflow PATH` to the service. |
| `just check-deps` | Reject non-exact first-party dependency declarations. |
| `just check` | Check dependency declarations, formatting, lint, compilation, and fast tests. |
| `just test [server\|web\|contracts] [runner arguments]` | Run all fast tests or focus on one package. |
| `just test-e2e [Playwright arguments]` | Build and run browser-to-service workflows. |
| `just build` | Produce release assets. |
| `just format` | Apply formatting explicitly. |
| `just probe [--smoke]` | Check Codex RPCs; the optional smoke mode makes real model calls. |
| `just smoke [--controls] [--workspace PATH]` | Exercise the browser against real Codex; requires authentication and model usage. |
| `just package-smoke` | Build and launch the Nix package outside the checkout. |

Bare `just` lists the recipes. `just check` does not rewrite source files; `just format` does.

Keep recipes thin and their behavior easy to inspect. Delegate to package-local scripts and existing tools; define each underlying build or test operation once. pnpm manages JavaScript dependencies and workspace tasks, Angular and TypeScript perform compilation, and test runners own test execution. `just` coordinates those commands without becoming a second build system or a custom process supervisor. Put substantial orchestration in a named script when necessary.

Nix supplies `just`, pnpm, and the development dependencies selected in [ADR 0007](0007-linux-packaging-and-storage.md). The initial workflow is `nix develop`, then `just setup` and `just dev`. A noninteractive equivalent is `nix develop -c just check` after setup. Obtaining the development environment must not require an already-installed `just`, and recipes inside it do not recursively enter Nix shells.

Documentation and CI use the same public recipes. Nix packaging invokes the same underlying build tasks in its prepared build environment, without duplicating build logic or running the development bootstrap.

Repository tasks normally run from the root justfile's directory, matching just's default. Any recipe that accepts a target workspace must explicitly define how relative paths resolve. Keep the installed `thrallwright` command and its caller-relative workspace semantics independent of developer recipes. [Just working directory](https://just.systems/man/en/working-directory.html)

## Build and quality tools

| Concern | Choice |
| --- | --- |
| Frontend build and development server | Angular CLI's supported application builder. |
| Backend and contracts compilation | TypeScript compiler. |
| Unit and integration tests | Vitest; Angular tests use its CLI integration. |
| Complete browser workflows | Playwright. |
| Linting | ESLint with TypeScript and Angular ESLint rules. |
| Formatting | Prettier. |

Angular's supported build and testing pipelines handle framework-specific compilation. Browser and Node compiler environments remain distinct while sharing strictness defaults. Exact manifest declarations and the pnpm lockfile select concrete tool versions. [Angular build system](https://angular.dev/tools/cli/build-system-migration), [Angular testing](https://angular.dev/guide/testing), [Angular ESLint](https://github.com/angular-eslint/angular-eslint)

Compile contracts to JavaScript and declarations with explicit package exports. Use the same package import paths during development and in installed code. Build contracts before their consumers; the development command handles initial readiness and subsequent rebuilds.

Place behavioral tests beside their features. Prioritize lifecycle transitions, approval handling, cancellation, reconnects, and uncertain command outcomes. Integration tests use temporary SQLite databases and controlled harness responses. Most automated checks require neither harness credentials nor paid model calls; real Codex integration has a separate smoke check. Use a small Playwright suite for browser-to-service workflows. [Playwright documentation](https://playwright.dev/docs/intro)

Provide focused checks for individual packages and features. Include native and test-browser dependencies in the managed development setup. Verify the packaged application from outside the source checkout early, including frontend assets and the native SQLite driver.

## Tradeoffs and alternatives

`just` adds a small command layer and a tool dependency, which Nix supplies. Its value is a discoverable, stable developer interface. Preserve direct access to underlying tools for debugging and keep forwarding transparent.

npm workspaces remain a viable alternative. pnpm is selected for explicit local dependency links and workspace support, without making its commands the public developer interface.

Nx remains a credible option for more extensive project graphs, dependency rules, and build coordination. Start with workspace tasks and explicit import rules; revisit an additional orchestrator if project growth or CI costs justify it. Do not add Nx or Turborepo initially.

## Verification

The CI workflow runs `just setup`, `just check`, `just build`, `just test-e2e`, and `just package-smoke` through the Nix development shell. `just setup` runs the dependency policy check before its frozen install, while `just check` repeats that check with formatting, lint, compilation, and fast tests. Focused tests run through `just test PACKAGE`. The development supervisor waits for both service and browser readiness and stops its child process groups on shutdown. The package smoke check verifies caller-relative workspace resolution and profile persistence outside the checkout.
