"""Read one completed reply from the exact local native conversation, read-only."""
from __future__ import annotations

import json
import os
import re
import sqlite3
from contextlib import closing
from pathlib import Path


MAX_SCAN_BYTES = 64 * 1024 * 1024
MAX_RECORD_BYTES = 2 * 1024 * 1024
MAX_REPLY_CHARS = 120_000
SESSION_ID = re.compile(r"[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}\Z")


class TranscriptError(Exception):
    """A short user-facing error with no transcript or database contents."""


def reverse_records(path: Path):
    """Bounded reverse JSONL scan; tolerate a partial trailing write/large records."""
    with path.open("rb") as stream:
        position = stream.seek(0, 2)
        floor = max(0, position - MAX_SCAN_BYTES)
        pending, discard = b"", False
        while position > floor:
            count = min(65536, position - floor)
            position -= count
            stream.seek(position)
            parts = stream.read(count).split(b"\n")
            tail = parts[-1] + pending
            if len(tail) > MAX_RECORD_BYTES:
                discard = True
            if len(parts) == 1:
                pending = b"" if discard else tail
                continue
            candidates = ([] if discard else [tail]) + list(reversed(parts[1:-1]))
            for raw in candidates:
                if len(raw) > MAX_RECORD_BYTES:
                    continue
                try:
                    value = json.loads(raw)
                    if isinstance(value, dict):
                        yield value
                except (ValueError, UnicodeError):
                    pass
            pending = parts[0]
            discard = len(pending) > MAX_RECORD_BYTES
            if discard:
                pending = b""
        if position == 0 and pending and not discard:
            try:
                value = json.loads(pending)
                if isinstance(value, dict):
                    yield value
            except (ValueError, UnicodeError):
                pass


def checked_text(text: str) -> str:
    if len(text) > MAX_REPLY_CHARS:
        raise TranscriptError("Last reply is too long to import (120,000 characters).")
    return text.strip()


def codex_root() -> Path:
    return Path(os.environ.get("CODEX_HOME") or Path.home() / ".codex").expanduser().resolve()


def codex_databases(root: Path):
    return sorted((p for p in root.glob("state_*.sqlite")
                   if re.fullmatch(r"state_\d+\.sqlite", p.name)),
                  key=lambda p: int(p.stem.split("_")[-1]), reverse=True)


def codex_thread(root: Path, session_id: str) -> dict:
    for database in codex_databases(root):
        try:
            with closing(sqlite3.connect(database.as_uri() + "?mode=ro", uri=True, timeout=1)) as db:
                db.row_factory = sqlite3.Row
                row = db.execute("SELECT * FROM threads WHERE id=?", (session_id,)).fetchone()
            if row:
                return dict(row)
        except sqlite3.Error:
            continue
    return {}


def named_codex_session(source: dict) -> str:
    """Daemon-backed TUIs can omit Herdr's ID. Accept only one exact name+cwd."""
    display = source.get("terminal_title_stripped")
    cwd = source.get("foreground_cwd") or source.get("cwd")
    if not isinstance(display, str) or not isinstance(cwd, str) or not Path(cwd).is_absolute():
        raise TranscriptError("Codex conversation ID is missing; no exact name/folder match is available.")
    cwd_path = Path(cwd).resolve()
    for database in codex_databases(codex_root()):
        try:
            with closing(sqlite3.connect(database.as_uri() + "?mode=ro", uri=True, timeout=1)) as db:
                # 'name' is Codex's displayed conversation name; 'title' can be
                # the full first user prompt. Never match snippets or recentness.
                rows = db.execute("SELECT id, name, cwd FROM threads WHERE archived=0 AND cwd IN (?, ?)",
                                  (cwd, str(cwd_path))).fetchall()
            matches = {session_id for session_id, name, folder in rows
                       if isinstance(name, str) and name.strip() and SESSION_ID.fullmatch(session_id)
                       and Path(folder).resolve() == cwd_path
                       and display in (name, name + " | " + cwd_path.name)}
            if len(matches) == 1:
                return matches.pop()
            if len(matches) > 1:
                raise TranscriptError("Multiple Codex conversations match this name/folder; rename this chat uniquely.")
            # A newer readable index is authoritative, even if it has no match.
            break
        except sqlite3.Error:
            continue
    raise TranscriptError("Cannot identify this Codex chat by its exact name and folder.")


def resolve_session(source: dict) -> dict:
    session = source.get("agent_session") or {}
    agent = source.get("agent") or session.get("agent")
    if agent not in ("codex", "claude"):
        raise TranscriptError("Reply import supports Codex and Claude conversations only.")
    if session.get("agent") and session["agent"] != agent:
        raise TranscriptError("The pane's agent changed; reopen its notes and try again.")
    session_id = session.get("value")
    if session.get("kind") == "id" and isinstance(session_id, str) and SESSION_ID.fullmatch(session_id):
        return {"agent": agent, "kind": "id", "value": session_id}
    if not session and agent == "codex":
        return {"agent": agent, "kind": "id", "value": named_codex_session(source)}
    raise TranscriptError("Herdr has not identified this conversation's session ID yet.")


def source_identity(source: dict):
    session = source.get("agent_session") or {}
    if session.get("value"):
        return (source.get("terminal_id"), source.get("agent"), session.get("agent"),
                session.get("kind"), session["value"])
    return (source.get("terminal_id"), source.get("agent"), source.get("terminal_title_stripped"),
            source.get("foreground_cwd") or source.get("cwd"))


