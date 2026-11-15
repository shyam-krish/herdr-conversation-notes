// The TUI's transcript tests, run against both implementations on the same files.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, appendFileSync, readFileSync, unlinkSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { latestReply, resolveSession, reverseRecords, limits, sourceIdentity } from "../lib/transcripts.js";
import { nodeSys, oracle, outcome, tempDir, pane, SESSION, OTHER } from "./helpers.mjs";

const event = (kind, extra = {}) => ({ type: "event_msg", payload: { type: kind, ...extra } });
const assistant = (text, phase = "final_answer") => ({ type: "response_item", payload: { type: "message",
  role: "assistant", phase, content: [{ type: "output_text", text }] } });
const claude = (text, { session = SESSION, message_id = "m1", stop = "end_turn", ...extra } = {}) => ({
  type: "assistant", sessionId: session, ...extra,
  message: { id: message_id, role: "assistant", stop_reason: stop, content: [{ type: "text", text }] } });

function sqlite(db, sql) {
  execFileSync("sqlite3", [db, sql]);
}

/** Run latest_reply (or another call) in both implementations and require the same outcome. */
async function same(root, source, { fn = "latest_reply", patch = {}, env = {} } = {}) {
  const fullEnv = { CODEX_HOME: root, CLAUDE_CONFIG_DIR: root, ...env };
  const python = oracle([{ fn, args: { source }, env: fullEnv,
    patch: Object.fromEntries(Object.entries(patch).map(([k, v]) => [`transcripts.${k}`, v])) }])[0];
  const saved = { ...limits };
  Object.assign(limits, patch);
  try {
    const call = fn === "latest_reply" ? () => latestReply(nodeSys(), { HOME: root, ...fullEnv }, source)
      : () => resolveSession(nodeSys(), { HOME: root, ...fullEnv }, source);
    const mine = await outcome(call);
    assert.deepEqual(mine, python, JSON.stringify(source));
    return mine;
  } finally {
    Object.assign(limits, saved);
  }
}

function setup(t) {
  const root = tempDir(t);
  const path = join(root, "sessions/2026/09/30", `rollout-today-${SESSION}.jsonl`);
  mkdirSync(dirname(path), { recursive: true });
  const write = (records, { header = true, to = path } = {}) => {
    if (header) records = [{ type: "session_meta", payload: { id: SESSION } }, ...records];
    writeFileSync(to, records.map((r) => JSON.stringify(r) + "\n").join(""));
  };
  return { root, path, write };
}

test("Codex: the exact latest completed reply while a new turn is busy", async (t) => {
  const { root, path, write } = setup(t);
  write([event("task_complete", { last_agent_message: "older" }),
    event("task_complete", { last_agent_message: "- latest café 📝" }),
    event("task_started"), assistant("progress", "commentary"),
    assistant("not completed yet"), event("turn_aborted")]);
  appendFileSync(path, '{"type": "partially written');
  assert.deepEqual(await same(root, pane(SESSION)), { ok: "- latest café 📝" });
});

test("Codex legacy completion finds the final answer only, never commentary", async (t) => {
  const { root, write } = setup(t);
  write([event("task_started"), assistant("commentary", "commentary"), assistant("the final answer"), event("task_complete")]);
  assert.deepEqual(await same(root, pane(SESSION)), { ok: "the final answer" });
  write([event("task_started"), assistant("progress", "commentary"), event("task_complete")]);
  assert.match((await same(root, pane(SESSION))).message, /No completed reply/);
});

test("Codex read-only index locates an archived thread and verifies identity", async (t) => {
  const { root, write } = setup(t);
  const archived = join(root, "saved-elsewhere.jsonl");
  write([event("task_complete", { last_agent_message: "archived reply" })], { to: archived });
  sqlite(join(root, "state_99.sqlite"),
    `CREATE TABLE threads (id TEXT, rollout_path TEXT); INSERT INTO threads VALUES ('${SESSION}', '${archived}');`);
  assert.deepEqual(await same(root, pane(SESSION)), { ok: "archived reply" });
  writeFileSync(archived, readFileSync(archived, "utf8").replace(SESSION, OTHER));
  assert.match((await same(root, pane(SESSION))).message, /identity/);
});

