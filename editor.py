"""A small multiline editor; Herdr provides the surrounding pane chrome."""
from __future__ import annotations

import asyncio
import base64
import json
import os
import shutil
import signal
import subprocess
import sys
import time

from prompt_toolkit import Application
from prompt_toolkit.clipboard import Clipboard, ClipboardData
from prompt_toolkit.document import Document as BufferDocument
from prompt_toolkit.filters import Condition
from prompt_toolkit.key_binding import KeyBindings
from prompt_toolkit.layout import ConditionalContainer, HSplit, Layout, Window
from prompt_toolkit.layout.controls import FormattedTextControl
from prompt_toolkit.mouse_events import MouseEventType
from prompt_toolkit.styles import Style
from prompt_toolkit.widgets import TextArea

from herdr_host import Herdr, find_pane, runtime_file, select_source
from notes_store import Store, digest, file_lock, read_json, title_for, write_json
from organizer import OrganizeError, extract_reply, flat_bullets, organize_text
from transcripts import TranscriptError, latest_reply, source_identity
from word_wrap import WordWrapProcessor


class SystemClipboard(Clipboard):
    def __init__(self):
        self.data = ClipboardData()
        self.emit = None

    def set_data(self, data: ClipboardData) -> None:
        self.data = data
        if sys.platform == "darwin" and not os.environ.get("SSH_CONNECTION"):
            subprocess.run(["/usr/bin/pbcopy"], input=data.text.encode(), check=True, timeout=3)
        elif os.environ.get("WAYLAND_DISPLAY") and shutil.which("wl-copy"):
            subprocess.run(["wl-copy"], input=data.text.encode(), check=True, timeout=3)
        elif os.environ.get("DISPLAY") and shutil.which("xclip"):
            subprocess.run(["xclip", "-selection", "clipboard"], input=data.text.encode(), check=True, timeout=3)
        elif self.emit:
            self.emit("\x1b]52;c;" + base64.b64encode(data.text.encode()).decode() + "\x07")
        else:
            raise OSError("Clipboard is unavailable in this terminal.")

    def get_data(self) -> ClipboardData:
        if sys.platform == "darwin" and not os.environ.get("SSH_CONNECTION"):
            cmd = ["/usr/bin/pbpaste"]
        elif os.environ.get("WAYLAND_DISPLAY") and shutil.which("wl-paste"):
            cmd = ["wl-paste", "--no-newline"]
        elif os.environ.get("DISPLAY") and shutil.which("xclip"):
            cmd = ["xclip", "-selection", "clipboard", "-o"]
        else:
            # Remote terminals can paste with their normal Cmd/Ctrl+Shift+V.
            return self.data
        result = subprocess.run(cmd, capture_output=True, check=True, timeout=3)
        return ClipboardData(result.stdout.decode("utf-8").replace("\r\n", "\n"))


