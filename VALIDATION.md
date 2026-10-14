# Validation

## Version 0.3.2 — 2026-10-01

- Ctrl+O now opens an optional instruction row. Enter submits, a blank Enter
  retains the original default behavior, and Esc cancels without an API request.
  Custom organization instructions are sent separately from the note and retain
  the existing flat-bullet and detail-preservation rules.
- 73 automated tests passed. New checks cover custom/blank instructions through
  the request and worker, actual Ctrl+O/Enter/Escape input, prompt clipboard focus,
  repeated shortcuts, conversation switching, mutually exclusive import/organize
  prompts, one-step undo, and rendering at a 46-column laptop width.
- A real Luna request with synthetic notes followed the requested software-first,
  personal-second ordering, preserved all four tasks in flat bullets, and
  autosaved. Ctrl+Z restored the exact original note. No real notes were sent.
- Close and reopen notes to load this update; no Herdr reload is needed.

## Version 0.3.1 — 2026-09-30

- Fixed a real failure in a resumed Codex daemon-backed terminal: Herdr recognized
  Codex but did not report its session ID. A unique exact displayed-name + working-
  directory lookup now resolves that case. Native session IDs remain preferred;
  ambiguous names, partial names, wrong folders, and Codex/Claude type mismatches
  fail instead of selecting another conversation.
- Fixed a second issue revealed by that investigation: the current Codex thread
  had migrated to paginated SQLite history, leaving the old JSONL rollout stale.
  Imports now read the completed turn's final agent item from the current store.
  Unavailable paginated history never falls back to stale JSONL.
- 65 automated tests passed, including the real missing-ID shape, current versus
  stale history, in-progress turns, multiple conversations, inherited IDs, source
  changes before/during import, and all existing editing/clipboard/wrapping tests.
- Verified Ctrl+R using the actual affected Codex pane and a live Claude pane.
  Both resolved the correct native conversation and fetched its completed reply;
  Codex's reply was checked against the last answer about the new Ctrl+R feature.
  The checks used temporary note stores and a mocked extractor, so actual notes
  were unchanged and no real conversation content was sent to OpenAI.
- Close and reopen notes to load this patch; no Herdr reload is needed.

## Version 0.3.0 — 2026-09-30

- 55 automated tests passed. New coverage includes exact conversation identity,
  Codex thread-index and file fallback, completed-turn filtering while an agent is
  working, Claude multipart replies, malformed/large records, bounded scanning,
  Ctrl+R/Enter/Escape, optional prompts, append/autosave, one-step undo, concurrent
  edits, clipboard focus, conversation switching/cancellation, read-only notes,
  external edits, save failures, API failures, and flat-bullet validation.
- Read-only checks found the completed replies in the current local Codex and
  Claude transcripts. Those real replies were neither printed nor sent to OpenAI.
- A real end-to-end check used only a temporary synthetic transcript and note.
  Ctrl+R with an extraction instruction called GPT-5.6 Luna, selected two requested
  list items, retained their link/uncertainty, omitted unrelated surrounding text,
  appended and autosaved in 2.86 seconds. Ctrl+Z restored the original exactly.
- The same check exercised the actual terminal renderer at 46 columns: the single
  prompt row and Enter/Escape hints fit. Existing word-wrap tests remain passing.
- Existing notes, agent hooks, and the prefix+z binding are unchanged. Close and
  reopen existing notes panels to load this version; no Herdr reload is needed.

## Version 0.2.1 — 2026-09-24

- 38 automated tests passed. Six new tests exercise the actual terminal renderer
  at narrow and wide widths: whole-word wrapping, exact-width boundaries without
  empty rows, resizing, long-paragraph scrolling/cursor visibility, mouse
  selection/copy and editing across wraps, wide/combining Unicode, and overlong
  words. Copying and saving retain the original text and whitespace.
- Wrapping is a display processor using the text width after scrollbar margins.
  It does not edit stored notes or introduce hard line breaks. The existing
  persistence, clipboard, and organizer tests continue to pass.

## Version 0.2.0 — 2026-09-21

- 32 automated tests passed, including Ctrl+O through terminal key input,
  one-step Ctrl+Z restoration, autosave, duplicate shortcut suppression, edits
  during requests, conversation switching, read-only/empty notes, failed saves,
  incomplete or malformed responses, flat-bullet enforcement, and worker
  cancellation/timeout cleanup.
- A real request with the inherited OPENAI_API_KEY and `gpt-5.6-luna` organized
  a synthetic note in 3.01 seconds. Its URL, name, numeric references, Unicode
  text, and uncertainty were retained. Only synthetic text was used in testing.
- The installed plugin also passed a live background Herdr pane check: Ctrl+O
  loaded the key through the login-shell fallback, called Luna, and autosaved
  flat bullets; Ctrl+Z restored the original in one step; closing and reopening
  preserved it. The temporary tab and synthetic note files were removed.
- Implementation references: [Responses text generation](https://developers.openai.com/api/docs/guides/text)
  and [GPT-5.6 Luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna).

## Version 0.1.0

Tested on 2026-09-18 with Herdr 0.9.0 and Python 3.14 on macOS.

- 17 automated tests passed: multiline Unicode storage, long notes, conversation
  isolation and resumption, delayed identity, old-note migration, concurrent
  editors, external-edit recovery, failed saves, mouse selection/copy, actual
  terminal key input, multiline paste, autosave, and panel lifecycle.
- The installed plugin was exercised in a temporary background Herdr tab using
  real plugin pane and terminal APIs. The full toggle handler opened and sized
  the pane; multiline Unicode paste autosaved verbatim; closing and reopening
  restored the note. The test tab and its notes were removed afterward, and the
  user's focused pane was unchanged.
- Conversation identity transitions were tested at the editor/storage level.
  Herdr's live shell test pane did not expose a simulated native agent identity,
  so the live test supplied synthetic identity only to the plugin.
- Mouse selection was tested with terminal SGR mouse events and an in-memory
  clipboard. The user's real clipboard was not overwritten during testing.
- Herdr accepted the shortcut configuration and applied its reload without
  diagnostics. One existing note was imported and the old store was archived.

This uses Herdr's public plugin and socket interfaces. Notes are local. Ctrl+R
reads the exact local native transcript on demand and sends its last completed
reply plus the extraction instruction to OpenAI. The plugin never sends a prompt
to the source agent. Submitting Ctrl+O sends the note and optional organization
instruction to OpenAI.
