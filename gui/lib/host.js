// The Herdr app's side of tui/herdr_host.py: which pane is an agent, what the
// TUI's `source` dict looks like for it, and which conversation a panel follows.
// The TUI gets native session IDs from Herdr's agent integration; here Claude's
// come from Claude Code's own ~/.claude/sessions/<pid>.json for the terminal's
// foreground process, so a conversation's note is the same file in both.

import { SESSION_ID } from "./transcripts.js";
import { utf8Decode } from "./util.js";

export const MOD = "conversation-notes";

/** The TUI's pane["agent"]: "claude", "codex", another agent's key, or null. */
export function agentName(pane) {
  if (!pane || !pane.terminal) return null;
  const key = pane.program && pane.program.key;
  const app = String(pane.app || "").toLowerCase();
  if (key === "claude" || app.startsWith("claude")) return "claude";
  if (key === "codex" || app.startsWith("codex")) return "codex";
  if ((pane.program && pane.program.agent) || pane.status) {
    return key && key !== "program" && key !== "shell" ? key : pane.app || "agent";
  }
  return null;
}

export function terminalFor(terminalList, address) {
  return terminalList.find((t) => t.address === address) || null;
}

/** The TUI plugin's source pane dict, from the app's pane and core terminal. */
export function sourceFromPane(pane, terminal, session) {
  return {
    pane_id: pane.pane,
    terminal_id: pane.terminal,
    tab_id: pane.tab,
    agent: agentName(pane),
    agent_session: session || null,
    terminal_title_stripped: pane.title || null,
    cwd: pane.cwd || null,
    foreground_cwd: (terminal && terminal.foreground && terminal.foreground.cwd) || null,
  };
}

export function sameSession(a, b) {
  return JSON.stringify(a || null) === JSON.stringify(b || null);
}

/**
 * Claude Code records its live session in <config>/sessions/<pid>.json. Check the
 * terminal's foreground process, then its children (a wrapper shell or launcher).
 */
export async function claudeSession(sys, env, pid, children) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  let root = env.CLAUDE_CONFIG_DIR || `${env.HOME}/.claude`;
  if (root === "~" || root.startsWith("~/")) root = env.HOME + root.slice(1);
  const read = async (candidate) => {
    try {
      const bytes = await sys.readBytes(`${root}/sessions/${candidate}.json`);
      if (!bytes) return null;
      const data = JSON.parse(utf8Decode(bytes));
      if (data && data.pid === candidate && typeof data.sessionId === "string" && SESSION_ID.test(data.sessionId)) {
        return { agent: "claude", kind: "id", value: data.sessionId };
      }
    } catch {}
    return null;
  };
  const direct = await read(pid);
  if (direct) return direct;
  for (const child of await children(pid)) {
    const found = await read(child);
    if (found) return found;
  }
  return null;
}

export async function childPids(sys, pid) {
  try {
    const result = await sys.exec("pgrep", ["-P", String(pid)], { timeout: 5000 });
    return result.stdout.split("\n").map((line) => Number(line.trim())).filter((n) => Number.isInteger(n) && n > 0);
  } catch {
    return [];
  }
}

/** Follow a focused agent in our tab; otherwise retain the original source. */
export function selectSource(paneList, focusedPaneId, sourceTerminal, ownPaneId) {
  const own = paneList.find((p) => p.pane === ownPaneId);
  const focusedPane = paneList.find((p) => p.pane === focusedPaneId);
  if (own && focusedPane && agentName(focusedPane) && focusedPane.tab === own.tab && focusedPane.pane !== own.pane) {
    return focusedPane;
  }
  return paneList.find((p) => p.terminal === sourceTerminal) || null;
}

/** The notes pane of a tab, if one is open. */
export function notesPaneIn(paneList, tab) {
  return paneList.find((p) => p.tab === tab && p.mod === MOD) || null;
}