test("missing, ambiguous, invalid, unsupported and huge replies fail safely", async (t) => {
  const { root, path, write } = setup(t);
  for (const source of [pane(SESSION), pane("../../wrong"), pane(null),
    { ...pane(SESSION), agent_session: { agent: "other", kind: "id", value: SESSION } }]) {
    assert.equal((await same(root, source)).error, "TranscriptError");
  }
  write([event("task_complete", { last_agent_message: "large reply" })]);
  assert.match((await same(root, pane(SESSION), { patch: { MAX_REPLY_CHARS: 5 } })).message, /too long/);
  const duplicate = join(root, "archived_sessions", `rollout-today-${SESSION}.jsonl`);
  mkdirSync(dirname(duplicate));
  writeFileSync(duplicate, readFileSync(path));
  assert.equal((await same(root, pane(SESSION))).error, "TranscriptError");
});

test("reverse reader: chunk boundaries, large records and the scan limit", async (t) => {
  const { path, write } = setup(t);
  const read = (patch = {}) => {
    const saved = { ...limits };
    Object.assign(limits, patch);
    try {
      return [...reverseRecords(new Uint8Array(readFileSync(path)))];
    } finally {
      Object.assign(limits, saved);
    }
  };
  const python = (patch = {}) => oracle([{ fn: "reverse_records", args: { path },
    patch: Object.fromEntries(Object.entries(patch).map(([k, v]) => [`transcripts.${k}`, v])) }])[0].ok;
  const records = Array.from({ length: 20 }, (_, i) => ({ i, text: "café".repeat(3000) }));
  write(records, { header: false });
  assert.deepEqual(read(), [...records].reverse());
  assert.deepEqual(read(), python());
  write([{ i: 1 }, { huge: "x".repeat(300_000) }, { i: 2 }], { header: false });
  assert.deepEqual(read({ MAX_RECORD_BYTES: 100_000 }), [{ i: 2 }, { i: 1 }]);
  assert.deepEqual(read({ MAX_RECORD_BYTES: 100_000 }), python({ MAX_RECORD_BYTES: 100_000 }));
  assert.deepEqual(read({ MAX_SCAN_BYTES: 80 }), [{ i: 2 }]);
  assert.deepEqual(read({ MAX_SCAN_BYTES: 80 }), python({ MAX_SCAN_BYTES: 80 }));
  // Invalid UTF-8 and non-object lines are skipped by both.
  writeFileSync(path, Buffer.concat([Buffer.from('{"i": 1}\n'), Buffer.from([0xff, 0xfe, 0x0a]),
    Buffer.from('[1, 2]\n"text"\n{"i": 2}\r\n\n{"i": 3}')]));
  assert.deepEqual(read(), python());
  assert.deepEqual(read(), [{ i: 3 }, { i: 2 }, { i: 1 }]);
});

test("Claude imports all final text blocks, without tools, thinking or other sessions", async (t) => {
  const { root, write } = setup(t);
  const path = join(root, "projects/project", `${SESSION}.jsonl`);
  mkdirSync(dirname(path), { recursive: true });
  const thought = claude("");
  thought.message.content = [{ type: "thinking", thinking: "private reasoning" }];
  write([claude("old", { message_id: "old" }), thought, claude("First item"), claude("Second item"),
    { type: "system", sessionId: SESSION }, claude("other", { session: OTHER }),
    claude("sidechain", { isSidechain: true }), claude("progress", { message_id: "new", stop: "tool_use" })],
  { header: false, to: path });
  const source = pane(SESSION);
  source.agent = "claude";
  source.agent_session.agent = "claude";
  assert.deepEqual(await same(root, source), { ok: "First item\nSecond item" });
  // Synthetic, API-error, empty-id and user-interrupted turns.
  write([claude("kept", { message_id: "a" }), { type: "user", sessionId: SESSION, message: { role: "user", content: "hi" } },
    claude("api error", { message_id: "b", isApiErrorMessage: true }), claude("synthetic", { message_id: "c", isSynthetic: true }),
    claude("no id", { message_id: "" })], { header: false, to: path });
  await same(root, source);
  // Two transcripts with this ID is ambiguous.
  const twin = join(root, "projects/other", `${SESSION}.jsonl`);
  mkdirSync(dirname(twin), { recursive: true });
  writeFileSync(twin, readFileSync(path));
  assert.equal((await same(root, source)).error, "TranscriptError");
});

// ---- Codex identity (tests/test_codex_identity.py) ---------------------------

