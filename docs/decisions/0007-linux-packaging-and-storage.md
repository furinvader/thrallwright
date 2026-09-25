# ADR 0007: Linux installation, command-line launch, and storage locations

Status: Accepted, 2026-09-25. Implemented for the first slice; see the [workbench guide](../workbench.md) and [integration evidence](../integration/codex.md).

## Context

The initial application is a local service with a browser interface. The maintainer wants a Linux command that can launch from a source checkout, with easy installation for both users and developers. Users should not have to assemble compatible runtime versions or native dependencies themselves.

Linux is the only initial target. A future hosted deployment or support for other operating systems through a VM remains possible, without requiring those deployment formats now. The existing runtime and native SQLite choices are recorded in [ADR 0005](0005-backend-libraries.md).

## Decision

Use Nix to manage the application runtime and development toolchain. Provide two explicit outputs from a repository flake with locked inputs:

- A runnable package containing the built frontend, backend, selected Node runtime, JavaScript dependencies, and required native dependencies.
- A development shell providing the same selected toolchain and the tools needed to build, test, and develop the application, including native dependency builds.

Keep JavaScript dependencies locked as well. The workspace manifests declare exact direct versions and the pnpm lockfile pins the resolved graph. The Nix package selects its Codex executable explicitly rather than depending on an arbitrary global installation. Codex retains ownership of authentication, permissions, execution, and its own storage.

A development shell supplies an environment; it does not by itself install JavaScript dependencies or produce a runnable application. Define the dependency installation and build steps explicitly. [ADR 0008](0008-repository-and-developer-tooling.md) selects pnpm and a just-based developer command interface, both supplied by Nix. Nix supports building and running an application through `nix run` and entering its development environment through `nix develop`. [Nix run](https://nix.dev/manual/nix/2.34/command-ref/new-cli/nix3-run.html), [Nix develop](https://nix.dev/manual/nix/2.34/command-ref/new-cli/nix3-develop.html)

Document the one-time Nix installation and required feature setup. Dependency management covers Thrallwright and its selected harness integration. Each target workspace can have its own development environment; Thrallwright does not automatically provision arbitrary project dependencies. Nix dependency management does not replace the harness's runtime isolation or permission mechanisms.

## Command-line launch

The installed Nix package provides a `thrallwright` command:

```sh
thrallwright --workspace /path/to/project
```

The command starts the local service, serves the built browser interface, prints its address, and opens the browser. `--no-open` suppresses browser launch. From a checkout, `nix run . -- --workspace /path/to/project` runs the same package; `nix profile add .#thrallwright` installs the command into a Nix profile. See the [development guide](../development.md#run-the-packaged-application) for current usage.

`nix run` or `nix build` can rebuild changed checkout sources. `just dev` is the separate watch-mode workflow for contracts, service, and browser changes.

Preserve the caller's working directory when resolving relative workspace paths. The Thrallwright source checkout and the agent's workspace are distinct locations even when the maintainer happens to use the same directory for both.

## Storage locations and ownership

Use XDG locations by default and respect valid absolute environment-variable overrides. The defaults below apply when those variables are unset or empty. [XDG Base Directory Specification](https://specifications.freedesktop.org/basedir/latest/)

| Contents | Base variable | Default application directory |
| --- | --- | --- |
| User settings and launch configuration | `XDG_CONFIG_HOME` | `~/.config/thrallwright/` |
| SQLite database and durable application data | `XDG_DATA_HOME` | `~/.local/share/thrallwright/` |
| State directory, reserved for diagnostic logs | `XDG_STATE_HOME` | `~/.local/state/thrallwright/` |
| Separate disposable file caches, if needed | `XDG_CACHE_HOME` | `~/.cache/thrallwright/` |

The SQLite database contains both durable application records and cache tables under [ADR 0004](0004-persistence-and-workflow-sources.md). Treat the entire database file as durable data and evict cache records within it. This decision does not require separate databases or duplicate workspace configuration in settings files; workspace records retain the ownership assigned in ADR 0004.

Keep normal application data independent of the application checkout so moving, replacing, or deleting that checkout does not remove user data. Workflow JSON remains at its configured external source location.

`--profile-dir PATH` provides an isolated application profile. It keeps settings, data, state, and cache directories together in one location, such as the gitignored `.thrallwright-dev/` used by `just dev`. Isolation applies to Thrallwright's profile; it does not implicitly relocate Codex's storage or change the workspace.

## Tradeoffs and alternatives

Nix introduces a one-time prerequisite for users and packaging maintenance for the project. In exchange, the application can supply a consistent dependency set across normal use and development. The package builds the native SQLite binding for its selected Node runtime; `just package-smoke` launches the resulting package outside the checkout and checks SQLite and browser assets.

Docker remains a possible later deployment format. Local host workspaces require explicit mounts and attention to paths and file permissions, adding integration work to the initial local experience. Container-based deployment becomes more attractive when execution workspaces are deliberately provisioned inside containers. [Docker bind mounts](https://docs.docker.com/engine/storage/bind-mounts/)

A native checkout bootstrap remains technically possible, but requiring users to supply compatible Node and native build dependencies does not meet the selected installation goal as well. Other operating systems, release distribution infrastructure, and hosted deployment are deferred.

## Verification

CI runs `just package-smoke` on x86_64 Linux. It launches the packaged application from a temporary directory with a minimal `PATH`, checks the served frontend and native SQLite database, and restarts with the same profile to verify persistence and caller-relative workspace resolution. The separate `just probe` and `just smoke` commands exercise Codex integration; the latter requires authentication and model usage.

Storage tests cover XDG override handling and an isolated profile. The package smoke check launches with `--no-open` and writes its database in the temporary profile. Its wrapper invokes the selected Node and Codex executables by absolute path instead of prepending them to `PATH`, preserving the target workspace's toolchain selection.
