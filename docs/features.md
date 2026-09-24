# Feature requirements

This document defines user-visible behavior. It intentionally avoids choosing implementation technology.

The words **must**, **should**, and **may** indicate requirement strength:

- **must** — required for the behavior to be considered correct;
- **should** — expected unless a documented constraint makes it impractical;
- **may** — useful extension, not required for the first implementation.

## 1. Workspace

Thrallwright operates in the context of a workspace.

### Required behavior

- The application must make the active workspace identifiable to the user.
- Sessions and workflow state shown together must belong to, or be explicitly associated with, that workspace.
- Changing workspace context must not silently move a running session to a different workspace.
- If a workspace source becomes unavailable, the interface must show that condition rather than presenting stale information as current.

### Initial scope

The first implementation may support exactly one local workspace at a time.

Workspace discovery, multiple simultaneous workspaces, remote workspaces, and workspace sharing are not required initially.

## 2. Harness integrations

A harness integration connects Thrallwright to an existing agent environment.

### Required behavior

- An integration must declare or expose the capabilities it actually supports.
- The application must not render unsupported actions as though they will work.
- Integration failures must be visible and attributable to the affected integration.
- Authentication and authorization should remain owned by the underlying harness unless a future product decision explicitly changes that boundary.
- Thrallwright must not bypass harness approval mechanisms.

### Capability examples

An integration may support any subset of:

- discovering sessions;
- starting a session;
- observing session status;
- reading historical activity;
- receiving new activity;
- sending user input;
- observing approval requests;
- approving or rejecting a request;
- interrupting active work;
- stopping active work;
- resuming a saved conversation;
- exposing parent/subagent relationships;
- exposing produced artifacts.

The first version only needs one useful integration.

## 3. Session overview

The user needs a compact view of available sessions before opening one.

### Required behavior

Each session entry should show, when known:

- a stable or recognizable name;
- the integration or agent type;
- current status;
- a concise indication of what it is working on;
- whether it needs user attention;
- parent or child context when available.

The session list must distinguish current state from historical existence. A session with saved history but no observable live process must not appear active.

### Status semantics

At minimum, Thrallwright must be able to represent:

- **running** — work is actively executing;
- **waiting** — progress is paused for user input, approval, or another known wait;
- **finished** — the session has completed;
- **disconnected** — the session is known, but its live state cannot currently be observed or controlled;
- **unknown** — there is insufficient authoritative information for a more specific status.

Integrations may introduce more detailed states, but the UI must not overstate certainty.

## 4. Session detail and activity

Opening a session should answer "what is happening here?"

### Required behavior

- The user must be able to view observable session activity in chronological order.
- The view must distinguish agent output from user input when the source provides that distinction.
- Structured tool activity should be shown as structured activity when the integration provides it.
- Tool results, status changes, errors, approval requests, and artifact references should remain distinguishable rather than being flattened into one undifferentiated transcript where possible.
- The interface should keep newly arriving activity visible without making older activity inaccessible.
- Historical activity must be visually or semantically distinguishable from currently streaming activity when that distinction matters.

### Reasoning boundary

Thrallwright must not claim to show a model's private chain-of-thought or complete internal reasoning.

If an integration exposes summaries, messages, tool invocations, or reasoning-like fields intended for external display, those may be shown with accurate labeling.

## 5. Starting sessions

When the selected integration supports creating sessions, the user should be able to start work from Thrallwright.

### Required behavior

- The user must be able to identify which integration will be used.
- The user should be able to provide the initial task or input required by that integration.
- Any optional session name should be presentation metadata and must not alter harness semantics unless explicitly documented.
- Start failures must be visible without creating a false running session.
- A successful start must result in a session that can be located in the session overview.

The product does not require a universal launch configuration model for the first integration.

## 6. Sending input

When an active session accepts user input, Thrallwright should provide a direct way to send it.

### Required behavior

- Input must be associated with exactly one target session.
- The target session must be obvious before the user sends input.
- Sending input must not imply approval of an unrelated pending action.
- Failed delivery must be visible.
- If the session can no longer accept input, the control must become unavailable or explain the failure.

Free-form input and structured harness responses may coexist, but they should not be conflated.

## 7. Approvals

Approval requests deserve explicit treatment because they block work and require deliberate user action.

### Required behavior

When the harness exposes structured approvals:

- pending approvals must be visually identifiable;
- the session requiring the approval must be identifiable;
- the requested action and any harness-provided context must be shown;
- available responses must mirror the harness capabilities;
- the application must not auto-approve by default;
- the result of the user's response must be visible;
- an expired or already-resolved approval must not remain actionable.

If an integration exposes approvals only as ordinary terminal or text interaction, Thrallwright may present that interaction without pretending it has a structured approval object.

## 8. Interrupting and stopping work

Interruption and termination are operational controls, not navigation.

### Required behavior

- If the integration supports interrupting current execution, the control must describe that effect clearly.
- If the integration separately supports stopping or terminating a session, that must be a distinct action.
- Destructive controls should require an interaction design that reduces accidental activation.
- A successful interrupt or stop must lead to updated session state when the integration can report it.
- Failure to interrupt or stop must be visible.

Thrallwright must not claim stronger process control than the integration actually provides.

## 9. Parent agents and subagents

Some harnesses may expose work delegated from one agent or session to another.

### Required behavior

When authoritative relationship data exists:

