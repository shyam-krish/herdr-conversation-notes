// tests/test_notes.py StorageTests, plus interop with the TUI plugin on one store.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync, existsSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Store, SaveConflict, atomicWrite, writeJson } from "../lib/store.js";
import { nodeSys, oracle, pane } from "./helpers.mjs";

const TUI = join(dirname(fileURLToPath(import.meta.url)), "../../tui");

async function setup(t, server = "/test/socket") {
  // Close every note (releasing its lock helper) before the folder is removed.
  const root = mkdtempSync(join(tmpdir(), "notes-gui-"));
  const docs = [];
  t.after(async () => {
    for (const doc of docs) await doc.close();
    rmSync(root, { recursive: true, force: true });
  });
  const store = await new Store(nodeSys(), root, server).init();
  const open = async (source = pane()) => {
    const doc = await store.document(await store.resolve(source));
    docs.push(doc);
    return doc;
  };
  return { root, store, open };
}

test("long unicode multiline note survives reopening, private on disk", async (t) => {
  const { open } = await setup(t);
  const text = "- Check the callback\n- résumé 日本語 📝\n\n" + "Long note. ".repeat(500);
  const doc = await open();
  await doc.save(text);
  await doc.close();
  assert.equal((await open()).text, text);
  assert.equal(statSync(doc.path).mode & 0o777, 0o600);
});

test("two conversations in one workspace are separate", async (t) => {
  const { open } = await setup(t);
  const one = await open();
  const two = await open(pane("conversation-b", "term-b", "w:p2"));
  await one.save("First conversation");
  await two.save("Second conversation");
  assert.notEqual(one.path, two.path);
  assert.equal(await one.diskText(), "First conversation");
});

test("resuming in another pane uses the same note; a new conversation is separate", async (t) => {
  const { open } = await setup(t);
  const doc = await open();
  await doc.save("Keep this across restarts");
  await doc.close();
  assert.equal((await open(pane("conversation-a", "new-terminal", "w:p9", "w:t9"))).text, "Keep this across restarts");
  assert.equal((await open(pane("conversation-b"))).text, "");
});

test("delayed native identity inherits the fallback note once", async (t) => {
  const { open } = await setup(t);
  const original = await open(pane(null));
  await original.save("Written before session detection");
  await original.close();
  assert.equal((await open()).text, "Written before session detection");
  assert.equal((await open(pane("conversation-b"))).text, "");
});

test("a temporarily missing session reference keeps the native note", async (t) => {
  const { open } = await setup(t);
  const original = await open();
  await original.save("Keep me");
  await original.close();
  assert.equal((await open(pane(null))).text, "Keep me");
});

test("legacy migration is exact and doesn't mix in a new conversation", async (t) => {
  const { root, store, open } = await setup(t);
  const legacy = join(root, "legacy.json");
  await writeJson(nodeSys(), legacy, { notes: { old: { agent_session: "conversation-a", terminal_id: "term-a", text: "Old note\nfull text" } } });
  store.legacy = legacy;
  assert.equal((await open()).text, "Old note\nfull text");
  assert.equal((await open(pane("conversation-b"))).text, "");
  assert.ok(existsSync(legacy));
});

test("a second editor is read only and follows the writer", async (t) => {
  const { open } = await setup(t);
  const writer = await open();
  const reader = await open();
  assert.equal(writer.read_only, false);
  assert.equal(reader.read_only, true);
  await writer.save("Newest text");
  assert.equal(await reader.refreshReadOnly(), "Newest text");
  await assert.rejects(reader.save("Cannot overwrite"), /open in another editor/);
  await writer.close();
  const next = await open();
  assert.equal(next.read_only, false, "closing releases the lock");
});

test("an external edit creates a recovery file without overwriting", async (t) => {
  const { open } = await setup(t);
  const doc = await open();
  await doc.save("Initial");
  await atomicWrite(nodeSys(), doc.path, "External");
  await assert.rejects(doc.save("My unsaved edits"), SaveConflict);
  assert.equal(await doc.diskText(), "External");
  assert.equal(readFileSync(doc.conflict_path, "utf8"), "My unsaved edits");
  assert.equal(doc.read_only, true);
  assert.match(doc.conflict_path, /\.recovered-\d+\.md$/);
});

test("notes remain on disk after closing the editor", async (t) => {
  const { open } = await setup(t);
  const doc = await open();
  await doc.save("Remember this tomorrow");
  await doc.close();
  assert.equal(readFileSync(doc.path, "utf8"), "Remember this tomorrow");
});

test("records and keys are identical to the Python plugin's", async (t) => {
  const cases = [pane(), pane(null), { ...pane("x"), agent_session: { agent: "claude", kind: "id", value: "abc" } },
    { ...pane(), terminal_title_stripped: "  Fix\tthe \u0007 login bug  " }];
  for (const [i, source] of cases.entries()) {
    const { root, store } = await setup(t, "herdr-core:37f91f1b");
    const pyRoot = join(root, "python");
    const python = oracle([{ fn: "resolve", args: { root: pyRoot, server: "herdr-core:37f91f1b", pane: source } }])[0].ok;
    const { updated_at, ...mine } = await store.resolve(source);
    assert.equal(typeof updated_at, "number");
    assert.deepEqual(mine, python, `case ${i}`);
    const layout = (dir) => readdirSync(join(dir, "aliases")).concat(readdirSync(join(dir, "notes"))).sort();
    assert.deepEqual(layout(root), layout(pyRoot));
  }
});

test("the TUI and GUI share notes, and each sees the other's one-writer lock", async (t) => {
  const { root, open } = await setup(t, "/shared/socket");
  const source = pane("shared-conversation");
  const doc = await open(source);
  await doc.save("Written by the GUI");
  // The Python editor sees the text, and the GUI's lock makes it read only.
  let python = oracle([{ fn: "document_text", args: { root, server: "/shared/socket", pane: source } }])[0].ok;
  assert.deepEqual(python, { text: "Written by the GUI", read_only: true });
  await doc.close();
  python = oracle([{ fn: "document_text", args: { root, server: "/shared/socket", pane: source } }])[0].ok;
  assert.equal(python.read_only, false);

  // A live Python editor holding the note makes the GUI's copy read only.
  const holder = spawn("python3", ["-I", "-c", [
    "import sys, json",
    `sys.path[:0] = [${JSON.stringify(TUI)}, ${JSON.stringify(TUI + "/vendor")}]`,
    "from pathlib import Path",
    "from notes_store import Store",
    `store = Store(Path(${JSON.stringify(root)}), '/shared/socket')`,
    `doc = store.document(store.resolve(json.loads(${JSON.stringify(JSON.stringify(source))})))`,
    "doc.save('Written by the TUI')",
    "print('ready', flush=True)",
    "sys.stdin.read()",
    "doc.close()",
  ].join("\n")], { stdio: ["pipe", "pipe", "inherit"] });
  await new Promise((resolve) => holder.stdout.once("data", resolve));
  const reader = await open(source);
  assert.equal(reader.read_only, true);
  assert.equal(reader.text, "Written by the TUI");
  holder.stdin.end();
  await new Promise((resolve) => holder.once("exit", resolve));
  await reader.close();
  assert.equal((await open(source)).read_only, false);
});

test("lock helpers release promptly and never leave markers behind", async (t) => {
  const { root, store, open } = await setup(t);
  const doc = await open();
  const markers = () => readdirSync(store.notes).filter((name) => name.includes(".gui-"));
  assert.equal(markers().length, 1);
  await doc.close();
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.deepEqual(markers(), []);
  assert.ok(!readdirSync(root).some((name) => name.includes(".gui-")));
});
