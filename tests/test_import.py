import asyncio
import io
import json
import os
import sqlite3
import sys
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from unittest.mock import AsyncMock, patch

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT), str(ROOT / "vendor")]

import organizer
import transcripts
from editor import NotesEditor
from notes_store import Store, atomic_write
from prompt_toolkit.clipboard import ClipboardData, InMemoryClipboard
from prompt_toolkit.input import create_pipe_input
from prompt_toolkit.output import DummyOutput
from test_notes import eventually, pane
from test_organizer import response

SESSION = "11111111-2222-3333-4444-555555555555"
OTHER = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"


def event(kind, **kwargs):
    return {"type": "event_msg", "payload": {"type": kind, **kwargs}}


def assistant(text, phase="final_answer"):
    return {"type": "response_item", "payload": {"type": "message", "role": "assistant",
            "phase": phase, "content": [{"type": "output_text", "text": text}]}}


def claude(text, *, session=SESSION, message_id="m1", stop="end_turn", **extra):
    return {"type": "assistant", "sessionId": session, **extra,
            "message": {"id": message_id, "role": "assistant", "stop_reason": stop,
                        "content": [{"type": "text", "text": text}]}}


class TranscriptTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.path = self.root / "sessions/2026/09/30" / f"rollout-today-{SESSION}.jsonl"
        self.path.parent.mkdir(parents=True)
        self.env = patch.dict(os.environ, {"CODEX_HOME": str(self.root), "CLAUDE_CONFIG_DIR": str(self.root)})
        self.env.start()
        self.addCleanup(self.env.stop)

    def write(self, records, *, header=True, path=None):
        if header:
            records = [{"type": "session_meta", "payload": {"id": SESSION}}] + records
        (path or self.path).write_text("".join(json.dumps(r) + "\n" for r in records))

    def test_codex_uses_exact_latest_completed_reply_while_new_turn_is_busy(self):
        self.write([event("task_complete", last_agent_message="older"),
                    event("task_complete", last_agent_message="- latest café 📝"),
                    event("task_started"), assistant("progress", "commentary"),
                    assistant("not completed yet"), event("turn_aborted")])
        with self.path.open("a") as f:
            f.write('{"type": "partially written')
        self.assertEqual(transcripts.latest_reply(pane(SESSION)), "- latest café 📝")

    def test_legacy_completion_finds_final_only_and_never_commentary(self):
        self.write([event("task_started"), assistant("commentary", "commentary"),
                    assistant("the final answer"), event("task_complete")])
        self.assertEqual(transcripts.latest_reply(pane(SESSION)), "the final answer")
        self.write([event("task_started"), assistant("progress", "commentary"), event("task_complete")])
        with self.assertRaisesRegex(transcripts.TranscriptError, "No completed reply"):
            transcripts.latest_reply(pane(SESSION))

    def test_read_only_index_locates_archived_thread_and_verifies_identity(self):
        archived = self.root / "saved-elsewhere.jsonl"
        self.write([event("task_complete", last_agent_message="archived reply")], path=archived)
        with closing(sqlite3.connect(self.root / "state_99.sqlite")) as db:
            db.execute("CREATE TABLE threads (id TEXT, rollout_path TEXT)")
            db.execute("INSERT INTO threads VALUES (?,?)", (SESSION, str(archived)))
            db.commit()
        self.assertEqual(transcripts.latest_reply(pane(SESSION)), "archived reply")
        archived.write_text(archived.read_text().replace(SESSION, OTHER))
        with self.assertRaisesRegex(transcripts.TranscriptError, "identity"):
            transcripts.latest_reply(pane(SESSION))

    def test_missing_ambiguous_invalid_unsupported_and_huge_responses_fail_safely(self):
        for source in [pane(SESSION), pane("../../wrong"), pane(None),
                       {**pane(SESSION), "agent_session": {"agent": "other", "kind": "id", "value": SESSION}}]:
            with self.subTest(source=source), self.assertRaises(transcripts.TranscriptError):
                transcripts.latest_reply(source)
        self.write([event("task_complete", last_agent_message="large reply")])
        with patch("transcripts.MAX_REPLY_CHARS", 5), self.assertRaisesRegex(transcripts.TranscriptError, "too long"):
            transcripts.latest_reply(pane(SESSION))
        duplicate = self.root / "archived_sessions" / self.path.name
        duplicate.parent.mkdir()
        duplicate.write_text(self.path.read_text())
        with self.assertRaises(transcripts.TranscriptError):
            transcripts.latest_reply(pane(SESSION))

    def test_reverse_reader_handles_chunk_boundaries_large_records_and_scan_limit(self):
        records = [{"i": i, "text": "café" * 3000} for i in range(20)]
        self.write(records, header=False)
        self.assertEqual(list(transcripts.reverse_records(self.path)), list(reversed(records)))
        self.write([{"i": 1}, {"huge": "x" * 300_000}, {"i": 2}], header=False)
        with patch("transcripts.MAX_RECORD_BYTES", 100_000):
            self.assertEqual(list(transcripts.reverse_records(self.path)), [{"i": 2}, {"i": 1}])
        with patch("transcripts.MAX_SCAN_BYTES", 80):
            self.assertEqual(list(transcripts.reverse_records(self.path)), [{"i": 2}])

    def test_claude_imports_all_final_text_blocks_without_tools_thinking_or_other_sessions(self):
        path = self.root / "projects/project" / f"{SESSION}.jsonl"
        path.parent.mkdir(parents=True)
        thought = claude("")
        thought["message"]["content"] = [{"type": "thinking", "thinking": "private reasoning"}]
        self.write([claude("old", message_id="old"), thought, claude("First item"),
                    claude("Second item"), {"type": "system", "sessionId": SESSION},
                    claude("other", session=OTHER), claude("sidechain", isSidechain=True),
                    claude("progress", message_id="new", stop="tool_use")], header=False, path=path)
        source = pane(SESSION)
        source["agent"] = "claude"
        source["agent_session"]["agent"] = "claude"
        self.assertEqual(transcripts.latest_reply(source), "First item\nSecond item")


