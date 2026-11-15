// The host operations the notes modules need, backed by the Herdr app.
// Tests supply the same shape backed by Node (tests/node-sys.mjs).

import { exec as hostExec, writeTextFile } from "herdr";
import * as fs from "fs/promises";
import { holdLock } from "./locks.js";

export function appSys() {
  const sys = {
    async exec(command, args = [], options = {}) {
      return await hostExec(command, args, { timeout: options.timeout ?? 30_000 });
    },
    async readBytes(path) {
      try {
        return await fs.readFile(path);
      } catch (error) {
        if (!(await sys.exists(path))) return null;
        throw error;
      }
    },
    /** Atomic; `expected` is the current text, or null for a file that must not exist yet. */
    async writeText(path, text, expected) {
      try {
        await writeTextFile(path, text, expected);
      } catch (error) {
        const message = String((error && error.message) || error);
        const wrapped = new Error(message);
        wrapped.stale = /changed outside|stale/i.test(message);
        throw wrapped;
      }
    },
    async exists(path) {
      try {
        return await fs.exists(path);
      } catch {
        return (await hostExec("/bin/test", ["-e", path])).code === 0;
      }
    },
    async isFile(path) {
      return (await hostExec("/bin/test", ["-f", path])).code === 0;
    },
    async readdir(path) {
      return await fs.readdir(path);
    },
    uuid() {
      return crypto.randomUUID();
    },
    holdLock(path, options) {
      return holdLock(sys, path, options);
    },
  };
  return sys;
}

/** The environment Herdr's own processes see (the TUI plugin reads its own). */
export async function hostEnv(sys) {
  const names = ["HOME", "HERDR_PLUGIN_STATE_DIR", "CLAUDE_CONFIG_DIR", "CODEX_HOME"];
  // \036 (record separator) between values: paths never contain it.
  const script = names.map((name) => `printf '%s\\036' "\${${name}:-}"`).join("; ");
  const result = await sys.exec("/bin/sh", ["-c", script]);
  const values = result.stdout.split("\x1e");
  return Object.fromEntries(names.map((name, i) => [name, values[i] || ""]));
}
