# Development and Linux installation

Thrallwright currently targets Linux on `x86_64` and `aarch64`. The flake pins
Nixpkgs, Node 24, pnpm 10, the Codex CLI, native build tools, Chromium, and
`just`. The pnpm lockfile pins JavaScript packages. Each target workspace still
provides its own project dependencies; Thrallwright does not change that
workspace's toolchain.

## Prerequisite

Install [Nix](https://nixos.org/download/) with flakes and the `nix-command`
feature enabled. For example, add the following to your Nix configuration:

```text
experimental-features = nix-command flakes
```

`nix develop` works before `just` or Node is installed on the host. An optional
`.envrc` calls `use flake` for users who already use direnv and nix-direnv.

## Work in a checkout

```sh
nix develop
just setup
just dev
just dev --workflow tasks.json
```

`just setup` installs exactly the lockfile dependencies and compiles shared
contracts. The first command may download the pinned toolchain. `just dev`
starts contract compilation in watch mode, the service, and the Angular browser
server. It waits for both servers to become ready and stops their process groups
on Ctrl+C. The browser server listens at `http://127.0.0.1:4200`; the API is at
`http://127.0.0.1:4318`. Development uses the checkout as its workspace and an
isolated `.thrallwright-dev/` profile, so it does not mix development records
with the normal application profile. Extra `just dev` arguments go to the
service CLI; `--workflow tasks.json` reads a JSON file relative to the checkout
workspace and saves that selection in the development profile.

Run `just` to list recipes. Routine checks and builds are:

```sh
just check
just test
just test-e2e
just build
just format
```

`just check` checks exact dependency declarations, formatting, lint, compilation,
and fast tests without rewriting files. `just format` is the explicit rewrite
command. `just test` runs all fast tests, or one package with `just test server`,
`just test web`, or `just test contracts`. Arguments after the package name go
to that package's test runner; the small Node tooling-test suite also runs for
focused tests. `just test-e2e` builds the app first and forwards
optional Playwright arguments, such as a test path. The shell supplies Chromium for
Playwright, so browser tests do not need a separate browser download. `just
probe` checks Codex through read-only RPCs. `just probe --smoke` additionally
starts ephemeral model turns and tests interruption; it requires Codex
authentication and may incur model usage. Ordinary checks need no Codex
credentials or paid model calls.

`just smoke [--workspace PATH]` exercises the browser and service against a
real, logged-in Codex CLI. It starts one model turn and can consume paid model
usage, so run it deliberately rather than as part of ordinary CI. The default
workspace is the repository root because `just` runs recipes there; pass
`--workspace` to use a specific project. Relative paths passed to this recipe
also resolve from the repository root. The check creates a temporary application
profile and workflow file.
`just smoke --controls [--workspace PATH]` extends that check through a real
service restart using the same temporary profile and workflow reference,
explicit Resume, Send, and Interrupt. It starts three model turns in total,
including one that is interrupted, and may consume more model usage. Neither
smoke command runs in ordinary CI.

Noninteractive CI commands use the same interface after setup:

```sh
nix develop -c just setup
nix develop -c just check
nix develop -c just build
nix develop -c just test-e2e
```

The workspace contains `packages/contracts` for browser-safe protocol schemas,
`apps/server` for the Node service and CLI, and `apps/web` for Angular. Both
applications import contracts through its package exports. Build contracts
before running either consumer when working outside the just recipes.

## Code map

- **Entry and transport:** [CLI](../apps/server/src/cli.ts) parses launch options;
  [application startup](../apps/server/src/app.ts) wires services, HTTP, and WebSocket.
- **Backend features:** [sessions](../apps/server/src/features/sessions/sessions.ts),
  [workflow JSON](../apps/server/src/features/workflow/workflow.ts),
  [commands and journal](../apps/server/src/features/commands/commands.ts),
  [auth](../apps/server/src/features/integration/auth.ts), and
  [approvals](../apps/server/src/features/approvals/approvals.ts).
- **Codex and storage:** [app-server adapter](../apps/server/src/integrations/codex.ts),
  [XDG/profile paths](../apps/server/src/storage/paths.ts),
  [SQLite schema and migrations](../apps/server/src/storage/database.ts), and
  [observation storage](../apps/server/src/storage/observations.ts).
- **Browser and protocol:** [Angular workbench](../apps/web/src/app/app.ts),
  [WebSocket connection](../apps/web/src/app/workbench-connection.ts), and
  [shared contracts](../packages/contracts/src/index.ts).
- **Tests and tooling:** colocated `*.test.ts` / `*.spec.ts`,
  [browser workflows](../tests/e2e/), [developer recipes](../justfile), and
  [scripts](../scripts/).

## Dependency versions

All first-party `package.json` dependency declarations use exact versions,
including development, optional, and peer dependencies. Local packages use an
exact workspace reference such as `workspace:0.1.0`. pnpm saves exact versions
for new additions by default. `just check-deps` validates every workspace
manifest without needing installed dependencies; `just setup` runs it before
installation, and `just check` runs it in CI.

Ordinary `pnpm install` uses a frozen lockfile, including outside CI. Missing or
outdated lockfiles cause an error rather than silently resolving a new tree.
Commit `pnpm-lock.yaml` alongside manifest changes: it pins the transitive
dependencies and their integrity hashes as well as direct dependencies. Do not
delete it to fix an installation error.

For a deliberate addition or update, select a specific version with `pnpm add`.
Unlike an ordinary install, this command explicitly changes the manifest and
lockfile. For example, the syntax for setting the server's RxJS pin is:

```sh
pnpm --filter @thrallwright/server add rxjs@7.8.2
just check-deps
just check
just package-smoke
```

Use `-D` for development dependencies or `-w` for root tooling. Specify an exact
version: an explicit range such as `rxjs@^7.8.2` can still be saved as a range,
which `just check-deps` rejects. If you edit a manifest manually,
`pnpm install --no-frozen-lockfile` explicitly permits regenerating the
lockfile. Review the manifest and full lockfile diff, including transitive
changes. When the resolved graph changes, recalculate the Nix dependency-cache
hash: temporarily set `pnpmDeps.hash` in `flake.nix` to `pkgs.lib.fakeHash`, run
`nix build .#thrallwright`, replace the fake hash with the actual hash reported
by the mismatch error, and rerun `just package-smoke`. This forces Nix to fetch
the changed graph instead of reusing the old cache. A manifest-only pin change
to an already locked version may leave the cache hash unchanged. Keep dependency
changes in a reviewable commit. Exact pins
prevent unintended version drift; selecting and reviewing trustworthy versions
remains necessary.

## Run the packaged application

```sh
nix run . -- --workspace /path/to/project --workflow tasks.json
nix run . -- --workspace ../project --no-open
```

To keep `thrallwright` on the command line, install the checkout into a Nix
profile with `nix profile add .#thrallwright`, then run
`thrallwright --workspace /path/to/project --workflow tasks.json`. Older Nix
versions call this profile subcommand `install`.

The command builds the frontend, backend, production JavaScript dependencies,
and native SQLite driver into one Nix package. It invokes the pinned Node and
Codex executables by absolute path; it does not prepend them to the service's
runtime `PATH`. A relative `--workspace` path is resolved from the directory
where the command is run. `--no-open` keeps the browser closed for headless use.
`--workflow` selects a JSON file relative to the chosen workspace and persists
that selection in the application profile for later launches. See
[the workbench guide](workbench.md) for workflow and session behavior.
`nix build .#thrallwright` writes a `result` link; `result/bin/thrallwright`
provides the same command. Run `just package-smoke` to launch the installed
service outside the checkout, check its browser assets and SQLite database,
and restart with the same isolated profile.

The normal profile uses XDG application directories under `thrallwright/`:
`XDG_CONFIG_HOME` for settings, `XDG_DATA_HOME` for the SQLite database,
`XDG_STATE_HOME` for state such as future diagnostic logs, and `XDG_CACHE_HOME`
for separate disposable file caches if needed. Session cache records currently
live in the SQLite database. When unset, those base directories default to
`~/.config`, `~/.local/share`, `~/.local/state`, and `~/.cache` respectively. The
`--profile-dir` option keeps
Thrallwright's files together at an explicit path. This does not relocate
Codex's own storage or authentication. To log in with the managed Codex CLI
without a global installation, run `nix develop -c codex login` from the
Thrallwright checkout before using actions that require authentication. Without
a checkout, use `nix develop github:furinvader/thrallwright -c codex login`.
The workbench checks Codex's auth status
with a read-only request and never copies account details into its database.
For a provider that does not require OpenAI authentication, a missing OpenAI
account does not block its controls. See [the workbench guide](workbench.md)
for explicit Resume, Send, Interrupt, and approval behavior.

Nix packages only Linux for now. The current flake has outputs for x86_64 and
aarch64 Linux; CI checks x86_64 Linux. Chromium and Codex are large parts of the
development environment, so the first `nix develop` or package build may take
time. The package build uses a locked, offline pnpm dependency cache after Nix
fetches its inputs.
