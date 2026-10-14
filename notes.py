#!/usr/bin/env python3
"""Herdr notes entrypoint. Reply imports read local transcripts on demand."""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "vendor"))

from herdr_host import Herdr, context_pane_id, toggle
from notes_store import Store, state_root


def main():
    parser = argparse.ArgumentParser(description="Private notes for the current Herdr conversation.")
    parser.add_argument("command", choices=["toggle", "editor", "path"])
    parser.add_argument("--pane", help="Explicit source pane for a toggle or path lookup")
    args = parser.parse_args()
    api = Herdr()
    legacy = Path.home() / ".local/state/herdr/plugins/agent-notes/notes.json"
    store = Store(state_root(), api.endpoint, legacy=legacy)
    try:
        if args.command == "editor":
            from editor import run_editor
            source = json.loads(os.environ["CONVERSATION_NOTES_SOURCE"])
            run_editor(store, source, api)
        elif args.command == "toggle":
            pane_id = args.pane or context_pane_id()
            if not pane_id:
                raise RuntimeError("No source pane was supplied by Herdr.")
            print(json.dumps(toggle(api, store, pane_id)))
        else:
            pane_id = args.pane or context_pane_id()
            if not pane_id:
                raise RuntimeError("No source pane was supplied by Herdr.")
            pane = api.request("pane.get", pane_id=pane_id)["pane"]
            print(store.notes / (store.resolve(pane)["key"] + ".md"))
    except (OSError, ValueError, RuntimeError, KeyError) as exc:
        print(f"Conversation Notes: {exc}", file=sys.stderr)
        if args.command == "toggle":
            try:
                api.request("notification.show", title="Conversation Notes", body=str(exc), sound="none")
            except Exception:
                pass
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
