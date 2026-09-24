"""Loopback-only HTTP/WebSocket surface; workspace readers never execute shell text."""
from __future__ import annotations

import asyncio
import contextlib
import hmac
import json
import logging
from pathlib import Path
import secrets

from aiohttp import WSMsgType, web

from .sessions import SessionManager, profiles

STATIC = Path(__file__).parent / "static"
ACK_TIMEOUT = 10
MANAGER = web.AppKey("manager", SessionManager)
TOKEN = web.AppKey("token", str)
SOCKETS = web.AppKey("sockets", set)
ASSETS = {
    "/app.js": ("app.js", "text/javascript"),
    "/style.css": ("style.css", "text/css"),
    "/vendor/terminal.js": ("vendor/terminal.js", "text/javascript"),
    "/vendor/terminal.css": ("vendor/terminal.css", "text/css"),
    "/vendor/xterm.js": ("vendor/xterm.js", "text/javascript"),
    "/vendor/addon-fit.js": ("vendor/addon-fit.js", "text/javascript"),
}


def check_origin(request: web.Request):
    port = request.transport.get_extra_info("sockname")[1]
    if request.host not in {f"127.0.0.1:{port}", f"localhost:{port}"}:
        raise web.HTTPForbidden(text="Untrusted Host")
    origin = request.headers.get("Origin")
    if origin is not None and origin != f"http://{request.host}":
        raise web.HTTPForbidden(text="Untrusted Origin")
    if request.headers.get("Sec-Fetch-Site") == "cross-site":
        raise web.HTTPForbidden(text="Cross-site access is not allowed")


@web.middleware
async def security(request: web.Request, handler):
    try:
        check_origin(request)
        if request.path.startswith("/api/"):
            if not hmac.compare_digest(request.headers.get("X-Thrallwright-Token", ""), request.app[TOKEN]):
                raise web.HTTPForbidden(text="Missing or invalid workspace token")
        response = await handler(request)
    except web.HTTPException as exc:
        response = web.json_response({"error": exc.text}, status=exc.status)
    except (ValueError, TypeError, json.JSONDecodeError) as exc:
        response = web.json_response({"error": str(exc)}, status=400)
    except KeyError:
        response = web.json_response({"error": "Session not found"}, status=404)
    except OSError as exc:
        logging.getLogger(__name__).warning("Workspace operation failed: %s", exc)
        response = web.json_response({"error": f"Workspace operation failed: {exc}"}, status=500)
    if not response.prepared:
        response.headers.update({
            "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
            "X-Frame-Options": "DENY", "Referrer-Policy": "no-referrer",
            "Cross-Origin-Resource-Policy": "same-origin",
            "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
                "connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; "
                "form-action 'none'; frame-ancestors 'none'",
        })
    return response


async def index(request: web.Request):
    html = (STATIC / "index.html").read_text().replace("__TOKEN__", request.app[TOKEN])
    return web.Response(text=html, content_type="text/html")


async def asset(request: web.Request):
    path, content_type = ASSETS[request.path]
    return web.Response(body=(STATIC / path).read_bytes(), content_type=content_type)


async def git_output(workspace: Path, *args: str) -> dict:
    """Bound output/duration and disable external diff, textconv, and fsmonitor helpers."""
    process = None
    data = bytearray()
    limit = 256 * 1024
    try:
        process = await asyncio.create_subprocess_exec(
            "git", "--no-optional-locks", "-c", "core.fsmonitor=false",
            "-c", "core.untrackedCache=false", *args, cwd=workspace,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
        )
        async with asyncio.timeout(5):
            while len(data) <= limit:
                chunk = await process.stdout.read(min(32768, limit + 1 - len(data)))
                if not chunk:
                    break
                data.extend(chunk)
            truncated = len(data) > limit
            if truncated and process.returncode is None:
                process.kill()
            code = await process.wait()
        return {"text": data[:limit].decode("utf-8", "replace"),
                "ok": code == 0 or truncated, "truncated": truncated}
    except FileNotFoundError:
        return {"text": "Git is not installed or is not on PATH.", "ok": False}
    except TimeoutError:
        return {"text": "Git took longer than five seconds; try Refresh.", "ok": False}
    finally:
        if process is not None and process.returncode is None:
            with contextlib.suppress(ProcessLookupError):
                process.kill()
            await process.communicate()


async def workspace_snapshot(request: web.Request):
    manager = request.app[MANAGER]
    status = await git_output(manager.workspace, "status", "--short", "--branch", "--untracked-files=normal")
    return web.json_response({
        "workspace": str(manager.workspace),
        "profiles": [{"id": key, "label": value["label"], "available": bool(value["command"])}
                     for key, value in profiles().items()],
        "sessions": manager.listing(), "git": status,
        "workflow": manager.store.workflow(), "warnings": manager.store.warnings[-10:],
    })


async def diff(request: web.Request):
    manager = request.app[MANAGER]
    options = ["--no-color", "--no-ext-diff", "--no-textconv"]
    unstaged, staged = await asyncio.gather(
        git_output(manager.workspace, "diff", *options),
        git_output(manager.workspace, "diff", "--cached", *options),
    )
    return web.json_response({"unstaged": unstaged, "staged": staged})


