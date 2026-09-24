# Conceptual model

This document defines concepts and relationships that implementations need to preserve. It is not a database schema, class diagram, API specification, or instruction to use any particular architecture.

## 1. Workspace

A **Workspace** is the project context in which the user is operating.

Conceptual properties may include:

- identity or path;
- display name;
- configured harness integrations;
- configured workflow sources;
- active source-control context;
- sessions associated with the workspace.

The first implementation may have exactly one active workspace.

## 2. Harness integration

A **Harness Integration** describes how Thrallwright observes and controls an existing agent environment.

Conceptual properties:

- integration identity;
- display name;
- availability;
- capabilities;
- integration-level errors or warnings.

An integration is a capability provider, not necessarily the owner of session persistence.

### Capability set

Capabilities should be independently representable. Examples:

| Capability | Meaning |
| --- | --- |
| discover sessions | Existing sessions can be enumerated. |
| start session | Thrallwright can create a new session through the harness. |
| observe status | The harness exposes current session state. |
| read history | Historical observable activity can be retrieved. |
| stream activity | New observable activity can be followed live. |
| send input | User input can be delivered to the session. |
| observe approvals | Structured approval requests are exposed. |
| answer approvals | Structured approval responses can be sent. |
| interrupt | Current execution can be interrupted. |
| stop | Live execution can be terminated. |
| resume | A saved conversation can be resumed through the harness. |
| relationships | Parent/child session relationships are exposed. |
| artifacts | Produced artifacts are exposed as structured data. |

No integration is assumed to support all capabilities.

## 3. Session

A **Session** is a durable conceptual unit of agent work or conversation.

Conceptual properties may include:

- session identity;
- display title;
- integration identity;
- workspace identity;
- status;
- start and end timestamps when known;
- current assignment or summary when known;
- parent session identity when authoritative;
- child session identities when authoritative;
- live-control availability;
- resume availability;
- attention state;
- associated activity;
- associated approvals;
- associated artifacts;
- explicit workflow references.

A session can exist as historical data without having a live process.

### Session status

Thrallwright needs a conservative status vocabulary:

| Status | Meaning |
| --- | --- |
| running | The source reports active execution. |
| waiting | The source reports a known wait for user input, approval, or another condition. |
| finished | The source reports completed work. |
| disconnected | The session is known, but live observation/control is unavailable. |
| unknown | Available evidence is insufficient for another status. |

An integration may expose more specific states. They should map into the UI without losing useful detail, but not with greater certainty than the source supports.

### Attention state

Attention is separate from execution status.

Examples:

- none;
- input requested;
- approval required;
- error;
- disconnected.

A running session may still need attention. A waiting session may be waiting for something other than the user.

## 4. Activity item

An **Activity Item** is an observable event associated with a session.

Possible kinds:

- agent message;
- user message;
- tool invocation;
- tool result;
- status change;
- approval request;
- approval response;
- artifact produced;
- warning;
- error;
- integration-specific event.

Conceptual properties may include:

- stable event identity when the source provides one;
- session identity;
- timestamp or sequence;
- kind;
- display content;
- structured source data;
- references to approvals, artifacts, parent tasks, or workflow items.

### Ordering

When the source provides a strict sequence, preserve it.

When only timestamps exist, display the best known order without claiming stronger causality than the data supports.

Duplicate delivery is possible in many event systems. An implementation should avoid visibly duplicating the same authoritative event when stable event identity is available.

## 5. Approval

An **Approval** is an explicit authorization decision exposed by a harness.

Conceptual properties may include:

- approval identity;
- requesting session;
- request description;
- structured action details;
- creation time;
- current resolution state;
- allowed responses;
- final response when resolved.

A textual question in a transcript is not automatically a structured approval.

## 6. Workflow source

A **Workflow Source** provides durable work state.

The first implementation may support a single JSON source.

Conceptual properties:

- source identity;
- workspace association;
- location or configuration;
- availability;
- last successful read;
- current document;
- parse or access error;
- optional recognized schema.

Thrallwright may read workflow state without owning its lifecycle.

## 7. Workflow document

A **Workflow Document** is the state obtained from a workflow source.

The generic representation must preserve arbitrary valid JSON structure.

Recognized schemas may expose semantic concepts such as:

- workflow title;
- workflow status;
- stages;
- tasks or steps;
- blockers;
- owners;
- session references;
- artifact references.

These semantic concepts are optional unless they are present in the source.

The application must not fabricate them from unrelated fields.

## 8. Workflow item

A **Workflow Item** is an optional semantic item extracted from a recognized workflow shape.

Conceptual properties may include:

- item identity;
- title;
- status;
- parent item;
- assigned agent or session;
- blockers;
- child items;
- artifact references.

A workflow can still be useful in Thrallwright without any Workflow Items if the document is shown generically.

## 9. Artifact

An **Artifact** is a durable output or reference surfaced by an authoritative source.

Conceptual properties may include:

- artifact identity;
- display name;
- type;
- location or reference;
- originating session;
- originating workflow item;
- creation time when known.

The interface should treat untrusted artifact references as data. Merely seeing file-like text in a transcript is not enough to create an authoritative Artifact.

## 10. Relationships

### Workspace to session

A session belongs to or is explicitly associated with a workspace.

### Integration to session

A session is observed or controlled through an integration.

### Session to session

A session may have a parent and children when the harness exposes that relationship.

### Session to workflow

A session may relate to a workflow or workflow item through an explicit reference or user-established association.

### Session to approval

An approval belongs to the session that requested it.

### Session or workflow item to artifact

Artifacts may be associated with the work that produced them when an authoritative relationship exists.

## 11. Live state versus durable state

Implementations must keep these concepts distinct:

### Durable session identity

The fact that a session existed and can still be referenced.

### Activity history

Observable events retained or retrievable after they occurred.

### Live execution

A currently running process or remote execution that the integration can authoritatively observe.

### Resumable conversation

A harness-level ability to continue a prior conversation, which may create or attach to new live execution.

### Workflow state

Persistent work state that may outlive every related agent process.

None of these implies the others.

## 12. Source authority

Every displayed fact should have a conceptual source.

Examples:

- session status comes from the harness or live process integration;
- workflow status comes from the workflow source;
- approval state comes from the harness;
- parent/child relationships come from harness metadata;
- source-control state comes from the workspace source-control system.

When two sources disagree, Thrallwright should preserve their distinction rather than silently combine them into invented truth.

## 13. Freshness

Some state changes continuously and some is durable.

The interface should be able to communicate whether information is:

- live or actively refreshed;
- recently read;
- historical;
- unavailable;
- stale or of unknown freshness.

Exact refresh mechanisms are an implementation choice.

## 14. Commands and effects

A **Command** is a user-initiated request sent through an available capability.

Conceptual command kinds include:

- start session;
- send input;
- approve;
- reject;
- interrupt;
- stop;
- resume.

Commands should have observable outcomes:

- accepted and reflected in source state;
- rejected by the source;
- failed in transport or execution;
- outcome unknown.

The UI should not report success merely because a button was clicked.
