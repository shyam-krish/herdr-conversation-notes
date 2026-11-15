#!/usr/bin/env python3
"""Run the TUI plugin's own Python functions for the GUI port's parity tests.

Reads a JSON list of calls on stdin: {"fn": name, "args": {...}, "env": {...},
"patch": {"module.CONSTANT": value}}. Prints one result per call:
{"ok": value} or {"error": exception class name, "message": str(exception)}.
"""
import json
import os
import sys
from pathlib import Path
from unittest.mock import patch

TUI = Path(__file__).resolve().parents[2] / "tui"
sys.path[:0] = [str(TUI), str(TUI / "vendor")]

import notes_store  # noqa: E402
import organizer  # noqa: E402
import transcripts  # noqa: E402


class Captured(BaseException):
    """Stops a request at the network boundary (BaseException passes `except Exception`)."""


class CapturingOpener:
    def open(self, request, timeout=None):
        raise Captured(json.loads(request.data))


def captured_request(call):
    with patch.object(organizer.urllib.request, "build_opener", lambda *_: CapturingOpener()):
        try:
            call()
        except Captured as stop:
            return {"request": stop.args[0]}
    return None


def run(fn, args):
    if fn == "digest":
        return notes_store.digest(args["value"])
    if fn == "dumps":
        return json.dumps(args["value"], ensure_ascii=False)
    if fn == "splitlines":
        return args["text"].splitlines()
    if fn == "title_for":
        return notes_store.title_for(args["pane"])
    if fn == "flat_bullets":
        return organizer.flat_bullets(args["text"])
    if fn == "parse_response":
        return organizer.parse_response(args["response"], importing=args.get("importing", False))
    if fn == "worker":
        # organizer.main() with this stdin payload, stopped where it would call OpenAI.
        import io
        stdout = io.StringIO()
        with patch.object(sys, "stdin", io.StringIO(json.dumps(args["payload"]))), \
             patch.object(sys, "stdout", stdout), \
             patch.dict(os.environ, {"OPENAI_API_KEY": args.get("key", "test-key")}):
            request = captured_request(organizer.main)
        return request or json.loads(stdout.getvalue())
    if fn == "reverse_records":
        return list(transcripts.reverse_records(Path(args["path"])))
    if fn == "claude_reply":
        return transcripts.claude_reply(Path(args["path"]), args["session"])
    if fn == "codex_reply":
        return transcripts.codex_reply(Path(args["path"]), args["session"])
    if fn == "resolve_session":
        return transcripts.resolve_session(args["source"])
    if fn == "latest_reply":
        return transcripts.latest_reply(args["source"])
    if fn == "source_identity_equal":
        return transcripts.source_identity(args["a"]) == transcripts.source_identity(args["b"])
    if fn == "resolve":
        legacy = Path(args["legacy"]) if args.get("legacy") else None
        record = notes_store.Store(Path(args["root"]), args["server"], legacy=legacy).resolve(args["pane"])
        return {k: v for k, v in record.items() if k != "updated_at"}
    if fn == "document_text":
        store = notes_store.Store(Path(args["root"]), args["server"])
        doc = store.document(store.resolve(args["pane"]))
        try:
            return {"text": doc.text, "read_only": doc.read_only}
        finally:
            doc.close()
    raise ValueError("unknown oracle function: " + fn)


def main():
    results = []
    for call in json.load(sys.stdin):
        env = call.get("env") or {}
        patches = [patch(name, value) for name, value in (call.get("patch") or {}).items()]
        try:
            with patch.dict(os.environ, env):
                for p in patches:
                    p.start()
                try:
                    results.append({"ok": run(call["fn"], call.get("args") or {})})
                finally:
                    for p in patches:
                        p.stop()
        except Exception as exc:  # noqa: BLE001 - the error type is the result
            results.append({"error": type(exc).__name__, "message": str(exc)})
    print(json.dumps(results, ensure_ascii=False))


if __name__ == "__main__":
    main()
