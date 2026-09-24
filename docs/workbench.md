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
as disconnected until Codex provides fresh evidence. Opening a session does
not resume it or send input.

Activity labels identify whether an item came from live observation, Codex
history, or Thrallwright's cache. Cached activity remains useful after a
restart, but it is historical and may be incomplete. A saved approval or status
does not become actionable merely because it was cached. The workbench shows
integration and history failures explicitly, so an unavailable source does not
look like an empty session.

Thrallwright keeps a bounded local activity cache for up to 20 sessions and
8 MiB of cached activity payloads per workspace. Older activity may be evicted;
Codex remains the source for its thread history. Thrallwright retains its own
session metadata and command journal when activity is evicted. Ephemeral
sessions are excluded from this durable cache. When Codex explicitly reports
that a thread's history was deleted, Thrallwright purges that thread's cached
activity.

## Workflow state

The Workflows view displays arbitrary valid JSON, including objects, arrays,
numbers, strings, booleans, and `null`. No special task schema is required. The
service checks the configured regular file about every two seconds and limits
the displayed source to 4 MiB. Replace the file externally and the view will
refresh; Thrallwright never writes to the workflow file.

A missing file, malformed JSON, invalid encoding, oversized file, or read
failure appears as a source error. A workflow error does not prevent session
observation. The view reports only fields and relationships represented in the
JSON; it does not infer task completion or link sessions from matching text.
