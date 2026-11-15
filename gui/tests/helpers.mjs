// Node-backed `sys` (the same shape as lib/sys.js) and the Python oracle runner.
import { promises as fs, existsSync, statSync, mkdtempSync, rmSync } from "node:fs";
import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { holdLock } from "../lib/locks.js";

const HERE = dirname(fileURLToPath(import.meta.url));

export function nodeSys() {
  const sys = {
    exec(command, args = [], { timeout = 30_000 } = {}) {
      return new Promise((resolve, reject) => {
        execFile(command, args, { timeout, maxBuffer: 8 * 1024 * 1024, encoding: "utf8" }, (error, stdout, stderr) => {
          if (error && typeof error.code !== "number") {
            reject(new Error(error.killed ? "command timed out" : String(error.message)));
            return;
          }
          resolve({ code: error ? error.code : 0, stdout, stderr });
        });
      });
    },
    async readBytes(path) {
      try {
        return new Uint8Array(await fs.readFile(path));
      } catch (error) {
        if (error.code === "ENOENT") return null;
        throw error;
      }
    },
    // Mirrors herdr.writeTextFile: replace only if the file still holds `expected`.
    async writeText(path, text, expected) {
      let current = null;
      try {
        current = await fs.readFile(path, "utf8");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      if (current !== expected) {
        const error = new Error("The file changed outside Herdr. Reload before saving; your draft is still here.");
        error.stale = true;
        throw error;
      }
      const temp = `${path}.tmp-${randomUUID()}`;
      await fs.writeFile(temp, text);
      await fs.rename(temp, path);
    },
    async exists(path) {
      return existsSync(path);
    },
    async isFile(path) {
      try {
        return statSync(path).isFile();
      } catch {
        return false;
      }
    },
    async readdir(path) {
      return await fs.readdir(path);
    },
    uuid: () => randomUUID(),
    holdLock(path, options) {
      return holdLock(sys, path, options);
    },
  };
  return sys;
}

/** Call the TUI plugin's Python functions; returns [{ok} | {error, message}]. */
export function oracle(calls) {
  const out = execFileSync("python3", ["-I", join(HERE, "py_oracle.py")], {
    input: JSON.stringify(calls), encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(out);
}

export function oracleOne(fn, args, extra = {}) {
  return oracle([{ fn, args, ...extra }])[0];
}

/** Run `fn` and report it the way the oracle does. */
export async function outcome(fn) {
  try {
    return { ok: await fn() };
  } catch (error) {
    return { error: error.constructor.name, message: error.message };
  }
}

export function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "notes-gui-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export const SESSION = "11111111-2222-3333-4444-555555555555";
export const OTHER = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

/** The Python tests' pane() helper. */
export function pane(session = "conversation-a", terminal = "term-a", paneId = "w:p1", tab = "w:t1") {
  const result = { pane_id: paneId, terminal_id: terminal, tab_id: tab, workspace_id: "w", agent: "codex",
    terminal_title_stripped: "My conversation" };
  if (session) result.agent_session = { agent: "codex", kind: "id", value: session };
  return result;
}