class NotesEditor:
    def __init__(self, store: Store, source: dict, api: Herdr | None = None,
                 own: dict | None = None, clipboard=None, input=None, output=None):
        self.store, self.source, self.api, self.own = store, source, api, own
        self.doc = store.document(store.resolve(source))
        self.clipboard = clipboard or SystemClipboard()
        self.message, self.message_at = "", 0.0
        self.last_edit = self.last_save = time.monotonic()
        self.pending_close = False
        self.background_error = ""
        self.organize_task = None
        self.organize_active = False
        self.import_task = None
        self.import_active = False
        self.import_source = None
        self.edit_revision = 0
        self.area = TextArea(text=self.doc.text, multiline=True, wrap_lines=True,
                             input_processors=[WordWrapProcessor()],
                             scrollbar=True, focus_on_click=True,
                             read_only=Condition(lambda: self.doc.read_only))
        self.area.buffer.on_text_changed += self.changed
        self.area.buffer.cursor_position = len(self.area.text)
        self.import_prompt = TextArea(height=1, multiline=False, wrap_lines=False,
                                      prompt=" Import> ", focus_on_click=True)
        self.organize_prompt = TextArea(height=1, multiline=False, wrap_lines=False,
                                        prompt=" Organize> ", focus_on_click=True)
        bindings = KeyBindings()

        @bindings.add("c-s")
        def save(event):
            self.save()

        @bindings.add("c-q")
        def close(event):
            if self.save():
                event.app.exit()

        @bindings.add("c-c")
        def copy(event):
            self.copy()

        @bindings.add("c-v")
        def paste(event):
            buffer = event.app.current_buffer
            if not buffer.read_only():
                try:
                    text = self.clipboard.get_data().text
                    buffer.save_to_undo_stack()
                    if buffer.selection_state:
                        buffer.cut_selection()
                    buffer.insert_text(text)
                except (OSError, subprocess.SubprocessError, UnicodeError) as exc:
                    self.tell("Paste failed: " + str(exc))

        @bindings.add("c-a")
        def select_all(event):
            buffer = event.app.current_buffer
            buffer.cursor_position = 0
            buffer.start_selection()
            buffer.cursor_position = len(buffer.text)

        @bindings.add("c-z")
        def undo(event):
            if not event.app.current_buffer.read_only():
                event.app.current_buffer.undo()

        @bindings.add("c-y")
        def redo(event):
            if not event.app.current_buffer.read_only():
                event.app.current_buffer.redo()

        @bindings.add("c-o")
        def organize(event):
            if self.import_active or self.import_task and not self.import_task.done():
                self.tell("Finish the import first.")
            elif self.organize_task and not self.organize_task.done():
                self.tell("Already organizing…")
            elif self.doc.read_only:
                self.tell("This note is read only.")
            elif not self.area.text.strip():
                self.tell("Write a note first.")
            else:
                if not self.organize_active:
                    self.organize_prompt.buffer.reset()
                    self.organize_active = True
                self.app.layout.focus(self.organize_prompt)

        @bindings.add("enter", filter=Condition(lambda: self.organize_active and
                       self.app.layout.has_focus(self.organize_prompt)))
        def submit_organize(event):
            prompt = self.organize_prompt.text.strip()
            self.dismiss_organize()
            self.organize_task = event.app.create_background_task(self.organize(prompt))

        @bindings.add("escape", filter=Condition(lambda: self.organize_active))
        def cancel_organize(event):
            self.dismiss_organize()
            self.tell("Organize cancelled")

        @bindings.add("c-r")
        def prompt_import(event):
            if self.organize_active:
                self.tell("Finish the organize prompt first.")
            elif any(task and not task.done() for task in (self.organize_task, self.import_task)):
                self.tell("A notes request is already running.")
            elif self.doc.read_only:
                self.tell("This note is read only.")
            else:
                if not self.import_active:
                    self.import_prompt.buffer.reset()
                    self.import_source = dict(self.source)
                    self.import_active = True
                self.app.layout.focus(self.import_prompt)

        @bindings.add("enter", filter=Condition(lambda: self.import_active and
                       self.app.layout.has_focus(self.import_prompt)))
        def submit_import(event):
            prompt, source, document = self.import_prompt.text.strip(), self.import_source, self.doc
            self.dismiss_import()
            self.import_task = event.app.create_background_task(self.import_reply(document, source, prompt))

        @bindings.add("escape", filter=Condition(lambda: self.import_active))
        def cancel_import(event):
            self.dismiss_import()
            self.tell("Import cancelled")

        mouse_handler = self.area.control.mouse_handler

        def select_and_copy(event):
            result = mouse_handler(event)
            if event.event_type == MouseEventType.MOUSE_UP and self.area.buffer.selection_state:
                self.copy(selection_only=True, buffer=self.area.buffer)
            return result

        self.area.control.mouse_handler = select_and_copy
        self.app = Application(
            layout=Layout(HSplit([
                Window(FormattedTextControl(self.header), height=1, style="class:header"),
                self.area,
                ConditionalContainer(self.import_prompt, filter=Condition(lambda: self.import_active)),
                ConditionalContainer(self.organize_prompt, filter=Condition(lambda: self.organize_active)),
                Window(FormattedTextControl(self.footer), height=1, style="class:footer"),
            ]), focused_element=self.area),
            key_bindings=bindings, full_screen=True, mouse_support=True,
            clipboard=self.clipboard, input=input, output=output,
            style=Style.from_dict({"header": "fg:ansicyan", "footer": "fg:ansibrightblack",
                                  "selected-text": "reverse"}),
            refresh_interval=0.25,
        )
        if isinstance(self.clipboard, SystemClipboard):
            def emit(sequence):
                self.app.output.write_raw(sequence)
                self.app.output.flush()
            self.clipboard.emit = emit

    def header(self):
        if self.import_task and not self.import_task.done():
            status = "Importing…"
        elif self.organize_task and not self.organize_task.done():
            status = "Organizing…"
        elif self.doc.conflict_path:
            status = "Recovery saved"
        elif self.doc.read_only:
            status = "Open elsewhere · read only"
        elif self.area.text != self.doc.baseline:
            status = "Saving…"
        else:
            status = "Saved"
        return f" Notes · {title_for(self.source)} · {status}"

    def footer(self):
        if self.organize_active:
            return " Optional prompt · Enter organize · Esc cancel"
        if self.import_active:
            return " Optional prompt · Enter import · Esc cancel"
        if self.message and time.monotonic() - self.message_at < 5:
            return " " + self.message
        if self.background_error:
            return " " + self.background_error
        if self.organize_task and not self.organize_task.done():
            return " Organizing…"
        if self.import_task and not self.import_task.done():
            return " Importing last completed reply…"
        return " ^R import  ^O organize  ^C copy  ^Q close"

    def changed(self, _):
        self.last_edit = time.monotonic()
        self.edit_revision += 1

    def dismiss_import(self):
        self.import_active = False
        self.import_source = None
        self.app.layout.focus(self.area)

    def dismiss_organize(self):
        self.organize_active = False
        self.app.layout.focus(self.area)

    def checked_import_source(self, expected: dict) -> dict:
        source = self.source
        if self.api:
            try:
                source = self.api.request("pane.get", pane_id=expected["pane_id"])["pane"]
            except (OSError, ValueError, RuntimeError, KeyError):
                raise TranscriptError("Cannot verify the source pane; import cancelled.") from None
        if source_identity(source) != source_identity(expected):
            raise TranscriptError("Conversation changed; import cancelled. Try again.")
        return source

    async def import_reply(self, document, source: dict, prompt: str):
        if self.doc is not document or document.read_only or not self.save():
            return
        self.tell("Reading last completed reply…")
        try:
            source = await asyncio.to_thread(self.checked_import_source, source)
            reply = await asyncio.to_thread(latest_reply, source)
            if self.doc is not document or document.read_only:
                return
            self.tell("Importing…")
            extracted = flat_bullets(await extract_reply(reply, prompt))
            await asyncio.to_thread(self.checked_import_source, source)
            if self.doc is not document or document.read_only:
                return
            if document.disk_text() != document.baseline:
                self.tell("Note changed on disk; imported result was not applied.")
                return
            # Append to the current buffer so typing during the request is kept.
            original = self.area.text
            separator = ""
            if original and not original.endswith("\n\n"):
                separator = "\n" if original.endswith("\n") else "\n\n"
            combined = original + separator + extracted
            document.save(combined)
            self.area.buffer.save_to_undo_stack()
            self.area.buffer.set_document(BufferDocument(combined, len(combined)))
            self.last_save = time.monotonic()
            self.tell("Reply appended · Ctrl+Z to undo")
        except (TranscriptError, OrganizeError) as exc:
            self.tell(str(exc))
        except (OSError, UnicodeError):
            self.tell("Could not save the imported reply; original kept.")
        finally:
            self.app.invalidate()

    async def organize(self, prompt=""):
        document = self.doc
        original = self.area.text
        revision = self.edit_revision
        if document.read_only or not original.strip() or not self.save():
            return
        self.tell("Organizing…")
        try:
            organized = flat_bullets(await organize_text(original, prompt))
            if self.doc is not document or self.edit_revision != revision or document.read_only:
                self.tell("Note changed; kept your edits. Press Ctrl+O to try again.")
                return
            # A separate editor may have changed the Markdown file on disk.
            if document.disk_text() != document.baseline:
                self.tell("Note changed on disk; organized result was not applied.")
                return
            if organized == original:
                self.tell("Already organized")
                return
            # Persist before touching the buffer: a disk failure keeps the original.
            document.save(organized)
            self.area.buffer.save_to_undo_stack()
            self.area.buffer.set_document(BufferDocument(organized, 0))
            self.last_save = time.monotonic()
            self.tell("Organized · Ctrl+Z to undo")
        except OrganizeError as exc:
            self.tell(str(exc))
        except (OSError, UnicodeError):
            self.tell("Could not save the organized note; original kept.")
        finally:
            self.app.invalidate()

    def tell(self, message: str):
        self.message, self.message_at = message, time.monotonic()
        self.app.invalidate()

    def copy(self, selection_only=False, buffer=None):
        buffer = buffer or self.app.current_buffer
        if buffer.selection_state:
            # Read the selected range without clearing its visual highlight.
            _, data = buffer.document.cut_selection()
        elif selection_only:
            return
        else:
            data = ClipboardData(buffer.text)
        if not data.text:
            return
        try:
            self.clipboard.set_data(data)
            self.tell("Copied")
        except (OSError, subprocess.SubprocessError) as exc:
            self.tell("Copy failed: " + str(exc))

    def save(self) -> bool:
        if self.doc.conflict_path:
            return True  # A recovery file already contains this read-only buffer.
        try:
            self.doc.save(self.area.text)
            self.last_save = time.monotonic()
            if self.background_error.startswith("Save error:"):
                self.background_error = ""
            return True
        except (OSError, UnicodeError) as exc:
            self.background_error = "Save error: " + str(exc)
            self.tell(self.background_error)
            return False

    def switch_source(self, source: dict):
        if not self.save():
            return
        record = self.store.resolve(source)
        if record["key"] == self.doc.record["key"]:
            self.source = source
            return
        replacement = self.store.document(record)
        if self.organize_task and not self.organize_task.done():
            self.organize_task.cancel()
        if self.import_task and not self.import_task.done():
            self.import_task.cancel()
        if self.import_active:
            self.dismiss_import()
        if self.organize_active:
            self.dismiss_organize()
        self.doc.close()
        self.doc = replacement
        self.source = source
        self.area.buffer.reset(document=BufferDocument(replacement.text, len(replacement.text)))
        self.background_error = ""
        self.tell("Conversation changed")

    def heartbeat(self, requested_handled: str | None = None) -> str | None:
        if not self.own:
            return None
        path = runtime_file(self.store, self.own["tab_id"])
        with file_lock(self.store.root / ("toggle-" + digest(self.store.server) + ".lock")):
            record = read_json(path, {})
            if record.get("terminal_id") not in (None, self.own["terminal_id"]):
                raise RuntimeError("Another notes panel owns this tab.")
            requested = record.get("requested_source")
            if requested_handled == requested:
                record.pop("requested_source", None)
            record.update({"pane_id": self.own["pane_id"], "terminal_id": self.own["terminal_id"],
                           "tab_id": self.own["tab_id"], "pid": os.getpid(), "heartbeat": time.time(),
                           "source_terminal": self.source["terminal_id"], "note_key": self.doc.record["key"]})
            write_json(path, record)
            return requested

    async def maintain(self):
        next_poll = 0.0
        while not self.app.is_done:
            await asyncio.sleep(0.2)
            now = time.monotonic()
            if self.pending_close:
                if self.save():
                    self.app.exit()
                    return
                self.pending_close = False
            if not self.doc.read_only and (now - self.last_edit >= 0.35 or now - self.last_save >= 2):
                self.save()
            if now < next_poll:
                continue
            next_poll = now + 1
            if self.doc.read_only and not self.doc.conflict_path:
                try:
                    refreshed = self.doc.refresh_read_only()
                    if refreshed != self.area.text:
                        self.area.buffer.set_document(BufferDocument(refreshed), bypass_readonly=True)
                except (OSError, UnicodeError) as exc:
                    self.tell("Could not refresh note: " + str(exc))
            if self.api and self.own:
                try:
                    requested = await asyncio.to_thread(self.heartbeat)
                    snapshot = await asyncio.to_thread(self.api.snapshot)
                    source = (find_pane(snapshot, terminal_id=requested) if requested else None)
                    source = source or select_source(snapshot, self.source["terminal_id"], self.own["terminal_id"])
                    if source and source.get("agent"):
                        if (source["terminal_id"] != self.source["terminal_id"] or
                            source.get("agent_session") != self.source.get("agent_session")):
                            self.switch_source(source)
                        else:
                            self.source = source
                    await asyncio.to_thread(self.heartbeat, requested)
                    if self.background_error.startswith("Connection unavailable"):
                        self.background_error = ""
                except (OSError, ValueError, RuntimeError) as exc:
                    self.background_error = "Connection unavailable; notes still save locally"
            self.app.invalidate()

    async def run_async(self):
        def start():
            self.app.create_background_task(self.maintain())
        try:
            await self.app.run_async(pre_run=start)
        finally:
            # Handles terminal closure as well as the normal Ctrl+Q exit.
            self.save()
            self.doc.close()