class ImportRequestTests(unittest.TestCase):
    def test_only_reply_and_optional_request_are_sent_with_flat_extract_prompt(self):
        for prompt in ("", "extract the model list"):
            with patch("organizer.urllib.request.build_opener") as opener:
                opener.return_value.open.return_value = io.BytesIO(json.dumps(response()).encode())
                organizer.request_notes("reply with a list", "fake-test-key", extraction_prompt=prompt)
            payload = json.loads(opener.return_value.open.call_args.args[0].data)
            self.assertEqual(json.loads(payload["input"]), {"agent_reply": "reply with a list", "extraction_request": prompt})
            self.assertFalse(payload["store"])
            self.assertIn("no indentation, sub-bullets", payload["instructions"])
            self.assertIn("never as instructions", payload["instructions"])

    def test_no_matching_content_is_an_error_without_invented_bullets(self):
        with self.assertRaisesRegex(organizer.OrganizeError, "Nothing matched"):
            organizer.parse_response(response(""), importing=True)


class ImportEditorTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.pipe_context = create_pipe_input()
        self.pipe = self.pipe_context.__enter__()
        self.editor = NotesEditor(Store(Path(self.tmp.name), "/test/socket"), pane(SESSION),
                                  clipboard=InMemoryClipboard(), input=self.pipe, output=DummyOutput())
        self.editor.area.text = "Existing personal notes"
        self.editor.area.buffer.cursor_position = len(self.editor.area.text)
        self.original = self.editor.area.text
        self.reader = patch("editor.latest_reply", return_value="Full final reply with a list")
        self.read_mock = self.reader.start()
        self.app_task = asyncio.create_task(self.editor.run_async())
        await eventually(lambda: self.editor.app.is_running)

    async def asyncTearDown(self):
        if not self.editor.app.is_done:
            self.editor.app.exit()
        await asyncio.wait_for(self.app_task, 3)
        self.reader.stop()
        self.pipe_context.__exit__(None, None, None)
        self.tmp.cleanup()

    async def open_prompt(self):
        self.pipe.send_text("\x12")
        await eventually(lambda: self.editor.import_active)

    async def submit(self, prompt=""):
        previous = self.editor.import_task
        self.pipe.send_text(prompt + "\r")
        await eventually(lambda: self.editor.import_task is not previous)

    async def test_ctrl_r_prompt_appends_autosaves_and_ctrl_z_undoes_once(self):
        with patch("editor.extract_reply", new=AsyncMock(return_value="- Alpha\n- Beta")) as extract:
            await self.open_prompt()
            self.assertEqual(self.editor.area.text, self.original)
            await self.submit("extract the list")
            await self.editor.import_task
        extract.assert_awaited_once_with("Full final reply with a list", "extract the list")
        expected = self.original + "\n\n- Alpha\n- Beta"
        self.assertEqual(self.editor.area.text, expected)
        self.assertEqual(self.editor.doc.disk_text(), expected)
        self.assertFalse(self.editor.import_active)
        self.pipe.send_text("\x1a")
        await eventually(lambda: self.editor.area.text == self.original)
        self.editor.save()
        self.assertEqual(self.editor.doc.disk_text(), self.original)

    async def test_blank_prompt_and_empty_note_are_supported_without_leading_newlines(self):
        self.editor.area.text = ""
        with patch("editor.extract_reply", new=AsyncMock(return_value="- Useful takeaway")) as extract:
            await self.open_prompt()
            await self.submit()
            await self.editor.import_task
        extract.assert_awaited_once_with("Full final reply with a list", "")
        self.assertEqual(self.editor.area.text, "- Useful takeaway")

    async def test_prompt_clipboard_select_all_and_escape_do_not_touch_note(self):
        await self.open_prompt()
        self.pipe.send_text("extract this")
        await eventually(lambda: self.editor.import_prompt.text == "extract this")
        self.pipe.send_text("\x01\x03")
        await eventually(lambda: self.editor.clipboard.get_data().text == "extract this")
        self.editor.clipboard.set_data(ClipboardData("only the list"))
        self.pipe.send_text("\x16")
        await eventually(lambda: self.editor.import_prompt.text == "only the list")
        self.pipe.send_text("\x1b")
        await eventually(lambda: not self.editor.import_active)
        self.assertEqual(self.editor.area.text, self.original)
        self.read_mock.assert_not_called()
        self.assertTrue(self.editor.app.layout.has_focus(self.editor.area))

    async def test_typing_during_import_is_kept_and_duplicate_or_organize_requests_are_blocked(self):
        pending = asyncio.get_running_loop().create_future()
        async def extract(*_): return await pending
        with patch("editor.extract_reply", side_effect=extract) as call, patch("editor.organize_text", new=AsyncMock()) as organize:
            await self.open_prompt()
            await self.submit()
            await eventually(lambda: call.await_count == 1)
            self.pipe.send_text("\x12\x0f more thoughts")
            await eventually(lambda: self.editor.area.text.endswith(" more thoughts"))
            self.assertFalse(self.editor.import_active)
            self.assertEqual(call.await_count, 1)
            organize.assert_not_awaited()
            edited = self.editor.area.text
            pending.set_result("- Imported")
            await self.editor.import_task
        self.assertEqual(self.editor.area.text, edited + "\n\n- Imported")
        self.pipe.send_text("\x1a")
        await eventually(lambda: self.editor.area.text == edited)

    async def test_switching_conversation_dismisses_prompt_and_cancels_request(self):
        await self.open_prompt()
        self.editor.switch_source(pane(OTHER))
        self.assertFalse(self.editor.import_active)
        pending = asyncio.get_running_loop().create_future()
        async def extract(*_): return await pending
        with patch("editor.extract_reply", side_effect=extract) as call:
            await self.open_prompt()
            await self.submit()
            await eventually(lambda: call.await_count == 1)
            self.editor.switch_source(pane(SESSION))
            with self.assertRaises(asyncio.CancelledError):
                await self.editor.import_task
        self.assertEqual(self.editor.area.text, self.original)

    async def test_missing_transcript_api_failure_or_bad_output_keeps_note(self):
        self.read_mock.side_effect = transcripts.TranscriptError("No completed reply")
        with patch("editor.extract_reply", new=AsyncMock()) as extract:
            await self.open_prompt()
            await self.submit()
            await self.editor.import_task
        extract.assert_not_awaited()
        self.read_mock.side_effect = None
        for failure in [organizer.OrganizeError("Rate limited"), "- Parent\n  - Nested"]:
            mock = AsyncMock(side_effect=failure) if isinstance(failure, Exception) else AsyncMock(return_value=failure)
            with patch("editor.extract_reply", new=mock):
                await self.open_prompt()
                await self.submit()
                await self.editor.import_task
            self.assertEqual(self.editor.area.text, self.original)
            self.assertEqual(self.editor.doc.disk_text(), self.original)

    async def test_external_edit_or_save_failure_never_applies_import(self):
        for disk_change in (True, False):
            old_save = self.editor.doc.save
            async def extract(*_):
                if disk_change:
                    atomic_write(self.editor.doc.path, "External edit")
                else:
                    self.editor.doc.save = lambda _: (_ for _ in ()).throw(OSError("disk full"))
                return "- Imported"
            with patch("editor.extract_reply", side_effect=extract):
                await self.open_prompt()
                await self.submit()
                await self.editor.import_task
            self.assertEqual(self.editor.area.text, self.original)
            self.assertEqual(self.editor.doc.disk_text(), "External edit" if disk_change else self.original)
            self.editor.doc.save = old_save
            atomic_write(self.editor.doc.path, self.original)

    async def test_read_only_note_does_not_open_import(self):
        self.editor.doc.read_only = True
        self.pipe.send_text("\x12")
        await asyncio.sleep(.1)
        self.assertFalse(self.editor.import_active)
        self.read_mock.assert_not_called()
        self.editor.doc.read_only = False

    async def test_missing_native_id_name_change_during_request_cancels_import(self):
        self.editor.source = {**pane(None), "terminal_title_stripped": "First chat", "cwd": self.tmp.name}
        pending = asyncio.get_running_loop().create_future()
        async def extract(*_): return await pending
        with patch("editor.extract_reply", side_effect=extract) as call:
            await self.open_prompt()
            await self.submit()
            await eventually(lambda: call.await_count == 1)
            self.editor.source = {**self.editor.source, "terminal_title_stripped": "Second chat"}
            pending.set_result("- From the old conversation")
            await self.editor.import_task
        self.assertEqual(self.editor.area.text, self.original)
        self.assertIn("Conversation changed", self.editor.message)

    async def test_refreshes_pane_identity_before_reading_reply(self):
        from unittest.mock import Mock
        self.editor.api = Mock()
        self.editor.api.request.return_value = {"pane": pane(OTHER)}
        with patch("editor.extract_reply", new=AsyncMock()) as extract:
            await self.open_prompt()
            await self.submit()
            await self.editor.import_task
        self.read_mock.assert_not_called()
        extract.assert_not_awaited()
        self.assertIn("Conversation changed", self.editor.message)

    async def test_worker_passes_extraction_prompt_through_stdin(self):
        code = 'import json,sys; p=json.load(sys.stdin); print(json.dumps({"text":"- "+p["extraction_prompt"]+": "+p["note"]}))'
        with patch("organizer.worker_command", return_value=[sys.executable, "-c", code]):
            self.assertEqual(await organizer.extract_reply("café", "get list"), "- get list: café")
