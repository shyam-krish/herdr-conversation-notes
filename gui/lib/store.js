// Private, atomic Markdown storage keyed by a native agent conversation.
// A port of tui/notes_store.py: the same files, keys, aliases and locks, so the
// TUI plugin and this mod read and write one shared note store.
//
// `sys` supplies the host operations (see gui/lib/sys.js for the app's version):
//   readBytes(path) -> Uint8Array | null (null: missing)
//   writeText(path, text, expected) -> atomic replace; expected is the current text,
//     or null when the file must not exist yet; rejects when it changed (StaleWrite)
//   exists(path), readdir(path), exec(cmd, args, {timeout}) -> {code, stdout, stderr}
//   holdLock(path, {waitSeconds}) -> {release(), ended} | null (null: held elsewhere)

import { digest, pyDumps, utf8Decode, printableOnly, collapseSpace, basename, nowSeconds } from "./util.js";

export const PLUGIN_ID = "shyam.conversation-notes";

export class SaveConflict extends Error {}

/** A note's lock: never wait, and renew every two minutes, so after a crash or a
 * quit that cut cleanup short the TUI sees the note writable again quickly. */
export const LOCK_OPTIONS = { waitSeconds: 0, maxSeconds: 120 };

export function stateRoot(env) {
  return env.HERDR_PLUGIN_STATE_DIR || `${env.HOME}/.local/state/herdr/plugins/${PLUGIN_ID}`;
}

export function titleFor(pane) {
  const text = pane.terminal_title_stripped || pane.label || pane.agent || "Conversation";
  return collapseSpace(printableOnly(String(text)));
}

export async function readText(sys, path) {
  const bytes = await sys.readBytes(path);
  return bytes === null ? null : utf8Decode(bytes);
}

export async function readJson(sys, path, fallback) {
  const text = await readText(sys, path);
  return text === null ? fallback : JSON.parse(text);
}

export async function makePrivateDir(sys, path) {
  if (await sys.exists(path)) return;
  const result = await sys.exec("/bin/mkdir", ["-p", "-m", "700", path]);
  if (result.code !== 0) throw new Error(`Cannot create ${path}`);
}

async function privateFile(sys, path) {
  // Python's mkstemp writes 0600 files; keep note contents private the same way.
  try {
    await sys.exec("/bin/chmod", ["600", path]);
  } catch {}
}

/** os.replace semantics: write whatever is there now, atomically. */
export async function atomicWrite(sys, path, data) {
  const parent = path.slice(0, path.lastIndexOf("/"));
  await makePrivateDir(sys, parent);
  for (let attempt = 0; ; attempt++) {
    const current = await readText(sys, path);
    try {
      await sys.writeText(path, data, current);
      break;
    } catch (error) {
      // Lost a race with another writer between the read and the write; retry.
      if (attempt >= 4) throw error;
    }
  }
  await privateFile(sys, path);
}

export async function writeJson(sys, path, value) {
  await atomicWrite(sys, path, JSON.stringify(value, null, 2) + "\n");
}

/** file_lock: an exclusive flock shared with the TUI plugin (blocking, bounded). */
export async function withFileLock(sys, path, fn) {
  const parent = path.slice(0, path.lastIndexOf("/"));
  await makePrivateDir(sys, parent);
  const lock = await sys.holdLock(path, { waitSeconds: 10 });
  if (!lock) throw new Error("Another notes process is holding the identity lock.");
  try {
    return await fn();
  } finally {
    await lock.release();
  }
}

export class Store {
  constructor(sys, root, server, legacy = null) {
    this.sys = sys;
    this.root = root;
    this.server = server;
    this.legacy = legacy;
    this.notes = `${root}/notes`;
  }

  async init() {
    await makePrivateDir(this.sys, this.notes);
    return this;
  }

