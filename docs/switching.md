# Switching to OneMemory from claude-mem, mem0 or basic-memory

`onememory import --from <tool>` copies another memory tool's notes into OneMemory. It works the same way as
`import --claude`:

- It runs only on this computer and sends nothing anywhere. It **reads** the other tool's data and never changes or deletes it.
- Start with `--dry-run`. It shows what would be imported and writes nothing. It does not even create the OneMemory data folder.
- Anything that looks like a password or token is skipped. It is counted, but it is never shown or stored.
- Every note goes through the memory linter. Text that reads like an instruction to an AI is held in `onememory quarantine` for you to approve or reject.
- Each note keeps the other tool's id in its `source` field (`import:claude-mem:obs:42`, `import:mem0:<id>`,
  `import:basic-memory:<permalink>`). If you run the import again, it adds only what is new.
- Notes are written by `import:<tool>` and tagged `imported:<tool>`. `--namespace ns` puts them in a namespace of your choice.

```sh
onememory import --from claude-mem --dry-run
onememory import --from claude-mem            # asks before writing; --yes skips the question
```

Get everything across first and check it. Remove the old tool only after that.

## From claude-mem

**What is read.** claude-mem keeps its data in a SQLite database: `~/.claude-mem/claude-mem.db`, or
`$CLAUDE_MEM_DATA_DIR/claude-mem.db` when that variable is set. If you moved the data folder in `~/.claude-mem/settings.json`,
pass `--path <folder>/claude-mem.db`. OneMemory opens the file read only, so it is safe to run while claude-mem's worker is
still running.

| claude-mem | OneMemory |
|---|---|
| `observations` row | a row of kind `observation`; `obs_type` is its type (bugfix, feature, decision, discovery, change, ...) |
| `title`, `subtitle`, `narrative`, `text`, `facts` | title and body |
| `files_read`, `files_modified` | linked files (shown in file context and the Sessions tab) |
| `concepts` | `obs.concept:` tags |
| `session_summaries` row | a row of kind `summary` (request, investigated, learned, completed, next steps, notes) |
| `project` | `project:<name>` tag |
| `created_at_epoch` | the original creation date |
| `memory_session_id` | session `claude-mem:<id>` |

A model wrote claude-mem's observations and summaries. OneMemory does not have a separate "written by a model" label yet. Use
the `imported:claude-mem` tag and the writer `import:claude-mem` to tell these rows apart from your own notes. Raw
`user_prompts` are not imported. They are your own typed prompts, not memories.

**Export first (optional).** The database file is the export. To keep a copy, stop the worker first (step 1 below). Then copy
`claude-mem.db` somewhere safe.

**Uninstall claude-mem cleanly.** OneMemory does not delete claude-mem's files for you. Do these steps yourself, in this order:

1. **Stop the worker and remove the plugin.** Run `npx claude-mem uninstall`. It stops the worker service on its port, removes
   the plugin and its marketplace and cache folders, and takes its entries out of `~/.claude/settings.json`. You can also remove
   it with `/plugin uninstall claude-mem` in Claude Code. Afterwards, check that no claude-mem worker process (it runs on Bun) is
   still running.
2. **Check `~/.claude/settings.json`.** Make sure `enabledPlugins` has no `claude-mem@thedotmack` entry. The claude-mem installer
   also sets `env.CLAUDE_CODE_DISABLE_AUTO_MEMORY` to `"1"`, which turns off Claude Code's own auto memory. The uninstaller removes
   it. If it is still there and you did not set it yourself, remove it.
3. **Remove the context blocks it wrote into CLAUDE.md files.** claude-mem puts its context between `<claude-mem-context>` and
   `</claude-mem-context>` in CLAUDE.md files, and in rules files for other editors such as `.cursor/rules`, `.windsurf` and
   `.agent/rules/claude-mem-context.md`. Search your projects for `claude-mem-context` and delete each block, from the opening
   tag to the closing tag. Leave the rest of the file as it is.
4. **Remove its data when you are sure.** The uninstaller keeps `~/.claude-mem`. That folder holds `claude-mem.db`, the
   Chroma vector data in `~/.claude-mem/chroma`, `settings.json` and its logs. If you use claude-mem's cloud sync or the
   Docker/Postgres runtime, follow its own teardown steps for those as well. Delete `~/.claude-mem` only after you have
   checked the import.
5. **Set up OneMemory's automatic memory** (`onememory setup`), so new sessions are captured again.

## From mem0

mem0 has no file of its own, so first export your memories as JSON. With the Python client this is
`json.dump(m.get_all(user_id="you"), open("mem0.json", "w"))`. The mem0 platform also offers a memory export. The importer
accepts a plain list of memories, or `{ "results": [...] }` / `{ "memories": [...] }`.

```sh
onememory import --from mem0 --path mem0.json --namespace personal --dry-run
```

Each memory becomes one note. Its `memory` (or `text`) is the body, `created_at` is kept, `metadata.categories` (or
`categories`) become `category:` tags, and the user or agent id becomes a `mem0-user:` tag. Then remove mem0 from your code or
MCP configuration. Stop and delete its vector store (Qdrant, Chroma, ...) the way you set it up.

## From basic-memory

basic-memory's notes are Markdown files, in `~/basic-memory` by default. Point `--path` at another project folder if yours is
somewhere else.

```sh
onememory import --from basic-memory --path ~/basic-memory --dry-run
```

Each `.md` file becomes one note. The note gets the front matter `title` (or the first heading, or the file name), its `tags` (`[a, b]`, `a, b` or a
YAML list), and its `type` as a `bm-type:` tag. The `created` date is kept, or the file date is used. The permalink (or the file path) is the stable id.
The Observations and Relations sections stay in the body as they are written, so `[[links]]` are kept as text. Folders
starting with `.` and symbolic links are skipped.

To remove basic-memory, take its MCP server out of your client's configuration (for example `claude mcp remove basic-memory`)
and uninstall it (`uv tool uninstall basic-memory`). Your Markdown files are yours to keep. basic-memory's index lives in
`~/.basic-memory` and can be deleted.
