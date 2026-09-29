# Contributing to Thrallwright

This workflow applies to human and agent contributors. GitHub issues and pull
requests are the durable record of work; repository documentation defines the
shared rules. Alex (`furinvader`) is the maintainer and authorizes merges.

The [maintainer guide](docs/maintaining.md) documents repository administration,
reviewable GitHub settings, verification, and outstanding administrative actions.

Start with the [README](README.md), the product and architecture reading order in
[AGENTS.md](AGENTS.md#read-first), and the [development guide](docs/development.md)
for setup and commands. Preserve the first slice's verified behavior and update
the relevant specification in the same PR when intentionally changing behavior.

## Agree on a task

Nontrivial work starts with an issue describing the problem, intended observable
result, acceptance criteria, constraints, dependencies, and unresolved decisions.
Small fixes may put this brief directly in their PR. Confirm the intended scope
with the maintainer before implementing an unsolicited feature or material
architecture change; an assigned task already supplies that authorization.

Keep scope, decisions, and blockers in the issue. Split independently reviewable
changes into linked issues and PRs, with a tracking issue when useful. Record one
coordinating owner in the issue or PR, including the agent/task identity when
several contributors share one GitHub account. Do not maintain a second backlog
in repository files or rely on a conversation as the only record of a decision.

## Implement in isolation

Use a task branch and a separate worktree for each independent task, normally
based on current `main`. For dependent PRs, state the dependency and temporary
base explicitly, then reconcile and retarget to `main` after the prerequisite
merges. Coordinate overlapping edits with the owner before changing the same
area. Preserve unrelated work and do not reset, remove, or overwrite another
contributor's changes.

Within an assigned task and available permissions, agents may implement, run
checks, commit, push the task branch, and open or update its PR. These operations
do not authorize merging. Every PR requires Alex's explicit merge authorization;
successful checks, access to Alex's account, and a general implementation request
do not provide that authorization. Do not enable automatic merging as a substitute.

Follow the [commit and PR naming rules](docs/development.md#commits-and-pull-requests)
for every commit and the final PR title, and run the documented
`just check-commits` command against the intended base. Keep the PR title and
description aligned with the final change as its scope develops.

## Make the PR reviewable

Open a draft PR when work or dependencies remain. Link its issue and explain the
problem, resulting behavior, validation actually performed, and relevant
documentation or architecture changes. Use a closing reference such as
`Closes #123` only when merging will satisfy the issue's acceptance criteria.
An administrative action or other outstanding work keeps its issue open after
the documentation PR merges.

Mark the PR ready when its scope is implemented, relevant specifications are
updated, applicable checks pass, and known review findings are addressed or
explicitly resolved with the maintainer. Record independent human or agent review
when available, identifying the reviewer and revision reviewed. Self-review and
automated checks are useful evidence but must not be described as independent
review. Unresolved blockers belong in the issue and PR, with the PR kept in draft.

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
distinction in the [first-slice evidence](docs/first-slice.md#14-verification-record).

Once Alex authorizes the specific PR, the authorized merger verifies the current
diff, resolved review conversations, and required checks before squash merging.
If later changes materially alter the reviewed scope, obtain authorization for
that revision. The merged PR closes completed implementation issues; verify any
remaining acceptance criteria before closing other issues or the tracking issue.

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
blocker, an owner, manual completion steps, and evidence needed to verify success.
Keep the issue open until that work is done; a documented procedure alone is not
proof that an external setting or release has changed.
