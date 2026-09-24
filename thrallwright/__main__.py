"""CLI entry point. No reload watcher: restarting would terminate agents."""
import argparse
from pathlib import Path
import sys


def main():
    parser = argparse.ArgumentParser(description="Thrallwright — a workbench for your agents")
    parser.add_argument("--workspace", type=Path, default=Path.cwd(), help="Working directory for all sessions")
    parser.add_argument("--port", type=int, default=3487, help="Loopback HTTP port (default: 3487)")
    args = parser.parse_args()
    if sys.platform == "win32":
        parser.error("This version needs a POSIX terminal. Run it inside WSL on Windows.")
    if not 1024 <= args.port <= 65535:
        parser.error("Port must be between 1024 and 65535")
    static = Path(__file__).parent / "static" / "vendor"
    if not all((static / name).is_file() for name in ("terminal.js", "terminal.css", "xterm.js", "addon-fit.js")):
        parser.error("Terminal assets are missing. Run npm install from the Thrallwright checkout first.")
    from aiohttp import web
    from .server import create_app
    try:
        app = create_app(args.workspace)
        print(f"\nThrallwright\nWorkspace: {args.workspace.resolve()}\nOpen http://127.0.0.1:{args.port}\n"
              "Keep this process running. Browser refreshes preserve sessions; server restarts do not.\n"
              "Local terminal access is NOT sandboxed. Do not expose this port or run as root.\n", flush=True)
        web.run_app(app, host="127.0.0.1", port=args.port, print=None,
                    access_log=None, shutdown_timeout=4)
    except (OSError, ValueError) as exc:
        parser.exit(1, f"Thrallwright: {exc}\n")


if __name__ == "__main__":
    main()
