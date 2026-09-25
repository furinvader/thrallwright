# Using the local workbench

Start Thrallwright from its checkout with a target workspace and, optionally, a
JSON workflow file:

```sh
nix run /path/to/thrallwright -- --workspace /path/to/project --workflow tasks.json
```

`--workflow` resolves relative to the selected workspace, so this example
reads `/path/to/project/tasks.json` regardless of the directory where the
command was entered. An absolute path also works. The selected workflow path is
saved for that workspace in Thrallwright's application database. Later launches
of the same workspace use it without repeating `--workflow`; passing a new path
changes the saved selection. The workflow file remains at its external source
location. Thrallwright reads it and does not edit it.

The service prints its local address and opens a browser. Add `--no-open` to
leave the browser closed, or `--profile-dir /path/to/profile` to keep this
instance's settings and database in an isolated directory. A different profile
has its own saved workflow selection and session metadata. See
[development and Linux installation](development.md) for Nix setup, the
checkout development commands, and default XDG storage locations.

## Sessions and activity

The Sessions list distinguishes a currently observed Codex session from saved
history. A thread discovered from Codex storage can be inspected, but its
existence does not show that an agent is running or that Thrallwright can
control it. A workbench-owned session that loses its live connection is shown
as disconnected. After a service restart, its restored activity is historical
until Codex provides fresh evidence. Opening a session does not resume it or
send input. **Refresh activity** requests a new, read-only history inspection
when the source changes or a previous read fails.

Activity labels identify whether an item came from live observation, Codex
history, or Thrallwright's cache. Cached activity remains useful after a
restart, but it is historical and may be incomplete. A saved approval or status
does not become actionable merely because it was cached. The workbench shows
integration and history failures explicitly, so an unavailable source does not
look like an empty session. The activity projection shows at most 100 recent
items per session and limits individual text items to 8 KiB. **Partial or in
progress** can therefore mean that history was truncated, unavailable, or is
still being produced; it is not a completion signal.

Thrallwright keeps a bounded local activity cache for up to 20 sessions and
8 MiB of cached activity payloads per workspace. Older activity may be evicted;
Codex remains the source for its thread history. Thrallwright retains its own
session metadata and command journal when activity is evicted. Ephemeral
sessions are excluded from this durable cache. When Codex explicitly reports
that a thread's history was deleted, Thrallwright purges that thread's cached
activity.

## Authentication and controls

The workbench checks Codex authentication through the connected harness and
shows whether it is ready, requires sign-in, or cannot be checked. Codex keeps
the account and credentials; Thrallwright does not store them or sign in on your
behalf. A configured provider that does not require OpenAI authentication can
be ready without an OpenAI account. If sign-in is required, run `codex login`
in the same environment that runs the workbench, then refresh. In a Nix
checkout, `nix develop -c codex login` uses the pinned CLI.

**Start** creates a Codex thread and sends the prompt entered for that action.
Opening a historical session only inspects it; **Resume saved conversation**
is a separate, explicit action that asks Codex to load the saved conversation.
A saved ID can be stale, in which case Codex may reject Resume. **Send input**
starts a new turn for a currently owned, idle session. Start, Resume, and Send
require the authentication check to be ready. **Interrupt active turn** targets
the currently observed turn and can remain available if the authentication
check fails. Its request acknowledgment does not prove that the turn stopped;
the workbench waits for Codex's turn outcome. All controls also depend on the
current connection and session state.

For a live structured command or file-change approval, the workbench can
**Allow once** or **Decline** that one request. Its card identifies the exact
session, turn, and item, with a **View session activity** button. A file-change
request may omit the proposed changes, so inspect the related activity before
deciding. These actions can remain available if the authentication check fails.
They do not create a session-wide permission grant. Other request kinds and
unsupported approval forms remain visible but cannot be answered as command
approvals. Saved or disconnected approval items are never actionable. An
**Approval request cleared** record means Codex cleared the request; the
underlying action's outcome is separate.

Execution-changing requests have local command records. A timed-out or lost
response may have reached Codex, so an **uncertain** record is not resent
automatically, including after a browser reconnect or service restart. Inspect
the Codex session before choosing another action. Thrallwright owns the Codex
app-server process it launches; closing the service ends that connection and
does not promise that its live process survives for later reconnection.

## Workflow state

The Workflows view displays arbitrary valid JSON, including objects, arrays,
numbers, strings, booleans, and `null`. It preserves the source document, so
large numeric literals and duplicate keys are not silently rewritten. Deep or
large documents may use the original compact source instead of indentation.
No special task schema is required. The service checks the configured regular
file about every two seconds and limits
the displayed source to 4 MiB. Replace the file externally and the view will
refresh; Thrallwright never writes to the workflow file.

A missing file, malformed JSON, invalid encoding, oversized file, or read
failure appears as a source error. A workflow error does not prevent session
observation. The view reports only fields and relationships represented in the
JSON; it does not infer task completion or link sessions from matching text.
