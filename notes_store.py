"""Private, atomic Markdown storage keyed by a native agent conversation."""
from __future__ import annotations

import fcntl
import hashlib
import json
import os
import tempfile
import time
from contextlib import contextmanager
from pathlib import Path


PLUGIN_ID = "shyam.conversation-notes"


def digest(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def state_root() -> Path:
    return Path(os.environ.get("HERDR_PLUGIN_STATE_DIR") or
                Path.home() / ".local/state/herdr/plugins" / PLUGIN_ID)


def atomic_write(path: Path, data: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, name = tempfile.mkstemp(prefix=".notes-", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        Path(name).unlink(missing_ok=True)


def read_json(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return default


def write_json(path: Path, value) -> None:
    atomic_write(path, json.dumps(value, ensure_ascii=False, indent=2) + "\n")


@contextmanager
def file_lock(path: Path):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with os.fdopen(os.open(path, os.O_RDWR | os.O_CREAT, 0o600), "a+") as stream:
        fcntl.flock(stream, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(stream, fcntl.LOCK_UN)


def title_for(pane: dict) -> str:
    text = (pane.get("terminal_title_stripped") or pane.get("label") or
            pane.get("agent") or "Conversation")
    return " ".join("".join(c for c in str(text) if c.isprintable()).split())


class Store:
    def __init__(self, root: Path, server: str, legacy: Path | None = None):
        self.root, self.server = root, server
        self.legacy = legacy
        self.notes = root / "notes"
        self.notes.mkdir(parents=True, exist_ok=True, mode=0o700)

    def resolve(self, pane: dict) -> dict:
        terminal = pane.get("terminal_id")
        if not terminal:
            raise ValueError("Cannot identify this agent terminal.")
        session = pane.get("agent_session") or {}
        native = bool(session.get("value") and session.get("agent"))
        alias_id = digest(self.server + "|" + terminal)
        alias_path = self.root / "aliases" / (alias_id + ".json")
        with file_lock(self.root / "identity.lock"):
            old = read_json(alias_path, {})
            if native:
                identity = ["native-v1", session["agent"], session.get("kind", "id"), session["value"]]
                kind = "native"
            elif old.get("kind") == "native":
                # Detection can momentarily omit a session; keep its existing note.
                return read_json(self.notes / (old["key"] + ".json"), old)
            else:
                identity = ["terminal-v1", self.server, terminal]
                kind = "terminal"
            key = digest(json.dumps(identity, ensure_ascii=False))
            record = {"key": key, "kind": kind, "identity": identity,
                      "title": title_for(pane), "source_terminal_id": terminal,
                      "source_pane_id": pane.get("pane_id"), "updated_at": time.time()}
            path = self.notes / (key + ".md")
            if not path.exists():
                seed = None
                if native and old.get("kind") == "terminal":
                    previous = self.notes / (old["key"] + ".md")
                    if previous.exists():
                        seed = previous.read_text(encoding="utf-8")
                if seed is None:
                    seed = self.legacy_note(pane)
                if seed is not None:
                    atomic_write(path, seed)
            write_json(self.notes / (key + ".json"), record)
            write_json(alias_path, record)
            return record

    def legacy_note(self, pane: dict) -> str | None:
        if not self.legacy:
            return None
        try:
            notes = read_json(self.legacy, {}).get("notes", {})
        except (OSError, ValueError):
            return None
        native = (pane.get("agent_session") or {}).get("value")
        for note in notes.values():
            if native and note.get("agent_session"):
                matches = native == note["agent_session"]
            else:
                matches = pane["terminal_id"] == note.get("terminal_id")
            if matches and isinstance(note.get("text"), str):
                return note["text"]
        return None

    def document(self, record: dict) -> "Document":
        return Document(self.notes / (record["key"] + ".md"), record)


class SaveConflict(OSError):
    pass


class Document:
    def __init__(self, path: Path, record: dict):
        self.path, self.record = path, record
        self.lock_stream = os.fdopen(os.open(path.with_suffix(".lock"), os.O_RDWR | os.O_CREAT, 0o600), "a+")
        self.read_only = False
        try:
            fcntl.flock(self.lock_stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            self.read_only = True
        try:
            self.text = self.disk_text()
        except BaseException:
            self.close()
            raise
        self.baseline = self.text
        self.conflict_path: Path | None = None

    def disk_text(self) -> str:
        try:
            return self.path.read_text(encoding="utf-8")
        except FileNotFoundError:
            return ""

    def save(self, text: str) -> bool:
        if self.read_only:
            if text != self.baseline:
                raise OSError("This note is open in another editor.")
            return False
        if text == self.baseline:
            return False
        if self.disk_text() != self.baseline:
            recovery = self.path.with_name(self.path.stem + f".recovered-{time.time_ns()}.md")
            atomic_write(recovery, text)
            self.conflict_path = recovery
            self.read_only = True
            raise SaveConflict(f"External edit detected. Your changes are saved in {self.conflict_path.name}")
        atomic_write(self.path, text)
        self.text = self.baseline = text
        return True

    def refresh_read_only(self) -> str:
        if self.read_only and not self.conflict_path:
            self.text = self.baseline = self.disk_text()
        return self.text

    def close(self):
        if not self.lock_stream.closed:
            self.lock_stream.close()
