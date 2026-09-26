# Working on Thrallwright

Thrallwright's initial Codex/JSON slice is implemented. Product requirements and architecture decisions remain separate; use the implementation and verification records to establish what works today.

## Read first

Before implementing behavior, read these documents in order:

1. README.md
2. docs/product-spec.md
3. docs/features.md
4. docs/domain-model.md
5. docs/first-slice.md
6. docs/decisions/README.md and the decisions relevant to the change
7. docs/development.md and docs/workbench.md for current commands and operational limits; docs/integration/codex.md when changing the harness integration

If code and documentation later disagree, do not silently reinterpret the product. Determine whether the code is incomplete or the product documentation needs an explicit update.

## Product intent

Thrallwright is a local workbench for understanding and directing existing AI agents and the persistent workflows around them.

The application should make it easy to answer:

- Which sessions exist?
- What is each session doing?
- Which sessions are running, waiting, finished, or disconnected?
- Are there subagents, and which parent session or assignment do they belong to?
- Does the agent need user input or approval?
- What stage is the broader workflow in?
- What has completed, what is blocked, and what outputs were produced?
- Which controls are actually available for this session through its harness?

The first practical milestone is complete: a local Codex workbench with read-only JSON workflow inspection. Its [verification record](docs/first-slice.md#14-verification-record) distinguishes real-Codex evidence from controlled approval fixtures. Preserve this loop while extending the application.

## Implementation rules

### Do not invent capabilities

Only display authoritative agent state that the connected harness or another configured source actually exposes.

Do not claim access to private chain-of-thought or a complete internal reasoning process. "Activity" means observable messages, tool activity, status, approval requests, results, and other externally available events.

Do not infer parent/subagent relationships from text when no authoritative relationship is available.

Do not make a saved conversation look controllable if there is no live process or resumable harness operation behind it.

### Preserve harness semantics

Thrallwright sits around existing agents. It should not bypass their authentication, authorization, approval, or safety mechanisms.

Starting, sending input, approving, denying, interrupting, resuming, and stopping are different operations. Expose only the operations the current integration can perform and label their effects clearly.

### Keep workflow state first-class

Persistent workflow state is not a decorative side panel. It is one of the two primary views of the work.

The first implementation may support a single configured JSON workflow source. It must remain useful even when the JSON does not match a special schema: a generic structured inspector is a valid first presentation.

### Keep the interface literal

Use functional labels such as Agents, Sessions, Workflows, Approvals, Activity, and Artifacts.

The fantasy-inspired identity should come from branding and visual treatment, not from renaming ordinary operations into fictional terminology.

### Prefer a vertical slice

Preserve the end-to-end loop in docs/first-slice.md when adding features. Broader integration abstractions, rich dashboards, generalized orchestration, and decorative features need concrete product justification.

The implementation should remain easy for another agent to inspect and modify.

## Technology choices

No technology stack is mandated by the product specification.

The accepted implementation direction is recorded separately in [docs/decisions/README.md](docs/decisions/README.md). Follow those decisions when extending the application. If implementation evidence requires a material change, explicitly amend or supersede the relevant decision; do not silently substitute a different stack or architecture. Check linked code and tests rather than treating an accepted decision as proof of every capability.

When selecting implementation technology:

- optimize for the smallest understandable working application;
- favor technology that makes the required local integrations reliable;
- avoid infrastructure whose only justification is hypothetical future scale;
- document material implementation constraints after they are proven by code.

Do not turn an incidental first implementation choice into a product requirement without updating the product documentation.

## Dependency policy

Keep all dependency declarations at exact versions, including development, optional, and peer dependencies. Use `workspace:<exact version>` for local packages. Do not introduce semver ranges, tags, or unpinned sources. Preserve the committed pnpm lockfile; routine installs must use the frozen lockfile. `just setup` runs `just check-deps` before installation; run it directly when editing manifests, and follow the deliberate update procedure in [docs/development.md](docs/development.md#dependency-versions).

## Commits and pull requests

Every new commit subject and PR title must use `type: summary`, with an optional scope and breaking-change marker: `type(scope)!: summary`. Use a lowercase type from `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, or `revert`. This applies to every commit inside a PR, not only its final squash commit. Keep the PR title aligned with the final change; the repository uses that title for squash commits on `main`. See [the contributor workflow](docs/development.md#commits-and-pull-requests) and run `just check-commits` as documented there.

## Changes to the specification

When behavior changes intentionally, update the relevant Markdown specification in the same pull request.

Prefer precise statements about observable behavior and capability boundaries over implementation-specific descriptions.
