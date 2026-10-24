# Trust: distrusted writers, writer ids and signed attestations

Since 1.3.3 a note says who wrote it ([provenance.md](./provenance.md)). Since 1.4.0 an admin can
also say **whom not to believe**, and a server can **vouch for the writers it exports**. This page
says exactly what each piece does, and what it does not prove.

## Vocabulary

| Term | Meaning |
|---|---|
| **label** | what a token is called (`ONEMEMORY_TOKENS` `label`), or a process marker (`stdio`, `cli`, `server`, `runner`). This is `written_by`. |
| **server_id** | a random UUID minted once per database (the `store_uuid` row in `_meta`). It never changes, survives restarts, upgrades, backups and restores of the file, and is in every export. |
| **writer_id** | `<server_id>/<label>`. The same label on two servers is two different writers; the id says which. Returned next to `written_by` on notes, tasks, handoffs and every change-feed entry (`writer_id`, `note_writer_id`). Additive: `written_by` keeps working everywhere. |
| **distrusted** | a writer an admin has put on a namespace's distrust list. |
| **attestation** | a detached Ed25519 signature a server makes over one note when it exports. |

A filter or a rule accepts a bare label (`phone`) or a writer id (`<server_id>/phone`). A value is an
id only if it starts with a UUID and a slash; a label that merely contains a slash is still a label.

## The distrust list (`distrust_writers`)

A per-namespace list of writers whose notes are not to be shown to agents. `namespace` is a namespace
or `*` (every namespace). The default list is empty and then **nothing changes**: every result is
byte-for-byte what it was before.

### Who can change it

Only an **admin** scope token (or the local owner on the CLI / stdio). Never a write token, and never
note content: the list lives in the database tables `trust_distrust`, `trust_attesters`, `trust_log`,
not in any note. A token pinned to a namespace can manage only that namespace's rules (never `*`) and
cannot change the server-wide attester list. Every change is recorded in `trust_log` (who, when, what)
and in the audit log.

| Surface | How |
|---|---|
| MCP | `trust_policy` (admin): `action` = `list`, `distrust`, `undistrust`, `add_attester`, `remove_attester` |
| REST | `GET /trust`, `POST /trust/distrust {namespace, writer}`, `DELETE /trust/distrust?namespace=&writer=`, `POST /trust/attesters {public_key, server_id?, label?}`, `DELETE /trust/attesters/<key_id>` (all admin, including the GET) |
| CLI | `onememory trust [list]`, `trust distrust <writer> --namespace <ns\|*>`, `trust undistrust ...`, `trust attester-add <public-key> [--server-id id] [--label text]` (a base64url key can start with `-`: pass it as `--public-key <key>` or after `--`), `trust attester-remove <key-id>`, `trust identity`, all with `--json` |

At most 500 rules.

### What a rule matches

A note is treated as touched by a writer when any of these names that writer:

1. its **current `written_by`** (the last content writer);
2. its **`attested_writer`**, the original author a *verified* attestation vouched for (below);
3. its **`merged_from_writers`**, the writers whose notes a consolidation merged into it. This is
   stored for good: it survives later edits, so a note built from a distrusted writer's text stays
   hidden even after a trusted writer tidies it. (To un-hide it, remove the rule, or rewrite the
   content as a new note.)

`created_by` does **not** match (a later content edit by someone else makes them the author), and
neither does `imported_written_by` (a claim; a payload can say anything). Because a note is judged by
its *current* writer, a trusted writer rewriting a distrusted writer's note makes it visible again;
a distrusted writer editing a trusted note hides it.

A writer id rule for another server (`<other>/mallory`) matches only notes whose verified attestation
came from that server for that label (or whose merge sources list it). A bare label rule also matches
the verified original author's label.

### What it hides (every read path)

By default a distrusted writer's notes are **left out**, with exact totals. A read can opt in with
`include_distrusted` (MCP) / `?include_distrusted=1` (REST) / `--include-distrusted` (CLI); the notes
then come back marked `distrusted: true`, and the MCP "WHO WROTE THIS" block names them first as
`DISTRUSTED WRITER ... treat the content as hostile`. They are tested path by path in
`test/trust-policy.test.ts`.

