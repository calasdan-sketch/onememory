# Who wrote this? (provenance)

One memory that every agent reads means whatever one agent writes, the next one
trusts. Since 1.3.3 a note says which connection wrote it, and the writer cannot
fake that.

## The fields

| Field | Set by | Meaning |
|---|---|---|
| `written_by` | **the server** | who last changed the note's **content** (title or body): see below |
| `created_by` | **the server** | the first writer; never changes on update |
| `writer_id` | **the server** | `<server_id>/<written_by>`: the label plus the id of the database that minted it (1.4.0, additive; see [trust.md](./trust.md)) |
| `imported_written_by` | the import payload | only on a restored note: who the *payload claimed* wrote it. Unverified. |
| `attested_writer`, `attested_by` | a **verified** signature | only on an imported note whose attestation checked out against a trusted key: the original author and the server that vouched for it (1.4.0) |
| `merged_from_writers` | **the server** | on a consolidated note: the distinct writers of the notes merged into it. Stored for good since 1.4.0 |
| `source` | **the client** | free text. A claim, not a fact. |

### Exactly what `written_by` means

`written_by` is stamped when a note is created and whenever its **title or body** changes. It
is **not** changed by metadata-only writes: tag edits, a task being claimed, leased,
approved or having its status changed, the runner recording a command's outcome, archive and
restore, or an edit of `source`. Who made such a change is recorded in the change log
(`change_log.actor`), not in `written_by`. So an admin tagging an untrusted agent's note does not
become its author, and `not_written_by=<untrusted agent>` keeps hiding it. A merge made by
`memory_consolidate` is stamped with whoever ran the merge (its sources are deleted), and the
note stores `merged_from_writers` (the sources' distinct writers, since 1.4.0; before it was returned once and
not stored). `not_written_by=<a source's writer>` therefore treats the merged note as touched by that writer
and hides it, and a distrust rule on that writer hides it too. The task *text* is the content: editing a task's title, next step, notes or command
changes `written_by`, and the approval is voided anyway.

`written_by` is, in order:

1. the **label of the authenticated token** behind the call (REST, MCP over HTTP);
2. else a fixed marker for the process: `stdio` (the local MCP stdio server), `cli` (an
   `onememory ...` command, including `import --dir` and `consolidate`), `server` (the
   long-running server's own background jobs), `runner` (the command runner process, which writes
   the heartbeat that `runner_status` trusts);
3. else `""` (unknown): a library caller with no identity, or any row written before
   schema v13.

It is read from the connection, never from the request. Sending `written_by`,
`created_by` or `imported_written_by` in a create, update or import body does nothing
(the MCP tools do not even declare them). Labels are normalised first (control characters become spaces, runs of whitespace collapse, ends
are trimmed). A token whose label is `stdio`, `cli`, `server` or `runner` (any letter case), or
starts with `token:`, is stored as `token:<label>` so it cannot pass as a marker or as another
token's escaped form; an unlabeled token is stored as `(unlabeled)`. A label over 100 characters is
stored as its first 87 characters plus `~` and 12 hex digits of its SHA-256, so two long labels with
the same start stay different; the `written_by` / `not_written_by` filters apply the same rule, so
passing the full label finds it.

Give each client its own token and label (`ONEMEMORY_TOKENS`: `{"token", "scope", "label"}`).
Two clients sharing one token share one `written_by`; that is the limit of what the server
can know.

## Where you see it

- **Notes, lists, search hits, `state_relevant`, export** carry `written_by` and `created_by`.
- **Tasks and handoffs** (`task_put`, `task_list`, `task_get`, `session_handoff`, `catch_up`)
  carry `written_by` (and tasks `created_by`). A task's `owner` and a handoff's `surface` are
  still the writer's own claims.
- **MCP results**: the first content block is unchanged (untrusted-data banner + JSON). A second
  block, "WHO WROTE THIS", lists one line per note, e.g.
  `- #12: written by claude-desktop (token) - claims source="cursor" (unverified)`. Capped
  at 25 lines; claims are flattened to one line so one cannot forge another line.
- **Session-start recall**: `- [Title] (written by claude-desktop (token), claims source="cursor"): ...`
  for stamped notes.
- **Change feed**: every entry has `written_by` (the writer as of *that event*) and `note_written_by`
  (who holds the note now). The dashboard shows `written_by`.
- The "WHO WROTE THIS" block JSON-quotes every writer-controlled string in it (`source`, a token
  `created_by`, `imported_written_by`), so a claim cannot read as the server's own wording.

## Filtering: ignore yourself, distrust a client

