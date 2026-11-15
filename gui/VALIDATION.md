# Validation

## Version 0.3.3 (first app port) — 2026-11-13

- 40 headless tests passed (`node --test tests/*.test.mjs`, Node 22, macOS). Most
  compare this port with the TUI plugin's own Python functions on the same input:
  note keys and records, `json.dumps`/`sha256`/`splitlines`/`title_for`, flat-bullet
  validation, response parsing, worker input checks and request bodies, every
  transcript test from `tui/tests/test_import.py` and `test_codex_identity.py`
  (Codex rollouts, paginated history, name/folder lookup, Claude replies,
  limits), and source identity.
- The TUI's storage tests were ported: unicode reopen with 0600 files, separate
  conversations, resume in another pane, delayed native identity, missing session,
  legacy migration, read-only second editor, recovery on external edits.
- Interop: a note written here is read by the Python plugin, and each side's lock
  makes the other's editor read only, including a live Python editor process.
  Lock helpers release immediately on close, end by themselves when their pipe is
  deleted or their time runs out, and keep the lock file (`lockf -k`).
- The OpenAI worker ran against a stand-in `curl` with temporary profiles:
  profile key, rotation between requests, inherited fallback, missing key, the
  no-zsh path; the key never appeared in curl's arguments and request files
  were removed. No real API request was made.
- `herdr-app check` passed in Herdr 0.1.15 with herdr-core 0.1.21.
- **Not yet run in the app window:** rendering, key handling (Ctrl shortcuts,
  Ctrl+C selection detection, mouse-selection copy), undo of AI changes, following
  agents, the read-only view, and the Cmd+Shift+N toggle. The window was not
  visible for a live test; see the manual checklist in the handoff.
