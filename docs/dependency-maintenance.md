# Dependency maintenance

Alex (`furinvader`) owns a dependency review each calendar month. Renovate
discovers updates and prepares selected proposals; Alex selects routine updates
in its Dependency Dashboard, or explicitly delegates selection as part of an
assigned dependency-maintenance task. Selection authorizes preparation only.
Every merge still requires independent review and Alex's explicit authorization.
Address urgent security or compatibility fixes sooner.

Record each review in a GitHub issue, including its date, owner, dependency groups
reviewed, selected updates or reasons to defer them, and linked PRs. A review that
finds no changes still records that result. Keep deferred work linked and visible.
Follow the [contribution workflow](../CONTRIBUTING.md) for implementation, review,
and merge authorization.

## Renovate proposals

The reviewed policy is in [renovate.json](../renovate.json). Hosting and live
activation are separate from this configuration; [activation issue #41](https://github.com/furinvader/thrallwright/issues/41)
records the owner, outstanding steps, and actual verification. Until that issue
records successful activation, do not assume the bot or its security proposals
are running.

Use the hosted Renovate GitHub App for this repository only. Its dashboard stays
open and current; the monthly human review does not restrict the bot to a monthly
processing window. Routine proposals require dashboard selection and releases at
least 30 days old. A missing release timestamp holds the update. Keep at most two
routine PRs open and create at most two per hour. Prereleases and broad lockfile
maintenance are not enabled. Major updates remain visible and separately
selectable; record a scoped migration issue before selecting one.

Only JavaScript dependency declarations and GitHub Action/reusable-workflow
references are managed. Keep exact JavaScript pins and full Action commit SHAs
with release-version comments. Local package versions, workspace references,
Node engines, the pnpm `packageManager` declaration, Nix snapshots, runner images,
and action runtime inputs remain manual. Angular framework/build packages move
as one group; Material/CDK and Angular ESLint form separate groups. Select other
updates individually and check compatibility before combining required changes.

Renovate creates drafts and never merges, enables platform automerge, or receives
a branch-protection bypass. A draft proposal may need migrations or a new Nix
dependency-cache hash before it is ready. An assigned implementer:

1. Records ownership in the PR and applies the `stop-updating` label before
   editing the branch. This pauses Renovate's updates; the implementer then owns
   reconciliation with `main` and subsequent lockfile/hash changes.
2. Completes the deliberate update and validation procedures below. Hosted
   Renovate cannot run the repository scripts that calculate the Nix hash.
3. Marks the PR non-draft when complete, requests an independent review through
   GitHub's review feature, and resolves findings within the agreed scope.
4. Obtains Alex's explicit merge authorization after reviewer acceptance of the
   current revision. Dashboard selection, bot authorship, and green CI alone
   never supply that authorization.

Security-remediation proposals may appear immediately without routine selection,
release-age, scheduling, or routine-PR-limit gates. They prefer the lowest fixing
version and remain drafts until completed. All review and merge rules still
apply. Renovate reads GitHub's Dependabot alerts: the dependency graph, alerts,
and the App's read access to alerts must be active. Keep Dependabot's automatic
security-update PR generation disabled to avoid a second update bot.

Release age is not proof of trustworthiness. Renovate's direct update gate does
not guarantee that every newly resolved transitive pnpm dependency is 30 days
old; inspect the full lockfile. Action digest updates may use their associated
version's timestamp, which is not proof of the digest's publication age. Verify
the upstream tag and commit as well. For updates held by absent timestamps, use
an explicitly reviewed manual update or narrowly scoped policy exception; do
not relax the repository-wide timestamp requirement. See Renovate's
[release-age limitations](https://docs.renovatebot.com/key-concepts/minimum-release-age/)
and [dashboard workflow](https://docs.renovatebot.com/key-concepts/dashboard/).

## Validate and activate the bot

Run `just check-renovate` inside `nix develop`; `just check` includes it. The
locked Nixpkgs supplies Renovate 44.104.0 and its strict validator. Offline policy
checks use that implementation's extraction, package-rule resolution, and release
filtering against controlled cases. They establish configuration behavior, not
that a hosted App was installed or that real security alerts were processed.
Do not replace the pinned validator with an unpinned `npx` invocation.

After the configuration and Action-pin PRs merge, the activation owner follows
issue #41:

1. Install/configure the hosted App with access only to Thrallwright. Do not
   grant a protection bypass or add credentials to repository files.
2. Verify the dependency graph, enable Dependabot alerts, and verify the App's
   read access to alerts. Alerts were disabled during the 2026-09-29 audit.
   Keep Dependabot security-update PR generation disabled.
3. Verify the first processed run: the dashboard exists, there are no unselected
   routine PRs, and there are no configuration or artifact-update errors. Record
   actual evidence and any remaining owner action in the activation issue.

Verified installation and repository scope, required settings, and the first
processed run complete activation. Record that evidence in issue #41 before
closing it. Track the first deliberately selected update in an owned monthly
maintenance issue linked from #41. That later PR supplies end-to-end evidence:
draft proposal, ownership handoff, complete package/hash validation, non-draft
independent review, and authorized merge. Do not select an unnecessary update
merely to demonstrate onboarding.

If installation or account consent requires Alex's browser, record the exact
action and keep the activation issue open. Merging configuration alone does not
complete that issue. Pause a bot-owned PR with `stop-updating`; to suspend the
integration as a whole, the maintainer can suspend its repository access and
record the reason and restoration conditions in the activation/maintenance issue.

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

Workflow Actions use full commit pins with release-version comments. Inspect
every changed reference during review: `just check-deps` checks JavaScript
manifests, not Action references. The initial conversion is recorded in
[issue #35](https://github.com/furinvader/thrallwright/issues/35); verify these
pins before bot activation. Renovate configuration does not itself select new
Action versions.

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
