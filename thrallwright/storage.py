"""Private, bounded local persistence. No database or separate input logging."""
from __future__ import annotations

import fcntl
import json
import os
from pathlib import Path
import re
import stat
from uuid import uuid4

SESSION_ID = re.compile(r"^[0-9a-f]{32}$")
LOG_BYTES = 2 * 1024 * 1024
REPLAY_BYTES = 512 * 1024


def private_directory(path: Path) -> Path:
    path.mkdir(mode=0o700, exist_ok=True)
    if path.is_symlink() or not path.is_dir():
        raise ValueError(f"Refusing non-directory or symlink: {path}")
    path.chmod(0o700)
    return path


def open_private(path: Path, flags: int) -> int:
    fd = os.open(path, flags | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    if not stat.S_ISREG(os.fstat(fd).st_mode):
        os.close(fd)
        raise ValueError(f"Not a regular file: {path}")
    return fd


def read_bytes(path: Path, limit: int) -> bytes:
    fd = open_private(path, os.O_RDONLY)
    with os.fdopen(fd, "rb") as file:
        data = file.read(limit + 1)
    if len(data) > limit:
        raise ValueError(f"File exceeds {limit:,} bytes")
    return data


class Store:
    def __init__(self, workspace: Path):
        self.root = private_directory(workspace / ".thrallwright")
        self.lock = open_private(self.root / "server.lock", os.O_CREAT | os.O_RDWR)
        try:
            fcntl.flock(self.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            os.close(self.lock)
            self.lock = None
            raise ValueError("Another Thrallwright server already owns this workspace") from exc
        try:
            self.sessions = private_directory(self.root / "sessions")
        except Exception:
            self.close()
            raise
        self.warnings: list[str] = []

    def close(self):
        if self.lock is not None:
            os.close(self.lock)
            self.lock = None

    def directory(self, session_id: str) -> Path:
        if not SESSION_ID.fullmatch(session_id):
            raise ValueError("Invalid session ID")
        path = self.sessions / session_id
        if path.is_symlink():
            raise ValueError("Session directory must not be a symlink")
        return path

    def create(self, session_id: str):
        self.directory(session_id).mkdir(mode=0o700)

    def save(self, metadata: dict):
        directory = self.directory(metadata["id"])
        temporary = directory / f".{uuid4().hex}.tmp"
        try:
            fd = open_private(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            with os.fdopen(fd, "w", encoding="utf-8") as file:
                json.dump(metadata, file, ensure_ascii=False)
                file.write("\n")
            temporary.replace(directory / "session.json")
        finally:
            temporary.unlink(missing_ok=True)

    def load(self) -> list[dict]:
        result = []
        for directory in self.sessions.iterdir():
            if not SESSION_ID.fullmatch(directory.name):
                continue
            try:
                data = json.loads(read_bytes(self.directory(directory.name) / "session.json", 16 * 1024))
                if (not isinstance(data, dict) or data.get("id") != directory.name
                        or not isinstance(data.get("started_at"), str)
                        or not isinstance(data.get("title"), str)):
                    raise ValueError("Invalid session metadata")
                if data.get("status") in {"running", "stopping"}:
                    data["status"] = "interrupted"
                    self.save(data)  # Never reconnect to a persisted PID: it may be reused.
                result.append(data)
            except (OSError, ValueError, TypeError) as exc:
                self.warnings.append(f"Skipped session {directory.name}: {exc}")
        return sorted(result, key=lambda item: item["started_at"], reverse=True)

    def append(self, session_id: str, data: bytes) -> bool:
        directory = self.directory(session_id)
        path = directory / "output.log"
        rotated = False
        if path.exists() and path.lstat().st_size + len(data) > LOG_BYTES:
            if path.is_symlink():
                raise ValueError("Transcript must not be a symlink")
            path.replace(directory / "previous.log")
            rotated = True
        fd = open_private(path, os.O_CREAT | os.O_APPEND | os.O_WRONLY)
        with os.fdopen(fd, "ab") as file:
            file.write(data)
        return rotated

    def transcript(self, session_id: str) -> bytes:
        directory = self.directory(session_id)
        pieces = []
        for name in ("previous.log", "output.log"):
            try:
                pieces.append(read_bytes(directory / name, LOG_BYTES + 32768))
            except FileNotFoundError:
                pass
        return b"".join(pieces)

    def workflow(self) -> dict:
        try:
            data = json.loads(read_bytes(self.root / "workflow.json", 128 * 1024))
            return {"exists": True, "data": data}
        except FileNotFoundError:
            return {"exists": False}
        except (OSError, ValueError, TypeError) as exc:
            return {"exists": True, "error": str(exc)}
