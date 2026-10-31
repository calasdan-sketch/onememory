# OneMemory in live Claude Code

How to connect OneMemory to Claude Code (and Claude Desktop, and Cursor) with `onememory setup`, how to move from the old
**claude-bridge** setup without losing a note, how to check that it works in a real session, and what to do when it does not.

## 1. Connect it

You need Node.js 24 or newer (`node -v`). Close Claude Code and Claude Desktop first: Claude Code rewrites its settings file while it
runs.

```text
npx onememory-mcp setup --dry-run     # look first: nothing is written
npx onememory-mcp setup               # then do it (asks you to type y)
```

What it does, in order:

1. Checks your Node version. If it is too old it says so, tells you where to get a newer one, and changes nothing.
2. Looks for Claude Code (`~/.claude.json`; Windows: `C:\Users\<you>\.claude.json`), Claude Desktop
   (Windows `%APPDATA%\Claude\claude_desktop_config.json`, macOS `~/Library/Application Support/Claude/claude_desktop_config.json`,
   Linux `~/.config/Claude/claude_desktop_config.json`) and Cursor (`~/.cursor/mcp.json`). `--project` also adds this folder's `.mcp.json`;
   `--only claude-code` limits it to one app.
3. Shows the plan in words and then **the exact lines it will add or replace** (passwords and tokens in an old entry are shown as `***`).
4. Waits for you to type `y`. (`--yes` skips the question for scripts. A backup is made either way.)
5. Opens your database first, writes a note titled "OneMemory is connected" and reads it back. If the database cannot be opened, no
   configuration file is touched.
6. Saves a copy of each file it changes beside it (`<file>.onememory-backup-<time>`), writes the change atomically (a temporary file, then
   a rename), reads it back, and checks again a moment later.
7. Runs `onememory doctor` and prints what to check in Claude Code.

It changes only the OneMemory entry. Other servers, other settings, comments, number formats, line endings and key order in the file
stay exactly as they were. A file it cannot read safely (broken JSON) stops everything and is not modified. If Claude Code writes the
file while you are reading the plan, the change is added to the **newer** text, not the one it read first.

**The start-of-session hook** (Claude sees your recent notes when a session starts) is only installed if you agree: setup asks
separately, or pass `--hook`. It is merged into the `SessionStart` list in `~/.claude/settings.json` without touching your other hooks.

**Go back:** `onememory setup --undo` restores the files it changed (if Claude Code has changed a file since, only the OneMemory part is
taken out and the rest is kept). Your notes are never touched by undo.

## 2. Coming from claude-bridge

OneMemory used to be called claude-bridge. If Claude Code has a server named `claude-bridge` (or one pointing at a `claude-bridge` folder, or
using `CLAUDE_BRIDGE_*` settings), setup offers to **replace it with `onememory`, in the same place, keeping the same database**:

- `CLAUDE_BRIDGE_DB_PATH` becomes `ONEMEMORY_DB_PATH` with the same value, so your notes stay where they are. (The old names also still
  work on their own: every `CLAUDE_BRIDGE_<NAME>` is read as `ONEMEMORY_<NAME>`, and the new name wins if both are set.)
- Any other setting the old entry had is carried over.
- If the entry named no database, setup looks for `data/state.db` beside the old install and says what it found.
- **The old install folder is never touched or deleted.**
- If both `claude-bridge` and `onememory` entries exist, setup stops and tells you; it does not guess which to keep.

**The database is upgraded the first time it is opened** (the "schema" changes to v15). Before that, a verified safety copy is saved next to
it as `state.db.pre-v16-backup`, and the upgrade does not run if that copy cannot be made. The upgrade is one-way: an older program cannot open
the upgraded file. So **close Claude Code, Claude Desktop and anything else that uses the old database before you run setup**. To roll
back: stop everything, **move** the `.pre-v16-backup` file over `state.db`, **delete `state.db-wal` and `state.db-shm`** next to it (they belong to the upgraded file, and an old program would try to replay them), and run `onememory setup --undo` so the old entry returns. Notes written after the upgrade are not in the safety copy; run `onememory backup --out <folder>` first if you want them. `onememory setup --undo` prints these exact steps when it brings back an old claude-bridge entry whose database was upgraded; it never touches a database itself.
When you are happy, `onememory backup --prune-premigration` removes the safety copy.

## 3. Check that it works in live Claude Code

