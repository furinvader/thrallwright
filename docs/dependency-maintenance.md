# Dependency maintenance

Alex (`furinvader`) owns a manual dependency review each calendar month and may
delegate its implementation. Address urgent security or compatibility fixes
sooner. This is a maintainer responsibility, not a scheduled job: the repository
does not use an update bot.

Record each review in a GitHub issue, including its date, owner, dependency groups
reviewed, selected updates or reasons to defer them, and linked PRs. A review that
finds no changes still records that result. Keep deferred work linked and visible.
Follow the [contribution workflow](../CONTRIBUTING.md) for implementation, review,
and merge authorization.

## Review and group updates

Review upstream release notes, compatibility requirements, and relevant security
advisories before selecting exact versions. Keep unrelated updates in separate
PRs; coordinate packages that must move together, particularly Angular core,
CLI/build tooling, Material/CDK, Angular ESLint, TypeScript, RxJS, and supported
Node versions. Include migration or configuration changes in the same PR as the
update that requires them.

The review covers three dependency sources:

- JavaScript manifests and `pnpm-lock.yaml`, including development tools and
  transitive changes. Check peer requirements and native SQLite compatibility.
- GitHub Actions in `.github/workflows/`, including action release notes, runtime
  requirements, permissions, and compatibility with the selected runner.
- The Nixpkgs input in `flake.nix` and `flake.lock`, which selects Node, pnpm,
  Codex, Chromium, native tools, and runtime libraries together.

## JavaScript dependencies

Use the [deliberate update procedure](development.md#dependency-versions).
Preserve exact versions in every dependency declaration and
`workspace:<exact version>` for local packages. Routine installs use the committed
frozen lockfile; do not delete it or disable frozen installs to work around drift.

Select an explicit version with `pnpm add`, or intentionally regenerate the
lockfile with `pnpm install --no-frozen-lockfile` after manual manifest edits.
Run `just check-deps` when editing manifests and review the entire manifest and
lockfile diff, including unexpected transitive changes and integrity entries.

When the resolved graph changes, update the Nix dependency cache deliberately:

1. Temporarily set `pnpmDeps.hash` in `flake.nix` to `pkgs.lib.fakeHash`.
2. Run `nix build .#thrallwright`; the dependency fetch should report a hash
   mismatch with the actual hash. Resolve any other build failure first.
3. Replace the fake hash with the reported hash and run `just package-smoke`.
4. Commit the manifest, lockfile, and applicable hash changes together. Never
   commit the fake hash or bypass integrity checking.

A manifest-only pin change to an already locked version may leave the cache hash
unchanged. A Nixpkgs or pnpm fetcher change can alter the cache format even if the
JavaScript graph is unchanged; investigate the cause and use the same procedure
when a new cache hash is needed.

## GitHub Actions

For action updates, verify the selected release in the action's upstream
repository and pin its full commit SHA, with a comment naming the release.
GitHub documents full-SHA pinning as the immutable form of an action reference.
[GitHub guidance](https://docs.github.com/en/actions/reference/security/secure-use#using-third-party-actions)
Update all occurrences of a shared action consistently and inspect the upstream
diff; preserve the workflow's required check names and minimum permissions.

The current workflows use major-version action tags. These are not immutable
pins and are not checked by `just check-deps`; converting them is work for a
dependency-maintenance PR. This guide does not change dependency selections.
Verify an action change with actual GitHub workflow runs, since local application
tests do not execute the GitHub runner or action runtime.

## Nix toolchain

The Nixpkgs input currently names a specific release archive URL, rather than a
moving branch. Merely refreshing the lockfile does not select a newer archive.

1. Select a concrete Nixpkgs revision/archive and inspect the affected tool
   versions and release notes. Edit `inputs.nixpkgs.url` in `flake.nix` to that
   explicit archive URL; retain an immutable source selection.
2. Run `nix flake update nixpkgs` from the checkout to regenerate that input's
   lock entry. Review and commit both the URL change and `flake.lock`, including
   the resolved revision and integrity hash. The
   [Nix command reference](https://nix.dev/manual/nix/stable/command-ref/new-cli/nix3-flake-update.html)
   describes updating a named input.
3. Enter the updated environment with `nix develop` and run `just setup`. Check
   the actual Node, pnpm, and Codex versions using their `--version` commands.
   Keep `packageManager` and Node engine declarations compatible with the
   selected toolchain; record other changed tools, including Chromium.
4. Recalculate the dependency-cache hash if necessary, then run the applicable
   source, browser, and installed-package checks below.

Keep both Linux outputs in the flake. Report the architecture actually tested;
an `x86_64-linux` run does not verify `aarch64-linux`.

## Verification and completion

Dependency and toolchain updates need `just check` and `just package-smoke`.
Run `just test-e2e` when browser behavior, framework/build tools, Chromium,
contracts, or service integration may be affected; a Nixpkgs update changes the
broader toolchain and needs that browser check. Record successful GitHub checks
on the final PR revision as well as relevant local evidence.

When Codex changes, rerun the adapter tests and the model-free `just probe`,
check the installed CLI's generated schema against the adapter, and update the
[integration contract and evidence](integration/codex.md) as needed. The probe
uses read-only RPCs; Codex startup still needs normal access to its own storage
and may perform storage maintenance.

Real-model verification is deliberate and separate: use the documented
`just probe --smoke` and `just smoke --controls` checks within the authorized
task. Record the exact Codex version, date, tested behavior, and sanitized
reports. Fixture tests and a successful no-tool model turn do not establish live
approval routing. If credentials, model usage, or environment prevent a live
check, record the missing evidence and owner in the PR/issue for the maintainer's
merge decision; do not relabel old or controlled evidence as a new live result.