def run_editor(store: Store, source: dict, api: Herdr):
    own_id = os.environ.get("HERDR_PANE_ID")
    if not own_id:
        raise RuntimeError("The notes editor must run in its own Herdr split pane.")
    own = api.request("pane.get", pane_id=own_id)["pane"]
    editor = NotesEditor(store, source, api=api, own=own)
    for sig in [signal.SIGHUP, signal.SIGTERM]:
        signal.signal(sig, lambda *_: setattr(editor, "pending_close", True))
    try:
        asyncio.run(editor.run_async())
    finally:
        path = runtime_file(store, own["tab_id"])
        with file_lock(store.root / ("toggle-" + digest(store.server) + ".lock")):
            if read_json(path, {}).get("terminal_id") == own["terminal_id"]:
                path.unlink(missing_ok=True)
        try:
            snapshot = api.snapshot()
            if snapshot.get("focused_pane_id") == own["pane_id"]:
                parent = find_pane(snapshot, terminal_id=editor.source["terminal_id"])
                if parent and parent["tab_id"] == own["tab_id"]:
                    api.request("pane.focus", pane_id=parent["pane_id"])
                    if os.environ.get("CONVERSATION_NOTES_ZOOMED") == "1":
                        api.request("pane.zoom", pane_id=parent["pane_id"], mode="on")
            api.request("pane.close", pane_id=own["pane_id"])
        except (OSError, RuntimeError, ValueError):
            pass
