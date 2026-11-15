// Read one completed reply from the exact local native conversation, read-only.
// A port of tui/transcripts.py. SQLite is read through the system `sqlite3`
// command in read-only mode, since the app's script runtime has no driver.

import { utf8Decode, basename, isAbsolute } from "./util.js";

export const MAX_SCAN_BYTES = 64 * 1024 * 1024;
export const MAX_RECORD_BYTES = 2 * 1024 * 1024;
export const MAX_REPLY_CHARS = 120_000;
export const SESSION_ID = /^[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$/;

/** A short user-facing error with no transcript or database contents. */
export class TranscriptError extends Error {}

class SqliteError extends Error {}

/** Limits, overridable by tests (the Python tests patch the module constants). */
export const limits = { MAX_SCAN_BYTES, MAX_RECORD_BYTES, MAX_REPLY_CHARS };

function parseRecord(bytes, start, end) {
  if (end - start > limits.MAX_RECORD_BYTES) return null;
  try {
    const value = JSON.parse(utf8Decode(bytes, start, end));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/** Bounded reverse JSONL scan; tolerate a partial trailing write and large records. */
export function* reverseRecords(bytes) {
  const floor = Math.max(0, bytes.length - limits.MAX_SCAN_BYTES);
  let end = bytes.length;
  for (let i = bytes.length - 1; i >= floor; i--) {
    if (bytes[i] !== 0x0a) continue;
    const record = parseRecord(bytes, i + 1, end);
    if (record) yield record;
    end = i;
  }
  // The text before the first newline is only a whole record at the file's start.
  if (floor === 0) {
    const record = parseRecord(bytes, 0, end);
    if (record) yield record;
  }
}

export function checkedText(text) {
  if (text.length > limits.MAX_REPLY_CHARS) {
    throw new TranscriptError("Last reply is too long to import (120,000 characters).");
  }
  return text.trim();
}

async function realpath(sys, path) {
  try {
    const result = await sys.exec("realpath", [path]);
    if (result.code === 0 && result.stdout.trim()) return result.stdout.replace(/\n$/, "");
  } catch {}
  return path;
}

export async function codexRoot(sys, env) {
  let root = env.CODEX_HOME || `${env.HOME}/.codex`;
  if (root === "~" || root.startsWith("~/")) root = env.HOME + root.slice(1);
  return await realpath(sys, root);
}

export async function codexDatabases(sys, root) {
  let names;
  try {
    names = await sys.readdir(root);
  } catch {
    return [];
  }
  return names
    .filter((name) => /^state_\d+\.sqlite$/.test(name))
    .sort((a, b) => Number(b.match(/\d+/)[0]) - Number(a.match(/\d+/)[0]))
    .map((name) => `${root}/${name}`);
}

function sqlQuote(text) {
  return "'" + String(text).replace(/'/g, "''") + "'";
}

/** Rows as objects; SqliteError when the database can't be opened or queried. */
async function sqliteRows(sys, database, sql, timeoutMs = 1000) {
  let result;
  try {
    result = await sys.exec("sqlite3", ["-readonly", "-json", "-cmd", `.timeout ${timeoutMs}`, database, sql],
      { timeout: timeoutMs + 10_000 });
  } catch {
    throw new SqliteError("sqlite3 could not run");
  }
  if (result.code !== 0) throw new SqliteError("query failed");
  const text = result.stdout.trim();
  if (!text) return [];
  try {
    return JSON.parse(text);
  } catch {
    throw new SqliteError("unreadable sqlite3 output");
  }
}

export async function codexThread(sys, root, sessionId) {
  if (!SESSION_ID.test(sessionId)) return {};
  for (const database of await codexDatabases(sys, root)) {
    try {
      const rows = await sqliteRows(sys, database, `SELECT * FROM threads WHERE id=${sqlQuote(sessionId)}`);
      if (rows.length) return rows[0];
    } catch (error) {
      if (error instanceof SqliteError) continue;
      throw error;
    }
  }
  return {};
}

/** Daemon-backed TUIs can omit Herdr's ID. Accept only one exact name+cwd. */
export async function namedCodexSession(sys, env, source) {
  const display = source.terminal_title_stripped;
  const cwd = source.foreground_cwd || source.cwd;
  if (typeof display !== "string" || typeof cwd !== "string" || !isAbsolute(cwd)) {
    throw new TranscriptError("Codex conversation ID is missing; no exact name/folder match is available.");
  }
  const cwdPath = await realpath(sys, cwd);
  for (const database of await codexDatabases(sys, await codexRoot(sys, env))) {
    let rows;
    try {
      // 'name' is Codex's displayed conversation name; 'title' can be
      // the full first user prompt. Never match snippets or recentness.
      rows = await sqliteRows(sys, database,
        `SELECT id, name, cwd FROM threads WHERE archived=0 AND cwd IN (${sqlQuote(cwd)}, ${sqlQuote(cwdPath)})`);
    } catch (error) {
      if (error instanceof SqliteError) continue;
      throw error;
    }
    const matches = new Set();
    for (const { id, name, cwd: folder } of rows) {
      // Both stored folders the query allows resolve to cwdPath.
      if (typeof name === "string" && name.trim() && typeof id === "string" && SESSION_ID.test(id)
          && (folder === cwd || folder === cwdPath)
          && (display === name || display === `${name} | ${basename(cwdPath)}`)) {
        matches.add(id);
      }
    }
    if (matches.size === 1) return [...matches][0];
    if (matches.size > 1) {
      throw new TranscriptError("Multiple Codex conversations match this name/folder; rename this chat uniquely.");
    }
    // A newer readable index is authoritative, even if it has no match.
    break;
  }
  throw new TranscriptError("Cannot identify this Codex chat by its exact name and folder.");
}

export async function resolveSession(sys, env, source) {
  const session = source.agent_session || {};
  const agent = source.agent || session.agent;
  if (agent !== "codex" && agent !== "claude") {
    throw new TranscriptError("Reply import supports Codex and Claude conversations only.");
  }
  if (session.agent && session.agent !== agent) {
    throw new TranscriptError("The pane's agent changed; reopen its notes and try again.");
  }
  const sessionId = session.value;
  if (session.kind === "id" && typeof sessionId === "string" && SESSION_ID.test(sessionId)) {
    return { agent, kind: "id", value: sessionId };
  }
  if (!Object.keys(session).length && agent === "codex") {
    return { agent, kind: "id", value: await namedCodexSession(sys, env, source) };
  }
  throw new TranscriptError("Herdr has not identified this conversation's session ID yet.");
}

/** Compared with ===: a string form of Python's identity tuple. */
export function sourceIdentity(source) {
  const session = source.agent_session || {};
  if (session.value) {
    return JSON.stringify([source.terminal_id ?? null, source.agent ?? null, session.agent ?? null,
      session.kind ?? null, session.value]);
  }
  return JSON.stringify([source.terminal_id ?? null, source.agent ?? null, source.terminal_title_stripped ?? null,
    source.foreground_cwd || source.cwd || null]);
}

async function findFiles(sys, roots, name) {
  const existing = [];
  for (const root of roots) if (await sys.exists(root)) existing.push(root);
  if (!existing.length) return [];
  const result = await sys.exec("find", [...existing, "-name", name, "-type", "f"], { timeout: 30_000 });
  return result.stdout.split("\n").filter(Boolean);
}

export async function codexPath(sys, root, sessionId) {
  // Codex's thread index also locates archived/resumed threads without guessing
  // from cwd or title. New schema versions can coexist with an older index.
  const path = (await codexThread(sys, root, sessionId)).rollout_path;
  if (typeof path === "string" && path && (await sys.isFile(path))) return path;
  const matches = await findFiles(sys, [`${root}/sessions`, `${root}/archived_sessions`],
    `rollout-*-${sessionId}.jsonl`);
  if (matches.length === 1) return matches[0];
  throw new TranscriptError("Cannot find this Codex conversation's local transcript.");
}

/** Paginated threads keep current replies in SQLite, not the old rollout. */
export async function codexDatabaseReply(sys, root, sessionId) {
  const database = `${root}/thread_history_1.sqlite`;
  let item = null;
  try {
    if (!(await sys.exists(database))) throw new SqliteError("missing");
    const rows = await sqliteRows(sys, database, `
      SELECT i.item_json FROM thread_turns t JOIN thread_items i
        ON i.thread_id=t.thread_id AND i.turn_id=t.turn_id AND i.item_id=t.final_agent_item_id
      WHERE t.thread_id=${sqlQuote(sessionId)} AND t.status='completed' AND i.item_type='agentMessage'
      ORDER BY t.rollout_ordinal DESC LIMIT 1`, 2000);
    if (rows.length) item = JSON.parse(rows[0].item_json);
  } catch (error) {
    if (error instanceof SqliteError || error instanceof SyntaxError || error instanceof TypeError) {
      throw new TranscriptError("Cannot read this Codex chat's current history database.");
    }
    throw error;
  }
  if (item && typeof item === "object" && item.type === "agentMessage"
      && (item.phase === undefined || item.phase === null || item.phase === "final_answer")
      && typeof item.text === "string" && item.text.trim()) {
    return checkedText(item.text);
  }
  throw new TranscriptError("No completed reply found yet. Wait for the agent to finish.");
}

function firstLine(bytes) {
  const limit = Math.min(bytes.length, limits.MAX_RECORD_BYTES + 1);
  for (let i = 0; i < limit; i++) if (bytes[i] === 0x0a) return [0, i + 1];
  return [0, limit];
}

export function codexReply(bytes, sessionId) {
  let matches = false;
  try {
    const [start, end] = firstLine(bytes);
    const header = JSON.parse(utf8Decode(bytes, start, end));
    const meta = header.payload ?? {};
    matches = header.type === "session_meta" && meta.id === sessionId;
  } catch {
    matches = false;
  }
  if (!matches) throw new TranscriptError("Transcript identity does not match this conversation.");
  let completed = false;
  for (const record of reverseRecords(bytes)) {
    const payload = record.payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) continue;
    if (record.type === "event_msg") {
      if (payload.type === "task_complete") {
        const text = payload.last_agent_message;
        if (typeof text === "string" && text.trim()) return checkedText(text);
        completed = true;
      } else if (payload.type === "task_started" || payload.type === "turn_aborted") {
        completed = false;
      }
    } else if (completed && record.type === "response_item" && payload.type === "message"
               && payload.role === "assistant" && payload.phase === "final_answer") {
      // Older completion events may omit their copy of the final message.
      const text = (Array.isArray(payload.content) ? payload.content : [])
        .filter((c) => c && typeof c === "object" && c.type === "output_text" && typeof c.text === "string")
        .map((c) => c.text).join("\n");
      if (text.trim()) return checkedText(text);
    }
  }
  throw new TranscriptError("No completed reply found yet. Wait for the agent to finish.");
}

export function claudeReply(bytes, sessionId) {
  let messageId = null;
  const parts = [];
  for (const record of reverseRecords(bytes)) {
    if (record.sessionId !== sessionId || record.isSidechain) continue;
    const kind = record.type;
    const message = record.message;
    if ((kind !== "assistant" && kind !== "user") || !message || typeof message !== "object" || Array.isArray(message)) {
      continue;
    }
    if (parts.length && (kind !== "assistant" || message.id !== messageId)) break;
    if (kind !== "assistant" || message.role !== "assistant" || record.isApiErrorMessage || record.isSynthetic) continue;
    if (messageId === null) {
      if (message.stop_reason !== "end_turn") continue;
      messageId = message.id === undefined ? null : message.id;
      if (!messageId) continue;
    } else if (message.id !== messageId) {
      break;
    }
    const text = (Array.isArray(message.content) ? message.content : [])
      .filter((c) => c && typeof c === "object" && c.type === "text" && typeof c.text === "string")
      .map((c) => c.text).join("\n");
    if (text.trim()) parts.push(text);
  }
  if (parts.length) return checkedText(parts.reverse().join("\n"));
  throw new TranscriptError("No completed reply found yet. Wait for the agent to finish.");
}

async function readAll(sys, path) {
  const bytes = await sys.readBytes(path);
  if (bytes === null) throw new TranscriptError("Cannot read this conversation's local transcript.");
  return bytes;
}

export async function latestReply(sys, env, source) {
  try {
    const session = await resolveSession(sys, env, source);
    const { agent, value: sessionId } = session;
    if (agent === "codex") {
      const root = await codexRoot(sys, env);
      const mode = (await codexThread(sys, root, sessionId)).history_mode;
      if (mode === "paginated") return await codexDatabaseReply(sys, root, sessionId);
      if (mode !== undefined && mode !== null && mode !== "legacy") {
        throw new TranscriptError("This Codex history format is not supported yet.");
      }
      const path = await codexPath(sys, root, sessionId);
      return codexReply(await readAll(sys, path), sessionId);
    }
    if (agent === "claude") {
      let root = env.CLAUDE_CONFIG_DIR || `${env.HOME}/.claude`;
      if (root === "~" || root.startsWith("~/")) root = env.HOME + root.slice(1);
      // (root / "projects").glob(f"*/{session_id}.jsonl"); the ID was validated above.
      const glob = await sys.exec("/bin/sh", ["-c",
        'for f in "$1"/projects/*/"$2".jsonl; do [ -f "$f" ] && printf "%s\\n" "$f"; done; exit 0',
        "sh", root, sessionId]);
      const matches = glob.stdout.split("\n").filter(Boolean);
      if (matches.length !== 1) throw new TranscriptError("Cannot find this Claude conversation's local transcript.");
      return claudeReply(await readAll(sys, matches[0]), sessionId);
    }
    throw new TranscriptError("Reply import currently supports local Codex and Claude conversations.");
  } catch (error) {
    if (error instanceof TranscriptError) throw error;
    throw new TranscriptError("Cannot read this conversation's local transcript.");
  }
}