  async resolve(pane) {
    const sys = this.sys;
    const terminal = pane.terminal_id;
    if (!terminal) throw new Error("Cannot identify this agent terminal.");
    const session = pane.agent_session || {};
    const native = Boolean(session.value && session.agent);
    const aliasId = await digest(this.server + "|" + terminal);
    const aliasPath = `${this.root}/aliases/${aliasId}.json`;
    return await withFileLock(sys, `${this.root}/identity.lock`, async () => {
      const old = await readJson(sys, aliasPath, {});
      let identity, kind;
      if (native) {
        identity = ["native-v1", session.agent, "kind" in session ? session.kind : "id", session.value];
        kind = "native";
      } else if (old.kind === "native") {
        // Detection can momentarily omit a session; keep its existing note.
        return await readJson(sys, `${this.notes}/${old.key}.json`, old);
      } else {
        identity = ["terminal-v1", this.server, terminal];
        kind = "terminal";
      }
      const key = await digest(pyDumps(identity));
      const record = {
        key, kind, identity,
        title: titleFor(pane),
        source_terminal_id: terminal,
        source_pane_id: pane.pane_id ?? null,
        updated_at: nowSeconds(),
      };
      const path = `${this.notes}/${key}.md`;
      if (!(await sys.exists(path))) {
        let seed = null;
        if (native && old.kind === "terminal") {
          const previous = `${this.notes}/${old.key}.md`;
          if (await sys.exists(previous)) seed = await readText(sys, previous);
        }
        if (seed === null) seed = await this.legacyNote(pane);
        if (seed !== null) await atomicWrite(sys, path, seed);
      }
      await writeJson(sys, `${this.notes}/${key}.json`, record);
      await writeJson(sys, aliasPath, record);
      return record;
    });
  }

  async legacyNote(pane) {
    if (!this.legacy) return null;
    let notes;
    try {
      const data = await readJson(this.sys, this.legacy, {});
      notes = (data && typeof data === "object" && data.notes) || {};
    } catch {
      return null;
    }
    const native = (pane.agent_session || {}).value;
    for (const note of Object.values(notes)) {
      if (!note || typeof note !== "object") continue;
      const matches = native && note.agent_session
        ? native === note.agent_session
        : pane.terminal_id === note.terminal_id;
      if (matches && typeof note.text === "string") return note.text;
    }
    return null;
  }

  async document(record) {
    const doc = new Document(this.sys, `${this.notes}/${record.key}.md`, record);
    await doc.open();
    return doc;
  }
}

export class Document {
  constructor(sys, path, record) {
    this.sys = sys;
    this.path = path;
    this.record = record;
    this.lock = null;
    this.read_only = false;
    this.conflict_path = null;
    this.text = "";
    this.baseline = "";
  }

  async open() {
    // One writer per note, shared with the TUI plugin's flock on <key>.lock.
    this.lock = await this.sys.holdLock(this.path.replace(/\.md$/, ".lock"), LOCK_OPTIONS);
    this.read_only = !this.lock;
    if (this.lock) {
      this.lock.ended.then(() => {
        // The holder outlived its renewal window or the lock was released.
        if (this.lock && !this.closed) this.onLockEnded?.();
      });
    }
    try {
      this.text = await this.diskText();
    } catch (error) {
      await this.close();
      throw error;
    }
    this.baseline = this.text;
  }

  async diskText() {
    return (await readText(this.sys, this.path)) ?? "";
  }

  async save(text) {
    if (this.read_only) {
      if (text !== this.baseline) throw new Error("This note is open in another editor.");
      return false;
    }
    if (text === this.baseline) return false;
    const disk = await readText(this.sys, this.path);
    if ((disk ?? "") !== this.baseline) return await this.recover(text);
    try {
      await this.sys.writeText(this.path, text, disk);
    } catch (error) {
      // Changed between the read and the write: the same external edit, caught later.
      if (error && error.stale) return await this.recover(text);
      throw error;
    }
    await privateFile(this.sys, this.path);
    this.text = this.baseline = text;
    return true;
  }

  async recover(text) {
    const stem = basename(this.path).replace(/\.md$/, "");
    const recovery = `${this.path.slice(0, this.path.lastIndexOf("/"))}/${stem}.recovered-${Date.now()}000000.md`;
    await atomicWrite(this.sys, recovery, text);
    this.conflict_path = recovery;
    this.read_only = true;
    throw new SaveConflict(`External edit detected. Your changes are saved in ${basename(recovery)}`);
  }

  async refreshReadOnly() {
    if (this.read_only && !this.conflict_path) this.text = this.baseline = await this.diskText();
    return this.text;
  }

  async close() {
    this.closed = true;
    const lock = this.lock;
    this.lock = null;
    if (lock) await lock.release();
  }
}
