# Herdr Conversation Notes

Private notes tied to each coding conversation, in a panel beside it, with
optional AI organization and reply imports.

| Folder | For | Install |
| --- | --- | --- |
| [`tui/`](tui/README.md) | Herdr in the terminal (Python plugin) | `herdr plugin link /path/to/herdr-conversation-notes/tui` |
| [`gui/`](gui/README.md) | The Herdr desktop app (JavaScript mod) | symlink `gui/` to `~/.config/herdr-app/mods/conversation-notes` |

Both use the same note store (`~/.local/state/herdr/plugins/shyam.conversation-notes/`),
the same note keys and the same one-writer lock, so a conversation's notes are the
same in each, and only one editor can write a note at a time.
