# Plain-file sync (Markdown)

Your memory as a folder of Markdown files you can read, grep, edit in any
editor, diff in git, and sync with anything that syncs files.

```bash
onememory export --format md --dir ~/memory     # store -> files
onememory import --dir ~/memory --dry-run       # what would merge back?
onememory import --dir ~/memory                 # files -> store
```

## Layout

```
~/memory/
  work/
    release-cadence--b48d83f6-12.md
  home/
    dentist--b48d83f6-3.md
  .conflicts/            # only after a conflict; never imported
```

One file per note, in a folder per namespace (unsafe characters become
`_`, Windows-reserved names such as `CON`/`NUL`/`COM1` get a `_` prefix,
trailing dots are dropped, at most 64 chars; the folder is cosmetic, the
front-matter `namespace` is authoritative). The filename is
`<title-slug>--<origin store, 8 hex>-<id>.md`; the slug keeps Unicode
letters (Greek, CJK titles stay readable) and is shortened so the full path
stays under Windows' 260-char limit.

```markdown
---
id: 12
origin: "b48d83f6-2fdc-4df8-899b-98d7bc60bdc5"
namespace: "work"
title: "Release cadence"
tags: ["decision"]
source: "claude-code"
origin_writer: "claude-code-token"
created_at: "2026-10-14T09:00:00.000Z"
updated_at: "2026-10-15T10:30:00.000Z"
rev: 3
hash: "9b1f0c2a7d3e4f51"
---
Ship weekly on Thursdays.
```

`origin_writer` (1.4.0) is who wrote the note on the exporting store (its writer id when known). It is
shown for information only: a file is stamped with whoever imports it, and the value arrives as the
unverified `imported_written_by`; it never counts for distrust rules or `written_by` filters. Files are not signed.

Values are JSON-encoded, which is valid YAML. The body is stored verbatim
(one trailing newline is added on export and removed on import; files are
LF-only and CR/CRLF in a body counts as the same content, so a round trip
never bumps `rev`). `hash` is the content hash at export.

**Deterministic:** fixed key order, notes in id order, LF endings, and a file
is only rewritten when its bytes change — re-exporting an unchanged store
produces no diff. `--namespace ns` exports one namespace.

