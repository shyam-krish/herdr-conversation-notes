import json
import os
import sqlite3
import sys
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT), str(ROOT / "vendor")]

from transcripts import TranscriptError, latest_reply, resolve_session
from test_import import OTHER, SESSION
from test_notes import pane


class CodexIdentityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.cwd = str(self.root / "my-project")
        self.source = {**pane(None), "cwd": self.cwd, "foreground_cwd": self.cwd,
                       "terminal_title_stripped": "Research notes | my-project"}
        self.env = patch.dict(os.environ, {"CODEX_HOME": str(self.root),
                                          "CODEX_THREAD_ID": OTHER})
        self.env.start()
        self.addCleanup(self.env.stop)
        self.state = sqlite3.connect(self.root / "state_5.sqlite")
        self.history = sqlite3.connect(self.root / "thread_history_1.sqlite")
        self.addCleanup(self.state.close)
        self.addCleanup(self.history.close)
        self.state.execute("CREATE TABLE threads(id TEXT, name TEXT, cwd TEXT, archived INT, history_mode TEXT, rollout_path TEXT)")
        self.state.execute("INSERT INTO threads VALUES(?,?,?,0,'paginated',?)",
                           (SESSION, "Research notes", self.cwd, str(self.root / "old.jsonl")))
        self.state.commit()
        self.history.executescript("""
            CREATE TABLE thread_turns(thread_id TEXT, turn_id TEXT, rollout_ordinal INT,
                status TEXT, final_agent_item_id TEXT);
            CREATE TABLE thread_items(thread_id TEXT, turn_id TEXT, item_id TEXT,
                item_type TEXT, item_json TEXT);
        """)
        self.turn(SESSION, 1, "Old reply")
        self.turn(SESSION, 2, "Current completed reply")
        self.turn(SESSION, 3, "Still working", status="inProgress", phase="commentary")
        self.turn(OTHER, 9, "Another chat's newer reply")
        (self.root / "old.jsonl").write_text(json.dumps({"type": "session_meta", "payload": {"id": SESSION}}) +
            "\n" + json.dumps({"type": "event_msg", "payload": {"type": "task_complete", "last_agent_message": "STALE ROLLOUT"}}) + "\n")

    def turn(self, thread_id, number, text, status="completed", phase="final_answer"):
        turn_id, item_id = f"turn{number}", f"item{number}"
        self.history.execute("INSERT INTO thread_turns VALUES(?,?,?,?,?)", (thread_id, turn_id, number, status, item_id))
        self.history.execute("INSERT INTO thread_items VALUES(?,?,?,?,?)", (thread_id, turn_id, item_id,
                             "agentMessage", json.dumps({"type": "agentMessage", "phase": phase, "text": text})))
        self.history.commit()

    def test_missing_id_uses_unique_exact_name_and_folder_then_current_database(self):
        self.assertEqual(resolve_session(self.source)["value"], SESSION)
        self.assertEqual(latest_reply(self.source), "Current completed reply")

    def test_native_id_uses_current_database_and_ignores_other_inherited_thread_id(self):
        self.assertEqual(latest_reply(pane(SESSION)), "Current completed reply")

    def test_duplicate_exact_name_fails_instead_of_choosing_newest(self):
        self.state.execute("INSERT INTO threads VALUES(?,?,?,0,'paginated',NULL)", (OTHER, "Research notes", self.cwd))
        self.state.commit()
        with self.assertRaisesRegex(TranscriptError, "Multiple Codex"):
            latest_reply(self.source)

    def test_same_name_in_other_folder_is_not_selected(self):
        self.state.execute("INSERT INTO threads VALUES(?,?,?,0,'paginated',NULL)", (OTHER, "Research notes", "/different/my-project"))
        self.state.commit()
        self.assertEqual(resolve_session(self.source)["value"], SESSION)
        with self.assertRaises(TranscriptError):
            resolve_session({**self.source, "cwd": "/missing/my-project", "foreground_cwd": "/missing/my-project"})

    def test_partial_names_generic_titles_and_wrong_project_suffix_are_not_matches(self):
        for display in ("Research", "Research notes | other-project", "Codex", "research notes | my-project"):
            with self.subTest(display=display), self.assertRaises(TranscriptError):
                resolve_session({**self.source, "terminal_title_stripped": display})

    def test_never_uses_codex_session_or_codex_name_lookup_for_claude(self):
        with self.assertRaisesRegex(TranscriptError, "session ID"):
            resolve_session({**self.source, "agent": "claude"})
        with self.assertRaisesRegex(TranscriptError, "agent changed"):
            resolve_session({**pane(SESSION), "agent": "claude"})

    def test_missing_or_unreadable_paginated_history_never_falls_back_to_stale_rollout(self):
        self.history.close()
        (self.root / "thread_history_1.sqlite").unlink()
        with self.assertRaisesRegex(TranscriptError, "current history"):
            latest_reply(pane(SESSION))
        self.assertFalse((self.root / "thread_history_1.sqlite").exists())

    def test_incomplete_or_invalid_final_does_not_import_commentary_or_another_chat(self):
        self.history.execute("DELETE FROM thread_turns WHERE thread_id=? AND status='completed'", (SESSION,))
        self.history.commit()
        with self.assertRaisesRegex(TranscriptError, "No completed reply"):
            latest_reply(pane(SESSION))
