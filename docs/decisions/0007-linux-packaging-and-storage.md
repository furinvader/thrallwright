# ADR 0007: Linux installation, command-line launch, and storage locations

Status: Accepted, 2026-09-25. Implemented for the first slice; see the [workbench guide](../workbench.md) and [integration evidence](../integration/codex.md).

## Context

The initial application is a local service with a browser interface. The maintainer wants a Linux command that can launch from a source checkout, with easy installation for both users and developers. Users should not have to assemble compatible runtime versions or native dependencies themselves.

Linux is the only initial target. A future hosted deployment or support for other operating systems through a VM remains possible, without requiring those deployment formats now. The existing runtime and native SQLite choices are recorded in [ADR 0005](0005-backend-libraries.md).

## Decision

Use Nix to manage the application runtime and development toolchain. Provide two explicit outputs from a repository flake with locked inputs:

- A runnable package containing the built frontend, backend, selected Node runtime, JavaScript dependencies, and required native dependencies.
- A development shell providing the same selected toolchain and the tools needed to build, test, and develop the application, including native dependency builds.

Keep JavaScript dependencies locked as well. Select compatible concrete versions during scaffolding and manage a supported Codex executable deliberately rather than depending on an arbitrary global installation. Codex retains ownership of authentication, permissions, execution, and its own storage.

A development shell supplies an environment; it does not by itself install JavaScript dependencies or produce a runnable application. Define the dependency installation and build steps explicitly. [ADR 0008](0008-repository-and-developer-tooling.md) selects pnpm and a just-based developer command interface, both supplied by Nix. Nix supports building and running an application through `nix run` and entering its development environment through `nix develop`. [Nix run](https://nix.dev/manual/nix/2.34/command-ref/new-cli/nix3-run.html), [Nix develop](https://nix.dev/manual/nix/2.34/command-ref/new-cli/nix3-develop.html)

Document the one-time Nix installation and required feature setup. Dependency management covers Thrallwright and its selected harness integration. Each target workspace can have its own development environment; Thrallwright does not automatically provision arbitrary project dependencies. Nix dependency management does not replace the harness's runtime isolation or permission mechanisms.

## Command-line launch

Provide a `thrallwright` command. The intended interface is:

```sh
thrallwright --workspace /path/to/project
```

The command starts the local service, serves the built browser interface, prints its address, and opens the browser. Provide a `--no-open` option for use without browser launch. These commands describe intended behavior and are not implemented yet.

Initially, a small launcher may invoke the Nix package from the source checkout. A later installed release can retain the same interface. A checkout-backed launch can rebuild changed application sources; development with automatic rebuilds is a separate workflow.

Preserve the caller's working directory when resolving relative workspace paths. The Thrallwright source checkout and the agent's workspace are distinct locations even when the maintainer happens to use the same directory for both.

## Storage locations and ownership

Use XDG locations by default and respect valid absolute environment-variable overrides. The defaults below apply when those variables are unset or empty. [XDG Base Directory Specification](https://specifications.freedesktop.org/basedir/latest/)

| Contents | Base variable | Default application directory |
| --- | --- | --- |
| User settings and launch configuration | `XDG_CONFIG_HOME` | `~/.config/thrallwright/` |
| SQLite database and durable application data | `XDG_DATA_HOME` | `~/.local/share/thrallwright/` |
| Diagnostic logs | `XDG_STATE_HOME` | `~/.local/state/thrallwright/` |
| Separate disposable caches, if needed | `XDG_CACHE_HOME` | `~/.cache/thrallwright/` |

The SQLite database contains both durable application records and cache tables under [ADR 0004](0004-persistence-and-workflow-sources.md). Treat the entire database file as durable data and evict cache records within it. This decision does not require separate databases or duplicate workspace configuration in settings files; workspace records retain the ownership assigned in ADR 0004.

Keep normal application data independent of the application checkout so moving, replacing, or deleting that checkout does not remove user data. Workflow JSON remains at its configured external source location.

Provide one explicit directory override for an isolated application profile. It can keep settings, data, logs, and caches together in a gitignored development directory such as `.thrallwright-dev/`. Isolation applies to Thrallwright's profile; it does not implicitly relocate Codex's storage or change the workspace. Exact flag names, settings format, and filenames remain implementation details.

## Tradeoffs and alternatives

Nix introduces a one-time prerequisite for users and packaging maintenance for the project. In exchange, the application can supply a consistent dependency set across normal use and development. Verify the native SQLite build and actual runtime dependencies when scaffolding rather than assuming a development shell makes packaging complete.

Docker remains a possible later deployment format. Local host workspaces require explicit mounts and attention to paths and file permissions, adding integration work to the initial local experience. Container-based deployment becomes more attractive when execution workspaces are deliberately provisioned inside containers. [Docker bind mounts](https://docs.docker.com/engine/storage/bind-mounts/)

A native checkout bootstrap remains technically possible, but requiring users to supply compatible Node and native build dependencies does not meet the selected installation goal as well. Other operating systems, release distribution infrastructure, and hosted deployment are deferred.

## Verification during implementation

Verify installation and launch on a supported Linux environment without a preinstalled application toolchain. Exercise the native SQLite dependency, Codex startup, and the frontend served by the packaged application. Confirm that launch from another directory resolves the requested workspace correctly.

Verify XDG overrides, an isolated development profile, persistence across application updates, and launch without opening a browser. Check that the application runs without writing into its installed package and that its runtime environment does not unintentionally override the target workspace's own toolchain.
