// Conversation Notes for the Herdr app: private notes for each coding conversation,
// in a panel beside it. A port of the TUI plugin in ../tui (same note store, keys,
// prompts and behavior). Opened with `mod.open` (a popup), this mod is the TUI's
// `toggle` action; opened as a pane beside an agent, it is the notes editor.

import { View, div } from "gpui-kit";
import { v_flex, h_flex, Input, InputState, Textarea, TextareaState, Editor, EditorState } from "gpui-base";
import {
  props, panes, terminals, focused, run, notify, closeOverlay, shared, setShared,
  theme, settings, hc, nextCommand,
} from "herdr";
import { appSys, hostEnv } from "./lib/sys.js";
import { Store, stateRoot, titleFor, makePrivateDir, LOCK_OPTIONS } from "./lib/store.js";
import {
  MOD, agentName, terminalFor, sourceFromPane, sameSession, claudeSession, childPids,
  selectSource, notesPaneIn,
} from "./lib/host.js";
import { latestReply, sourceIdentity, TranscriptError } from "./lib/transcripts.js";
import { OrganizeError, organizeText, extractReply, flatBullets } from "./lib/organizer.js";

const REQUEST_KEY = "conversation-notes.request";
const REQUEST_TTL_MS = 10_000;
const MESSAGE_MS = 5_000;

function errorText(error) {
  return String((error && error.message) || error);
}

/** The TUI's `toggle` action: open, focus, retarget or close the panel for the focused pane. */
function toggle() {
  const all = panes();
  const where = focused();
  const pane = where && all.find((p) => p.pane === where.pane);
  if (!pane) return "The originating pane is no longer open.";
  const open = notesPaneIn(all, pane.tab);
  if (open) {
    if (open.pane === pane.pane) {
      // From the notes pane itself: save and close (the TUI sends Ctrl+Q).
      setShared(REQUEST_KEY, { tab: pane.tab, action: "close", at: Date.now() });
      return null;
    }
    if (agentName(pane)) {
      // The panel receives the desired source independently of focus.
      setShared(REQUEST_KEY, { tab: pane.tab, action: "source", terminal: pane.terminal, at: Date.now() });
    }
    run("pane.focus", { pane: open.pane });
    return null;
  }
  if (!agentName(pane)) return "Focus the conversation whose notes you want to open.";
  const wasZoomed = Boolean(pane.zoomed);
  if (wasZoomed) run("pane.zoom", { pane: pane.pane });
  run("pane.split", {
    direction: "right", pane: pane.pane, mod: MOD,
    props: { tab: pane.tab, source_pane: pane.pane, source_terminal: pane.terminal, zoomed: wasZoomed },
  });
  return null;
}

