# Herdr Conversation Notes

A small personal Herdr plugin: a real multiline editor beside each conversation.

## Use

- **Ctrl+B, z** from an agent opens its notes in a right split. If already open,
  the shortcut focuses the panel. From the notes panel, the shortcut closes it.
- Start typing immediately. **Enter inserts a new line.** Words wrap to the next
  display row when they do not fit. Resizing the pane reflows the display without
  adding line breaks or spaces to the saved note. Only words or URLs longer than
  the entire pane width need to split across rows.
- Notes autosave after a short pause and at least every two seconds while typing.
- Drag or double-click text to select and copy it. **Ctrl+C** copies the selection,
  or the whole note when nothing is selected. Clipboard shortcuts use macOS
  `pbcopy`/`pbpaste`; Linux uses Wayland/X11 when available, otherwise OSC 52 copy.
- **Cmd+V** uses your terminal's normal paste. **Ctrl+V** pastes from the local
  system clipboard. Multiline bracketed paste is inserted as text, not submitted.
- **Ctrl+A** selects all. **Ctrl+Z / Ctrl+Y** undo / redo.
- **Ctrl+O** opens an optional organization prompt. Type an instruction such as
  `Put action items first, then group the remaining thoughts by topic`, or leave
  it blank for the default. **Enter** organizes the note into flat `- ` bullets
  using GPT-5.6 Luna; **Esc** cancels. **Ctrl+Z** afterward restores the original
  in one undo step.
- **Ctrl+R** opens a small import prompt. Type an optional instruction, such as
  `extract the list of models and their tradeoffs`, then **Enter** to extract from
  this agent's last completed reply and append to the note. **Esc** cancels the
  prompt. **Ctrl+Z** immediately afterward undoes the append in one step.
- **Ctrl+S** saves immediately. **Ctrl+Q** saves and closes the panel.
- Click your agent to continue chatting while notes stay visible. In a tab with
  several agents, the panel follows the most recently focused agent. A different
  native conversation in the same pane gets a different note.

Notes are ordinary local Markdown files with no 80-character limit; they survive
closing agent panes. AI requests run only when you submit a Ctrl+O organization
or Ctrl+R import with Enter.

## Import an agent reply

Ctrl+R adds a single input row only while you are entering the instruction. Leave
it blank to extract useful takeaways, lists, decisions, and open questions. Enter
reads the latest **completed** reply at that moment; if the agent is still working,
this uses its previous completed reply. Only that reply and your instruction are
sent to Luna. Existing notes and the rest of the conversation are not included.

The extracted result uses flat `- ` bullets without indented sub-bullets. It is
appended after a blank line and autosaved, preserving existing text and any edits
made while the request runs. The input row disappears on submission or cancel.
Copy/paste and undo in the prompt apply to the prompt, not to your note. Closing
the panel or switching conversations cancels a pending import; organizer/import
requests cannot run simultaneously. A failed request or no matching content leaves
the note intact. Ctrl+Z reverses the append while the editor remains open.

Import supports **local Codex and Claude conversations**. Herdr's native session
ID is preferred. Newer Codex daemon-backed terminals sometimes omit that ID; in
that case, the plugin requires a unique exact match of the displayed conversation
name and working directory in Codex's index. It does not use fuzzy titles, the
most recently updated conversation, or inherited `CODEX_THREAD_ID`. Duplicate
names in the same folder produce an error; give the conversation a unique name.
The source pane is checked again before reading and before appending, so changing
conversations during an import cancels it.

Codex's read-only thread index selects the current history format. Paginated
conversations use the latest completed turn's final reply in the history database;
legacy conversations use their exact-ID rollout file. A paginated conversation
never falls back to its stale old rollout. Claude uses Herdr's reported Claude
session ID and the exact-ID project transcript. Agent/session-type disagreements
are rejected. `CODEX_HOME` and `CLAUDE_CONFIG_DIR` are respected. These reads do not
change agent hooks or send a prompt to the source agent.
Remote sessions or agents without an accessible supported transcript show an
error. There is no terminal-screen fallback that could import truncated text.

Only completed final replies are eligible: tool output, reasoning, and progress
messages are excluded. The reader scans at most the last 64 MiB of the transcript
and rejects replies over 120,000 characters instead of silently truncating them.
Local history formats can change with agent upgrades; `transcripts.py` contains
the small adapters and identity checks. This was verified against both locally
installed agents on 2026-09-30.

## Organize notes

Ctrl+O opens a single input row for an optional instruction about grouping,
ordering, emphasis, or wording. Enter submits it; a blank instruction preserves
the default organization. Esc cancels without calling OpenAI. The instruction is
separate from the note and is cleared each time the prompt opens. Copy/paste and
undo in this row operate on the instruction. Switching conversations dismisses it.

Submitting sends the current note and optional instruction to OpenAI's Responses
API with `gpt-5.6-luna`,
reasoning `none`, and `store: false`. It uses the exported `OPENAI_API_KEY`;
if Herdr did not inherit it, the worker starts through a login zsh to read
`~/.zprofile`. The key is never saved in the plugin or put in command arguments.

The prompt requests only flat `- ` bullets, preserving distinct details, names,
links, questions, and uncertainty. It permits light wording cleanup and merging
repetition. It forbids indentation, sub-bullets, invented information, and answering
questions in the note. Custom instructions keep these preservation and flat-list
rules, including no indented sub-bullets. See `organizer.py` for the complete prompt.

The footer shows **Organizing…**, then the result replaces the note and autosaves.
Typing while the request runs keeps your edits and discards the pending result.
Switching conversations or closing the editor cancels the worker. Empty notes,
read-only notes, failed requests, incomplete output, and invalid bullet formatting
do not replace your text. Requests time out after 30 seconds and do not retry
automatically. Ctrl+Z reverses the rewrite while the editor remains open.

## Storage

`~/.local/state/herdr/plugins/shyam.conversation-notes/notes/<hash>.md`

The hash identifies the native agent kind + session kind + session ID/path. It
does not depend on the workspace title or pane position. Agents without a reported
native session use an isolated server/terminal identity; their notes migrate when
a native session reference first becomes available. Resuming an unknown agent in
a brand-new terminal cannot be matched automatically without a native session ID.

Matching saved notes from `agent-notes` are copied on first open. The originals are
never removed. Each Markdown file has companion metadata describing its source.
Use `python3 notes.py path --pane <pane-id>` inside Herdr to locate one.

Writes use a private temporary file, fsync, and atomic rename. Only one editor can
write a note at a time; another view is read-only. Unexpected external edits create
a `.recovered-*.md` copy of unsaved text instead of overwriting the other version.

For remote terminals without a local clipboard backend, normal terminal paste is
recommended. OSC 52 copy depends on the outer terminal allowing clipboard writes.

## Development

Python 3.10+ (tested on macOS Python 3.14) and Herdr 0.9+. Dependencies are vendored
locally from `requirements.txt`; there are no runtime downloads. The organizer and
importer use Python's standard library and call `https://api.openai.com/v1/responses`
on demand. Ordinary editing uses Herdr's local socket and the local filesystem.
The native clipboard tools run on demand.

```sh
python3 -m pip install --target vendor -r requirements.txt
python3 -m unittest discover -s tests -v
herdr plugin link /absolute/path/to/herdr-conversation-notes
```

Bind your preferred key to the `shyam.conversation-notes.toggle` plugin action.
The personal install uses `prefix+z`. Reinstalling the old marketplace plugin has
no effect on this separate plugin's source or notes.
