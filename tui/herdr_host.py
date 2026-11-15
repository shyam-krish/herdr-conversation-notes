"""Small JSON socket client and reversible notes-pane lifecycle."""
from __future__ import annotations

import json
import os
import socket
import time
import uuid
from pathlib import Path

from notes_store import PLUGIN_ID, Store, digest, file_lock, read_json, write_json


class Herdr:
    def __init__(self, endpoint: str | None = None):
        self.endpoint = endpoint or os.environ.get("HERDR_SOCKET_PATH", "")
        if not self.endpoint:
            raise RuntimeError("Open Conversation Notes from inside Herdr.")

    def request(self, method: str, **params) -> dict:
        request = {"id": "notes:" + uuid.uuid4().hex, "method": method, "params": params}
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
            client.settimeout(4)
            client.connect(self.endpoint)
            client.sendall((json.dumps(request) + "\n").encode())
            with client.makefile("rb") as stream:
                line = stream.readline(4_000_000)
        reply = json.loads(line)
        if "error" in reply:
            error = reply["error"]
            raise RuntimeError(f"{method}: {error.get('message') or error.get('code')}")
        return reply["result"]

    def snapshot(self) -> dict:
        result = self.request("session.snapshot")
        return result.get("snapshot", result)


def context_pane_id() -> str | None:
    context = json.loads(os.environ.get("HERDR_PLUGIN_CONTEXT_JSON") or "{}")
    return (context.get("focused_pane_id") or os.environ.get("HERDR_ACTIVE_PANE_ID")
            or os.environ.get("HERDR_PANE_ID"))


def find_pane(snapshot: dict, *, pane_id=None, terminal_id=None) -> dict | None:
    for pane in snapshot.get("panes", []):
        if terminal_id and pane.get("terminal_id") == terminal_id:
            return pane
        if not terminal_id and pane_id and pane.get("pane_id") == pane_id:
            return pane
    return None


def runtime_file(store: Store, tab_id: str) -> Path:
    return store.root / "panels" / (digest(store.server + "|" + tab_id) + ".json")


def panel_alive(record: dict, snapshot: dict) -> bool:
    pane = find_pane(snapshot, terminal_id=record.get("terminal_id"))
    if not pane or pane.get("pane_id") != record.get("pane_id"):
        return False
    if not record.get("pid"):
        return time.time() - record.get("opened_at", 0) < 10
    try:
        os.kill(record["pid"], 0)
    except (OSError, TypeError):
        return False
    return time.time() - record.get("heartbeat", 0) < 15


def select_source(snapshot: dict, source_terminal: str, own_terminal: str) -> dict | None:
    """Follow a focused agent in our tab; otherwise retain the original source."""
    own = find_pane(snapshot, terminal_id=own_terminal)
    focused = find_pane(snapshot, pane_id=snapshot.get("focused_pane_id"))
    if (own and focused and focused.get("agent")
            and focused["tab_id"] == own["tab_id"]
            and focused["terminal_id"] != own_terminal):
        return focused
    return find_pane(snapshot, terminal_id=source_terminal)


def toggle(api: Herdr, store: Store, pane_id: str) -> dict:
    with file_lock(store.root / ("toggle-" + digest(store.server) + ".lock")):
        snapshot = api.snapshot()
        source = find_pane(snapshot, pane_id=pane_id)
        if not source:
            raise RuntimeError("The originating pane is no longer open.")
        path = runtime_file(store, source["tab_id"])
        panel = read_json(path, {})
        if panel_alive(panel, snapshot):
            if source["terminal_id"] == panel["terminal_id"]:
                api.request("pane.send_keys", pane_id=panel["pane_id"], keys=["ctrl+q"])
                return {"action": "close", "pane_id": panel["pane_id"]}
            if source.get("agent"):
                # The editor receives the desired source independently of global focus.
                panel["requested_source"] = source["terminal_id"]
                write_json(path, panel)
            api.request("pane.focus", pane_id=panel["pane_id"])
            return {"action": "focus", "pane_id": panel["pane_id"]}
        if not source.get("agent"):
            raise RuntimeError("Focus the conversation whose notes you want to open.")
        stale = find_pane(snapshot, terminal_id=panel.get("terminal_id"))
        if stale and stale["pane_id"] == panel.get("pane_id"):
            api.request("pane.close", pane_id=stale["pane_id"])
        record = store.resolve(source)
        layout_result = api.request("pane.layout", pane_id=source["pane_id"])
        layout = layout_result.get("layout", layout_result)
        was_zoomed = bool(layout.get("zoomed"))
        if was_zoomed:
            api.request("pane.zoom", pane_id=source["pane_id"], mode="off")
        try:
            result = api.request("plugin.pane.open", plugin_id=PLUGIN_ID, entrypoint="editor",
                                 placement="split", direction="right", target_pane_id=source["pane_id"],
                                 focus=True, env={"CONVERSATION_NOTES_SOURCE": json.dumps(source),
                                                  "CONVERSATION_NOTES_ZOOMED": "1" if was_zoomed else "0"})
        except BaseException:
            if was_zoomed:
                api.request("pane.zoom", pane_id=source["pane_id"], mode="on")
            raise
        info = result.get("plugin_pane", result)
        opened = info["pane"]
        # The editor takes the same lifecycle lock before publishing its heartbeat.
        write_json(path, {"pane_id": opened["pane_id"], "terminal_id": opened["terminal_id"],
                          "tab_id": source["tab_id"], "source_terminal": source["terminal_id"],
                          "note_key": record["key"], "opened_at": time.time()})
        api.request("pane.rename", pane_id=opened["pane_id"], label="Notes")
        # A plugin split starts half-width. Give the conversation roughly 2/3.
        try:
            api.request("pane.resize", pane_id=opened["pane_id"], direction="right", amount=0.15)
        except (OSError, RuntimeError):
            pass
        return {"action": "open", "pane_id": opened["pane_id"], "note_key": record["key"]}