export default class ConversationNotes extends View {
  init(_props, cx) {
    const given = props() || {};
    this.launcher = Boolean(given.overlay);
    if (this.launcher) {
      const problem = toggle();
      if (problem) notify({ title: "Conversation Notes", body: problem, level: "error" });
      cx.timer.after(1, () => closeOverlay(given.overlay));
      return;
    }
    this.given = given;
    this.tab = given.tab || (focused() && focused().tab) || null;
    this.sys = appSys();
    this.handle = cx.focus_handle();
    this.area = TextareaState.new({ value: "" });
    this.area.set_soft_wrap(true);
    this.viewer = EditorState.new({
      value: "", readonly: true, line_numbers: false, folding: false, soft_wrap: true,
      font_family: settings().font_family,
    });
    this.importPrompt = InputState.new({});
    this.organizePrompt = InputState.new({});
    this.focusedBuffer = "area";
    this.area.on("change", () => this.changed());
    this.area.on("focus", () => (this.focusedBuffer = "area"));
    this.viewer.on("focus", () => (this.focusedBuffer = "viewer"));
    this.importPrompt.on("focus", () => (this.focusedBuffer = "import"));
    this.organizePrompt.on("focus", () => (this.focusedBuffer = "organize"));
    this.importPrompt.on("submit", (_e, cx) => this.submitImport(cx));
    this.organizePrompt.on("submit", (_e, cx) => this.submitOrganize(cx));

    this.ready = false;
    this.fatal = "";
    this.message = "";
    this.messageAt = 0;
    this.lastEdit = this.lastSave = Date.now();
    this.backgroundError = "";
    this.organizing = false;
    this.organizeActive = false;
    this.importing = false;
    this.importActive = false;
    this.importSource = null;
    this.editRevision = 0;
    this.generation = 0;
    this.saveChain = Promise.resolve(true);
    this.saving = false;
    this.polling = false;
    this.nextPoll = 0;
    this.closing = false;
    this.lastRequestAt = Date.now();
    this.requested = null;
    this.children = new Map();
    this.shown = "";

    cx.spawn(async (cx) => {
      try {
        await this.start();
      } catch (error) {
        this.fatal = "Conversation Notes: " + errorText(error);
      }
      cx.notify();
    });
    cx.timer.every(200, (cx) => this.tick(cx));
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        if (command === "focus") this.focusEditor();
        cx.notify();
      }
    });
  }

  async start() {
    const sys = this.sys;
    this.env = await hostEnv(sys);
    const root = this.given.state_dir || stateRoot(this.env);
    let server = "herdr-core";
    try {
      const status = JSON.parse((await hc(["server", "status", "--json"])).stdout);
      if (status && status.core && status.core.id) server = "herdr-core:" + status.core.id;
    } catch {}
    const legacy = `${this.env.HOME}/.local/state/herdr/plugins/agent-notes/notes.json`;
    this.store = await new Store(sys, root, server, legacy).init();
    this.scratch = `${root}/requests`;
    const pane = panes().find((p) => p.terminal && p.terminal === this.given.source_terminal)
      || panes().find((p) => p.pane === this.given.source_pane);
    this.source = pane
      ? await this.sourceFor(pane)
      : { pane_id: this.given.source_pane || null, terminal_id: this.given.source_terminal || null,
          tab_id: this.tab, agent: null, agent_session: null };
    this.doc = await this.store.document(await this.store.resolve(this.source));
    this.watchLock(this.doc);
    this.setText(this.doc.text, "end");
    this.ready = true;
    this.focusEditor();
  }

  // ---- Sources -------------------------------------------------------------

  async childrenOf(pid) {
    const cached = this.children.get(pid);
    if (cached && Date.now() - cached.at < 10_000) return cached.list;
    const list = await childPids(this.sys, pid);
    this.children.set(pid, { at: Date.now(), list });
    return list;
  }

  async sourceFor(pane) {
    const terminal = terminalFor(terminals(), pane.terminal);
    let session = null;
    // Remote terminals (machine/address) have no local Claude session files.
    if (agentName(pane) === "claude" && !String(pane.terminal).includes("/") && terminal && terminal.foreground) {
      session = await claudeSession(this.sys, this.env, terminal.foreground.pid, (pid) => this.childrenOf(pid));
    }
    return sourceFromPane(pane, terminal, session);
  }

  ownPane() {
    const own = notesPaneIn(panes(), this.tab);
    return own ? own.pane : null;
  }

  async checkedImportSource(expected) {
    const pane = panes().find((p) => p.pane === expected.pane_id);
    if (!pane) throw new TranscriptError("Cannot verify the source pane; import cancelled.");
    const source = await this.sourceFor(pane);
    if (sourceIdentity(source) !== sourceIdentity(expected)) {
      throw new TranscriptError("Conversation changed; import cancelled. Try again.");
    }
    return source;
  }

  async switchSource(source) {
    if (!(await this.save())) return;
    const record = await this.store.resolve(source);
    if (record.key === this.doc.record.key) {
      this.source = source;
      return;
    }
    const replacement = await this.store.document(record);
    // Keep anything typed while the replacement was opening.
    for (let i = 0; i < 3; i++) {
      const text = this.text();
      if (!(await this.save())) {
        await replacement.close();
        return;
      }
      if (this.text() === text) break;
    }
    this.generation++;
    this.organizing = this.importing = false;
    if (this.importActive) this.dismissImport();
    if (this.organizeActive) this.dismissOrganize();
    const previous = this.doc;
    this.doc = replacement;
    this.source = source;
    this.setText(replacement.text, "end");
    this.watchLock(replacement);
    this.backgroundError = "";
    this.tell("Conversation changed");
    await previous.close();
  }

  watchLock(document) {
    document.onLockEnded = async () => {
      // The lock helper let go (its renewal window): take it again or go read-only.
      if (this.doc !== document || this.closing) return;
      const lock = await this.sys.holdLock(document.path.replace(/\.md$/, ".lock"), LOCK_OPTIONS);
      if (this.doc !== document || this.closing) {
        if (lock) await lock.release();
        return;
      }
      document.lock = lock;
      if (lock) lock.ended.then(() => document.lock === lock && document.onLockEnded && document.onLockEnded());
      else {
        document.read_only = true;
        this.tell("Note opened in another editor; now read only.");
      }
    };
  }

  // ---- Editing -------------------------------------------------------------

  text() {
    return this.area.value();
  }

  setText(text, cursor) {
    this.area.set_value(text);
    const at = cursor === "start" ? 0 : text.length;
    this.area.set_selected_range({ start: at, end: at });
    this.viewer.set_value(text);
    this.shown = text;
  }

  /** Replace the whole note as one edit, so Ctrl+Z undoes it in one step. */
  replaceAll(text, cursor) {
    this.area.set_selected_range({ start: 0, end: this.text().length });
    this.area.replace(text);
    if (this.text() !== text) this.area.set_value(text);
    const at = cursor === "start" ? 0 : text.length;
    this.area.set_selected_range({ start: at, end: at });
    this.viewer.set_value(text);
  }

  changed() {
    this.lastEdit = Date.now();
    this.editRevision++;
  }

  focusEditor() {
    try {
      if (this.ready && !this.doc.read_only) this.area.focus();
      else this.handle.focus();
    } catch {
      // Focus can only move during some host calls; the next click or "focus" does it.
    }
  }

  focusedText() {
    if (this.focusedBuffer === "import") return this.importPrompt.value();
    if (this.focusedBuffer === "organize") return this.organizePrompt.value();
    return this.text();
  }

  focusedReadOnly() {
    return (this.focusedBuffer === "area" || this.focusedBuffer === "viewer") && (!this.ready || this.doc.read_only);
  }

  tell(message) {
    this.message = message;
    this.messageAt = Date.now();
  }

  /** Copy the selection; with none, the whole focused text (unless selection-only). */
  copy(cx, selectionOnly) {
    const before = cx.read_from_clipboard();
    window.dispatch_action("input::Copy");
    cx.timer.after(30, (cx) => {
      const after = cx.read_from_clipboard();
      if (after !== before && after) {
        this.tell("Copied");
      } else if (!selectionOnly) {
        const text = this.focusedText();
        if (!text) return;
        cx.write_to_clipboard(text);
        this.tell("Copied");
      }
      cx.notify();
    });
  }

  async save() {
    const result = this.saveChain.then(() => this.saveNow());
    this.saveChain = result.catch(() => false);
    return await result;
  }

  async saveNow() {
    if (!this.ready || !this.doc) return true;
    if (this.doc.conflict_path) return true; // A recovery file already contains this read-only buffer.
    try {
      await this.doc.save(this.text());
      this.lastSave = Date.now();
      if (this.backgroundError.startsWith("Save error:")) this.backgroundError = "";
      return true;
    } catch (error) {
      this.backgroundError = "Save error: " + errorText(error);
      this.tell(this.backgroundError);
      if (this.doc.read_only) this.viewer.set_value(this.text());
      return false;
    }
  }

  // ---- Prompts -------------------------------------------------------------

  promptOrganize(cx) {
    if (this.importActive || this.importing) this.tell("Finish the import first.");
    else if (this.organizing) this.tell("Already organizing…");
    else if (this.doc.read_only) this.tell("This note is read only.");
    else if (!this.text().trim()) this.tell("Write a note first.");
    else {
      if (!this.organizeActive) {
        this.organizePrompt.set_value("");
        this.organizeActive = true;
      }
      cx.timer.after(1, () => {
        try {
          this.organizePrompt.focus();
        } catch {}
      });
    }
  }

  submitOrganize(cx) {
    if (!this.organizeActive) return;
    const prompt = this.organizePrompt.value().trim();
    this.dismissOrganize();
    this.organizing = true;
    const generation = this.generation;
    cx.spawn(async (cx) => {
      try {
        await this.organize(prompt, generation);
      } finally {
        if (generation === this.generation) this.organizing = false;
        cx.notify();
      }
    });
    cx.notify();
  }

  dismissOrganize() {
    this.organizeActive = false;
    this.focusEditor();
  }

  promptImport(cx) {
    if (this.organizeActive) this.tell("Finish the organize prompt first.");
    else if (this.organizing || this.importing) this.tell("A notes request is already running.");
    else if (this.doc.read_only) this.tell("This note is read only.");
    else {
      if (!this.importActive) {
        this.importPrompt.set_value("");
        this.importSource = { ...this.source };
        this.importActive = true;
      }
      cx.timer.after(1, () => {
        try {
          this.importPrompt.focus();
        } catch {}
      });
    }
  }

  submitImport(cx) {
    if (!this.importActive) return;
    const prompt = this.importPrompt.value().trim();
    const source = this.importSource;
    const document = this.doc;
    this.dismissImport();
    this.importing = true;
    const generation = this.generation;
    cx.spawn(async (cx) => {
      try {
        await this.importReply(document, source, prompt, generation);
      } finally {
        if (generation === this.generation) this.importing = false;
        cx.notify();
      }
    });
    cx.notify();
  }

  dismissImport() {
    this.importActive = false;
    this.importSource = null;
    this.focusEditor();
  }

  // ---- AI operations ---------------------------------------------------------

  async importReply(document, source, prompt, generation) {
    const live = () => generation === this.generation && this.doc === document && !document.read_only;
    const say = (message) => generation === this.generation && this.tell(message);
    if (!live() || !(await this.save())) return;
    say("Reading last completed reply…");
    try {
      await makePrivateDir(this.sys, this.scratch);
      source = await this.checkedImportSource(source);
      const reply = await latestReply(this.sys, this.env, source);
      if (!live()) return;
      say("Importing…");
      const extracted = flatBullets(await extractReply(this.sys, this.scratch, reply, prompt));
      await this.checkedImportSource(source);
      if (!live()) return;
      if ((await document.diskText()) !== document.baseline) {
        say("Note changed on disk; imported result was not applied.");
        return;
      }
      // Append to the current buffer so typing during the request is kept.
      for (let attempt = 0; attempt < 3; attempt++) {
        const original = this.text();
        let separator = "";
        if (original && !original.endsWith("\n\n")) separator = original.endsWith("\n") ? "\n" : "\n\n";
        const combined = original + separator + extracted;
        await document.save(combined);
        if (!live()) return;
        if (this.text() !== original) continue; // Typed during the save: append to that instead.
        this.replaceAll(combined, "end");
        this.lastSave = Date.now();
        say("Reply appended · Ctrl+Z to undo");
        return;
      }
      await this.save();
    } catch (error) {
      if (error instanceof TranscriptError || error instanceof OrganizeError) say(error.message);
      else say("Could not save the imported reply; original kept.");
    }
  }

  async organize(prompt, generation) {
    const document = this.doc;
    const original = this.text();
    const revision = this.editRevision;
    const say = (message) => generation === this.generation && this.tell(message);
    if (document.read_only || !original.trim() || !(await this.save())) return;
    say("Organizing…");
    try {
      await makePrivateDir(this.sys, this.scratch);
      const organized = flatBullets(await organizeText(this.sys, this.scratch, original, prompt));
      if (generation !== this.generation || this.doc !== document || this.editRevision !== revision || document.read_only) {
        say("Note changed; kept your edits. Press Ctrl+O to try again.");
        return;
      }
      // A separate editor may have changed the Markdown file on disk.
      if ((await document.diskText()) !== document.baseline) {
        say("Note changed on disk; organized result was not applied.");
        return;
      }
      if (organized === original) {
        say("Already organized");
        return;
      }
      // Persist before touching the buffer: a disk failure keeps the original.
      await document.save(organized);
      if (this.editRevision !== revision || this.doc !== document) {
        // Typed while it saved: put the edited text back on disk instead.
        await this.save();
        say("Note changed; kept your edits. Press Ctrl+O to try again.");
        return;
      }
      this.replaceAll(organized, "start");
      this.lastSave = Date.now();
      say("Organized · Ctrl+Z to undo");
    } catch (error) {
      if (error instanceof OrganizeError) say(error.message);
      else say("Could not save the organized note; original kept.");
    }
  }

  // ---- Lifecycle -------------------------------------------------------------

  tick(cx) {
    if (!this.ready || this.closing) return;
    const now = Date.now();
    const request = shared(REQUEST_KEY);
    if (request && request.tab === this.tab && request.at > this.lastRequestAt && now - request.at < REQUEST_TTL_MS) {
      this.lastRequestAt = request.at;
      if (request.action === "close") cx.spawn(async (cx) => { await this.closeNotes(); cx.notify(); });
      else if (request.action === "source") this.requested = request.terminal;
    }
    if (!this.doc.read_only && !this.saving && (now - this.lastEdit >= 350 || now - this.lastSave >= 2000)) {
      if (this.text() !== this.doc.baseline) {
        this.saving = true;
        cx.spawn(async (cx) => {
          await this.save();
          this.saving = false;
          cx.notify();
        });
      }
    }
    if (now >= this.nextPoll && !this.polling) {
      this.nextPoll = now + 1000;
      this.polling = true;
      cx.spawn(async (cx) => {
        try {
          await this.poll();
        } catch (error) {
          this.backgroundError = "Notes: " + errorText(error);
        } finally {
          this.polling = false;
          cx.notify();
        }
      });
    }
    const shown = this.header() + "\n" + this.footer() + "\n" + (this.doc.read_only ? 1 : 0);
    if (shown !== this.lastShown) {
      this.lastShown = shown;
      cx.notify();
    }
  }

  async poll() {
    if (this.closing) return;
    if (this.doc.read_only && !this.doc.conflict_path) {
      try {
        const refreshed = await this.doc.refreshReadOnly();
        if (refreshed !== this.text()) this.setText(refreshed, "end");
      } catch (error) {
        this.tell("Could not refresh note: " + errorText(error));
      }
    }
    const all = panes();
    const where = focused();
    const requested = this.requested;
    let pane = requested ? all.find((p) => p.terminal === requested) : null;
    pane = pane || selectSource(all, where && where.pane, this.source.terminal_id, this.ownPane());
    if (pane && agentName(pane)) {
      const source = await this.sourceFor(pane);
      if (source.terminal_id !== this.source.terminal_id || !sameSession(source.agent_session, this.source.agent_session)) {
        await this.switchSource(source);
      } else {
        this.source = source;
      }
    }
    if (requested === this.requested) this.requested = null;
  }

  /** Ctrl+Q: save, give focus back to the conversation, and close the pane. */
  async closeNotes() {
    if (this.closing || !this.ready) return;
    if (!(await this.save())) return;
    this.closing = true;
    const own = this.ownPane();
    const where = focused();
    if (where && where.pane === own) {
      const parent = panes().find((p) => p.terminal === this.source.terminal_id);
      if (parent && parent.tab === this.tab) {
        run("pane.focus", { pane: parent.pane });
        if (this.given.zoomed) run("pane.zoom", { pane: parent.pane });
      }
    }
    await this.doc.close();
    if (own) run("pane.close", { pane: own });
  }

  /** The pane closed or the app is quitting (also after Ctrl+Q). */
  async close() {
    if (this.launcher || !this.doc) return;
    const wasClosing = this.closing;
    this.closing = true;
    if (!wasClosing) {
      try {
        await this.saveNow();
      } catch {}
    }
    await this.doc.close();
  }

  // ---- Keys ------------------------------------------------------------------

  key(e, cx) {
    if (!this.ready) return;
    const writable = !this.focusedReadOnly();
    switch (e.keystroke) {
      case "ctrl-s":
        cx.spawn(async (cx) => { await this.save(); cx.notify(); });
        break;
      case "ctrl-q":
        cx.spawn(async (cx) => { await this.closeNotes(); cx.notify(); });
        break;
      case "ctrl-c":
        this.copy(cx, false);
        break;
      case "ctrl-v":
        if (writable) window.dispatch_action("input::Paste");
        break;
      case "ctrl-a":
        window.dispatch_action("input::SelectAll");
        break;
      case "ctrl-z":
        if (writable) window.dispatch_action("input::Undo");
        break;
      case "ctrl-y":
        if (writable) window.dispatch_action("input::Redo");
        break;
      case "ctrl-o":
        this.promptOrganize(cx);
        break;
      case "ctrl-r":
        this.promptImport(cx);
        break;
      case "escape":
        if (this.organizeActive) {
          this.dismissOrganize();
          this.tell("Organize cancelled");
        } else if (this.importActive) {
          this.dismissImport();
          this.tell("Import cancelled");
        } else return;
        break;
      default:
        return;
    }
    cx.stop_propagation();
    cx.notify();
  }

  // ---- View ------------------------------------------------------------------

  header() {
    let status;
    if (this.importing) status = "Importing…";
    else if (this.organizing) status = "Organizing…";
    else if (this.doc.conflict_path) status = "Recovery saved";
    else if (this.doc.read_only) status = "Open elsewhere · read only";
    else if (this.text() !== this.doc.baseline) status = "Saving…";
    else status = "Saved";
    return ` Notes · ${titleFor(this.source)} · ${status}`;
  }

  footer() {
    if (this.organizeActive) return " Optional prompt · Enter organize · Esc cancel";
    if (this.importActive) return " Optional prompt · Enter import · Esc cancel";
    if (this.message && Date.now() - this.messageAt < MESSAGE_MS) return " " + this.message;
    if (this.backgroundError) return " " + this.backgroundError;
    if (this.organizing) return " Organizing…";
    if (this.importing) return " Importing last completed reply…";
    return " ^R import  ^O organize  ^C copy  ^Q close";
  }

  promptRow(t, id, label, state) {
    return h_flex().id(id).flex_none().px(8).py(4).gap(6).items_center().border_t_1().border_color(t.border)
      .child(div().text_color(t.dim).child(label))
      .child(Input.new(state).flex_1().text_color(t.foreground));
  }

  render() {
    if (this.launcher) return div();
    const t = theme();
    const font = settings().font_family;
    const root = v_flex().id("notes").size_full().bg(t.background).text_color(t.foreground).text_size(13)
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.key(e, cx));
    if (this.fatal || !this.ready) {
      return root.child(div().p(10).text_color(this.fatal ? t.blocked : t.dim).child(this.fatal || "Loading…"));
    }
    const body = this.doc.read_only
      ? Editor.new(this.viewer).size_full()
      : Textarea.new(this.area).size_full().px(8).py(4).bg(t.background).text_color(t.foreground);
    return root
      .child(div().id("notes-header").flex_none().px(8).py(4).text_size(12).text_color(t.ansi6).truncate()
        .child(this.header()))
      .child(div().id("notes-body").flex_1().min_h(0).when(Boolean(font), (el) => el.font_family(font))
        .on_mouse_up("left", (_e, cx) => this.copy(cx, true))
        .child(body))
      .when(this.importActive, (el) => el.child(this.promptRow(t, "notes-import", "Import>", this.importPrompt)))
      .when(this.organizeActive, (el) => el.child(this.promptRow(t, "notes-organize", "Organize>", this.organizePrompt)))
      .child(div().id("notes-footer").flex_none().px(8).py(4).text_size(12).text_color(t.dim).truncate()
        .child(this.footer()));
  }
}
