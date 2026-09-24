# Bootstrap validation

## Verified locally

The restored implementation passed **19 integration tests** on Linux, Python 3.13, and aiohttp 3.13.3. These use real PTYs, authenticated HTTP/WebSocket connections, temporary repositories, and actual process control. Coverage includes input, resize, reconnection, interrupt/stop, shutdown, saved output, workflow errors and symlink rejection, staged/unstaged diffs without external helpers, tokens, Host/Origin checks, request validation, output backpressure, limits, private storage, and the workspace lock.

The app also hosted this checkout, started its own real shell through the API, and successfully ran those same 19 tests over its WebSocket connection with exit status zero. This verifies the backend self-development loop; it does not imply a browser or paid agent participated.

Editable Python installation, Python compilation, and JavaScript/asset-copy-script syntax were checked. No local runtime state or transcripts belong in the repository.

## Limitations

The full browser smoke test was attempted but this environment's managed Chromium rejected localhost navigation with `net::ERR_BLOCKED_BY_ADMINISTRATOR`. No browser policy was changed. A real browser-to-server pass remains outstanding locally.

The npm registry was unreachable from the preparation container. Local backend/static-route tests used the installed Playwright 1.57.0 terminal bundle as an ignored fixture, not a successful fresh npm installation. The published source instead installs exact official xterm.js/fit-addon npm versions with `npm install` and copies the assets locally. CI exercises that setup and the real browser test. Do not interpret the local results as verification of the npm setup or claim CI is green without checking its actual run.

Codex/Claude were not installed or authenticated; their live compatibility remains to be checked with the user's CLI versions. macOS, WSL, and Python 3.11 were not exercised locally. CI covers Linux/macOS and Python 3.11/3.13, plus Chromium on Linux; WSL still needs a manual check.

## Repeat

```sh
npm install
python3 -m venv .venv
.venv/bin/python -m pip install -e .
.venv/bin/python -m unittest discover -s tests -v
.venv/bin/python -m compileall -q thrallwright scripts tests
npm run check
```

For the full browser boundary:

```sh
.venv/bin/python -m pip install playwright
.venv/bin/python -m playwright install chromium
.venv/bin/python scripts/browser-smoke.py
```

For manual self-development, launch the server against this checkout, create a Shell session, and run the tests inside it. Refresh the browser, type another command, inspect a tracked edit in Diff, update workflow state, then stop the session. Use a coding-agent session after installing and authenticating its CLI normally.