1. Close every Claude Code window and open Claude Code again (it reads the server list when it starts).
2. Type `/mcp`. You should see **onememory** in the list, connected. (`claude mcp list` in a terminal shows the same, with a health check.)
3. Ask: `Search my memory for "OneMemory is connected"`. Claude should call `state_search` and show the test note.
4. Ask: `Remember that my favourite editor is Neovim`, start a new session and ask `What is my favourite editor?`.
5. If you installed the hook: a new session starts with a short "Recent memory" summary (check with `onememory recall`).
6. Optional: `onememory start`, then open http://localhost:8790 and paste the token from `~/.onememory/.token` (Windows
   `%USERPROFILE%\.onememory\.token`) to see the notes, and the **Review** button for notes an agent wrote.

## 4. Troubleshooting

| What you see | What to do |
|---|---|
| `/mcp` shows onememory as failed | Run the command from the entry yourself: `node "<path to cli.js>" mcp`. It should sit silently waiting (press Ctrl+C). An error there is the real problem. `onememory doctor` checks Node, the database and the token. |
| onememory is not in `/mcp` at all | Claude Code was still running and rewrote its file. Close it completely, run `onememory setup` again, then open Claude Code. In a project, a `.mcp.json` server must be approved the first time Claude Code asks. |
| "needs Node.js 24 or newer" | Install Node 24 from nodejs.org, open a **new** terminal, check `node -v`, run setup again. |
| Windows: a server started through `npx` fails | On native Windows, `npx` is a `.cmd` script, and wrapping it as `cmd /c npx ...` is commonly needed; the Claude Code MCP docs do not say so (checked), so this is not confirmed there. Setup writes that form when it is run through npx; check with `/mcp`. |
| Windows: path with spaces or a short `PROGRA~1` name | Setup stores the path exactly as it found it and Claude Code starts the program without a shell, so spaces are safe. In a hook, the path is quoted. |
| "the database is at schema v15 ... newer" | The database came from a newer OneMemory. Install the newest `onememory-mcp`. |
| An old claude-bridge process still runs | Close Claude Code first. A process of the old program that has the database open will fail once it is upgraded; that is expected. |
| `Stopped: ... keeps being rewritten by another program` | Close Claude Code (and Claude Desktop), then run setup again. |
| Rename refused (`EPERM`/`EBUSY`) on Windows | Antivirus or a file indexer had the file open. Setup retries for about 2 seconds (about 7 on Windows); if it still fails, nothing was changed. |
| The hook shows nothing | `onememory doctor` reports whether the hook is wired and whether it runs. Hooks that fail stay silent by design. Check `claude --version` supports `SessionStart` hooks. |
| `... exists but is completely empty (0 bytes)` | Setup will not replace an empty config file, because a program may have been cut off while saving it. Look for a backup beside it; if you are sure, run setup again with `--force-empty`. |
| I want it all gone | `onememory setup --undo`; delete `~/.onememory` only if you also want to delete your notes. |

## 5. Bringing in what Claude Code already remembers

```text
onememory import --claude --dry-run          # a table: what would be added, per file; secrets are counted, never shown
onememory import --claude                    # asks, then imports
onememory import --claude --project ~/code/atlas,~/code/site     # more project folders
```

Reads (on this computer only) your `~/.claude/CLAUDE.md`, the `CLAUDE.md`, `.claude/CLAUDE.md` and `CLAUDE.local.md` of the current folder
(or `--project`), and Claude Code's auto memory at `~/.claude/projects/<project>/memory/*.md` (layout as documented at
https://code.claude.com/docs/en/memory; `MEMORY.md` there is only an index and is skipped unless you pass `--include-index`). Each file is
cut into notes at its `#` and `##` headings. Notes are tagged `claude-import`, where they came from and `project:<name>`, written by
"import:claude", and carry a stable key in `source`, so running it again adds only what is new. A section whose text changed since is
left alone unless you pass `--update`. Anything the secret linter flags (API keys, tokens, private keys, long random credentials) is
skipped; the count is shown but never the text or the heading. `@file` imports inside a file are not followed. A link that leads
outside the memory folder, or to something that is not a Markdown file, is refused.

## 6. Where secrets can end up, and how to keep them in

- `~/.claude.json` and your other config files may hold tokens (in `env` or headers). Before it changes a file, setup saves a full copy beside
  it (`.onememory-backup-<time>`), and `~/.onememory/setup-history.json` keeps the **old and new OneMemory entry** so `--undo` can take out only
  our change. Both can therefore contain the same secrets as your config. On macOS and Linux setup creates them readable by you only (`0600`;
  the folder `0700`). **On Windows those modes do not apply**: the files get your user folder's normal permissions, so keep them in your own
  profile, do not sync or share them, and delete old backups once you are happy (`setup --undo` needs the newest one).
- The diff setup prints hides the value of secret-looking settings and passwords inside URLs.
- Sealed git sync (`sync --git --encrypt`) names each file with a keyed hash of the note's path, so the repository does not reveal your note
  titles or let anyone confirm a guessed path. It still shows how many notes you have and when they change; use a private repository.
