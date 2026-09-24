# Thrallwright product specification

## 1. Product statement

Thrallwright is a local workbench for observing and directing AI agents, managing their sessions, and understanding persistent workflows that may span multiple sessions or agents.

Its defining idea is the combination of **live agent activity** and **durable workflow state** in one coherent working view.

Thrallwright should make existing agent harnesses easier to work with. It should not require agents to be rewritten for Thrallwright, and it should not become a new agent framework merely to provide its core value.

## 2. Primary user

The initial user is a developer or technical operator running one or more AI agents on work in a local project or workspace.

The user is expected to remain in control of consequential actions. Thrallwright should reduce the effort required to observe state, provide input, handle approvals, and understand progress without obscuring what the underlying harness is doing.

Multi-user administration, organization-wide policy, remote fleet management, and hosted collaboration are outside the initial product definition.

## 3. Core jobs

### 3.1 Observe agent work

The user should be able to discover sessions and understand the state of each one without reconstructing it from several terminals.

For a selected session, show the observable activity its harness makes available, including messages, tool activity, status transitions, approval requests, results, and errors.

Where the harness exposes parent and child relationships, show how subagents relate to the parent session or assignment.

The product must not imply that it exposes a model's complete internal reasoning.

### 3.2 Understand workflow progress

The user should be able to inspect durable workflow state that exists independently of an individual live session.

The workflow view should help answer:

- What stage is the work in?
- What is complete?
- What remains?
- What is blocked?
- Which session or agent is responsible, when that information is available?
- Which outputs or artifacts were produced, when that information is available?

A configured JSON document is an important first workflow source. A generic inspector is sufficient before specialized workflow renderers exist.

### 3.3 Direct work

The user should be able to act through the capabilities of the connected harness.

Possible actions include:

- start a new session;
- send input to an active session;
- respond to an approval request;
- interrupt active execution;
- resume a saved conversation if the harness supports resumption;
- stop or terminate a live process if the integration exposes that operation.

The interface must not merge distinct operations into one ambiguous "resume" or "control" action.

## 4. Product concepts

### Workspace

The local project context in which Thrallwright is being used. A workspace anchors sessions, persistent workflow state, and any workspace-level inspection features.

### Harness integration

A connection to an existing agent or CLI harness. An integration declares the facts it can observe and the actions it can perform.

### Session

A unit of agent work or conversation. A session can have durable identity even when there is no longer a live process attached to it.

### Activity

Observable events associated with a session. Activity may include agent messages, user messages, tool actions, tool results, status changes, approvals, warnings, and artifacts.

### Approval

A specific request that requires user authorization or rejection before the underlying harness proceeds.

### Workflow

Persistent state describing the progress of work beyond a single conversational transcript.

### Artifact

A durable output or reference produced by the work, such as a file, change set, report, generated asset, or other result that the available sources can identify.

## 5. Capability model

Every integration should be treated as a set of independently available capabilities rather than assumed to implement a complete common interface.

Examples include:

- enumerate sessions;
- create session;
- observe live status;
- read historical activity;
- stream new activity;
- send input;
- observe approvals;
- respond to approvals;
- interrupt execution;
- stop execution;
- resume a conversation;
- report parent/child relationships;
- report artifacts.

The UI should adapt to the actual capability set. Unsupported actions should be absent or clearly unavailable, not simulated.

## 6. Session truthfulness

Thrallwright must distinguish at least these concepts:

- **running** — the integration reports active execution;
- **waiting** — the integration reports that progress is paused for user input, approval, or another identifiable wait condition;
- **finished** — the session has completed;
- **disconnected** — Thrallwright knows the session but cannot currently observe or control the live execution it was associated with;
- **unknown** — the source does not provide enough information to claim a more specific status.

An integration may expose additional states, but it must map them without overstating certainty.

A historical transcript is not evidence that a process is still running. A stored session identifier is not proof that a session is resumable. A terminal that can accept keystrokes is not equivalent to a structured agent-control API.

## 7. Workflow truthfulness

Workflow state can come from a file or another persistent source and may be written by agents, external tools, or the user.

Thrallwright should:

- present the state that actually exists;
- make parse or access errors visible;
- avoid inventing completion, ownership, or blockage that is not represented by the source;
- preserve unknown fields in a generic view;
- support richer renderers later without making them necessary for the first version.

Workflow display and workflow mutation are separate capabilities. The initial product may be read-only.

## 8. Relationship between sessions and workflows

The product should visually connect live execution and durable progress without claiming a relationship that cannot be established.

A relationship may be authoritative when:

- the workflow state explicitly references a session or agent;
- the harness emits workflow or task identifiers;
- the user explicitly establishes the association;
- another configured source provides a stable mapping.

If none of these exists, showing session activity and workflow state side-by-side is preferable to guessing.

## 9. Workspace context

Because the initial use case is development work, workspace-level context may include a read-only view of source-control changes or other project state.

This is useful when it helps the user understand what agent work has changed, but it is secondary to sessions and workflow state.

An initial implementation may support one source-control system rather than generalizing in advance.

## 10. Persistence expectations

Thrallwright should preserve enough durable metadata to make session and workflow history understandable after the interface is closed and reopened.

Persistence does not imply that a live process can survive every application restart. The interface must state the difference between:

- persistent session metadata;
- persistent activity history;
- resumable harness conversations;
- currently running processes.

The product should prefer rediscovering authoritative live state over assuming that saved runtime identifiers remain valid.

## 11. User experience principles

### Clarity over theme

Use ordinary operational vocabulary. Fantasy-inspired branding should never obscure the meaning or consequence of a control.

### State before decoration

The user should see active work, waiting work, failures, approvals, and blockers quickly.

### Context preservation

Switching between sessions or views should not silently start, stop, resume, or modify work.

### Explicit destructive actions

Actions that interrupt or terminate work should be clearly distinguishable from navigation and observation.

### Errors are product state

Disconnected integrations, malformed workflow data, unsupported capabilities, failed actions, and stale information should be represented explicitly rather than disappearing behind generic empty states.

## 12. Identity and visual direction

Thrallwright's identity is fantasy-inspired craftsmanship and coordination.

Good references include:

- a craftsman's workbench;
- assembled or specialized constructs;
- magical tools;
- capable companions;
- careful preparation and coordination.

Avoid making death, domination, armies, skulls, throne rooms, or dark fantasy the central visual identity.

The intended character is capable, considered, imaginative, and suitable for everyday development work.

## 13. Non-goals for the initial product

The initial product does not need to be:

- a model provider;
- a new agent runtime;
- a general-purpose orchestration framework;
- a multi-user control plane;
- a remote execution platform;
- a workflow engine that owns every state transition;
- a hidden chain-of-thought viewer;
- a universal abstraction for every agent harness;
- a heavily themed game-like interface.

## 14. Success condition for the first version

A user should be able to run Thrallwright while developing Thrallwright and use it to:

1. locate or start an agent session;
2. follow the session's observable work;
3. provide input or approvals when supported;
4. understand whether the session is active, waiting, finished, or unavailable;
5. inspect persistent workflow state for the same workspace;
6. understand the relationship between current activity and broader progress without relying on hidden or inferred state.

That is enough to validate the product before broadening the architecture.