def codex_path(root: Path, session_id: str) -> Path:
    # Codex's thread index also locates archived/resumed threads without guessing
    # from cwd or title. New schema versions can coexist with an older index.
    path = codex_thread(root, session_id).get("rollout_path")
    if isinstance(path, str) and Path(path).is_file():
        return Path(path)
    matches = []
    for directory in ("sessions", "archived_sessions"):
        matches.extend((root / directory).rglob(f"rollout-*-{session_id}.jsonl"))
    if len(matches) == 1:
        return matches[0]
    raise TranscriptError("Cannot find this Codex conversation's local transcript.")


def codex_database_reply(root: Path, session_id: str) -> str:
    """Paginated threads keep current replies in SQLite, not the old rollout."""
    database = root / "thread_history_1.sqlite"
    try:
        with closing(sqlite3.connect(database.as_uri() + "?mode=ro", uri=True, timeout=2)) as db:
            row = db.execute("""
                SELECT i.item_json FROM thread_turns t JOIN thread_items i
                  ON i.thread_id=t.thread_id AND i.turn_id=t.turn_id AND i.item_id=t.final_agent_item_id
                WHERE t.thread_id=? AND t.status='completed' AND i.item_type='agentMessage'
                ORDER BY t.rollout_ordinal DESC LIMIT 1
            """, (session_id,)).fetchone()
        if row:
            item = json.loads(row[0])
            if (item.get("type") == "agentMessage" and item.get("phase") in (None, "final_answer")
                    and isinstance(item.get("text"), str) and item["text"].strip()):
                return checked_text(item["text"])
    except (sqlite3.Error, ValueError, AttributeError):
        raise TranscriptError("Cannot read this Codex chat's current history database.") from None
    raise TranscriptError("No completed reply found yet. Wait for the agent to finish.")


def codex_reply(path: Path, session_id: str) -> str:
    with path.open("rb") as stream:
        try:
            header = json.loads(stream.readline(MAX_RECORD_BYTES + 1))
            meta = header.get("payload", {})
            matches = header.get("type") == "session_meta" and meta.get("id") == session_id
        except (ValueError, AttributeError, UnicodeError):
            matches = False
    if not matches:
        raise TranscriptError("Transcript identity does not match this conversation.")
    completed = False
    for record in reverse_records(path):
        payload = record.get("payload")
        if not isinstance(payload, dict):
            continue
        if record.get("type") == "event_msg":
            if payload.get("type") == "task_complete":
                text = payload.get("last_agent_message")
                if isinstance(text, str) and text.strip():
                    return checked_text(text)
                completed = True
            elif payload.get("type") in ("task_started", "turn_aborted"):
                completed = False
        elif (completed and record.get("type") == "response_item"
              and payload.get("type") == "message" and payload.get("role") == "assistant"
              and payload.get("phase") == "final_answer"):
            # Older completion events may omit their copy of the final message.
            text = "\n".join(c["text"] for c in payload.get("content", [])
                             if isinstance(c, dict) and c.get("type") == "output_text"
                             and isinstance(c.get("text"), str))
            if text.strip():
                return checked_text(text)
    raise TranscriptError("No completed reply found yet. Wait for the agent to finish.")


def claude_reply(path: Path, session_id: str) -> str:
    message_id, parts = None, []
    for record in reverse_records(path):
        if record.get("sessionId") != session_id or record.get("isSidechain"):
            continue
        kind = record.get("type")
        message = record.get("message")
        if kind not in ("assistant", "user") or not isinstance(message, dict):
            continue
        if parts and (kind != "assistant" or message.get("id") != message_id):
            break
        if (kind != "assistant" or message.get("role") != "assistant"
                or record.get("isApiErrorMessage") or record.get("isSynthetic")):
            continue
        if message_id is None:
            if message.get("stop_reason") != "end_turn":
                continue
            message_id = message.get("id")
            if not message_id:
                continue
        elif message.get("id") != message_id:
            break
        text = "\n".join(c["text"] for c in message.get("content", [])
                         if isinstance(c, dict) and c.get("type") == "text"
                         and isinstance(c.get("text"), str))
        if text.strip():
            parts.append(text)
    if parts:
        return checked_text("\n".join(reversed(parts)))
    raise TranscriptError("No completed reply found yet. Wait for the agent to finish.")


def latest_reply(source: dict) -> str:
    try:
        session = resolve_session(source)
        agent, session_id = session["agent"], session["value"]
        if agent == "codex":
            root = codex_root()
            mode = codex_thread(root, session_id).get("history_mode")
            if mode == "paginated":
                return codex_database_reply(root, session_id)
            if mode not in (None, "legacy"):
                raise TranscriptError("This Codex history format is not supported yet.")
            return codex_reply(codex_path(root, session_id), session_id)
        if agent == "claude":
            root = Path(os.environ.get("CLAUDE_CONFIG_DIR") or Path.home() / ".claude").expanduser()
            matches = list((root / "projects").glob(f"*/{session_id}.jsonl"))
            if len(matches) != 1:
                raise TranscriptError("Cannot find this Claude conversation's local transcript.")
            return claude_reply(matches[0], session_id)
        raise TranscriptError("Reply import currently supports local Codex and Claude conversations.")
    except (OSError, UnicodeError):
        raise TranscriptError("Cannot read this conversation's local transcript.") from None
