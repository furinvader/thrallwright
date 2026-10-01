# Future test execution isolation

Status: planned, not implemented. Track scope, ownership, and delivery in
[issue #42](https://github.com/furinvader/thrallwright/issues/42); this note is
a design starting point, not a second backlog or a claim of current isolation.

Current browser tests use OS-assigned ports, per-test temporary state, bounded
startup and health waits, and process-group cleanup. Separate prebuilt worktrees
can run them concurrently. The Nix development shell supplies pinned tools; it
does not isolate networking, credentials, or execution from the host.
Interactive `just dev` still requires one coordinated owner per machine.

The next step is a disposable rootless container per complete validation run.
Keep the service, Chromium, and controlled harness fixtures together inside it,
using the pinned Nix toolchain. Give each run separate writable build/cache,
workspace, profile, and report directories. Define source mounts and ownership
explicitly; do not mount host Codex credentials or unrelated workspaces. Keep
real-model verification separate and opt-in.

Preserve the service's loopback-only binding. Browser tests inside the container
can use that address directly. Interactive development will need an explicit,
controlled localhost forwarding design rather than exposing the API on all host
interfaces. Define graceful signal forwarding, bounded forced cleanup, container
removal, and extraction of failure artifacts before disposal.

Revisit this work when parallel validation needs isolation beyond port/state
collisions or when agents need disposable execution environments. Acceptance
requires two concurrent complete source/browser/package runs with distinct
writable state, useful failure artifacts, and no surviving child processes or
containers after success, failure, or interruption. Verify that host credentials
are inaccessible and forwarding remains local-only. Consider a VM only if a
separate guest kernel is required; do not add a VM merely to solve test ports.