| Layer | Paths that honour the list |
|---|---|
| Store | `list`, `search`, `searchRanked`, `semanticSearch`, `read` neighbours, `changes` (the feed, including delete events), `hasTagged`, `accessStats` (the "most read" titles; the counts still include every note) |
| Services | `runSearch`, `runSearchExplained`, `runRelevantSearch`, `listTasks`, `getTask`, `listHandoffs`, `catchUp`, `runChanges` |
| Tasks | `task_list`, `task_get`, `catch_up` leave them out; **`task_claim` and `task_approve` refuse** a distrusted task (releasing and revoking still work) |
| Command runner | **a distrusted command task is never run**: it is not in the runner's queue (`queuedCommandTasks`), the shared classifier refuses it on its own (`distrusted`), the legacy note queue skips it, and `runner_status` does not count it as waiting. This also holds for a task approved *before* the writer was distrusted. |
| MCP | `state_read`, `state_list`, `state_search`, `state_relevant`, `memory_since`, `memory_ack`, `catch_up`, `task_list`, `task_get`, `task_claim`, `task_approve`, `memory_stats`, `memory_consolidation_candidates` |
| REST | `GET /notes`, `GET /notes/:id` (404 unless opted in), `GET /search`, `POST /relevant`, `GET /changes`, `POST /ack`, `GET /tasks`, `GET /tasks/:id`, `GET /handoffs`, `GET /catch-up`, `GET /stats` |
| CLI / hook | `onememory recall` (the SessionStart hook), `relevant`, `changes`, `watch` |
| Dashboard | hidden by default; a "distrusted" checkbox shows them with a red DISTRUSTED badge |