function codexSetup(t) {
  const root = tempDir(t);
  const cwd = join(root, "my-project");
  const source = { ...pane(null), cwd, foreground_cwd: cwd, terminal_title_stripped: "Research notes | my-project" };
  const state = join(root, "state_5.sqlite");
  const history = join(root, "thread_history_1.sqlite");
  sqlite(state, `CREATE TABLE threads(id TEXT, name TEXT, cwd TEXT, archived INT, history_mode TEXT, rollout_path TEXT);
    INSERT INTO threads VALUES('${SESSION}', 'Research notes', '${cwd}', 0, 'paginated', '${join(root, "old.jsonl")}');`);
  sqlite(history, `CREATE TABLE thread_turns(thread_id TEXT, turn_id TEXT, rollout_ordinal INT, status TEXT, final_agent_item_id TEXT);
    CREATE TABLE thread_items(thread_id TEXT, turn_id TEXT, item_id TEXT, item_type TEXT, item_json TEXT);`);
  const turn = (thread, n, text, status = "completed", phase = "final_answer") => {
    const json = JSON.stringify({ type: "agentMessage", phase, text }).replace(/'/g, "''");
    sqlite(history, `INSERT INTO thread_turns VALUES('${thread}', 'turn${n}', ${n}, '${status}', 'item${n}');
      INSERT INTO thread_items VALUES('${thread}', 'turn${n}', 'item${n}', 'agentMessage', '${json}');`);
  };
  turn(SESSION, 1, "Old reply");
  turn(SESSION, 2, "Current completed reply");
  turn(SESSION, 3, "Still working", "inProgress", "commentary");
  turn(OTHER, 9, "Another chat's newer reply");
  writeFileSync(join(root, "old.jsonl"), JSON.stringify({ type: "session_meta", payload: { id: SESSION } }) + "\n" +
    JSON.stringify({ type: "event_msg", payload: { type: "task_complete", last_agent_message: "STALE ROLLOUT" } }) + "\n");
  return { root, cwd, source, state, history };
}

test("Codex without an ID: a unique exact name and folder, then the current database", async (t) => {
  const { root, source } = codexSetup(t);
  assert.equal((await same(root, source, { fn: "resolve_session" })).ok.value, SESSION);
  assert.deepEqual(await same(root, source), { ok: "Current completed reply" });
  assert.deepEqual(await same(root, pane(SESSION), { env: { CODEX_THREAD_ID: OTHER } }), { ok: "Current completed reply" });
});

test("Codex name lookup: duplicates, other folders and partial names never match", async (t) => {
  const { root, cwd, source, state } = codexSetup(t);
  for (const display of ["Research", "Research notes | other-project", "Codex", "research notes | my-project"]) {
    assert.equal((await same(root, { ...source, terminal_title_stripped: display }, { fn: "resolve_session" })).error,
      "TranscriptError");
  }
  sqlite(state, `INSERT INTO threads VALUES('${OTHER}', 'Research notes', '/different/my-project', 0, 'paginated', NULL)`);
  assert.equal((await same(root, source, { fn: "resolve_session" })).ok.value, SESSION);
  await same(root, { ...source, cwd: "/missing/my-project", foreground_cwd: "/missing/my-project" }, { fn: "resolve_session" });
  sqlite(state, `INSERT INTO threads VALUES('${OTHER}', 'Research notes', '${cwd}', 0, 'paginated', NULL)`);
  assert.match((await same(root, source)).message, /Multiple Codex/);
});

test("Claude never uses the Codex name lookup; agent changes are rejected", async (t) => {
  const { root, source } = codexSetup(t);
  assert.match((await same(root, { ...source, agent: "claude" }, { fn: "resolve_session" })).message, /session ID/);
  assert.match((await same(root, { ...pane(SESSION), agent: "claude" }, { fn: "resolve_session" })).message, /agent changed/);
});

test("missing paginated history never falls back to a stale rollout", async (t) => {
  const { root, history } = codexSetup(t);
  unlinkSync(history);
  assert.match((await same(root, pane(SESSION))).message, /current history/);
  assert.equal(existsSync(history), false);
});

test("an incomplete or invalid final turn imports nothing", async (t) => {
  const { root, history } = codexSetup(t);
  sqlite(history, `DELETE FROM thread_turns WHERE thread_id='${SESSION}' AND status='completed'`);
  assert.match((await same(root, pane(SESSION))).message, /No completed reply/);
});

test("source identity equality matches the Python tuples", () => {
  const a = pane(SESSION);
  const variants = [a, { ...a }, { ...a, pane_id: "w:p9" }, { ...a, terminal_id: "other" },
    { ...a, agent_session: { ...a.agent_session, value: OTHER } }, pane(null),
    { ...pane(null), cwd: "/x" }, { ...pane(null), foreground_cwd: "/y", cwd: "/x" }];
  const calls = [];
  for (const x of variants) for (const y of variants) calls.push({ fn: "source_identity_equal", args: { a: x, b: y } });
  const python = oracle(calls).map((r) => r.ok);
  let i = 0;
  for (const x of variants) for (const y of variants) assert.equal(sourceIdentity(x) === sourceIdentity(y), python[i++]);
});