async def create_session(request: web.Request):
    if request.content_type != "application/json":
        raise ValueError("Expected application/json")
    body = await request.json()
    if not isinstance(body, dict) or set(body) - {"kind", "title"}:
        raise ValueError("Expected an object containing kind and optional title")
    session = await request.app[MANAGER].create(body.get("kind"), body.get("title", ""))
    return web.json_response(session.meta, status=201)


async def stop_session(request: web.Request):
    await request.app[MANAGER].get(request.match_info["session_id"]).stop()
    return web.json_response({"ok": True})


async def interrupt_session(request: web.Request):
    session = request.app[MANAGER].get(request.match_info["session_id"])
    await asyncio.wait_for(session.write("\x03"), timeout=2)
    return web.json_response({"ok": True})


async def transcript(request: web.Request):
    session = request.app[MANAGER].get(request.match_info["session_id"])
    data = request.app[MANAGER].store.transcript(session.meta["id"])
    return web.Response(body=data, content_type="text/plain", charset="utf-8", headers={
        "Content-Disposition": f'attachment; filename="thrallwright-{session.meta["id"]}.log"',
    })


async def terminal_socket(request: web.Request):
    expected = "thrallwright." + request.app[TOKEN]
    offered = request.headers.get("Sec-WebSocket-Protocol", "").split(",")
    if not any(hmac.compare_digest(item.strip(), expected) for item in offered):
        raise web.HTTPForbidden(text="Invalid terminal token")
    if request.headers.get("Origin") != f"http://{request.host}":
        raise web.HTTPForbidden(text="Terminal connections require a same-origin browser")
    session = request.app[MANAGER].get(request.match_info["session_id"])
    replay = session.replay()
    queue = session.subscribe()
    ws = web.WebSocketResponse(protocols=[expected], heartbeat=20, max_msg_size=65536, compress=False)
    ack = asyncio.Event()
    sequence = 0
    acknowledged = 0

    async def send_output(data: str):
        nonlocal sequence
        sequence += 1
        ack.clear()
        await ws.send_json({"type": "output", "seq": sequence, "data": data})
        # Bound browser parsing and socket queues with renderer acknowledgements.
        await asyncio.wait_for(ack.wait(), timeout=ACK_TIMEOUT)

    async def sender():
        try:
            await ws.send_json({"type": "ready", "session": session.meta})
            await send_output(replay)
            while not ws.closed:
                try:
                    item = await asyncio.wait_for(queue.get(), timeout=0.2)
                except asyncio.TimeoutError:
                    if session.running or not queue.empty():
                        continue
                    await ws.send_json({"type": "exit", "session": session.meta})
                    return
                session.resume_reading()
                await send_output(item["data"])
        except (ConnectionError, RuntimeError, asyncio.TimeoutError):
            await ws.close(code=1013, message=b"Terminal view too slow; reconnect")

    task = None
    try:
        await ws.prepare(request)
        request.app[SOCKETS].add(ws)
        task = asyncio.create_task(sender())
        async for message in ws:
            if message.type != WSMsgType.TEXT:
                if message.type in {WSMsgType.ERROR, WSMsgType.CLOSE}:
                    break
                await ws.close(code=1003, message=b"Expected JSON text")
                break
            try:
                body = json.loads(message.data)
                if not isinstance(body, dict):
                    raise ValueError("Expected an object")
                kind = body.get("type")
                if kind == "ack":
                    if type(body.get("seq")) is int and body["seq"] == sequence and sequence > acknowledged:
                        acknowledged = sequence
                        ack.set()
                elif kind == "input":
                    await asyncio.wait_for(session.write(body.get("data")), timeout=2)
                elif kind == "resize":
                    session.resize(body.get("cols"), body.get("rows"))
                else:
                    raise ValueError("Unknown terminal message")
            except (ValueError, TypeError, OSError, TimeoutError) as exc:
                await ws.send_json({"type": "error", "message": str(exc) or "Terminal input timed out"})
    finally:
        if task is not None:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
        session.unsubscribe(queue)
        request.app[SOCKETS].discard(ws)
    return ws


def create_app(workspace: Path) -> web.Application:
    workspace = workspace.expanduser().resolve(strict=True)
    if not workspace.is_dir():
        raise ValueError("Workspace must be a directory")
    app = web.Application(middlewares=[security], client_max_size=32768)
    app[MANAGER] = SessionManager(workspace)
    app[TOKEN] = secrets.token_hex(32)
    app[SOCKETS] = set()
    app.router.add_get("/", index)
    for route in ASSETS:
        app.router.add_get(route, asset)
    app.router.add_get("/api/workspace", workspace_snapshot)
    app.router.add_get("/api/diff", diff)
    app.router.add_post("/api/sessions", create_session)
    app.router.add_post("/api/sessions/{session_id}/stop", stop_session)
    app.router.add_post("/api/sessions/{session_id}/interrupt", interrupt_session)
    app.router.add_get("/api/sessions/{session_id}/transcript", transcript)
    app.router.add_get("/ws/{session_id}", terminal_socket)

    async def cleanup(application):
        await asyncio.gather(*(socket.close(code=1001, message=b"Server stopping")
                               for socket in tuple(application[SOCKETS])), return_exceptions=True)
        await application[MANAGER].close()

    app.on_shutdown.append(cleanup)
    return app
