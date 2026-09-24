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
```

`just setup` installs exactly the lockfile dependencies and compiles shared
contracts. The first command may download the pinned toolchain. `just dev`
starts contract compilation in watch mode, the service, and the Angular browser
server. It waits for both servers to become ready and stops their process groups
on Ctrl+C. The browser server listens at `http://127.0.0.1:4200`; the API is at
`http://127.0.0.1:4318`. Development uses the checkout as its workspace and an
isolated `.thrallwright-dev/` profile, so it does not mix development records
with the normal application profile.

Run `just` to list recipes. Routine checks and builds are:

```sh
just check
just test
just test-e2e
just build
just format
```

`just check` checks formatting, lint, compilation, and fast tests without
rewriting files. `just format` is the explicit rewrite command. `just test`
runs all fast tests, or one package with `just test server`, `just test web`, or
`just test contracts`. Arguments after the package name go to that package's
test runner. `just test-e2e` builds the app first and forwards optional
Playwright arguments, such as a test path. The shell supplies Chromium for
Playwright, so browser tests do not need a separate browser download. `just
probe` checks Codex through read-only RPCs. `just probe --smoke` additionally
starts ephemeral model turns and tests interruption; it requires Codex
authentication and may incur model usage. Ordinary checks need no Codex
credentials or paid model calls.

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

## Run the packaged application

```sh
nix run . -- --workspace /path/to/project
nix run . -- --workspace ../project --no-open
```

The command builds the frontend, backend, production JavaScript dependencies,
and native SQLite driver into one Nix package. It invokes the pinned Node and
Codex executables by absolute path; it does not prepend them to the service's
runtime `PATH`. A relative `--workspace` path is resolved from the directory
where the command is run. `--no-open` keeps the browser closed for headless use.
`nix build .#thrallwright` writes a `result` link; `result/bin/thrallwright`
provides the same command. Run `just package-smoke` to launch the installed
service outside the checkout, check its browser assets and SQLite database,
and restart with the same isolated profile.

The normal profile uses XDG application directories under `thrallwright/`:
`XDG_CONFIG_HOME` for settings, `XDG_DATA_HOME` for the SQLite database,
`XDG_STATE_HOME` for logs, and `XDG_CACHE_HOME` for disposable caches. When
unset, those base directories default to `~/.config`, `~/.local/share`,
`~/.local/state`, and `~/.cache` respectively. The `--profile-dir` option keeps
Thrallwright's files together at an explicit path. This does not relocate
Codex's own storage or authentication. To log in with the managed Codex CLI
without a global installation, run `nix develop -c codex login` before using
actions that require authentication.

Nix packages only Linux for now. The current flake has outputs for x86_64 and
aarch64 Linux; CI checks x86_64 Linux. Chromium and Codex are large parts of the
development environment, so the first `nix develop` or package build may take
time. The package build uses a locked, offline pnpm dependency cache after Nix
fetches its inputs.
