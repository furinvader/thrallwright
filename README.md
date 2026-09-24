# Thrallwright

**A workbench for your agents.**

A local workbench for observing and directing AI agents, managing sessions, and tracking persistent workflows. Start a CLI agent in a real terminal, answer its approval prompts, and inspect the working tree and JSON workflow state alongside it. The first milestone is deliberately small: **use Thrallwright to develop Thrallwright.**

Canonical repository: https://github.com/furinvader/thrallwright

## Start here

Requires **Python 3.11+**, **Node 18+ and npm for one-time asset setup**, and **Linux, macOS, or WSL**. Git powers the inspector. A coding agent is optional; the shell works without one. Native Windows is not supported in this version.

From this checkout:

```sh
npm install
python3 -m venv .venv
.venv/bin/python -m pip install -e .
.venv/bin/python -m thrallwright --workspace .
```

Open **http://127.0.0.1:3487**, select **New session**, and choose Codex, Claude Code, or Shell. Missing CLIs are disabled. Install and authenticate your agent separately; Thrallwright uses the executable on the server's PATH and its normal authentication. A shell can run other harnesses, too.

`npm install` copies pinned xterm.js and fit-addon assets, including licenses, into the local static directory. There is no frontend bundler and no browser CDN request. Node is not required while running the server. Run asset setup before building a Python wheel. The Python dependency is `aiohttp>=3.13.3,<4`; its transitive dependencies are not locked by this bootstrap.

```sh
.venv/bin/python -m thrallwright --workspace /absolute/path/to/project --port 3488
```

The working directory is selected when starting the server, not by browser requests. All sessions share that directory. Only one server may own a workspace at a time.

## Develop the app using the app

Start the server from this checkout and leave the launcher terminal running. Create a coding-agent session named `Develop Thrallwright`. A first task could be:

> Read AGENTS.md and docs/architecture.md. Create a feature branch, add a way to rename an existing session, cover it with tests, and inspect the diff. Do not push to main. Keep .thrallwright/workflow.json up to date.

Use a second Shell session to run:

```sh
.venv/bin/python -m unittest discover -s tests -v
```

Review Changes and Diff, then create a PR using your normal Git workflow. Browser refreshes reconnect without stopping the PTY. Static asset edits appear after refresh. **There is no backend auto-reloader: restarting the server ends its sessions.** Preview backend changes with a disposable workspace and another port:

```sh
mkdir -p /tmp/thrallwright-preview
.venv/bin/python -m thrallwright --workspace /tmp/thrallwright-preview --port 3488
```

Restart the main server from its original launcher only after the agent is idle. Saved history is not a resumable process; use a harness's own resume command in a new shell when needed.

## Included in v0.1

- Real interactive terminals with ANSI rendering, keyboard input, resize, named sessions, reconnect, Interrupt (Ctrl+C), and confirmed Stop.
- Private local session metadata and bounded output logs; archived sessions remain readable after a restart.
- Read-only Git status and separate staged/unstaged tracked diffs, plus JSON workflow state, refreshed every three seconds.

There is no API-key management, hidden orchestration, approval bypass, structured subagent tree, editor, worktree isolation, or remote execution service. A selected agent can still require credentials and contact its provider.

## Workflow state

After starting the server:

```sh
cp examples/workflow.json .thrallwright/workflow.json
```

Any valid JSON is displayed. An object with a `title` and `steps` array additionally becomes a checklist:

```json
{
  "version": 1,
  "title": "Build one small improvement",
  "status": "running",
  "steps": [
    {"id": "inspect", "title": "Read the relevant code", "status": "done"},
    {"id": "build", "title": "Implement and test", "status": "running"}
  ]
}
```

The viewer is read-only and accepts at most 128 KiB. Prefer temporary-file writes and atomic rename. Invalid or mid-write JSON is shown as an error and retried; workflow statuses are display conventions, not an orchestration engine.

## Persistence and limits

`.thrallwright/` is ignored by Git and created with owner-only permissions. It holds a workspace lock, workflow state, and per-session metadata/output. Output rotates between two approximately 2 MiB segments; older output is discarded. Reconnection replays the last 512 KiB. Full-screen replay is approximate, not an exact terminal snapshot; Ctrl+L may help a running TUI redraw. Save log downloads retained raw output, including control sequences.

At most six processes and four browser views per session are allowed. The newest 100 sessions are retained; older inactive directories are pruned. Slow browser viewers use bounded queues and a ten-second renderer-acknowledgement deadline.

Logs record output, not a separate keystroke stream. Echoed commands and displayed credentials can still be captured. Treat state and exported logs as sensitive. Recording failures are visible while the process continues. Stop the server before manually clearing state. Stale running records become interrupted on restart; no saved PID is ever adopted.

## Security boundary

**Trusted local machine only. Do not expose, tunnel, or reverse-proxy this port. Do not run as root.** The server binds to `127.0.0.1`, validates Host and Origin, and requires a random per-start API/socket token. Browser resources are local; framing is disabled and workspace text is never inserted as HTML.

This is **not a sandbox**. Processes inherit your account, environment, credentials, and filesystem access. The workspace is a starting directory, not confinement. Normal agent permission prompts remain intact. Local-user or local-process compromise is outside this boundary.

Sessions share a checkout and can conflict. Begin with one coding agent at a time. Stop signals the session leader and current foreground process group, then escalates after a short grace period. Deliberately detached descendants may escape this model.

## Tests

```sh
.venv/bin/python -m unittest discover -s tests -v
.venv/bin/python -m compileall -q thrallwright scripts tests
npm run check
```

The integration suite uses real PTYs and temporary Git repositories without paid agents. The optional browser smoke test launches a shell, types commands, refreshes, reads workflow/diff state, downloads logs, and runs the integration tests inside that shell:

```sh
.venv/bin/python -m pip install playwright
.venv/bin/python -m playwright install chromium
.venv/bin/python scripts/browser-smoke.py
```

See `docs/validation.md` for preparation-time results and limitations. CI includes Linux/macOS integration checks and a Linux Chromium smoke test.

## Code map

`server.py` owns HTTP/WebSockets; `sessions.py` supervises PTYs; `storage.py` owns bounded persistence; `pty_child.py` establishes a controlling terminal. `static/app.js` and `static/style.css` are the unbundled UI. `AGENTS.md` records development rules.

No project license has been selected in this bootstrap. Terminal dependencies carry their own MIT notices, copied during setup.
