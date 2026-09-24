# Working on Thrallwright

Canonical repository: https://github.com/furinvader/thrallwright

## Intent

A small local workbench for existing CLI agents and persistent workflows. The first useful loop is developing this app inside one of its own sessions. The name suggests fantasy craftsmanship and coordination, not a dark-fantasy game. Use clear functional labels. Working tagline: **A workbench for your agents.**

## Setup and validation

Run `npm install` once to copy the pinned terminal assets. Install the Python project with `python -m pip install -e .` in a virtual environment. Start `python -m thrallwright --workspace .` and open the printed loopback URL.

Run `python -m unittest discover -s tests -v` after backend changes, and `npm run check` after JavaScript changes. `scripts/browser-smoke.py` is the optional Playwright end-to-end check. Keep tests independent of paid/authenticated agents.

## Preserve the self-development loop

The server owns processes; browsers are disposable. Reloading the page must not terminate a session. Do not add a backend auto-reloader. Never kill the server hosting your current agent session; test with another workspace/port, then let the user restart from the original launcher once work is idle.

## Boundaries

Preserve loopback binding, token checks, Host/Origin validation, output limits, and read-only Git inspection. Never accept arbitrary launch command text through API parameters, bypass harness approvals, serve workspace files as static assets, insert untrusted text as HTML, or adopt a process by a persisted PID. Shell sessions already support other CLI harnesses under explicit user control.

Keep local state under `.thrallwright/`. Do not inspect or commit credentials, environment dumps, transcripts, or actual workflow state; logs may contain secrets. Update the tracked workflow example instead. Preserve an existing workflow's structure and update it atomically.

The workflow viewer is generic and read-only. Add typed harness events before promising authoritative tool/subagent status; do not scrape terminal strings into claimed agent state.

## Contribution workflow

Read the relevant code and `docs/architecture.md`, take one small task, work on a feature branch, add regression tests, and inspect the diff. Do not push application changes to main or merge a PR unless explicitly requested. Keep the code understandable rather than adding abstractions for hypothetical integrations.

Terminal assets are generated from pinned npm dependencies. Do not edit or commit the generated minified files. Preserve their license notices when changing asset setup.
