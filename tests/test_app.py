"""Integration tests use real local PTYs and temporary repositories; no paid agents."""
import asyncio
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from aiohttp import ClientSession, WSServerHandshakeError, web

from thrallwright.server import MANAGER, TOKEN, create_app
from thrallwright.storage import Store


class AppTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.environment = patch.dict(os.environ, {"SHELL": "/bin/sh"})
        self.environment.start()
        self.app = create_app(self.root)
        self.runner = web.AppRunner(self.app, shutdown_timeout=1)
        await self.runner.setup()
        self.site = web.TCPSite(self.runner, "127.0.0.1", 0)
        await self.site.start()
        self.port = self.site._server.sockets[0].getsockname()[1]
        self.base = f"http://127.0.0.1:{self.port}"
        self.headers = {"X-Thrallwright-Token": self.app[TOKEN]}
        self.client = ClientSession()

    async def asyncTearDown(self):
        await self.client.close()
        await self.runner.cleanup()
        self.environment.stop()
        self.temporary.cleanup()

    async def create(self, title="Test shell"):
        response = await self.client.post(self.base + "/api/sessions", headers=self.headers,
                                          json={"kind": "shell", "title": title})
        self.assertEqual(response.status, 201, await response.text())
        return await response.json()

    async def connect(self, session_id):
        return await self.client.ws_connect(self.base + f"/ws/{session_id}",
            headers={"Origin": self.base}, protocols=["thrallwright." + self.app[TOKEN]])

    async def until(self, ws, text):
        output = ""
        async with asyncio.timeout(5):
            while text not in output:
                message = await ws.receive_json()
                if message["type"] == "output":
                    output += message["data"]
                    await ws.send_json({"type": "ack", "seq": message["seq"]})
                elif message["type"] == "error":
                    self.fail(message["message"])
        return output

    async def test_assets_and_security_headers(self):
        response = await self.client.get(self.base)
        self.assertEqual(response.status, 200)
        self.assertIn(self.app[TOKEN], await response.text())
        self.assertEqual(response.headers["Cache-Control"], "no-store")
        self.assertIn("frame-ancestors 'none'", response.headers["Content-Security-Policy"])
        for path in ["/app.js", "/style.css", "/vendor/terminal.js", "/vendor/terminal.css",
                     "/vendor/xterm.js", "/vendor/addon-fit.js"]:
            response = await self.client.get(self.base + path)
            self.assertEqual(response.status, 200, path)
            self.assertNotIn(self.app[TOKEN], await response.text())
        for path in ["/.git/config", "/.thrallwright/server.lock", "/server.py", "/vendor/../../server.py"]:
            response = await self.client.get(self.base + path)
            self.assertEqual(response.status, 404, path)

    async def test_http_authentication_and_rebinding_protection(self):
        for headers in [{}, {"X-Thrallwright-Token": "wrong"},
                        {**self.headers, "Origin": "https://evil.example"},
                        {**self.headers, "Host": f"evil.example:{self.port}"},
                        {**self.headers, "Sec-Fetch-Site": "cross-site"}]:
            response = await self.client.get(self.base + "/api/workspace", headers=headers)
            self.assertEqual(response.status, 403)
        response = await self.client.get(self.base + "/api/workspace", headers=self.headers)
        self.assertEqual(response.status, 200)

    async def test_websocket_authentication_and_origin(self):
        session = await self.create()
        for origin, token in [(self.base, "wrong"), ("https://evil.example", self.app[TOKEN]),
                              (None, self.app[TOKEN])]:
            with self.assertRaises(WSServerHandshakeError) as caught:
                await self.client.ws_connect(self.base + f"/ws/{session['id']}",
                    headers={"Origin": origin} if origin else {}, protocols=["thrallwright." + token])
            self.assertEqual(caught.exception.status, 403)

    async def test_launch_validation_and_no_arbitrary_command_api(self):
        for body in [[], {"kind": "unknown"}, {"kind": []}, {"kind": "shell", "title": 4},
                     {"kind": "shell", "title": "x" * 81}, {"kind": "shell", "title": "bad\nname"},
                     {"kind": "shell", "command": "arbitrary command"}, {"kind": "shell", "cwd": "/"}]:
            response = await self.client.post(self.base + "/api/sessions", headers=self.headers, json=body)
            self.assertEqual(response.status, 400, str(body))
        self.assertEqual(self.app[MANAGER].listing(), [])

    async def test_real_shell_io_resize_refresh_and_saved_output(self):
        session = await self.create()
        item = self.app[MANAGER].get(session["id"])
        pid = item.process.pid
        ws = await self.connect(session["id"])
        await ws.send_json({"type": "input", "data": "printf '__REAL_%s__\\n' 'PTY'\r"})
        await self.until(ws, "__REAL_PTY__")
        await ws.send_json({"type": "resize", "cols": 111, "rows": 37})
        await ws.send_json({"type": "input", "data": "stty size\r"})
        await self.until(ws, "37 111")
        await ws.close()
        self.assertTrue(item.running)
        ws = await self.connect(session["id"])
        await self.until(ws, "__REAL_PTY__")
        self.assertEqual(item.process.pid, pid)
        response = await self.client.get(self.base + f"/api/sessions/{session['id']}/transcript", headers=self.headers)
        self.assertIn("__REAL_PTY__", await response.text())
        self.assertIn("attachment", response.headers["Content-Disposition"])
        await ws.close()

    async def test_interrupt_foreground_job_and_stop(self):
        session = await self.create()
        ws = await self.connect(session["id"])
        await ws.send_json({"type": "input", "data": "sleep 30\r"})
        await asyncio.sleep(0.2)
        response = await self.client.post(self.base + f"/api/sessions/{session['id']}/interrupt", headers=self.headers)
        self.assertEqual(response.status, 200)
        await ws.send_json({"type": "input", "data": "printf '__AFTER_%s__\\n' 'INTERRUPT'\r"})
        await self.until(ws, "__AFTER_INTERRUPT__")
        response = await self.client.post(self.base + f"/api/sessions/{session['id']}/stop", headers=self.headers)
        self.assertEqual(response.status, 200, await response.text())
        item = self.app[MANAGER].get(session["id"])
        self.assertFalse(item.running)
        self.assertEqual(item.meta["status"], "stopped")
        self.assertIsNotNone(item.meta["exit_code"])
        await ws.close()

    async def test_exited_session_history_after_restart(self):
        session = await self.create()
        ws = await self.connect(session["id"])
        await ws.send_json({"type": "input", "data": "printf '__SAVED_%s__\\n' 'HISTORY'; exit 7\r"})
        await self.until(ws, "__SAVED_HISTORY__")
        await asyncio.wait_for(self.app[MANAGER].get(session["id"]).finished.wait(), 3)
        await ws.close()
        await self.runner.cleanup()
        restarted = create_app(self.root)
        try:
            item = restarted[MANAGER].get(session["id"])
            self.assertEqual(item.meta["status"], "exited")
            self.assertEqual(item.meta["exit_code"], 7)
            self.assertFalse(item.running)
            self.assertIn("__SAVED_HISTORY__", item.replay())
        finally:
            await restarted[MANAGER].close()

    async def test_workflow_invalid_large_and_symlink(self):
        path = self.root / ".thrallwright/workflow.json"
        store = self.app[MANAGER].store
        self.assertEqual(store.workflow(), {"exists": False})
        path.write_text('{"title":"First workflow","steps":[{"id":"1","status":"done"}]}')
        self.assertEqual(store.workflow()["data"]["title"], "First workflow")
        path.write_text("{")
        self.assertIn("error", store.workflow())
        path.write_text(" " * (129 * 1024))
        self.assertIn("exceeds", store.workflow()["error"])
        path.unlink()
        outside = self.root / "private.json"
        outside.write_text('{"secret":"do-not-read"}')
        path.symlink_to(outside)
        self.assertIn("error", store.workflow())
        self.assertNotIn("do-not-read", json.dumps(store.workflow()))

    async def test_git_status_staged_and_unstaged_without_helpers(self):
        def git(*args):
            return subprocess.run(["git", *args], cwd=self.root, check=True,
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        git("init", "-b", "main")
        git("config", "user.name", "Test")
        git("config", "user.email", "test@example.invalid")
        (self.root / "tracked.txt").write_text("before\n")
        git("add", "tracked.txt")
        git("commit", "-m", "fixture")
        (self.root / "tracked.txt").write_text("staged version\n")
        git("add", "tracked.txt")
        (self.root / "tracked.txt").write_text("unstaged version\n")
        (self.root / "new.txt").write_text("untracked\n")
        helper = self.root / "helper.sh"
        helper.write_text("#!/bin/sh\ntouch helper-ran\n")
        helper.chmod(0o755)
        git("config", "diff.external", str(helper))
        git("config", "core.fsmonitor", str(helper))
        response = await self.client.get(self.base + "/api/workspace", headers=self.headers)
        data = await response.json()
        self.assertIn("main", data["git"]["text"])
        self.assertIn("new.txt", data["git"]["text"])
        response = await self.client.get(self.base + "/api/diff", headers=self.headers)
        data = await response.json()
        self.assertIn("+unstaged version", data["unstaged"]["text"])
        self.assertIn("+staged version", data["staged"]["text"])
        self.assertFalse((self.root / "helper-ran").exists())

    async def test_workspace_lock(self):
        with self.assertRaisesRegex(ValueError, "already owns"):
            create_app(self.root)

    async def test_active_limit(self):
        with patch("thrallwright.sessions.MAX_ACTIVE", 1):
            await self.create()
            response = await self.client.post(self.base + "/api/sessions", headers=self.headers,
                                              json={"kind": "shell"})
            self.assertEqual(response.status, 400)
            self.assertIn("At most 1", await response.text())

    async def test_websocket_invalid_messages_do_not_crash_server(self):
        session = await self.create()
        ws = await self.connect(session["id"])
        for body in [{"type": "resize", "cols": "120", "rows": 30},
                     {"type": "resize", "cols": 1000000, "rows": 30},
                     {"type": "input", "data": []}, {"type": "unknown"}, []]:
            await ws.send_json(body)
            async with asyncio.timeout(3):
                while True:
                    message = await ws.receive_json()
                    if message["type"] == "output":
                        await ws.send_json({"type": "ack", "seq": message["seq"]})
                    if message["type"] == "error":
                        break
        self.assertTrue(self.app[MANAGER].get(session["id"]).running)
        await ws.close()

    async def test_slow_browser_is_detached_without_killing_session(self):
        session = await self.create()
        with patch("thrallwright.server.ACK_TIMEOUT", 0.1):
            ws = await self.connect(session["id"])
            async with asyncio.timeout(3):
                async for message in ws:
                    pass  # Deliberately never acknowledge output.
            self.assertEqual(ws.close_code, 1013)
            await asyncio.sleep(0.05)
            item = self.app[MANAGER].get(session["id"])
            self.assertTrue(item.running)
            self.assertEqual(len(item.subscribers), 0)
            self.assertTrue(item.reading)

    async def test_shutdown_closes_socket_and_process(self):
        session = await self.create()
        ws = await self.connect(session["id"])
        await self.runner.cleanup()
        item = self.app[MANAGER].get(session["id"])
        self.assertFalse(item.running)
        self.assertIsNone(item.fd)
        await ws.close()

    async def test_oversized_request_rejected(self):
        response = await self.client.post(self.base + "/api/sessions", headers=self.headers,
                                          json={"kind": "shell", "title": "x" * 40000})
        self.assertEqual(response.status, 413)
        self.assertFalse(self.app[MANAGER].listing())

    async def test_missing_cli_returns_actionable_error(self):
        from thrallwright.sessions import profiles
        available = profiles()
        available["codex"]["command"] = None
        with patch("thrallwright.sessions.profiles", return_value=available):
            response = await self.client.post(self.base + "/api/sessions", headers=self.headers,
                                              json={"kind": "codex"})
        self.assertEqual(response.status, 400)
        self.assertIn("not on PATH", await response.text())


class StoreTests(unittest.TestCase):
    def test_private_permissions_rotation_and_crash_recovery(self):
        with tempfile.TemporaryDirectory() as temporary:
            store = Store(Path(temporary))
            session_id = "a" * 32
            try:
                store.create(session_id)
                store.save(dict(id=session_id, started_at="2026-01-01", title="Example", status="running"))
                with patch("thrallwright.storage.LOG_BYTES", 64):
                    store.append(session_id, b"A" * 40)
                    store.append(session_id, b"B" * 40)
                    store.append(session_id, b"C" * 40)
                    self.assertEqual(store.transcript(session_id), b"B" * 40 + b"C" * 40)
                self.assertEqual(store.load()[0]["status"], "interrupted")
                self.assertEqual((store.directory(session_id) / "session.json").stat().st_mode & 0o777, 0o600)
                self.assertEqual(store.root.stat().st_mode & 0o777, 0o700)
            finally:
                store.close()

    def test_reject_symlink_state_directory(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "outside").mkdir()
            (root / ".thrallwright").symlink_to(root / "outside", target_is_directory=True)
            with self.assertRaises(ValueError):
                Store(root)

    def test_corrupt_metadata_is_skipped(self):
        with tempfile.TemporaryDirectory() as temporary:
            store = Store(Path(temporary))
            try:
                store.create("b" * 32)
                (store.directory("b" * 32) / "session.json").write_text("not json")
                self.assertEqual(store.load(), [])
                self.assertTrue(store.warnings)
            finally:
                store.close()


if __name__ == "__main__":
    unittest.main()
