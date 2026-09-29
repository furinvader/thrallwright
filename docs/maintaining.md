# Maintaining Thrallwright

Alex (`furinvader`) owns repository administration and merge authorization.
GitHub issues record unfinished work and its owner; PRs record implementation
and verification. This guide records reusable administrative procedures.
See the [contribution workflow](../CONTRIBUTING.md) for task and PR policy.

## Main branch and merge settings

The reviewed target configuration lives in
[main-ruleset.json](../.github/main-ruleset.json) and
[repository-settings.json](../.github/repository-settings.json).
Committing those files does **not** apply them to GitHub.

The intended rules require a PR, resolved review conversations, and the
`check`, `package`, and `commit-conventions` checks from GitHub Actions. The PR
must be current with `main`. Main cannot be deleted or force-pushed, and no
actors have a standing bypass. The repository allows only squash merges, uses
the PR title for the squash commit title, deletes merged branches, and leaves
automatic merging disabled.

There are zero required GitHub approvals because a maintainer and an agent may
share an account. Every PR still requires
[independent acceptance of its current base/head](../CONTRIBUTING.md#independent-review)
through GitHub's review feature. Same-account `COMMENT` acceptance is a mandatory
procedural gate and is not a formal `APPROVED` review. Alex must explicitly
authorize each PR's merge; reviewer acceptance does not supply that authority.

[Issue #43](https://github.com/furinvader/thrallwright/issues/43) owns future
evaluation of a distinct reviewer identity for native approval enforcement.
Keep zero formal approvals until a legitimate independent approval is proven
to satisfy the proposed rule. No reviewer account, bypass, or Codex review
integration is introduced by the current workflow.

### Inspect before applying

Use an authenticated GitHub CLI with repository administration permission. Run
these commands from the repository root:

```sh
gh api repos/furinvader/thrallwright/rulesets
gh api repos/furinvader/thrallwright/branches/main/protection
gh api repos/furinvader/thrallwright/commits/main/check-runs --jq '.check_runs | map({name, app: {id: .app.id, slug: .app.slug}})'
gh api repos/furinvader/thrallwright --jq '{allow_squash_merge, allow_merge_commit, allow_rebase_merge, squash_merge_commit_title, delete_branch_on_merge, allow_auto_merge}'
```

A `Branch not protected` 404 means no classic branch protection was found;
rulesets must still be inspected separately. A permissions or network failure
does not establish that protection is absent. The configured integration ID
`15368` was verified as `github-actions` on this repository's checks. Confirm
that association again before applying, especially if adapting this procedure
to another GitHub installation.

### Apply the reviewed configuration

After Alex authorizes the settings rollout, inspect all existing rulesets and
classic protection first. Preserve unrelated rules. If no `Protect main`
ruleset exists, create it once:

```sh
gh api --method POST repos/furinvader/thrallwright/rulesets --input .github/main-ruleset.json
```

If that ruleset already exists, use its verified numeric ID to update it instead
of creating a duplicate. If several rulesets have that name, resolve which is
authoritative before proceeding:

```sh
RULESET_ID=12345 # Replace with the ID returned by the inspection.
gh api --method PUT "repos/furinvader/thrallwright/rulesets/$RULESET_ID" --input .github/main-ruleset.json
```

Apply the repository merge settings:

```sh
gh api --method PATCH repos/furinvader/thrallwright --input .github/repository-settings.json
```

The settings calls are separate operations. If one fails, record which changes
took effect; inspect before retrying. After a timeout creating a ruleset, list
rulesets before attempting another creation.

### Verify and record

Using the actual ruleset ID, read back both the configuration and effective
rules for the branch:

```sh
RULESET_ID=12345 # Replace with the ID returned by creation or inspection.
gh api "repos/furinvader/thrallwright/rulesets/$RULESET_ID" --jq '{name, target, enforcement, bypass_actors, conditions, rules}'
gh api repos/furinvader/thrallwright/rules/branches/main
gh api repos/furinvader/thrallwright --jq '{allow_squash_merge, allow_merge_commit, allow_rebase_merge, squash_merge_commit_title, delete_branch_on_merge, allow_auto_merge}'
```

Compare every configured field with the two checked-in files. Confirm active
enforcement, the exact branch, no bypass actors, all three check names and their
app IDs, strict current-base checking, conversation resolution, zero required
approvals, and both force-push/deletion restrictions. GitHub may return extra
default fields. Inspect a current PR's merge requirements as a second check;
do not attempt destructive pushes to test the rules.

Record the date, ruleset ID, relevant PR, readback results, and any remaining
actions in the administration issue. Close that issue only when the settings
have been applied and verified. Merging a documentation PR alone is not enough.
If an exception is necessary later, Alex must authorize the specific temporary
change; record its reason and restore and verify the intended configuration.

## Administration records and handoffs

The initial inspection on 2026-09-29 found no rulesets or classic protection.
Squash-only merging and PR-title squash messages were already configured;
merged-branch deletion was disabled and auto-merge was disabled. This is a
dated observation, not a claim about current effective settings.

[Issue #20](https://github.com/furinvader/thrallwright/issues/20) owns the first
protection rollout. Record authorization, application, and readback there using
the procedure above. No permission limitation was known at the initial
inspection. Consult that issue for the latest rollout status; the checked-in
configuration expresses intended policy and is not evidence of activation.

For any action that cannot be completed, keep an issue open with:

- the exact action and blocker, including any actual permissions/API failure;
- a responsible person and the necessary decision or access;
- commands or UI steps to finish it, linking this guide where applicable;
- completed work and evidence, and the evidence still required for closure.

Distinguish technical inability, waiting for authorization, and deliberately
scheduled future maintenance. Do not claim that settings, releases, or checks
have completed merely because their instructions exist.
