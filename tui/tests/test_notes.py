import asyncio
import io
import json
import os
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT), str(ROOT / "vendor")]

from prompt_toolkit.clipboard import InMemoryClipboard
from prompt_toolkit.input import create_pipe_input
from prompt_toolkit.output import DummyOutput
from editor import NotesEditor
from herdr_host import find_pane, runtime_file, select_source, toggle
from notes_store import Store, SaveConflict, atomic_write, read_json, write_json


def pane(session="conversation-a", terminal="term-a", pane_id="w:p1", tab="w:t1"):
    result = {"pane_id": pane_id, "terminal_id": terminal, "tab_id": tab,
              "workspace_id": "w", "agent": "codex", "terminal_title_stripped": "My conversation"}
    if session:
        result["agent_session"] = {"agent": "codex", "kind": "id", "value": session}
    return result


class StorageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.store = Store(self.root, "/test/socket")

    def open(self, source=None):
        doc = self.store.document(self.store.resolve(source or pane()))
        self.addCleanup(doc.close)
        return doc

    def test_long_unicode_multiline_survives_reopen(self):
        text = "- Check the callback\n- résumé 日本語 📝\n\n" + "Long note. " * 500
        doc = self.open()
        doc.save(text)
        path = doc.path
        doc.close()
        reopened = self.open()
        self.assertEqual(reopened.text, text)
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    def test_two_codex_conversations_in_one_workspace_are_separate(self):
        one, two = self.open(), self.open(pane("conversation-b", "term-b", "w:p2"))
        one.save("First conversation")
        two.save("Second conversation")
        self.assertNotEqual(one.path, two.path)
        self.assertEqual(one.disk_text(), "First conversation")

    def test_resume_in_another_pane_uses_same_note(self):
        doc = self.open()
        doc.save("Keep this across restarts")
        doc.close()
        reopened = self.open(pane(terminal="new-terminal", pane_id="w:p9", tab="w:t9"))
        self.assertEqual(reopened.text, "Keep this across restarts")

    def test_new_conversation_in_same_terminal_is_separate(self):
        old = self.open()
        old.save("Old chat")
        new = self.open(pane("conversation-b"))
        self.assertEqual(new.text, "")
        self.assertNotEqual(old.path, new.path)

    def test_delayed_native_identity_inherits_fallback_once(self):
        original = self.open(pane(None))
        original.save("Written before session detection")
        original.close()
        resolved = self.open()
        self.assertEqual(resolved.text, "Written before session detection")
        other = self.open(pane("conversation-b"))
        self.assertEqual(other.text, "")

    def test_temporary_missing_session_reference_keeps_native_identity(self):
        original = self.open()
        original.save("Keep me")
        original.close()
        self.assertEqual(self.open(pane(None)).text, "Keep me")

    def test_legacy_migration_is_exact_and_does_not_mix_new_conversation(self):
        legacy = self.root / "legacy.json"
        write_json(legacy, {"notes": {"old": {"agent_session": "conversation-a", "terminal_id": "term-a", "text": "Old note\nfull text"}}})
        self.store.legacy = legacy
        self.assertEqual(self.open().text, "Old note\nfull text")
        self.assertEqual(self.open(pane("conversation-b")).text, "")
        self.assertTrue(legacy.exists())

    def test_second_editor_is_read_only(self):
        writer = self.open()
        reader = self.open()
        self.assertTrue(reader.read_only)
        writer.save("Newest text")
        self.assertEqual(reader.refresh_read_only(), "Newest text")
        with self.assertRaises(OSError):
            reader.save("Cannot overwrite")

    def test_external_edit_creates_recovery_without_overwriting(self):
        doc = self.open()
        doc.save("Initial")
        atomic_write(doc.path, "External")
        with self.assertRaises(SaveConflict):
            doc.save("My unsaved edits")
        self.assertEqual(doc.disk_text(), "External")
        self.assertEqual(doc.conflict_path.read_text(), "My unsaved edits")

    def test_notes_remain_on_disk_after_closing_editor(self):
        doc = self.open()
        doc.save("Remember this tomorrow")
        doc.close()
        self.assertEqual(doc.path.read_text(), "Remember this tomorrow")

    def test_failed_recovery_write_does_not_claim_buffer_is_preserved(self):
        doc = self.open()
        doc.save("Initial")
        atomic_write(doc.path, "External")
        with patch("notes_store.atomic_write", side_effect=OSError("disk full")):
            with self.assertRaises(OSError):
                doc.save("My unsaved edits")
        self.assertIsNone(doc.conflict_path)
        self.assertFalse(doc.read_only)
        with self.assertRaises(SaveConflict):
            doc.save("My unsaved edits")
        self.assertEqual(doc.conflict_path.read_text(), "My unsaved edits")


class FakeHerdr:
    endpoint = "/test/socket"

    def __init__(self):
        self.panes = [pane(), pane("conversation-b", "term-b", "w:p2")]
        self.focused = "w:p1"
        self.calls = []
        self.opens = 0

    def snapshot(self):
        return {"panes": self.panes, "focused_pane_id": self.focused}

    def request(self, method, **params):
        self.calls.append((method, params))
        if method == "pane.layout":
            return {"layout": {"zoomed": False}}
        if method == "plugin.pane.open":
            self.opens += 1
            opened = pane(None, "notes-terminal", "w:notes")
            opened.pop("agent")
            self.panes.append(opened)
            self.focused = opened["pane_id"]
            return {"plugin_pane": {"pane": opened}}
        if method == "pane.focus":
            self.focused = params["pane_id"]
        return {}


