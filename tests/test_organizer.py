import asyncio
import io
import json
import os
import sys
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import AsyncMock, patch

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT), str(ROOT / "vendor")]

import organizer
from editor import NotesEditor
from notes_store import Store, atomic_write
from prompt_toolkit.clipboard import ClipboardData, InMemoryClipboard
from prompt_toolkit.input import create_pipe_input
from prompt_toolkit.output import DummyOutput
from test_notes import eventually, pane


def response(text="- First thought\n- Second thought", status="completed"):
    return {"status": status, "output": [{"type": "message", "role": "assistant",
            "content": [{"type": "output_text", "text": text}]}]}


class RequestTests(unittest.TestCase):
    def test_custom_organization_is_separate_from_note_and_keeps_flat_rules(self):
        with patch("organizer.urllib.request.build_opener") as opener:
            opener.return_value.open.return_value = io.BytesIO(json.dumps(response()).encode())
            organizer.request_notes("The unmodified note", "test-key", organization_prompt="  Put action items first  ")
        payload = json.loads(opener.return_value.open.call_args.args[0].data)
        self.assertEqual(json.loads(payload["input"]), {"notes": "The unmodified note",
                                                       "organization_request": "Put action items first"})
        self.assertIn("no indentation, sub-bullets", payload["instructions"])
        self.assertIn("preservation", payload["instructions"])
        self.assertFalse(payload["store"])

    def test_blank_instruction_preserves_default_request(self):
        with patch("organizer.urllib.request.build_opener") as opener:
            opener.return_value.open.return_value = io.BytesIO(json.dumps(response()).encode())
            organizer.request_notes("The note", "test-key", organization_prompt=" \n ")
        payload = json.loads(opener.return_value.open.call_args.args[0].data)
        self.assertEqual(payload["input"], "The note")
        self.assertEqual(payload["instructions"], organizer.PROMPT)

    def test_worker_main_forwards_organization_instruction(self):
        payload = {"note": "Remember the link", "organization_prompt": "Group by topic"}
        with patch("organizer.sys.stdin", io.StringIO(json.dumps(payload))), \
             patch("organizer.sys.stdout", io.StringIO()), \
             patch("organizer.request_notes", return_value="- Remember the link") as request:
            self.assertEqual(organizer.main(), 0)
        self.assertEqual(request.call_args.args[0], payload["note"])
        self.assertEqual(request.call_args.kwargs["organization_prompt"], "Group by topic")
        self.assertIsNone(request.call_args.kwargs["extraction_prompt"])

    def test_request_uses_only_note_and_flat_prompt_with_agreed_model(self):
        note = "maybe café tomorrow? keep https://example.com/a?q=2"
        with patch("organizer.urllib.request.build_opener") as opener:
            opener.return_value.open.return_value = io.BytesIO(json.dumps(response()).encode())
            self.assertEqual(organizer.request_notes(note, "test-key"), "- First thought\n- Second thought")
        request = opener.return_value.open.call_args.args[0]
        payload = json.loads(request.data)
        self.assertEqual(request.full_url, "https://api.openai.com/v1/responses")
        self.assertEqual(payload["model"], "gpt-5.6-luna")
        self.assertEqual(payload["input"], note)
        self.assertEqual(payload["reasoning"], {"effort": "none"})
        self.assertFalse(payload["store"])
        self.assertIn("no indentation, sub-bullets", payload["instructions"])
        self.assertNotIn("test-key", request.data.decode())

    def test_nested_numbered_empty_and_nonbullet_output_is_rejected(self):
        for text in ["", "- Parent\n  - Child", "1. First", "Here are your notes:\n- First",
                     "- ", "- One\ncontinued", "- One\x1b[31m"]:
            with self.subTest(text=text), self.assertRaises(organizer.OrganizeError):
                organizer.parse_response(response(text))

    def test_incomplete_or_refused_responses_are_rejected(self):
        cases = [response(status="incomplete"), response(status="failed"),
                 {"status": "completed", "output": [{"type": "message", "role": "assistant",
                  "content": [{"type": "refusal", "refusal": "no"}]}]}]
        for result in cases:
            with self.subTest(result=result), self.assertRaises(organizer.OrganizeError):
                organizer.parse_response(result)

    def test_api_errors_do_not_echo_sensitive_response_bodies(self):
        with patch("organizer.urllib.request.build_opener") as opener:
            opener.return_value.open.side_effect = urllib.error.HTTPError(
                organizer.ENDPOINT, 401, "secret-key and private note", {}, io.BytesIO(b"private"))
            with self.assertRaises(organizer.OrganizeError) as caught:
                organizer.request_notes("private note", "secret-key")
        self.assertNotIn("secret", str(caught.exception))
        self.assertNotIn("private", str(caught.exception))

    def test_missing_key_never_sends_request(self):
        with patch("organizer.urllib.request.build_opener") as opener:
            with self.assertRaisesRegex(organizer.OrganizeError, "OPENAI_API_KEY"):
                organizer.request_notes("a note", "")
            opener.assert_not_called()

    def test_worker_uses_inherited_key_or_login_zprofile_without_key_arguments(self):
        with patch.dict(os.environ, {"OPENAI_API_KEY": "secret-key"}):
            argv = organizer.worker_command()
            self.assertEqual(argv[0], sys.executable)
            self.assertNotIn("secret-key", " ".join(argv))
        with patch.dict(os.environ, {}, clear=True):
            argv = organizer.worker_command()
            self.assertEqual(argv[:2], ["/bin/zsh", "-lc"])
            self.assertEqual(argv[2], 'exec "$1" "$2" --worker')