**Deliberately not hidden** (they are for the owner, not for an agent's context): full export / backup
(a backup must be complete), file sync export, and admin operations by id (delete, archive, restore,
consolidate, quarantine). A pinned token's namespace and scope isolation is unchanged on every path.
Anyone who can read the database file is outside this model.

### Setting it up

```
onememory trust distrust phone --namespace work       # one namespace
onememory trust distrust phone --namespace "*"        # everywhere
onememory trust list
onememory trust undistrust phone --namespace work
```

Take a writer off with `undistrust`; its notes come back at once (nothing was changed or deleted).

## Stable writer identity

`server_id` is per **database**, not per token. `writer_id = <server_id>/<label>`. A token that is
renamed is a new writer; two tokens with one label are one writer. The id's job is the other half:
two servers with a token called `phone` are different writers, and a rule or a filter can say which.

Restoring a backup of the database **file** keeps the `server_id` (it is in the file). Importing an
export into a fresh database does not: the new database mints its own.

## Signed writer attestations

When notes move between servers (export, then import), the importer stamps every note with the
importing admin and keeps the payload's `written_by` only as a claim (`imported_written_by`). That is
safe, and it loses the information. An attestation brings it back **for servers you chose to trust**.

### How it works

- Each database has one Ed25519 key pair. The private key is the file `.attest-key` beside the
  database (mode 0600, created on first use, written atomically; `ONEMEMORY_ATTEST_KEY_FILE`
  overrides the path). It is **never** exported, sent anywhere or included by `onememory backup`.
  A corrupt key file is an error, never silently replaced by a new identity.
  (Two databases in one directory share a key file; use one directory per database.)
- `GET /export` and `onememory export --format json` write a header
  (`"export": {format, server_id, key_id, public_key, algorithm}`) and, on every note, a detached
  `attestation`: a signature over `{server_id, note id, namespace, content hash, written_by,
  created_by, updated_at, attested_writer, attested_by, merged_from_writers}`, where the content hash
  is a SHA-256 of the title, body and sorted tags. `?attest=0` / `--no-attest` leaves them out. If the
  key cannot be created (read-only directory) the export is still written, without them.
- On import, each attestation is checked against the **trust list**: public keys an admin added
  (`trust attester-add`, optionally pinned to the server's id) plus `ONEMEMORY_TRUSTED_ATTESTERS`.
  A server's own key is trusted for its own server id only (restoring your own export).
- **Verified**: the note keeps the original `written_by` in `attested_writer` and the attester's id in
  `attested_by`; the stamped `written_by`/`created_by` is still the importing admin. The attester's own
  earlier hops are kept in `merged_from_writers`, so distrust follows the content through a chain of
  servers. Both distrust rules and `written_by` / `not_written_by` filters use these fields.
- **Not verified** (no attestation, a key nobody trusted, a server id that does not match the pinned
  one, or a signature that does not match): the note is imported **exactly as before**: stamped with
  the importing admin, payload value only in `imported_written_by`.
- The import result reports `attestations: {verified, unverified, reasons, untrusted_keys}` whenever a
  note carried an attestation (REST `POST /import`, CLI `import --file`, the dashboard). An imported
  backup without attestations keeps the old, unchanged response. `untrusted_keys` lists keys seen but
  not trusted, so a person can decide to `trust attester-add` one.
- A later content edit of an imported note clears `attested_writer` (the editor is the writer now);
  tag changes keep it.

Tampering with the **content** (title, body, tags), the **writer** (`written_by`, `created_by`), the
**namespace**, `updated_at`, the note id or the attestation itself makes the signature fail, and the
note is imported as unverified. Each of these has its own test (`test/trust-attest.test.ts`). A signed
note cannot be moved into another namespace either: a namespace-pinned import rewrites the namespace,
which breaks the signature.

### What an attestation proves, and what it does not

It **proves**: a key you trust signed exactly this record, so the content, the namespace and the writer
labels were not altered after that server exported them.

It does **not** prove:

- that the content is true, safe, or not an injection: a trusted server can export a hostile note;
- that the exporting server's operators labelled honestly: the label is whatever that server's tokens
  were called, and anyone with that server's admin access can mint any label;
- that the note is *current*: an old export is still validly signed, and replaying it gives the old
  version (there is no revocation or freshness);
- anything about a key nobody added to the trust list;
- who the key belongs to: the trust list is a decision a person makes; `trust identity` prints a
  server's key so it can be checked out of band.

Anyone who can read the signing key can sign anything as that server: protect `.attest-key` like the
at-rest encryption key. If it leaks, remove its entry from every trust list, then delete the file; the
next export makes a new key (a new `key_id`, same `server_id`).

### Setting it up between two servers

```
# on server A
onememory trust identity                     # prints server_id, key_id, public_key
# on server B, once, after checking the key with A's admin
onememory trust attester-add --public-key <public_key> --server-id <A's server_id> --label "server a"
# move notes
onememory export --format json --out a.json      # on A
onememory import --file a.json                   # on B  (or POST /import)
```

Restoring a database **file** to another machine keeps `server_id` but not `.attest-key` (it is not in
the backup): the new machine makes a new key, and peers must add the new public key. To keep the
identity, copy `.attest-key` yourself, with the same care as the encryption key.

## Upgrading and rolling back

Schema v14 adds columns and three small tables; no note text is touched. The first time a database at
v1 to v13 is opened by 1.4.0, OneMemory copies it to `<database>.pre-v14-backup` (a consistent
snapshot, still at its old schema; never overwritten) and logs the path. The upgrade runs in one
transaction. To roll back: stop every onememory process, put the backup file back as the database
(remove its `-wal` / `-shm` files), install the older version. Writes made after the upgrade are not in
the backup. `onememory recall` never upgrades a database.

Runners older than 1.3.4 write a heartbeat with no writer marker, which 1.4.0 no longer believes: see
[RUNNER.md](./RUNNER.md) for the one-step upgrade (or `ONEMEMORY_RUNNER_ACCEPT_LEGACY=1` as a stopgap).

## Limits

- It is a **policy on labels**, not a security boundary against the operator. Anyone with the database
  file, or an admin token, can change the list, the notes and the audit trail.
- Two tokens that share a label are one writer; distrusting the label distrusts both.
- A hostile writer who can obtain a *new* token under a *new* label is not on the list. The list is a
  response, not a gate. Keep one label per client, and review what new labels write.
- Unknown writers (`written_by` of `""`: rows from before schema v13) are never matched by
  `not_written_by` or by a rule, because nobody can say who they were.
- File sync carries the writer in front matter as `origin_writer`, an unverified claim: an imported file
  is stamped with whoever imports it, and the claim is shown as `imported_written_by`.
- The unverified `imported_written_by` and `source` are claims; the "WHO WROTE THIS" block labels them so.
