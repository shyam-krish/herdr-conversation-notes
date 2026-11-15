import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentName, sourceFromPane, selectSource, claudeSession, notesPaneIn, sameSession, MOD } from "../lib/host.js";
import { nodeSys, tempDir, SESSION, OTHER } from "./helpers.mjs";

const program = (key, agent = true) => ({ key, name: key, agent, shell: key === "shell" });
const paneOf = (pane, tab, terminal, extra = {}) => ({ pane, tab, terminal, title: `title ${pane}`, cwd: "/repo",
  status: null, app: null, program: program("shell", false), focused: false, zoomed: false, ...extra });

test("agent detection follows the program table and agent reports", () => {
  assert.equal(agentName(paneOf("p1", "t1", "t1a", { program: program("claude") })), "claude");
  assert.equal(agentName(paneOf("p1", "t1", "t1a", { app: "claude-code", status: "idle" })), "claude");
  assert.equal(agentName(paneOf("p1", "t1", "t1a", { program: program("codex") })), "codex");
  assert.equal(agentName(paneOf("p1", "t1", "t1a", { program: program("pi") })), "pi");
  assert.equal(agentName(paneOf("p1", "t1", "t1a", { status: "working", app: "aider" })), "aider");
  assert.equal(agentName(paneOf("p1", "t1", "t1a")), null, "a plain shell");
  assert.equal(agentName({ pane: "p9", tab: "t1", terminal: null, mod: MOD }), null, "a mod pane");
});

test("the source dict carries what the TUI's pane dict did", () => {
  const pane = paneOf("p1", "tab1", "t7", { program: program("claude"), title: "Fix login" });
  const session = { agent: "claude", kind: "id", value: SESSION };
  assert.deepEqual(sourceFromPane(pane, { foreground: { cwd: "/repo/sub", pid: 9 } }, session), {
    pane_id: "p1", terminal_id: "t7", tab_id: "tab1", agent: "claude", agent_session: session,
    terminal_title_stripped: "Fix login", cwd: "/repo", foreground_cwd: "/repo/sub",
  });
  assert.ok(sameSession(session, { ...session }));
  assert.ok(!sameSession(session, null));
});

test("follows the focused agent in its own tab only, else keeps its source", () => {
  const notes = { pane: "pN", tab: "tab1", terminal: null, mod: MOD };
  const a = paneOf("pA", "tab1", "tA", { program: program("claude") });
  const b = paneOf("pB", "tab1", "tB", { program: program("codex") });
  const shell = paneOf("pS", "tab1", "tS");
  const elsewhere = paneOf("pX", "tab2", "tX", { program: program("claude") });
  const all = [notes, a, b, shell, elsewhere];
  assert.equal(selectSource(all, "pB", "tA", "pN"), b, "focus moved to another agent in the tab");
  assert.equal(selectSource(all, "pN", "tA", "pN"), a, "the notes pane itself is focused");
  assert.equal(selectSource(all, "pS", "tA", "pN"), a, "a plain shell doesn't take over");
  assert.equal(selectSource(all, "pX", "tA", "pN"), a, "focus in another tab must not switch");
  assert.equal(selectSource(all, "pX", "gone", "pN"), null);
  assert.equal(notesPaneIn(all, "tab1"), notes);
  assert.equal(notesPaneIn(all, "tab2"), null);
});

test("Claude's session comes from its own sessions/<pid>.json, or a child's", async (t) => {
  const home = tempDir(t);
  const root = join(home, ".claude", "sessions");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "4242.json"), JSON.stringify({ pid: 4242, sessionId: SESSION, cwd: "/repo" }));
  writeFileSync(join(root, "5151.json"), JSON.stringify({ pid: 5151, sessionId: OTHER }));
  writeFileSync(join(root, "6000.json"), JSON.stringify({ pid: 1, sessionId: OTHER }));
  writeFileSync(join(root, "7000.json"), JSON.stringify({ pid: 7000, sessionId: "../../etc" }));
  const sys = nodeSys();
  const env = { HOME: home };
  const none = async () => [];
  assert.deepEqual(await claudeSession(sys, env, 4242, none), { agent: "claude", kind: "id", value: SESSION });
  assert.deepEqual(await claudeSession(sys, env, 100, async () => [5151]), { agent: "claude", kind: "id", value: OTHER });
  assert.equal(await claudeSession(sys, env, 6000, none), null, "a stale file for a reused pid");
  assert.equal(await claudeSession(sys, env, 7000, none), null, "not a session ID");
  assert.equal(await claudeSession(sys, env, 9999, none), null);
  assert.equal(await claudeSession(sys, { HOME: "/nowhere", CLAUDE_CONFIG_DIR: join(home, ".claude") }, 4242, none).then((s) => s.value), SESSION);
});