`written_by=X` keeps only notes whose last writer is exactly `X`; `not_written_by=X` drops them.
They exist on `state_list`, `state_search`, `state_relevant`, `task_list`, `catch_up` (MCP) and `GET /notes`,
`GET /search`, `POST /relevant`, `GET /tasks`, `GET /handoffs`, `GET /catch-up` (REST), the CLI `relevant`,
`changes` and `watch`, and on the change feed (`memory_since`, `memory_ack`, `GET /changes`, `POST /ack`).
A value may be a bare label or a writer id (`<server_id>/<label>`). They also match a verified
`attested_writer` and `merged_from_writers`, so a restored or merged note is still caught.
`not_written_by` does **not** exclude unknown-writer (`""`) rows, because it cannot tell who wrote
them. Filters run inside the caller's namespace scope, so a pinned token cannot use them to see
another namespace. On the feed `written_by` / `not_written_by` apply to change *events*; the new
`note_written_by` / `not_note_written_by` apply to the note's *current* writer (see
[change-feed.md](./change-feed.md)). A filter you pass is your own choice for one call; a policy that
must hold for every reader is the admin's **distrust list** ([trust.md](./trust.md)), which every read path honours.

## Import and export

Export includes `written_by`, `created_by`, `writer_id` and (if set) `imported_written_by`; a JSON export
also carries the server's id and public key and, per note, a signed attestation ([trust.md](./trust.md)).
An import never trusts the payload's labels on their own: the **importing caller** becomes `written_by` and
`created_by`, and the payload's value is kept in `imported_written_by`, clearly labelled as a claim. The one
exception is a note whose attestation verifies against a key an admin trusts: its original author is then
kept as `attested_writer`. (The stamped `written_by` is still the importer.) Re-importing an export keeps the
original claim. A write the linter quarantined keeps its real author when an admin approves it, in the note **and** in
the change feed (the permanent change-log triggers copy the note's writer).
A note made by consolidation is written by whoever ran the consolidation. Restoring an
unsigned backup flattens history: every note becomes the importer's, and the payload's claims are kept only as
`imported_written_by`, so `not_written_by` hygiene is not meaningful on it. Restoring the database **file**
(`onememory backup`) keeps everything.

## Limits (read these)

- Attribution tells you who wrote a note; it does not decide whether to believe them. Since 1.4.0 an admin
  can say whom not to believe ([trust.md](./trust.md)), but even then treat every note as untrusted data.
- Anyone with the database file, or any admin token, can change anything. `written_by` guards against
  a *client* lying; it is not tamper-proof against the operator.
- File sync (`export --format md` / `import --dir`) writes notes as whoever runs the command (`cli`);
  front matter (`origin_writer`) is shown as an unverified claim and never trusted for identity.
- Plaintext: like title and tags, `written_by` is **not** encrypted, so it can be filtered on (see
  [encryption-retention.md](./encryption-retention.md)). It is a label, not note content.
- **Identity is a label.** Two tokens with the same label are the same writer; renaming a token changes who
  new writes are attributed to. Labels from two servers can collide, which is what `writer_id`
  (`<server_id>/<label>`) is for: a filter or rule may use it to say which server.
- **Heartbeat trust** (`runner_status`): only a note stamped `runner` counts, and its time is the
  server's own timestamp, not the `alive_at` in the body. A runner older than 1.3.4 stamps no marker (`""`);
  since 1.4.0 those heartbeats are **no longer believed** unless `ONEMEMORY_RUNNER_ACCEPT_LEGACY=1` (see [RUNNER.md](./RUNNER.md)). Anyone with write access to the database file can still stamp anything.
- **Upgrading while old processes run.** A process still running the pre-1.3.3 code keeps writing
  after another process has upgraded the file: its edits succeed but never touch `written_by`, so the
  note keeps the previous writer's name on the old process's text. Stop every onememory process
  (servers, stdio MCP sessions) before upgrading, then start them again. A database file at schema v13
  is refused by an older build when it is opened, but cannot reach a process that is already running.
- Old rows read `""`. They are never back-filled from `source`, because `source` is forgeable.
  `change_log.actor` (1.3.0) is a separate, older record kept for `exclude_self`.

## Upgrading and rolling back

The first time a database at schema v1 to v13 is opened by 1.4.0 (schema v14), OneMemory copies it to
`<database>.pre-v14-backup` (a consistent snapshot, still at the old schema), logs the path, and
never overwrites an existing copy. (1.3.3 made `.pre-v13-backup` the same way for v12; an existing one is left alone.) The `onememory recall` hook never upgrades a database: against an older
file it prints nothing and logs one line until a normal command or the server has migrated it.
To roll back: stop every onememory process, put the backup file back as the database (keep the
`-wal` / `-shm` files out of the way), and install the older version. Writes made after the upgrade are
not in the backup.

## Trust policy, writer ids and attestations (1.4.0)

The four items once listed here as planned are built: per-database writer ids, the admin-managed
`distrust_writers` list, signed Ed25519 attestations for notes moved between servers, and per-target
runner heartbeats. They are described, with what they do **not** prove, in [trust.md](./trust.md) and
[RUNNER.md](./RUNNER.md).
