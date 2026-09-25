# First implementation slice

Status: Implemented and verified for the initial Codex/JSON scope. See the [verification record](#14-verification-record) for evidence and the [workbench guide](workbench.md) for current limits.

This document preserves the acceptance criteria for the smallest end-to-end Thrallwright. Use them as a regression baseline before broadening the product.

The goal is not to prove a technology stack. The goal is to prove that combining live agent work with persistent workflow state is useful in daily development.

## 1. Outcome

A developer should be able to open Thrallwright for the Thrallwright repository, start or attach to one supported agent session, follow its observable work, interact with it, and inspect persistent workflow state without leaving the workbench for routine monitoring.

The version should be useful enough to help build its own next increment.

## 2. Assumptions

The first slice may assume:

- one local user;
- one local workspace at a time;
- one supported agent harness;
- one configured JSON workflow source;
- one simple interface;
- no remote deployment;
- no collaboration features;
- no generalized workflow engine.

These are scope reductions, not permanent product constraints.

## 3. Required end-to-end scenario

An implementation is ready for its first product test when the following scenario works.

### Step 1 — Open a workspace

The user opens Thrallwright in the context of a local project.

The interface makes the active workspace obvious.

### Step 2 — See integration availability

The user can see whether the supported agent harness is available.

If it is unavailable or misconfigured, Thrallwright shows a useful error instead of presenting controls that cannot work.

### Step 3 — Start or locate a session

The user can create a session through the harness, or locate an existing session if creation is not the integration's supported path.

Afterward, the session appears in the session overview with a truthful status.

### Step 4 — Follow observable work

Opening the session shows the activity the harness exposes.

New observable activity appears without requiring the user to reconstruct it from a separate terminal or log.

The UI does not describe this as access to hidden reasoning.

### Step 5 — Provide input

If the harness supports input, the user can send input to the selected session and can tell whether delivery succeeded.

The target session is unambiguous.

### Step 6 — Handle attention

If the harness exposes a structured approval request, Thrallwright shows it and allows an available response.

If the harness does not expose structured approvals, this step may be satisfied by ordinary session interaction without pretending the approval is structured.

The user can also distinguish a session waiting for attention from one that is simply running.

### Step 7 — Interrupt

If interruption is supported, the user can explicitly interrupt active execution.

The interface reflects the resulting state or reports that the outcome could not be confirmed.

### Step 8 — Inspect persistent workflow state

The same workbench provides a view of a configured JSON workflow document for the workspace.

The user can inspect arbitrary valid JSON.

Missing, inaccessible, or malformed workflow data produces an explicit state rather than an empty success screen.

### Step 9 — Compare live work with durable progress

The user can look at the current session and the workflow state within the same product flow.

Automatic linkage is not required yet.

The important result is that the user no longer needs to treat terminal history as the only record of where the work stands.

### Step 10 — Reopen without false state

After closing and reopening the interface, previously known session metadata and workflow state are rediscoverable.

If live execution can still be authoritatively reconnected or rediscovered, show it as live.

Otherwise show the session as historical, disconnected, or unknown rather than falsely running.

## 4. Required user-visible areas

The exact layout is open, but the first slice needs these conceptual areas.

### Workspace context

Shows which project is active.

### Sessions

Shows known sessions, status, and attention state.

### Session activity

Shows observable activity for the selected session.

### Session controls

Shows only supported actions such as send input or interrupt.

### Workflow

Shows the current configured JSON workflow state and any read/parse errors.

These may be separate screens, panels, tabs, routes, or another interaction model.

## 5. Minimal integration contract

The first harness integration should provide the smallest real capability set needed for the scenario.

At minimum, the implementation must have a real path for:

- identifying a session;
- obtaining session status with an honest fallback to unknown or disconnected;
- obtaining observable activity.

To make the first slice materially useful, it should also provide at least one directional capability:

- start a session; or
- send input to an active session; or
- respond to approvals; or
- interrupt execution.

A purely static transcript viewer is not enough to validate "direct work."

## 6. Minimal workflow contract

The first workflow source may be one configured JSON document.

Required behavior:

- detect whether the source exists;
- read valid JSON;
- preserve arbitrary JSON values;
- display nested structure readably;
- report malformed JSON;
- report access/read failures;
- refresh without modifying the source.

No schema-specific editing is required.

A specialized checklist or stage view may be added only if it does not prevent generic inspection.

## 7. Persistence required for the slice

Persist or rediscover enough information that reopening Thrallwright does not erase the user's understanding of known sessions.

At minimum, the application should retain or reacquire:

- session identity;
- presentation title when available;
- integration identity;
- last known status with appropriate freshness;
- enough history or source access to understand what happened.

Do not treat stale live-process identifiers as authoritative.

Workflow persistence itself may remain owned entirely by the external JSON source.

## 8. Error cases that must be designed, not ignored

The first slice should have deliberate behavior for:

- harness not installed or unavailable;
- session start failure;
- session disconnect;
- input delivery failure;
- interrupt failure;
- workflow file missing;
- workflow file malformed;
- workflow file temporarily unreadable;
- activity stream interruption;
- stale session metadata.

Error handling can be simple, but the product must not silently convert these cases into normal empty states.

## 9. Behavioral acceptance checklist

An implementation agent should be able to demonstrate all applicable items without explaining internal architecture.

- [x] The active workspace is visible.
- [x] One real harness integration is discoverable.
- [x] A real session can be started or discovered.
- [x] The session list never marks a historical-only session as live without evidence.
- [x] Observable activity for a selected session can be read.
- [x] Newly observed activity becomes visible.
- [x] At least one real directional control works.
- [x] Unsupported controls are not presented as working.
- [x] Waiting or approval-required work is distinguishable when the source provides that information.
- [x] A configured JSON workflow can be inspected generically.
- [x] Missing and malformed workflow state produce explicit errors.
- [x] Session context and workflow state are accessible in one coherent product flow.
- [x] Reopening the interface does not silently duplicate sessions.
- [x] Historical, disconnected, live, and unknown conditions are not conflated.
- [x] No feature claims access to private chain-of-thought.
- [x] The interface uses functional labels rather than fantasy replacements for operational concepts.

## 10. Recommended test scenarios

These are behavioral tests; the implementation method is open.

### Session lifecycle

Create or discover a session, observe a status transition, interact with it, and verify the UI reflects the resulting state.

### Unsupported capability

Use an integration configuration that lacks one action and verify that Thrallwright does not offer a misleading working control for it.

### Disconnect

Make the live source unavailable and verify that the session does not remain falsely marked running.

### Workflow update

Change the JSON workflow externally and verify that Thrallwright displays the new state after refresh.

### Malformed workflow

Provide invalid JSON and verify that the error is visible while the application remains usable.

### Reopen

Close and reopen the interface and verify that known session context remains understandable without creating a duplicate session.

## 11. Useful extension after the slice

Once the core scenario works, a good next addition for coding workflows is a read-only workspace change view:

- changed files;
- current source-control context;
- staged versus unstaged changes when relevant;
- tracked diffs.

This helps connect agent activity to concrete repository effects.

It should remain subordinate to the primary loop of sessions plus persistent workflow state.

## 12. Deliberately deferred

Do not delay the first slice for:

- support for many harnesses;
- a generic plugin architecture;
- multiple simultaneous workspaces;
- multi-user access;
- remote execution;
- workflow editing;
- generalized task orchestration;
- rich subagent graphs;
- artifact indexing across the whole filesystem;
- source-control mutation;
- built-in code editing;
- elaborate fantasy interaction terminology;
- speculative scale infrastructure.

## 13. Definition of done

The first implementation is done when a second agent or developer can use Thrallwright to observe and direct a real agent working on Thrallwright, inspect a persistent workflow document for that work, encounter the expected failure states without ambiguity, and understand the codebase well enough to implement the next feature.

The implementation should then be judged by actual use before expanding the abstraction surface.

## 14. Verification record

The initial Codex/JSON slice is implemented. Fast tests cover source errors, history/live overlap, stale capabilities, command persistence failures, approval races, and recovery without replay. Controlled Playwright scenarios cover the browser flow without model calls.

The separate `just smoke --controls` browser check was run against real Codex 0.156.1 in the Thrallwright checkout on 2026-09-25. It verified session creation and observable output, JSON inspection and external updates, browser reload, service restart with retained context, explicit conversation resumption, new input, and a confirmed interruption. The sanitized report is in [workbench-controls.json](../tests/fixtures/codex/workbench-controls.json).

Structured approvals are verified against the pinned protocol and controlled integration/browser fixtures. The live smoke run did not encounter an approval request. Arbitrary externally running CLI sessions are not attached; saved conversations remain historical until an explicit supported resume. Unsupported request types and session-wide grants have no approval control. See [Using the local workbench](workbench.md) for operational limits.