class WorkerTests(unittest.IsolatedAsyncioTestCase):
    async def test_worker_protocol_passes_organization_instruction_via_stdin(self):
        code = 'import json,sys; p=json.load(sys.stdin); print(json.dumps({"text":"- "+p["organization_prompt"]+": "+p["note"]}))'
        with patch("organizer.worker_command", return_value=[sys.executable, "-c", code]):
            self.assertEqual(await organizer.organize_text("café 📝", "Group by topic"), "- Group by topic: café 📝")

    async def test_worker_protocol_passes_notes_via_stdin(self):
        code = 'import json,sys; n=json.load(sys.stdin)["note"]; print(json.dumps({"text":"- "+n}))'
        with patch("organizer.worker_command", return_value=[sys.executable, "-c", code]):
            self.assertEqual(await organizer.organize_text("café 📝"), "- café 📝")

    async def test_cancel_and_timeout_kill_the_worker(self):
        real_spawn = asyncio.create_subprocess_exec
        for cancel in [True, False]:
            with self.subTest(cancel=cancel):
                processes = []
                async def spawn(*args, **kwargs):
                    process = await real_spawn(*args, **kwargs)
                    processes.append(process)
                    return process
                with patch("organizer.worker_command", return_value=[sys.executable, "-c", "import time; time.sleep(60)"]), \
                     patch("organizer.asyncio.create_subprocess_exec", side_effect=spawn), \
                     patch("organizer.REQUEST_TIMEOUT", 2 if cancel else .05):
                    task = asyncio.create_task(organizer.organize_text("a note"))
                    await eventually(lambda: bool(processes))
                    if cancel:
                        task.cancel()
                        with self.assertRaises(asyncio.CancelledError):
                            await task
                    else:
                        with self.assertRaisesRegex(organizer.OrganizeError, "timed out"):
                            await task
                    self.assertIsNotNone(processes[0].returncode)


class OrganizerEditorTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.pipe_context = create_pipe_input()
        self.pipe = self.pipe_context.__enter__()
        self.editor = NotesEditor(Store(Path(self.tmp.name), "/test/socket"), pane(),
                                  clipboard=InMemoryClipboard(), input=self.pipe, output=DummyOutput())
        self.editor.area.text = "remember café tomorrow? also check callback"
        self.original = self.editor.area.text
        self.app_task = asyncio.create_task(self.editor.run_async())
        await eventually(lambda: self.editor.app.is_running)

    async def asyncTearDown(self):
        if not self.editor.app.is_done:
            self.editor.app.exit()
        await asyncio.wait_for(self.app_task, 3)
        self.pipe_context.__exit__(None, None, None)
        self.tmp.cleanup()

    async def press_organize(self, prompt=""):
        previous = self.editor.organize_task
        self.pipe.send_text("\x0f")
        await eventually(lambda: self.editor.organize_active)
        self.pipe.send_text(prompt + "\r")
        await eventually(lambda: self.editor.organize_task is not previous)

    async def test_optional_prompt_is_submitted_without_becoming_part_of_note(self):
        with patch("editor.organize_text", new=AsyncMock(return_value="- Check callback\n- Remember café tomorrow?")) as request:
            self.pipe.send_text("\x0f")
            await eventually(lambda: self.editor.organize_active)
            self.pipe.send_text("Put the callback first")
            await eventually(lambda: self.editor.organize_prompt.text == "Put the callback first")
            self.assertEqual(self.editor.area.text, self.original)
            request.assert_not_awaited()
            self.pipe.send_text("\r")
            await eventually(lambda: self.editor.organize_task is not None)
            await self.editor.organize_task
        request.assert_awaited_once_with(self.original, "Put the callback first")
        self.assertFalse(self.editor.organize_active)
        self.assertTrue(self.editor.app.layout.has_focus(self.editor.area))
        self.assertEqual(self.editor.doc.disk_text(), self.editor.area.text)
        self.pipe.send_text("\x1a")
        await eventually(lambda: self.editor.area.text == self.original)

    async def test_prompt_clipboard_repeated_shortcut_and_escape_preserve_note(self):
        with patch("editor.organize_text", new=AsyncMock()) as request:
            self.pipe.send_text("\x0f")
            await eventually(lambda: self.editor.organize_active)
            self.pipe.send_text("First instruction\x0f")
            await eventually(lambda: self.editor.organize_prompt.text == "First instruction")
            self.pipe.send_text("\x01\x03")
            await eventually(lambda: self.editor.clipboard.get_data().text == "First instruction")
            self.editor.clipboard.set_data(ClipboardData("Order by priority"))
            self.pipe.send_text("\x16")
            await eventually(lambda: self.editor.organize_prompt.text == "Order by priority")
            self.pipe.send_text("\x1b")
            await eventually(lambda: not self.editor.organize_active)
            request.assert_not_awaited()
        self.assertEqual(self.editor.area.text, self.original)
        self.assertTrue(self.editor.app.layout.has_focus(self.editor.area))
        self.pipe.send_text("\x0f")
        await eventually(lambda: self.editor.organize_active)
        self.assertEqual(self.editor.organize_prompt.text, "")

    async def test_prompts_are_mutually_exclusive_and_source_change_dismisses_organize(self):
        with patch("editor.organize_text", new=AsyncMock()) as request:
            self.pipe.send_text("\x0f")
            await eventually(lambda: self.editor.organize_active)
            self.pipe.send_text("keep my instruction\x12")
            await eventually(lambda: "Finish" in self.editor.message)
            self.assertTrue(self.editor.organize_active)
            self.assertFalse(self.editor.import_active)
            self.assertEqual(self.editor.organize_prompt.text, "keep my instruction")
            self.editor.switch_source(pane("conversation-b"))
            self.assertFalse(self.editor.organize_active)
            self.assertTrue(self.editor.app.layout.has_focus(self.editor.area))
            request.assert_not_awaited()
            self.editor.switch_source(pane())
            self.pipe.send_text("\x12")
            await eventually(lambda: self.editor.import_active)
            self.pipe.send_text("\x0f")
            await eventually(lambda: self.editor.message == "Finish the import first.")
            self.assertFalse(self.editor.organize_active)
            self.assertTrue(self.editor.import_active)

    async def test_organize_prompt_renders_at_laptop_width(self):
        from test_word_wrap import ResizableOutput
        output = ResizableOutput()
        output.columns, output.rows = 46, 15
        self.editor.app.renderer.output = output
        self.pipe.send_text("\x0f")
        await eventually(lambda: self.editor.organize_active)
        await eventually(lambda: self.editor.app.renderer._last_screen is not None and
                         self.editor.organize_prompt.window in self.editor.app.renderer._last_screen.visible_windows)
        screen = self.editor.app.renderer._last_screen
        rows = ["".join(screen.data_buffer[y][x].char for x in range(output.columns)).rstrip()
                for y in range(output.rows)]
        self.assertTrue(rows[-2].startswith(" Organize>"), rows[-2:])
        self.assertIn("Enter organize", rows[-1])
        self.assertIn("Esc cancel", rows[-1])

    async def test_ctrl_o_autosaves_and_ctrl_z_restores_original_in_one_step(self):
        organized = "- Remember café tomorrow?\n- Check the callback."
        with patch("editor.organize_text", new=AsyncMock(return_value=organized)) as request:
            await self.press_organize()
            await self.editor.organize_task
        request.assert_awaited_once_with(self.original, "")
        self.assertEqual(self.editor.area.text, organized)
        self.assertEqual(self.editor.doc.path.read_text(), organized)
        self.pipe.send_text("\x1a")
        await eventually(lambda: self.editor.area.text == self.original)
        self.editor.save()
        self.assertEqual(self.editor.doc.path.read_text(), self.original)

    async def test_repeated_shortcut_sends_one_request_and_edits_are_never_overwritten(self):
        pending = asyncio.get_running_loop().create_future()
        async def request(_note, _prompt): return await pending
        with patch("editor.organize_text", side_effect=request) as call:
            await self.press_organize()
            await eventually(lambda: call.await_count == 1)
            self.pipe.send_text("\x0f")
            await asyncio.sleep(.1)
            self.assertEqual(call.await_count, 1)
            self.editor.area.buffer.insert_text(" newer typing")
            newer = self.editor.area.text
            pending.set_result("- Stale result")
            await self.editor.organize_task
        self.assertEqual(self.editor.area.text, newer)
        self.assertIn("kept your edits", self.editor.message)

    async def test_switching_conversation_cancels_and_never_applies_result_to_other_note(self):
        pending = asyncio.get_running_loop().create_future()
        async def request(_note, _prompt): return await pending
        with patch("editor.organize_text", side_effect=request) as call:
            await self.press_organize()
            await eventually(lambda: call.await_count == 1)
            self.editor.switch_source(pane("conversation-b"))
            with self.assertRaises(asyncio.CancelledError): await self.editor.organize_task
        self.assertEqual(self.editor.area.text, "")
        self.editor.switch_source(pane())
        self.assertEqual(self.editor.area.text, self.original)

    async def test_failures_and_malformed_output_keep_original(self):
        for failure in [organizer.OrganizeError("Rate limited"), "- Parent\n  - Child"]:
            with self.subTest(failure=failure):
                mock = AsyncMock(side_effect=failure) if isinstance(failure, Exception) else AsyncMock(return_value=failure)
                with patch("editor.organize_text", new=mock):
                    await self.press_organize()
                    await self.editor.organize_task
                self.assertEqual(self.editor.area.text, self.original)
                self.assertEqual(self.editor.doc.path.read_text(), self.original)

    async def test_disk_change_during_request_keeps_both_existing_versions(self):
        async def request(_note, _prompt):
            atomic_write(self.editor.doc.path, "External edit")
            return "- Organized text"
        with patch("editor.organize_text", side_effect=request):
            await self.press_organize()
            await self.editor.organize_task
        self.assertEqual(self.editor.area.text, self.original)
        self.assertEqual(self.editor.doc.path.read_text(), "External edit")

    async def test_save_failure_after_response_keeps_original(self):
        async def request(_note, _prompt):
            self.editor.doc.save = lambda _: (_ for _ in ()).throw(OSError("disk full"))
            return "- Organized text"
        with patch("editor.organize_text", side_effect=request):
            await self.press_organize()
            await self.editor.organize_task
        self.assertEqual(self.editor.area.text, self.original)
        self.assertEqual(self.editor.doc.path.read_text(), self.original)

    async def test_empty_and_read_only_notes_never_call_api(self):
        with patch("editor.organize_text", new=AsyncMock()) as request:
            self.editor.area.text = "  "
            self.pipe.send_text("\x0f")
            await asyncio.sleep(.1)
            self.editor.area.text = self.original
            self.editor.doc.read_only = True
            self.pipe.send_text("\x0f")
            await asyncio.sleep(.1)
        request.assert_not_awaited()
        self.editor.doc.read_only = False
