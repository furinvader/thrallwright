"""Real PTY sessions, independent of browser connections."""
from __future__ import annotations

import asyncio
import codecs
from datetime import datetime, timezone
import errno
import fcntl
import os
from pathlib import Path
import shutil
import signal
import struct
import sys
import termios
from uuid import uuid4

from .storage import REPLAY_BYTES, Store

MAX_ACTIVE = 6
MAX_HISTORY = 100
MAX_INPUT = 16 * 1024


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def profiles() -> dict:
    shell = os.environ.get("SHELL") or shutil.which("bash") or "/bin/sh"
    return {
        "codex": {"label": "Codex", "command": shutil.which("codex"), "args": []},
        "claude": {"label": "Claude Code", "command": shutil.which("claude"), "args": []},
        "shell": {"label": "Shell", "command": shutil.which(shell), "args": ["-i"]},
    }


class Session:
    def __init__(self, manager: "SessionManager", metadata: dict):
        self.manager = manager
        self.meta = metadata
        self.process: asyncio.subprocess.Process | None = None
        self.fd: int | None = None
        self.tail = bytearray()
        self.decoder = codecs.getincrementaldecoder("utf-8")("replace")
        self.subscribers: set[asyncio.Queue] = set()
        self.eof = asyncio.Event()
        self.finished = asyncio.Event()
        self.writer_lock = asyncio.Lock()
        self.reading = False
        self.monitor: asyncio.Task | None = None

    @property
    def running(self):
        return self.process is not None and not self.finished.is_set()

    def save(self):
        try:
            self.manager.store.save(self.meta)
        except (OSError, ValueError) as exc:
            self.meta["recording_error"] = str(exc)

    async def start(self, command: str, args: list[str]):
        master, slave = os.openpty()
        self.fd = master
        os.set_blocking(master, False)
        self.resize(100, 28)
        env = dict(os.environ, TERM="xterm-256color", COLORTERM="truecolor")
        try:
            self.process = await asyncio.create_subprocess_exec(
                sys.executable, "-I", str(Path(__file__).with_name("pty_child.py")),
                command, *args, cwd=self.manager.workspace, env=env,
                stdin=slave, stdout=slave, stderr=slave, start_new_session=True,
            )
        except Exception:
            os.close(master)
            self.fd = None
            self.meta.update(status="failed", ended_at=now())
            self.save()
            raise
        finally:
            os.close(slave)
        self.resume_reading()
        self.monitor = asyncio.create_task(self._wait())

    def resize(self, cols: int, rows: int):
        if type(cols) is not int or type(rows) is not int:
            raise ValueError("Terminal dimensions must be integers")
        if not 2 <= cols <= 400 or not 2 <= rows <= 200:
            raise ValueError("Terminal size must be 2–400 columns by 2–200 rows")
        if self.fd is not None:
            fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
        self.meta.update(cols=cols, rows=rows)

    def resume_reading(self):
        if (self.fd is not None and not self.eof.is_set() and not self.reading
                and all(queue.qsize() < 8 for queue in self.subscribers)):
            asyncio.get_running_loop().add_reader(self.fd, self._read)
            self.reading = True

    def pause_reading(self):
        if self.fd is not None and self.reading:
            asyncio.get_running_loop().remove_reader(self.fd)
            self.reading = False

    def _read(self):
        if any(queue.full() for queue in self.subscribers):
            self.pause_reading()
            return
        try:
            data = os.read(self.fd, 32768)
        except BlockingIOError:
            return
        except OSError as exc:
            if exc.errno != errno.EIO:
                self.meta["terminal_error"] = str(exc)
            data = b""
        if not data:
            self.pause_reading()
            self.eof.set()
            return
        self.tail.extend(data)
        if len(self.tail) > REPLAY_BYTES:
            del self.tail[:-REPLAY_BYTES]
        if not self.meta.get("recording_error"):
            try:
                if self.manager.store.append(self.meta["id"], data):
                    self.meta["log_rotated"] = True
                    self.save()
            except (OSError, ValueError) as exc:
                self.meta["recording_error"] = str(exc)
                self.save()
        text = self.decoder.decode(data)
        if text:
            for queue in tuple(self.subscribers):
                queue.put_nowait({"type": "output", "data": text})

    async def write(self, text: str):
        if not isinstance(text, str) or len(text.encode("utf-8")) > MAX_INPUT:
            raise ValueError("Input must be text, at most 16 KiB per message")
        async with self.writer_lock:
            remaining = text.encode("utf-8")
            while remaining:
                if self.fd is None or not self.running:
                    raise ValueError("This session has ended")
                try:
                    written = os.write(self.fd, remaining)
                    remaining = remaining[written:]
                except BlockingIOError:
                    await asyncio.sleep(0.01)
                except OSError as exc:
                    raise ValueError("Terminal is no longer available") from exc

    def subscribe(self) -> asyncio.Queue:
        if len(self.subscribers) >= 4:
            raise ValueError("At most four browser views per session")
        queue = asyncio.Queue(maxsize=32)
        self.subscribers.add(queue)
        return queue

    def unsubscribe(self, queue: asyncio.Queue):
        self.subscribers.discard(queue)
        self.resume_reading()

    def replay(self) -> str:
        if self.process is not None:
            return self.tail.decode("utf-8", errors="replace")
        return self.manager.store.transcript(self.meta["id"])[-REPLAY_BYTES:].decode("utf-8", errors="replace")

    async def _wait(self):
        code = await self.process.wait()
        try:
            await asyncio.wait_for(self.eof.wait(), timeout=1.0)
        except asyncio.TimeoutError:
            pass
        finally:
            self.pause_reading()
            if self.fd is not None:
                os.close(self.fd)
                self.fd = None
            self.meta.update(status="stopped" if self.meta["status"] == "stopping" else "exited",
                             exit_code=code, ended_at=now())
            self.save()
            self.finished.set()

    async def stop(self):
        if not self.running:
            return
        self.meta["status"] = "stopping"
        self.save()
        groups = {self.process.pid}
        if self.fd is not None:
            try:
                foreground = os.tcgetpgrp(self.fd)
                if foreground > 0:
                    groups.add(foreground)
            except OSError:
                pass
        for group in groups:
            try:
                os.killpg(group, signal.SIGTERM)
            except ProcessLookupError:
                pass
        # Capture groups before terminating the leader: foreground jobs may outlive it.
        await asyncio.sleep(0.4)
        for group in groups:
            try:
                os.killpg(group, signal.SIGKILL)
            except ProcessLookupError:
                pass
        await asyncio.wait_for(self.finished.wait(), timeout=3)