**Export never clobbers an unimported edit.** If a file was changed since
this store last synced it (by you, or another machine's export), export
skips it and reports it: run import first. The `force` option (API:
`exportMarkdown(store, dir, { force: true })`) overwrites anyway after
copying the file to `.conflicts/<name>.overwritten.md`. One file that cannot
be written (bad path, permissions) is reported and the rest still export.

Export **prunes** only stale copies it can account for: the old file of a
note this store renamed, and the file of a note this store deleted (its own
notes, and another machine's notes it imported and then deleted) — and
only while the file still holds what was last synced. Another machine's file
this store never imported is never pruned, nor are files without OneMemory
front-matter. `--no-prune` keeps everything.

**Deleting an imported note is remembered.** When you delete a note that
came from another machine, the store keeps its sync identity and merge base
(table `sync_deleted`), so the next import treats the file as deleted here
(`skipped`) instead of creating the note again; only a file edited since
brings it back (`restored`). The other machine still has the note and may
re-export the file — it stays skipped here until someone edits it.

**Symlinks:** every write, prune and `.conflicts/` copy checks each path
segment under the sync folder with `lstat` and refuses symlinks, and right
before each write, rename or delete re-checks that the real (resolved)
directory is still inside the sync folder. Writes go through an
owner-only (0600) temp file opened with `O_EXCL`/`O_NOFOLLOW` + rename, so
a planted `work -> ~/.ssh` link cannot redirect a write.

## Writing new notes as files

Drop any `.md` file into the folder. Front-matter is optional: without
`title`, a leading `# Heading` (or the filename) becomes the title; without
`namespace`, the folder name (or `default`). Plain YAML (`title: My note`,
`tags: [a, b]`, block lists) is accepted. After the import creates the note,
the file is rewritten with full front-matter so the next import updates it
instead of creating it again.

A file may only claim a note of **this** store (`origin` = this store) if
this store exported or merged that note before; otherwise it is `rejected`,
so a dropped-in file cannot overwrite an arbitrary local note. A file that
would move a note to another namespace is `rejected` unless moves are
allowed (API: `importMarkdown(store, dir, { allowMove: true })`).

## How import merges

Import is three-way. The **base** is the content hash this store last
exported or merged for the note (kept per store in `sync_base`); for a note
this store never synced, the file's own `hash` is used.

| File vs base | Store vs base | Result |
|---|---|---|
| same | same | `unchanged` |
| changed | same | `updated` — file wins (compare-and-swap on the note's rev) |
| same | changed | `skipped` — store is newer; the next export refreshes the file |
| changed | changed, same content | `unchanged` |
| changed | changed, different | `conflict` — the **newer** side wins; the loser is written to `.conflicts/` |

"Newer" compares the store's `updated_at` with the file's front-matter
`updated_at` (file mtime is ignored: sync tools rewrite it). A hand edit
that leaves `updated_at` alone therefore loses a conflict — its text is kept
in `.conflicts/`. Nothing is silently lost: a
conflict always leaves the losing version in `.conflicts/` and is listed in
the report. After a conflict is resolved it is not raised again.

Other outcomes: `created` (new file or another store's note), `restored`
(the note was deleted here but the file was edited afterwards — your own
note's file is rewritten with the restored note's new id so it is restored
once; another machine's note is re-linked to its origin; an unedited file of
a deleted note is `skipped`), `quarantined` / `rejected`
(every import write goes through the [memory linter](./memory-linter.md);
re-importing content that is already pending in quarantine reports it again
without queuing a duplicate).
**Import never deletes notes.** Deleting a file does not delete the note; to
propagate a delete, delete the note in the store and export (prune).

`--json` prints the full per-file report.

## Several machines, one folder

Every store has a UUID (`_meta.store_uuid`). A note's identity is
`(origin store, id)`, so ids that collide between machines never get mixed
up: importing another store's file creates a local note and remembers the
mapping (`sync_map`), the next import updates that same note, and this
store's export writes it back under its **original** identity and filename.
Two machines exporting into one git repo converge on the same files.

### GitHub (private repo)

```bash
# once
mkdir ~/memory && cd ~/memory && git init && git remote add origin git@github.com:you/memory.git

# on each machine, e.g. from cron or a shell alias
cd ~/memory
git pull --rebase
onememory import --dir .          # merge others' edits in
onememory export --format md --dir .
git add -A && git commit -m "memory sync $(hostname) $(date -u +%FT%TZ)" && git push
```

Import before export, so your store absorbs remote edits before it rewrites
the files. Add `.conflicts/` to `.gitignore` if you would rather review
conflicts locally only. Use a **private** repository: notes are plaintext.

### Git, in one command (`sync --git`, 1.7.0)

```bash
git clone git@github.com:you/my-private-memory.git ~/my-private-memory     # a PRIVATE repository you own
onememory sync --git ~/my-private-memory --dry-run      # look first: nothing is fetched, written or pushed
onememory sync --git ~/my-private-memory --encrypt      # fetch, merge, write back, commit, push
```

There is no OneMemory server in this: it is the export/import above with git carrying the files. Each run fetches, merges what
your other computers pushed (git's own merge first; if git cannot, it stops and leaves your memory untouched), merges the files into
the local database with the same three-way rules as `import --dir`, writes the result back, commits and pushes. Only the
`onememory/` folder (or `onememory-enc/` with `--encrypt`) of the repository is ever committed; other files in the repository are
not touched. A push that loses a race with another computer is retried once after merging again. `--no-push` commits locally only.

- **Readable or sealed.** Without `--encrypt` the repository holds your notes as readable Markdown (the command asks you to confirm the
  repository is private; from a script pass `--yes`). With `--encrypt` every file is sealed with AES-256-GCM (the same primitives as
  [at-rest encryption](./encryption-retention.md)) before it is committed: the repository holds only opaque file names and ciphertext,
  not even titles. The sealed text is kept byte-for-byte when a note did not change, so git history stays small.
- **The key stays out of the repository.** It is a 32-byte file on your computers: your at-rest key if you use one, otherwise
  `<data folder>/.sync-key`, created on the first `--encrypt` run (or `--key-file`, or `ONEMEMORY_SYNC_KEY_FILE`). A key file inside
  the repository is refused. **Copy the key to your other computers yourself, never through the repository.** A computer without the
  key is told so and does not invent a new one over sealed notes; the wrong key stops everything before the database is changed.
  Lose the key and the sealed copies cannot be read: keep a copy of it somewhere safe, apart from the repository.
- **While it runs**, the readable notes of a sealed sync exist only in a temporary folder inside the data folder, removed afterwards.
- **Conflicts.** A note edited on two computers keeps one version and saves the other (under `<data folder>/sync-conflicts/` for a sealed
  sync, `.conflicts/` otherwise); nothing is lost silently.
- **Deletes do not propagate** (see Limits): deleting a note removes its file from the repository, but the other computers keep their copy
  until you delete it there too. A deleted note does not come back on the computer that deleted it.
- Do not run two syncs at once on the same repository.

### Syncthing / Dropbox / iCloud

Point the sync tool at the folder and run the same two commands on each
machine (import, then export) on a timer. The sync tool's own conflict
copies (`*.sync-conflict-*.md`, Dropbox "conflicted copy") carry the same
note identity as the original, so import **skips** them and reports them —
merge them by hand.

## Limits

- Not a live sync: run the commands (or a timer). The CLI uses full local
  trust and ignores server-side namespace resolution, like the other
  maintenance commands.
- Conflicts are whole-note, not line-level merges.
- Deletes do not propagate through files (see above).

**Tasks and handoffs.** Import is a local admin command (no token can reach it), so
notes carrying the reserved `task` / `handoff` / `task.*` tags are restored as
written: an export/import round trip keeps your tasks, handoffs and any 1.2.x notes
you tagged `task`. The `task.approval:` tag is never imported (approvals are bound
to the store's own key). If any file is `rejected`, the command prints a loud count
on stderr and exits with status 1.

**Distrusted writers (1.4.1).** An export leaves out notes touched by a writer on the distrust list
([trust.md](./trust.md)) and removes their earlier files (pruning is the default; `--no-prune` keeps them), so a vault synced to another
machine or an editor plugin does not carry the content an agent is told not to trust. `--include-distrusted`
writes them anyway, with `distrusted: true` in the front matter. A file's `origin_writer` is a claim, not a
proof; on import it is recorded as `imported_written_by` and added to the note's taint set, so a distrust
rule on that name hides the imported note. A file that omits `origin_writer` carries no taint.
