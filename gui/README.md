# Conversation Notes (Herdr app)

The Herdr app (GUI) version of Conversation Notes: a private multiline note beside
each coding conversation. It is a port of the TUI plugin in [`../tui`](../tui/README.md)
and uses **the same note store** (`~/.local/state/herdr/plugins/shyam.conversation-notes/`),
the same note keys and the same one-writer lock, so a Claude conversation's notes
are the same file in both, and only one editor writes a note at a time.

## Install

The mod folder is this directory, linked into the app's mods:

```sh
ln -s /absolute/path/to/herdr-conversation-notes/gui ~/.config/herdr-app/mods/conversation-notes
```

and a shortcut in `~/.config/herdr-app/keys.json` (`global` section):

```json
"cmd-shift-n": "mod.open:conversation-notes"
```

Saving any file here reloads the mod in the running app.

## Use

- **Cmd+Shift+N** from an agent opens its notes in a split to the right. If the tab
  already has notes open, it focuses them (and switches them to that agent); from
  the notes pane it saves and closes them.
- The editing shortcuts are the TUI's: **Ctrl+S** save, **Ctrl+Q** save and close,
  **Ctrl+C** copy the selection (or the whole note with nothing selected),
  **Ctrl+V** paste, **Ctrl+A** select all, **Ctrl+Z / Ctrl+Y** undo / redo.
  Selecting with the mouse copies too. The usual Cmd shortcuts also work.
- **Ctrl+O** organizes the note into flat `- ` bullets with GPT-5.6 Luna, with an
  optional instruction; **Ctrl+R** extracts from the agent's last completed reply
  and appends it. **Enter** submits, **Esc** cancels, **Ctrl+Z** undoes the change
  in one step. These are the TUI's prompts, model, settings and messages.
- Notes autosave after a short pause and at least every two seconds while typing.
- The panel follows the most recently focused agent in its tab; focus in another
  tab never switches it. Lines wrap at word boundaries without changing the note.

## How it matches conversations

The TUI gets each agent's session ID from Herdr's agent integration. The app's
core doesn't record one, so for **Claude** this mod reads Claude Code's own
`~/.claude/sessions/<pid>.json` for the terminal's foreground process (or its
child). That ID gives the same note key as the TUI. Respects `CLAUDE_CONFIG_DIR`.

**Codex** has no such file, so a Codex conversation's note is keyed to its
terminal here (the TUI's fallback before a session ID is known), and its reply
import uses the TUI's exact name-and-folder lookup in Codex's index. Codex notes
are therefore not shared with the TUI.

## Differences from the TUI, and why

- **Locking:** the app's scripts can't hold a file lock, so a small `lockf`
  (Linux: `flock`) helper holds the same flock the TUI uses while the note is
  open, waiting on a private named pipe. It exits when the note closes, and by
  itself after two minutes (renewed while the note is open) if the app dies.
- **OpenAI requests:** a `curl` worker started through a login `zsh`, like the
  TUI's Python worker. It reloads `OPENAI_API_KEY` from `~/.zprofile` on every
  request, gets the key as a header on stdin (never in its arguments), follows no
  redirects, and is limited to 20 s and 2 MB. The request body is written to a
  private file in the store's `requests/` folder, which the worker deletes.
- **SQLite:** Codex's indexes are read with the system `sqlite3 -readonly`.
- **Pane width:** the app has no command to resize a pane, so the notes split
  opens at half width instead of a third.
- **Wrapping and selection** are the app's native text area, so there is no
  `word_wrap.py` equivalent. Ctrl+C detects a selection by whether the text
  area's own copy changed the clipboard.

## Development

The logic lives in `lib/`, which takes the host's file and process operations as a
`sys` argument (`lib/sys.js` for the app, `tests/helpers.mjs` for Node). The tests
compare it against the TUI's Python functions on the same inputs
(`tests/py_oracle.py` calls them):

```sh
node --test --test-timeout=60000 tests/*.test.mjs
herdr-app check ~/.config/herdr-app/mods/conversation-notes
```

A notes pane opened with `props.state_dir` uses that folder as its store, for
trying the panel without touching real notes.
