# Contributing to Thrallwright

This workflow applies to human and agent contributors. GitHub issues and pull
requests are the durable record of work; repository documentation defines the
shared rules. Alex (`furinvader`) is the maintainer and authorizes merges.

The [maintainer guide](docs/maintaining.md) documents repository administration,
reviewable GitHub settings, verification, and outstanding administrative
actions.

Start with the [README](README.md), the product and architecture reading order
in [AGENTS.md](AGENTS.md#read-first), and the
[development guide](docs/development.md) for setup and commands. Preserve the
first slice's verified behavior and update the relevant specification in the
same PR when intentionally changing behavior.

## Agree on a task

Nontrivial work starts with an issue describing the problem, intended observable
result, acceptance criteria, constraints, dependencies, and unresolved
decisions. Small fixes may put this brief directly in their PR. Confirm the
intended scope with the maintainer before implementing an unsolicited feature or
material architecture change; an assigned task already supplies that
authorization.

Keep scope, decisions, and blockers in the issue. Split independently reviewable
changes into linked issues and PRs, with a tracking issue when useful. Record
one coordinating owner in the issue or PR, including the agent/task identity
when several contributors share one GitHub account. Do not maintain a second
backlog in repository files or rely on a conversation as the only record of a
decision.

## Implement in isolation

Use a task branch and a separate worktree for each independent task, normally
based on current `main`. For dependent PRs, state the dependency and temporary
base explicitly, then reconcile and retarget to `main` after the prerequisite
merges. Coordinate overlapping edits with the owner before changing the same
area. Preserve unrelated work and do not reset, remove, or overwrite another
contributor's changes.

Within an assigned task and available permissions, agents may implement, run
checks, commit, push the task branch, and open or update its PR. These
operations do not authorize merging. Every PR requires Alex's explicit merge
authorization; successful checks, access to Alex's account, and a general
implementation request do not provide that authorization. Do not enable
automatic merging as a substitute.

Follow the
[commit and PR naming rules](docs/development.md#commits-and-pull-requests) for
every commit and the final PR title, and run the documented `just check-commits`
command against the intended base. Keep the PR title and description aligned
with the final change as its scope develops.

## Make the PR reviewable

Open a draft PR while its implementation or validation is incomplete. Link its
issue and explain the problem, resulting behavior, validation actually
performed, and relevant documentation or architecture changes. Use a closing
reference such as `Closes #123` only when merging will satisfy the issue's
acceptance criteria. An administrative action or other outstanding work keeps
its issue open after the documentation PR merges. Use `Refs #123` or a plain
issue link in that case. Avoid closing keywords even in negated prose: GitHub
may still recognize them.

State the PR's narrow outcome, acceptance criteria, and exclusions. Mark it
non-draft when that scope is implemented, specifications are updated, and
applicable validation passes, before requesting independent review. A dependent
PR may be reviewed against its explicitly named temporary base once its own
scope is complete. It cannot merge until its prerequisites have merged and it
has been reconciled, validated, and reviewed against current `main`.

## Independent review

Every PR needs an independent human or agent reviewer who did not implement its
changes. Self-review and automated checks are useful evidence but are not
independent review. Review the actual diff and its consequences against the
linked acceptance criteria; changes to workflows or validators require the same
scrutiny as application code. A green check alone cannot establish that the PR
preserved the meaning of that check.

Use GitHub's official pull-request review feature, including inline findings
where useful. Record the reviewer identity (including agent/task identity when
accounts are shared), base and head commit IDs, scope, and an explicit outcome:
`Accepted` or `Changes requested`. A shared account cannot formally approve its
own PR, so independent agents using it submit a `COMMENT` review with that
outcome. This is a procedural acceptance record, not a GitHub `APPROVED` review.
`@codex review` is not part of this workflow.

Resolve findings in one of these ways, recording the evidence in the review:

- Fix a valid finding within the PR's scope and have the reviewer verify it.
- Explain why a finding is invalid and obtain the reviewer's agreement.
- For an independent, unrelated defect, open and link a scoped follow-up issue
  or PR and obtain the reviewer's agreement that this resolves the finding for
  the current PR. Do not hide a regression introduced by this PR by moving it
  into a new ticket.

Repeat correction and independent review until the current revision is accepted;
there is no fixed iteration limit. New head or base revisions invalidate earlier
acceptance and need renewed review, including after a rebase or retarget. Keep
reviewer-approved follow-ups visible without expanding this PR into unrelated
work. If the work cannot converge, narrow or split the scope with the
maintainer, or leave a handoff; do not merge unresolved blockers. Return to
draft if scope or implementation becomes incomplete, then mark non-draft again
before the next independent review. Resolving a GitHub thread alone does not
establish reviewer acceptance.

## Validation and merging

Choose validation based on the affected behavior:

| Change                                  | Evidence to provide                                                                                                                              |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Documentation or templates              | Formatting, working links, and consistency with actual commands and behavior; inspect template structure/rendering where applicable.             |
| Application behavior                    | `just check` and focused behavioral tests for the changed path, including relevant failure cases.                                                |
| Browser behavior                        | Applicable application checks and `just test-e2e`; inspect changed layout or interaction at relevant sizes and with keyboard navigation.         |
| Shared contracts or harness integration | Applicable application checks, affected producer/consumer and controlled integration tests, and updates to capability documentation when needed. |
| Packaging, toolchain, or dependencies   | Applicable application checks, `just check-deps` for manifest changes, and `just package-smoke`; review the full lockfile and packaging diff.    |

The [development guide](docs/development.md#work-in-a-checkout) explains focused
commands. These rows guide relevant local evidence; required GitHub checks still
apply. Avoid tests that merely repeat the implementation. Report the command,
result, and relevant environment or revision, and distinguish passed checks from
checks not run or blocked. Repeat affected checks after changes invalidate their
evidence.

For dependency updates, follow the monthly review and verification procedure in
[Dependency maintenance](docs/dependency-maintenance.md).

Ordinary checks use controlled fixtures without paid model calls. Run real-model
checks deliberately within the authorized task, following the documented
`just probe --smoke` and `just smoke` procedures. State their model usage and
scope separately; fixture coverage does not establish live harness behavior.
Record outstanding live verification without claiming it passed. Preserve the
distinction in the
[first-slice evidence](docs/first-slice.md#14-verification-record).

Once Alex authorizes the specific PR, the authorized merger verifies the current
diff, independent acceptance of its current base/head, resolved review
conversations, and required checks before squash merging. If later changes
materially alter the authorized scope, obtain authorization for that revision.
Reviewer acceptance does not supply merge authorization. Required checks and the
repository's zero formal approval count cannot enforce the same-account
acceptance record; humans and agents must verify it before merging.

Record concise merge evidence in the PR, for example:

```text
Owner: contributor or agent/task identity
Scope: issue and acceptance criteria
Reviewed base / head: full commit IDs
Independent review: review URL, reviewer identity, Accepted
Findings: fixed/invalid/deferred with reviewer agreement and links
Checks: links to successful required checks for the current revision
Authorization: Alex's instruction/link, PR and scope it covers
Remaining issue criteria: none, or administrative work with owner and link
```

Close an implementation issue only after reviewer acceptance, merge, and
satisfaction of its acceptance criteria. Verify remaining administrative work
before closing its issue or the tracking issue; neither approval nor a merged
documentation PR proves activation. Do not manually close an implementation
ticket before its PR has independent acceptance.

The [release procedure](docs/releases.md) defines version preparation, release
verification, and the separate authorization required to publish a release.

## Leave a useful handoff

When pausing or transferring work, post a concise handoff in its issue or PR:

```text
Owner: contributor or agent/task identity
Branch / PR / revision: links and commit
Completed: observable results and relevant decisions
Remaining: next steps and acceptance criteria still unmet
Blocked: exact obstacle, who can resolve it, and required action
Validation: commands run, results, and checks still needed
```

Include local worktree information and uncommitted changes when they matter to
the next contributor. If access or tooling prevents an action, record the exact
blocker, an owner, manual completion steps, and evidence needed to verify
success. Keep the issue open until that work is done; a documented procedure
alone is not proof that an external setting or release has changed.