class SessionManager:
    def __init__(self, workspace: Path):
        self.workspace = workspace
        self.store = Store(workspace)
        self.sessions: dict[str, Session] = {
            item["id"]: Session(self, item) for item in self.store.load()
        }
        self.create_lock = asyncio.Lock()
        self.closing = False
        self.prune()

    def prune(self):
        archived = sorted((item for item in self.sessions.values() if not item.running),
                          key=lambda item: item.meta["started_at"])
        while len(self.sessions) > MAX_HISTORY and archived:
            item = archived.pop(0)
            try:
                shutil.rmtree(self.store.directory(item.meta["id"]))
                del self.sessions[item.meta["id"]]
            except OSError as exc:
                self.store.warnings.append(f"Could not prune session: {exc}")
                break

    async def create(self, kind: str, title: str = "") -> Session:
        async with self.create_lock:
            if self.closing:
                raise ValueError("Server is shutting down")
            if not isinstance(kind, str) or kind not in profiles():
                raise ValueError("Choose codex, claude, or shell")
            if not isinstance(title, str) or len(title) > 80 or any(ord(c) < 32 for c in title):
                raise ValueError("Session name must be at most 80 characters without control characters")
            if sum(item.running for item in self.sessions.values()) >= MAX_ACTIVE:
                raise ValueError(f"At most {MAX_ACTIVE} active sessions")
            profile = profiles()[kind]
            if not profile["command"]:
                raise ValueError(f"{profile['label']} is not on PATH. Install it, then restart Thrallwright.")
            metadata = dict(id=uuid4().hex, kind=kind, title=title.strip() or profile["label"],
                            status="running", started_at=now(), cols=100, rows=28)
            self.store.create(metadata["id"])
            self.store.save(metadata)
            item = Session(self, metadata)
            self.sessions[metadata["id"]] = item
            await item.start(profile["command"], profile["args"])
            self.prune()
            return item

    def get(self, session_id: str) -> Session:
        if session_id not in self.sessions:
            raise KeyError("Session not found")
        return self.sessions[session_id]

    def listing(self) -> list[dict]:
        return [item.meta.copy() for item in sorted(self.sessions.values(),
                key=lambda item: item.meta["started_at"], reverse=True)]

    async def close(self):
        self.closing = True
        async with self.create_lock:
            pass  # Let an in-flight spawn finish before collecting processes.
        try:
            await asyncio.gather(*(item.stop() for item in self.sessions.values() if item.running),
                                 return_exceptions=True)
        finally:
            self.store.close()