- the user should be able to see which session is the parent;
- child sessions should be discoverable from the parent context;
- the assignment or relationship label should be shown when provided;
- navigating the relationship must not alter either session.

When authoritative relationship data does not exist, Thrallwright must not infer a hierarchy from naming conventions or transcript text.

A rich graph visualization is not required for the first version. A simple hierarchical or linked presentation is sufficient.

## 10. Persistent workflows

Workflow state is a first-class product area.

### Required behavior

- The application must support at least one configured persistent workflow source.
- The first implementation may support a JSON document as its only workflow source.
- Valid JSON must remain inspectable even when it does not match a recognized schema.
- Objects, arrays, scalar values, and nested structures must remain understandable in the generic view.
- Parse errors, missing sources, permission errors, and other read failures must be visible.
- Refreshing workflow state must not silently mutate it.
- The first version may be read-only.

### Structured presentation

Thrallwright may add richer presentations for recognized workflow shapes.

A richer renderer must not hide fields that are still important to the user. The generic representation should remain available when useful for inspection or debugging.

### Progress questions

When the data supports the answer, the workflow view should make it easy to determine:

- current stage or status;
- completed work;
- remaining work;
- blockers;
- responsible session or agent;
- produced artifacts.

When the data does not contain an answer, the interface should leave it unknown rather than infer it.

## 11. Linking workflows and sessions

The central product value is strongest when live activity and persistent state can be related.

### Required behavior

- The user must be able to inspect workflow state while working with sessions from the same workspace.
- Explicit session/workflow links should be rendered when available.
- Selecting a linked session or workflow item should support navigation to the related context where practical.
- The product must distinguish explicit links from mere temporal proximity.

### Acceptable first version

The initial implementation may place session activity and workflow state side-by-side without automatic cross-linking.

That still satisfies the core product direction if both are easy to inspect during the same work loop.

## 12. Artifacts

Artifacts are durable outputs of agent work.

### Required behavior

When an integration or workflow source identifies artifacts:

- show the artifact name or description;
- show its originating session or workflow item when that relationship is known;
- provide a safe way to inspect or navigate to it when the artifact type and environment allow;
- do not fabricate artifacts by interpreting arbitrary text as a path or result.

Artifact editing is not required for the initial product.

## 13. Workspace change inspection

For coding work, a read-only view of source-control state is a useful supporting feature.

### Behavior

An implementation may provide:

- changed-file status;
- staged and unstaged distinctions when supported by the source-control system;
- diffs for tracked changes;
- the current branch or equivalent working context.

This feature should remain read-only in the first version unless mutation is deliberately added later.

Thrallwright does not need a source-control abstraction before supporting one concrete system.

This feature is supportive rather than central. It must not displace session observation or workflow state from the initial vertical slice.

## 14. Reopening and reconnecting

Users should not lose conceptual continuity when the interface is closed and reopened.

### Required behavior

- Durable session metadata and workflow state should be rediscoverable after reopening Thrallwright.
- Reopening the user interface must not silently create duplicate sessions.
- If a session is still live and the integration can rediscover or reconnect to it, the UI should restore its live status.
- If live execution cannot be recovered, the session must be shown as historical, disconnected, or unknown as appropriate.
- A persisted process identifier or stale runtime handle must not by itself be treated as proof of live ownership.

Exact process survival across application restarts is not a product requirement unless the chosen integration can guarantee it.

## 15. Attention and error states

Thrallwright should help the user notice where intervention is needed.

### Required behavior

The UI should distinguish:

- normal active work;
- waiting for input;
- waiting for approval;
- blocked or failed activity;
- disconnected integrations;
- malformed workflow state;
- failed user actions.

Errors should be attached to the relevant session, integration, workflow source, or action whenever possible.

A generic global error banner may supplement, but should not replace, local context.

## 16. Navigation and layout

The exact interface layout is not prescribed.

Regardless of layout, the application should make these areas reachable with little friction:

- Agents or integrations;
- Sessions;
- Activity;
- Workflows;
- Approvals;
- Artifacts, when available.

The first version may combine several areas on one workbench screen.

Switching views must not change execution state unless the user activates an explicit control.

## 17. Branding and terminology

The product name and visual identity may use fantasy-inspired craftsmanship.

### Use ordinary functional terms

Preferred examples:

- Start session
- Send input
- Approval required
- Interrupt
- Workflow
- Artifact
- Agent
- Session

Avoid replacing these with themed verbs or nouns that require the user to learn fictional mechanics.

### Visual direction

The presentation may draw from workshops, crafted constructs, magical tools, specialized companions, and careful assembly.

Avoid centering the identity on death, domination, armies, skulls, throne rooms, or deliberately sinister imagery.

## 18. Accessibility and basic usability

The first version should be operable without relying exclusively on color, animation, or pointer hover.

Interactive controls should have visible labels or accessible names.

Status, approval, error, and destructive-action distinctions should remain understandable in text.

Dense agent output should remain readable for extended development sessions.

## 19. Explicitly deferred features

Unless required by a later decision, the first implementation does not need:

- multiple concurrent workspaces;
- multiple users or permissions administration;
- remote agent fleet management;
- a universal orchestration engine;
- arbitrary workflow editing;
- a generalized plugin marketplace;
- rich agent relationship graphs;
- a built-in code editor;
- source-control write operations;
- hidden reasoning visualization;
- broad support for many harnesses.

These may be added after the first vertical slice proves the central loop.
