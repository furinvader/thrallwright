# Architecture: one useful local loop

Browser (xterm.js and plain JavaScript) → authenticated WebSocket → session manager → POSIX PTY → installed CLI agent or shell.

The Python/aiohttp server owns the terminal independently of browser connections. HTTP snapshots expose sessions, read-only Git status, and workflow state. Tracked diffs are fetched only for the Diff view. Every process starts in the workspace selected at server launch. `profiles()` is the small extension point for fixed launch presets; a shell can already run arbitrary user-selected harnesses.

## Process lifecycle

A fresh Python interpreter starts a new OS session, claims the slave PTY as its controlling terminal, then execs the selected CLI. This avoids Python `preexec_fn` callbacks in the server. The parent uses a nonblocking master, asyncio readers, partial input writes, and asynchronous child reaping.

Interrupt writes terminal Ctrl+C. Stop captures the leader and foreground process groups, signals them, and escalates after a short grace period. Detached daemons can escape; this is not process-tree containment. Restarting cannot resume a process, and persisted PIDs are not trusted.

## HTTP and socket boundary

`GET /` places a per-start random token in a meta element. API calls use `X-Thrallwright-Token`; sockets offer `thrallwright.<token>` as their subprotocol, never as a URL parameter. All routes validate the literal local Host/port. Browser socket connections also require the matching Origin. Static routes are an exact allowlist, not a directory mapper.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/workspace` | Workspace, presets, sessions, status, workflow |
| GET | `/api/diff` | Staged/unstaged tracked diffs |
| POST | `/api/sessions` | Fixed `kind` and optional `title` |
| POST | `/api/sessions/{id}/interrupt` | Terminal Ctrl+C |
| POST | `/api/sessions/{id}/stop` | Terminate a session |
| GET | `/api/sessions/{id}/transcript` | Retained raw output |
| GET / upgrade | `/ws/{id}` | Terminal connection |

Browser messages are `input`, `resize`, and sequence-numbered `ack`. Server messages are `ready`, `output`, `exit`, and `error`. Output is acknowledged from the terminal renderer's write callback, not merely on socket receipt. Each view permits one output message in flight; bounded queues can pause PTY reads, and a stalled view disconnects after ten seconds. Sessions with no viewers continue recording.

Reconnect creates a new emulator and replays a bounded output tail. This is not exact screen serialization. Multiple viewers may type; the last resize wins. These are deliberate small-version tradeoffs, not a multiuser control protocol.

## Storage and observation

An advisory lock prevents two servers owning the same workspace. Metadata uses temporary files plus atomic replacement. Transcript segments rotate; workflow and metadata reads are bounded. State-directory/file symlinks are rejected at the boundary, but a hostile same-user process remains outside the security model.

Workflow JSON is never executed. A `steps` array is an optional checklist convention; invalid JSON remains an error until a later poll. Git uses explicit argv without a shell, external diff/textconv, or fsmonitor helpers. Output and duration are bounded. The diff viewer deliberately omits untracked file contents.

## Dependencies and next steps

Python uses aiohttp. Browser assets are copied from exact npm versions using `scripts/copy-terminal.mjs`, with licenses retained. Setup needs npm; runtime does not. No bundler or runtime CDN is involved. Run setup before building a wheel.

Good incremental extensions include renaming/archiving, explicit controller ownership, worktree isolation, or one typed harness adapter. Defer an editor, orchestration platform, desktop wrapper, and arbitrary filesystem API until a concrete workflow needs them.
