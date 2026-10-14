# Conversation Notes — agent instructions

## Scope and purpose

This directory is the live installation and source of the personal Herdr plugin
`shyam.conversation-notes`. Work here for notes features; this is separate from the
Axiom Wallet application. Read `README.md` for current usage and `VALIDATION.md`
for previously recorded checks. Inspect the code before relying on those records.

The user wants personal notes tied to each coding conversation, outside the chat:
- A minimal right-hand panel that can be opened or hidden when needed.
- Free-form, multiline notes with reliable selection, copying, pasting, and undo.
- No short character limit, preset text, or permanently visible instruction forms.
- Whole-word visual wrapping on narrow laptop screens; resizing must not insert
  whitespace into the saved text. A word wider than the entire pane may split.
- Optional AI organization and imports, only when explicitly triggered in the UI.

The old marketplace `agent-notes` plugin was removed at the user's request. Do not
reinstall it or restore its shortcut. Compatibility migration code is intentional.
Use normal chat and Markdown for communication; create Lavish or HTML explainers
only when the user explicitly requests them.

## Structure

| File | Responsibility |
| --- | --- |
| `herdr-plugin.toml` | Plugin identity, version, toggle action, editor pane |
| `notes.py` | CLI entry points: `toggle`, `editor`, and `path` |
| `herdr_host.py` | Herdr socket API, source pane selection, panel lifecycle |
| `editor.py` | prompt_toolkit editor, shortcuts, autosave, async AI operations |
| `notes_store.py` | Note identity, metadata, migration, locks, atomic writes |
| `word_wrap.py` | Display-only wrapping and cursor/selection mapping |
| `transcripts.py` | Correct-session Codex and Claude final-reply readers |
| `organizer.py` | Prompts, Responses API worker, output validation, cancellation |
| `tests/` | Storage, editor, transcript, identity, API, and wrapping checks |
| `vendor/` | Vendored dependencies from `requirements.txt` |

Python 3.10+; dependencies are already vendored. No build step or runtime package
installation is needed. Change dependencies deliberately, not as routine setup.

## Interaction contract

- **prefix+z** (currently Ctrl+B, then z) opens/focuses notes from an agent and
  closes them from the notes pane. The binding lives in `~/.config/herdr/config.toml`.
- **Ctrl+Q** saves and closes; **Ctrl+S** saves. Ordinary Enter inserts a newline.
- **Ctrl+C** copies the selection, or the whole note with no selection. Mouse
  selection copies too. **Ctrl+V** pastes; terminal bracketed paste stays multiline.
- **Ctrl+A** selects all; **Ctrl+Z / Ctrl+Y** undo/redo.
- **Ctrl+O** opens an optional organization instruction; Enter submits, blank uses
  the default, and Esc cancels. A successful result replaces the note.
- **Ctrl+R** opens an optional extraction instruction for the agent's latest
  completed reply. Enter submits and appends the result after a blank line.
- Prompt rows appear only while needed and start empty. Editing, clipboard, and
  undo shortcuts operate on the focused prompt or note buffer.
- Successful AI changes autosave and can be undone in one step.
- The panel follows the most recently focused agent within its tab. Focus in
  another tab must not switch this panel's source.

## Persistence and asynchronous safety

Default state: `~/.local/state/herdr/plugins/shyam.conversation-notes/`.
`HERDR_PLUGIN_STATE_DIR` can override it. Markdown files live in `notes/<hash>.md`
with metadata and locks; `aliases/` tracks identities and `panels/` runtime state.
Use `python3 notes.py path --pane <pane-id>` inside Herdr to locate a note.

Keep native agent/session identity as the note key, not the title or pane position.
Before a native ID is known, isolate by server/terminal identity and migrate when
it becomes available. Preserve aliases through transient missing session metadata.
Notes survive closing panes. Do not delete notes or test against the user's store.

Preserve private file permissions, atomic writes, and the one-writer lock. A second
editor is read-only. External edits must preserve unsaved text in a recovery file,
not overwrite either version silently.

AI operations must never lose edits or write into another conversation:
- Organization discards its pending result if the user has edited the note.
- Import appends to the current buffer, preserving edits made during extraction.
- Recheck source identity before reading and before applying an import.
- Switching sources or closing the panel cancels pending work. Organization and
  import cannot run concurrently. Errors leave the note intact.

## Correct conversation imports

Support local **Codex and Claude**. Prefer Herdr's native session reference and
reject agent/session-type disagreements. Never use terminal screen scraping,
reasoning, tool output, or in-progress commentary as the imported reply.

If Codex lacks a native ID, require a unique exact conversation name and working
folder match in its index. Never infer identity from the most recently updated
thread, fuzzy titles, or an inherited `CODEX_THREAD_ID`. Reject ambiguous matches.
This lookup is a transcript-reader fallback, not a replacement note-storage key.

Respect `CODEX_HOME` and `CLAUDE_CONFIG_DIR`. Codex's read-only state index selects
the history format: paginated sessions use their completed final reply in the
history database; legacy sessions use the exact-session rollout. **Never fall back
from unavailable paginated history to a stale rollout file.** Claude reads the
exact-session project transcript's completed assistant text, excluding sidechains.
Keep bounded reads and explicit oversized-reply errors instead of silent truncation.
Agent history formats change; verify the locally installed format when debugging.

## AI behavior

The current implementation uses the OpenAI Responses API with `gpt-5.6-luna`,
reasoning `none`, and `store: false`. Keep this agreed configuration unless the
user asks to change it or a verified compatibility issue requires an adjustment.

Output must contain only flat `- ` bullets: **no indented sub-bullets**, headings,
or code fences. Preserve distinct facts, names, links, questions, and uncertainty.
Do not invent information or answer questions in the notes. Optional instructions
control organization or extraction without relaxing these preservation rules.

Organization sends the note and its optional instruction. Import sends only the
latest completed reply and extraction instruction, not existing notes or the full
chat. These operations do not send a message to the source agent or change hooks.

Use the inherited `OPENAI_API_KEY`; the worker's login-zsh fallback can obtain it
from the already configured `~/.zprofile`. Never print, persist, or put the key in
arguments, and do not display shell profile contents. Keep note/prompt input on
worker stdin. Preserve cancellation, bounded timeouts, no automatic retries,
redirect protection, and rejection of incomplete or malformed responses.

## Development and verification

Run relevant checks from this directory; the full headless suite is:

```sh
python3 -m unittest discover -s tests -v
```

Use temporary state directories, synthetic transcripts/notes, mocked API calls,
and in-memory clipboard backends for automated checks. For an appropriate live
API check, use synthetic text and keep credentials out of output. Exercise the
actual behavior affected, especially source identity, stale async results, undo,
clipboard focus, and wrapping cursor/selection mapping. Documentation-only edits
need content verification, not a runtime test run. Report only checks actually run.

This is the live installation: preserve unrelated user changes and back up source
before substantial edits. Existing backups live under
`~/.config/herdr/plugin-backups/`. Keep usage documentation and relevant validation
records current when behavior changes; bump the manifest version when appropriate.

Open panels keep their loaded Python code. To pick up normal source changes,
**Ctrl+Q, then prefix+z**; a Herdr reload is unnecessary. Binding/configuration
changes may require a reload. Before live Herdr control, read the installed help
or applicable Herdr instructions, use `HERDR_ENV=1` and explicit pane IDs, and avoid
closing user agent panes, stopping the server, or changing real notes for tests.