class LifecycleTests(unittest.TestCase):
    def test_open_focus_close_does_not_create_duplicate(self):
        with tempfile.TemporaryDirectory() as tmp:
            store, api = Store(Path(tmp), "/test/socket"), FakeHerdr()
            self.assertEqual(toggle(api, store, "w:p1")["action"], "open")
            self.assertEqual(toggle(api, store, "w:p2")["action"], "focus")
            self.assertEqual(api.opens, 1)
            self.assertEqual(read_json(runtime_file(store, "w:t1"), {})["requested_source"], "term-b")
            self.assertEqual(toggle(api, store, "w:notes")["action"], "close")
            self.assertIn(("pane.send_keys", {"pane_id": "w:notes", "keys": ["ctrl+q"]}), api.calls)

    def test_focus_in_another_tab_does_not_change_note(self):
        own = pane(None, "notes", "w:notes")
        own.pop("agent")
        source = pane()
        other = pane("b", "term-b", "w:p2", tab="w:t2")
        snapshot = {"panes": [own, source, other], "focused_pane_id": "w:p2"}
        self.assertEqual(select_source(snapshot, "term-a", "notes"), source)
        other["tab_id"] = "w:t1"
        self.assertEqual(select_source(snapshot, "term-a", "notes"), other)


async def eventually(predicate, timeout=3):
    until = asyncio.get_running_loop().time() + timeout
    while not predicate():
        if asyncio.get_running_loop().time() > until:
            raise AssertionError("Timed out waiting for editor")
        await asyncio.sleep(0.02)


class EditorTests(unittest.IsolatedAsyncioTestCase):
    async def test_mouse_drag_copies_selection(self):
        with tempfile.TemporaryDirectory() as tmp, create_pipe_input() as pipe:
            clip = InMemoryClipboard()
            editor = NotesEditor(Store(Path(tmp), "/test/socket"), pane(), clipboard=clip, input=pipe, output=DummyOutput())
            editor.area.text = "Hello world"
            task = asyncio.create_task(editor.run_async())
            await eventually(lambda: editor.app.is_running)
            await asyncio.sleep(0.1)
            # SGR mouse events: drag from column 1 to 6 on editor row 2.
            pipe.send_text("\x1b[<0;1;2M\x1b[<32;6;2M\x1b[<0;6;2m")
            await eventually(lambda: clip.get_data().text == "Hello")
            self.assertIsNotNone(editor.area.buffer.selection_state)
            pipe.send_text("\x11")
            await asyncio.wait_for(task, 3)

    async def test_real_key_input_multiline_paste_copy_paste_and_autosave(self):
        with tempfile.TemporaryDirectory() as tmp, create_pipe_input() as pipe:
            clip = InMemoryClipboard()
            store = Store(Path(tmp), "/test/socket")
            editor = NotesEditor(store, pane(), clipboard=clip, input=pipe, output=DummyOutput())
            task = asyncio.create_task(editor.run_async())
            await eventually(lambda: editor.app.is_running)
            text = "First line\nSecond line 📝\n" + "A long thought. " * 35
            pipe.send_text("\x1b[200~" + text + "\x1b[201~")
            await eventually(lambda: editor.area.text == text)
            self.assertFalse(task.done())
            await eventually(lambda: editor.doc.path.exists() and editor.doc.path.read_text() == text)
            pipe.send_text("\x03")
            await eventually(lambda: clip.get_data().text == text)
            clip.set_text("\nPasted later")
            pipe.send_text("\x16")
            await eventually(lambda: editor.area.text == text + "\nPasted later")
            pipe.send_text("\x11")
            await asyncio.wait_for(task, 3)
            self.assertEqual(editor.doc.path.read_text(), text + "\nPasted later")

    async def test_switch_saves_dirty_buffer_and_separates_conversations(self):
        with tempfile.TemporaryDirectory() as tmp, create_pipe_input() as pipe:
            editor = NotesEditor(Store(Path(tmp), "/test/socket"), pane(), clipboard=InMemoryClipboard(), input=pipe, output=DummyOutput())
            try:
                editor.area.text = "Unsaved in conversation A"
                editor.switch_source(pane("conversation-b"))
                self.assertEqual(editor.area.text, "")
                editor.area.text = "Conversation B"
                editor.switch_source(pane())
                self.assertEqual(editor.area.text, "Unsaved in conversation A")
            finally:
                editor.doc.close()

    async def test_failed_save_refuses_close_and_keeps_buffer(self):
        with tempfile.TemporaryDirectory() as tmp, create_pipe_input() as pipe:
            editor = NotesEditor(Store(Path(tmp), "/test/socket"), pane(), clipboard=InMemoryClipboard(), input=pipe, output=DummyOutput())
            def fail(_):
                raise OSError("disk full")
            editor.doc.save = fail
            editor.area.text = "Still here"
            self.assertFalse(editor.save())
            self.assertEqual(editor.area.text, "Still here")
            self.assertIn("disk full", editor.background_error)
            editor.doc.close()


if __name__ == "__main__":
    unittest.main()
