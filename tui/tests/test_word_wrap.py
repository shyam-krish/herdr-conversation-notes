import asyncio
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT), str(ROOT / "vendor")]

from editor import NotesEditor
from notes_store import Store
from prompt_toolkit.clipboard import InMemoryClipboard
from prompt_toolkit.data_structures import Size
from prompt_toolkit.input import create_pipe_input
from prompt_toolkit.output import DummyOutput
from test_notes import eventually, pane


class ResizableOutput(DummyOutput):
    columns = 16  # 15 text cells, plus the scrollbar.
    rows = 14

    def get_size(self):
        return Size(rows=self.rows, columns=self.columns)


class WordWrapTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.pipe_context = create_pipe_input()
        self.pipe = self.pipe_context.__enter__()
        self.output = ResizableOutput()
        self.clipboard = InMemoryClipboard()
        self.editor = NotesEditor(Store(Path(self.temp.name), "/test/socket"), pane(),
                                  clipboard=self.clipboard, input=self.pipe, output=self.output)
        self.task = asyncio.create_task(self.editor.run_async())
        await eventually(lambda: self.editor.app.renderer._last_screen is not None)

    async def asyncTearDown(self):
        if not self.editor.app.is_done:
            self.editor.app.exit()
        await asyncio.wait_for(self.task, 3)
        self.pipe_context.__exit__(None, None, None)
        self.temp.cleanup()

    def rows(self):
        screen = self.editor.app.renderer._last_screen
        # Omit header, footer, and the scrollbar; inspect actual rendered cells.
        return ["".join(screen.data_buffer[y][x].char for x in range(self.output.columns - 1)).rstrip()
                for y in range(1, self.output.rows - 1)]

    async def show(self, text, columns=16):
        self.output.columns = columns
        self.editor.area.text = text
        self.editor.area.buffer.cursor_position = 0
        count = self.editor.app.render_counter
        self.editor.app.invalidate()
        await eventually(lambda: self.editor.app.render_counter > count)

    async def test_words_move_intact_and_exact_fit_does_not_create_blank_row(self):
        for text, expected in [
            ("hello beautiful world", ["hello beautiful", "world"]),
            ("hello beautiful world", ["hello", "beautiful", "world"]),
        ]:
            columns = 16 if len(expected) == 2 else 11
            await self.show(text, columns)
            self.assertEqual(self.rows()[:len(expected)], expected)
            self.assertEqual(self.editor.area.text, text)

    async def test_resize_reflows_without_modifying_copy_or_saved_note(self):
        text = "- Review the validation more closely."
        await self.show(text, 21)
        self.assertEqual(self.rows()[:2], ["- Review the", "validation more"])
        await self.show(text, 51)
        self.assertEqual(self.rows()[0], text)
        self.pipe.send_text("\x03")
        await eventually(lambda: self.clipboard.get_data().text == text)
        self.editor.save()
        self.assertEqual(self.editor.doc.path.read_text(), text)

    async def test_mouse_selection_and_editing_after_wrap_maps_to_original_text(self):
        await self.show("hello beautiful world", 11)
        # "beautiful" now starts at column 1, terminal row 3 (below the header).
        self.pipe.send_text("\x1b[<0;1;3M\x1b[<32;10;3M\x1b[<0;10;3m")
        await eventually(lambda: self.clipboard.get_data().text == "beautiful")
        self.editor.area.buffer.exit_selection()
        await asyncio.sleep(.35)  # A fresh click, outside the double-click window.
        self.pipe.send_text("\x1b[<0;1;3M\x1b[<0;1;3m")
        await eventually(lambda: self.editor.area.buffer.cursor_position == 6)
        self.pipe.send_text("\x7f")
        await eventually(lambda: self.editor.area.text == "hellobeautiful world")

    async def test_wide_and_combining_unicode_use_terminal_cells(self):
        text = "look 日本語 café\u0301 soon"
        await self.show(text, 11)
        self.assertEqual(self.rows()[:3], ["look", "日本語", "café\u0301 soon"])
        self.assertEqual(self.editor.area.text, text)

    async def test_overlong_words_remain_visible_and_explicit_lines_stay_separate(self):
        text = "abcdefghijklmnopqrstuv\n\n  Keep  spaces."
        await self.show(text, 11)
        self.assertEqual(self.rows()[:6], ["abcdefghij", "klmnopqrst", "uv", "", "  Keep", "spaces."])
        self.editor.save()
        self.assertEqual(self.editor.doc.path.read_text(), text)

    async def test_laptop_resize_keeps_cursor_visible_in_long_paragraph(self):
        text = "Review the validation carefully and check the callback tomorrow. " * 8
        await self.show(text, 81)
        self.editor.area.buffer.cursor_position = len(text)
        self.output.columns = 21
        count = self.editor.app.render_counter
        self.editor.app.invalidate()
        await eventually(lambda: self.editor.app.render_counter > count)
        cursor = self.editor.app.renderer._last_screen.get_cursor_position(self.editor.area.window)
        self.assertTrue(1 <= cursor.y < self.output.rows - 1)
        self.assertTrue(0 <= cursor.x < self.output.columns - 1)
        self.assertEqual(self.editor.area.buffer.cursor_position, len(text))
        self.pipe.send_text("\x7f")
        await eventually(lambda: self.editor.area.text == text[:-1])
