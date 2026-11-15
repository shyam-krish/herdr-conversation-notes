import test from "node:test";
import assert from "node:assert/strict";
import { utf8Encode, utf8Decode, UnicodeError, digest, pyDumps, splitlines } from "../lib/util.js";
import { titleFor } from "../lib/store.js";
import { oracle } from "./helpers.mjs";

const SAMPLES = ["", "plain", "résumé 日本語 📝", "a\u0000b\u001fc\u007f", "tab\tquote\"back\\slash", "\u2028\u2029\u0085",
  "emoji 👩\u200d💻 flags 🇯🇵", "x".repeat(20000)];

test("UTF-8 encode/decode match Node's", () => {
  for (const text of SAMPLES) {
    assert.deepEqual(Buffer.from(utf8Encode(text)), Buffer.from(text, "utf8"));
    assert.equal(utf8Decode(new Uint8Array(Buffer.from(text, "utf8"))), text);
  }
});

test("invalid UTF-8 is rejected like Python's strict decoder", () => {
  for (const bytes of [[0xff], [0xc0, 0x80], [0xe2, 0x82], [0xed, 0xa0, 0x80], [0xf4, 0x90, 0x80, 0x80], [0x80]]) {
    assert.throws(() => utf8Decode(Uint8Array.from(bytes)), UnicodeError);
  }
});

test("digest, json.dumps, splitlines and title_for match the Python plugin", async () => {
  const identities = [
    ["native-v1", "claude", "id", "11111111-2222-3333-4444-555555555555"],
    ["terminal-v1", "/Users/x/.config/herdr/herdr.sock", "w:t1"],
    ["terminal-v1", "herdr-core:37f91f1b", "t7"],
    ["native-v1", "codex", null, "café \"quoted\" \\ \n\t\u0001 日本 📝"],
  ];
  const lines = ["a\nb", "a\n", "\n", "a\r\nb\rc", "x\u2028y\u2029z\u0085w\u000bv\u000cu\u001cq", "trailing\r\n", "", "no break"];
  const panes = [
    { terminal_title_stripped: "  My\tconversation \u0007 title  " },
    { label: "Label only" },
    { agent: "claude" },
    {},
    { terminal_title_stripped: "", label: "", agent: "codex" },
    { terminal_title_stripped: "zero\u200bwidth nbsp 日本" },
  ];
  const calls = [
    ...identities.map((value) => ({ fn: "dumps", args: { value } })),
    ...identities.map((value) => ({ fn: "digest", args: { value: JSON.stringify(value) } })),
    ...lines.map((text) => ({ fn: "splitlines", args: { text } })),
    ...panes.map((pane) => ({ fn: "title_for", args: { pane } })),
  ];
  const results = oracle(calls).map((r) => r.ok);
  let i = 0;
  for (const value of identities) assert.equal(pyDumps(value), results[i++]);
  for (const value of identities) assert.equal(await digest(JSON.stringify(value)), results[i++]);
  for (const text of lines) assert.deepEqual(splitlines(text), results[i++], JSON.stringify(text));
  for (const pane of panes) assert.equal(titleFor(pane), results[i++], JSON.stringify(pane));
});
