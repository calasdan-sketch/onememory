# Footprint: everything OneMemory writes, and how to remove it

OneMemory keeps to two places on its own: **its data folder** and **the config files of the apps you connect with
`onememory setup`**. It never writes into your project folders unless you ask for it with a command that names the
folder (`setup --project`, `export --dir`, `export --out`, `backup --out`, `sync --git`). It writes no `CLAUDE.md` or
`AGENTS.md` anywhere, runs no background service you did not start, and every queue it keeps has a size or retry limit.

To take it all out: `onememory uninstall` (configs) or `onememory uninstall --purge` (configs and data, after a final
backup). Both show the plan first and change nothing until you type `y`; `--dry-run` only shows it.

## The data folder

`ONEMEMORY_HOME`, else `~/.onememory` (in a git checkout of OneMemory that already has `./data/state.db`, that `data`
folder). `onememory doctor` prints which one, and its size.

| File | Written when | Remove |
|---|---|---|
| `state.db`, `state.db-wal`, `state.db-shm` | every note, task, capture event (`ONEMEMORY_DB_PATH` moves the database elsewhere) | `uninstall --purge` |
| `state.db.pre-v<N>-backup[-<time>]` | once per schema upgrade: the database as it was before | `backup --prune-premigration` |
| `.token`, `tokens.json` | first start (the API token) / by you | `uninstall --purge` |
| `.key`, `.attest-key`, `.sync-key` | `encrypt enable` / first signed export / first `sync --git --encrypt` (`ONEMEMORY_KEY_FILE`, `ONEMEMORY_ATTEST_KEY_FILE`, `ONEMEMORY_SYNC_KEY_FILE` move them) | `uninstall --purge` (a key moved elsewhere: by hand) |
| `audit.log`, `audit.log.1..5` | every API write; rotated at 5 MB, 5 kept (`ONEMEMORY_AUDIT_LOG`, `_MAX_BYTES`, `_KEEP`) | `uninstall --purge` |
| `capture-spool.jsonl` (+ `.draining`) | a capture hook could not open the database; capped at 10 MB, drained by the next hook | `uninstall --purge` |
| `capture.json`, `spaces.json` | by you | `uninstall --purge` |
| `setup-history.json` | each `setup` that changed a file (what `--undo` / `uninstall` replay) | `uninstall --purge` |
| `claude-import-held.json` | `import --claude` (files you chose to hold back) | `uninstall --purge` |
| `.sync-work-*`, `sync-conflicts/<time>/` | `sync --git --encrypt` (work folder, removed after); the losing side of an edit conflict | `uninstall --purge` |
| `.migrate.lock` | a few ms while a 1.0.x database is moved out of the package | removed by itself |

## App config files (only with `onememory setup`)

`setup` changes only the `onememory` entry and, if you agree, the OneMemory hooks, in:
`~/.claude.json`, `~/.claude/settings.json` (hooks), Claude Desktop's `claude_desktop_config.json`, `~/.cursor/mcp.json`,
`~/.codex/config.toml` and `~/.codex/hooks.json`, `~/.gemini/settings.json`, `~/.config/muse/settings.json`, VS Code's
user `mcp.json`, Zed's `settings.json`, and `./.mcp.json` only with `--project`. Before each change it saves
`<file>.onememory-backup-<time>` beside the file; `setup --undo` and `uninstall` save `...-before-undo` when the file had
changed since.

`onememory uninstall` replays every recorded setup in reverse: a file setup created is deleted, a file nobody touched
since is put back byte for byte from its backup, and a file the app changed since keeps those changes and loses only the
OneMemory part. An entry setup did not add (one you wrote by hand) is listed, not removed. `--purge` also deletes the
`.onememory-backup-*` copies setup recorded; `...-before-undo` copies are always kept for you to check.

## Written only where you point it

| Command | Writes |
|---|---|
| `setup --project` | `./.mcp.json` |
| `export --format md --dir <d>` / `export --format json --out <f>` | that folder / file |
| `backup [--out <d>]` | `<d>`, default `~/onememory-backup-<time>` (never the current folder: a backup and its key must not land in a repo) |
| `uninstall --purge` | the final backup, `~/onememory-final-backup-<time>` (unless `--no-backup`) |
| `sync --git <repo>` | `<repo>/onememory/` or `<repo>/onememory-enc/`, and git commits in that repo |
| `npm run runner` (a OneMemory checkout only, not in the npm package) | `<checkout>/data/runner.lock`, `runner-seen.json` |

## Processes and loops

Nothing runs unless you start it (`start`, `mcp`, `watch`, the runner) or an app runs a hook. The session-end hook may
start one short detached child for the optional local-model summary; it makes one call with a timeout (at most 5
minutes) and exits. Every retry is bounded:

- **embeddings** (`ONEMEMORY_EMBEDDINGS=auto`): a failed call stops all calls for 60 s; each call has a timeout.
- **capture spool**: capped at 10 MB; an event that fails to store is retried by at most 5 drains, then dropped; a
  `.draining` file left by a killed hook is picked up by the next drain after 10 minutes.
- **local-model summary** (`ONEMEMORY_LLM_URL`): one call per session, timeout at most 5 minutes, no retry.
- **runner**: a note is marked seen before it is acted on, so a failing note is not retried; each poll reads at most 20
  pages and runs a capped number of commands.
- **watch**: gives up with an error after 10 failures in a row (a failed wait or a failing `--exec` handler).
- **setup**: a busy file is retried for a few seconds, a file rewritten under it at most 5 times.

`onememory doctor` reports the data folder size (warns over 1 GB), the spool size (warns when anything is waiting, and
when it is full) and the capture backlog: events no session summary has taken in yet (warns over 10,000).
