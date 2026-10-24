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
cannot change the server-wide attester list. A pinned admin also **sees** only its own namespace's
rules, the global (`*`) rules that apply to it and the matching log lines: never another namespace's
rules, never the attester list, never another namespace's runner host names. Every change is
recorded in `trust_log` (who, when, what; the newest 1000 lines are kept) and in the audit log.

| Surface | How |
|---|---|
| MCP | `trust_policy` (admin): `action` = `list`, `distrust`, `undistrust`, `add_attester`, `remove_attester` |
| REST | `GET /trust`, `POST /trust/distrust {namespace, writer}`, `DELETE /trust/distrust?namespace=&writer=`, `POST /trust/attesters {public_key, server_id, label?, not_after?, any_server?}`, `DELETE /trust/attesters/<key_id>` (all admin, including the GET) |
| CLI | `onememory trust [list]`, `trust distrust <writer> --namespace <ns\|*>`, `trust undistrust ...`, `trust attester-add <public-key> --server-id <id> [--label text] [--not-after <ISO time>] [--any-server]` (a base64url key can start with `-`: pass it as `--public-key <key>` or after `--`), `trust attester-remove <key-id>`, `trust identity`, `trust export-key --out <file>`, `trust rotate`, `trust --help`, all with `--json` |

At most 50 rules per namespace and 500 in total. A writer reference that could never match is refused
(an empty label, or a bare server id with no label).

### What a rule matches

A note is treated as touched by a writer when any of these names that writer:

1. its **current `written_by`** (the last content writer);
2. its **`attested_writer`**, the original author a *verified* attestation vouched for (below);
3. its **`merged_from_writers`**, the **taint set**. It only ever grows (1.4.1). It holds the writers
   whose notes a consolidation merged into this one, **every earlier content writer** (when someone
   rewrites a note, the previous writer, and the attested author it carried, are added), and the
   names an imported file *claims* (`written_by`, `created_by`, `imported_*`, `origin_writer` in a
   vault file). It survives later edits and exports.

So a **trusted writer editing a distrusted writer's note does not make it visible**: the note may still
contain the poisoned text, and nothing can tell which words are whose. Neither does a tags-only
change, stripping an attestation, deleting an attester from the trust list or losing a signing key.
The only ways to see the note again are to remove the rule, or to rewrite the content as a **new**
note. (Claims can only *add* taint, never remove it: a forged claim can at worst hide the forger's own
import.)

`created_by` does **not** match on its own, and `imported_written_by` never makes a note *trusted*;
it only adds taint. Two tokens that share a label are one writer.

A writer id rule for another server (`<other>/mallory`) matches only notes whose verified attestation
came from that server for that label (or whose taint set lists it). A bare label rule also matches
the verified original author's label. A label of any length works: the writer id is split on its
UUID first, then the label is shortened exactly the way a stored `written_by` is.

`not_written_by` is the same test turned around: it skips every note the writer touched in any of the
ways above. So does `not_note_written_by` on the change feed, while `note_written_by` matches only the
note's current writer.

### What it hides (every read path)

By default a distrusted writer's notes are **left out**, with exact totals. An **admin** can opt in with
`include_distrusted` (MCP) / `?include_distrusted=1` (REST) / `--include-distrusted` (CLI); the notes
then come back marked `distrusted: true`. A read or write token that asks for it is **refused**
(REST 403, MCP error), not silently served and not silently ignored: the option turns the policy off,
and a hostile note must not be able to talk an agent into asking. The dashboard unticks its
"distrusted" box when its token is refused, and the MCP "WHO WROTE THIS" block names them first as
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

**One gate.** A note read by id goes through `Store.readVisible` and a set of notes through
`Store.filterVisible` or the SQL predicate (`distrustSql`); `test/trust-gate-guard.test.ts` fails when a
new HTTP GET route, MCP tool or raw store read appears that nobody classified, and a canary note is
shown to never reach a non-admin reader through any classified route. By id, a hidden note is "not
found" to a non-admin for read, update (so a tags-only change cannot echo its body), archive, restore
and `task_put`; `client_key` replays and the janitor never touch it; consolidating a mix of hidden and
visible notes is refused.

**Also honoured since 1.4.1:** the markdown vault export (`onememory sync export`) leaves hidden notes out
and prunes their earlier files; `--include-distrusted` writes them with `distrusted: true` in the front
matter. The auto-merge janitor ignores hidden notes.

**Deliberately not hidden** (they are for the owner): the full JSON export / backup (a backup must be
complete; the notes keep their writer fields and taint, so another server applies its own policy), and
admin operations by id (delete, consolidate, quarantine). A pinned token's namespace and scope
isolation is unchanged on every path. Anyone who can read the database file is outside this model.

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
  database (mode 0600, re-tightened at every start, created on first signed export or
  `onememory trust identity`, written atomically; `ONEMEMORY_ATTEST_KEY_FILE` overrides the path).
  It is **never** exported or sent anywhere. `onememory trust list` never creates one. A corrupt key
  file is an error, never silently replaced by a new identity, and it does not break an import of
  unsigned notes. (Two databases in one directory share a key file; use one directory per database.)
- `GET /export?attest=1` and `onememory export --format json --attest` write a header
  (`"export": {format, format_version, server_id, key_id, public_key, algorithm}`) and, on every
  note, a detached `attestation`. **The default export is unchanged from 1.3.x**: `{"notes": [...]}`
  with no header and no signatures (1.4.0 added them by default; 1.4.1 puts it back, because a plain
  backup consumer expects the old shape). `/import` and `import --file` accept the plain object, the
  attested envelope and a bare array alike.
- The signature (version 2) covers `{server_id, exported_at, note id, namespace, content hash,
  written_by, created_by, updated_at, created_at, source, expires_at, archived_at, rev,
  attested_writer, attested_by, merged_from_writers}`; the content hash is a SHA-256 of the title,
  body and sorted tags. Version 1 attestations (from 1.4.0 exports) still verify, but they do not
  cover `created_at`, `source`, `expires_at`, `archived_at` or `rev`, and they carry no signed export
  time, so a key with a `not_after` rejects them. If the key cannot be created (read-only directory)
  the export is still written, without signatures.
- On import, each attestation is checked against the **trust list**: public keys an admin added
  (`trust attester-add`) plus `ONEMEMORY_TRUSTED_ATTESTERS`. **A key is pinned to one `server_id`.**
  Without the pin a trusted key could claim to be any server (including a peer you pinned another key
  for), so `attester-add` needs `--server-id`, and an unpinned entry needs the explicit `--any-server`
  (it is flagged `unpinned` in every listing and in the audit log). Even an unpinned key cannot claim
  this database's own server id. A server's own key is trusted for its own server id only.
- **Rotation / expiry:** `--not-after <ISO time>` trusts a key only for exports it signed up to that
  time (the signed `exported_at`). To retire a key, set `not_after` instead of deleting it; notes
  already imported keep their recorded provenance either way.
- **Verified**: the note keeps the original `written_by` in `attested_writer` and the attester's id in
  `attested_by`; the stamped `written_by`/`created_by` is still the importing admin. The attester's own
  earlier hops are kept in the taint set, so distrust follows the content through a chain of servers.
- **Not verified** (no attestation, a key nobody trusted, a server id that does not match the pinned
  one, an expired key, a malformed `server_id`, or a signature that does not match): the note is
  imported with the importing admin as writer, and the file's claims recorded in `imported_written_by`
  and **added to the taint set** (so a distrust rule on the claimed name still hides the note).
- The import result reports `attestations: {verified, unverified, reasons, untrusted_keys}` whenever a
  note carried an attestation (REST `POST /import`, CLI `import --file`, the dashboard). An imported
  backup without attestations keeps the old, unchanged response. `untrusted_keys` lists keys seen but
  not trusted, so a person can decide to `trust attester-add` one. The CLI prints only sanitised
  text from the file (control characters and escape sequences are removed) and never splices file
  text into a suggested command.
- A later content edit of an imported note clears `attested_writer` as the writer of record (the
  editor is the writer now) but moves it into the taint set; tag changes keep it.

Tampering with the **content** (title, body, tags), the **writer** (`written_by`, `created_by`), the
**namespace**, `updated_at`, `created_at`, `source`, `expires_at`, `archived_at`, `rev`, the note id,
the export time or the attestation itself makes the signature fail, and the note is imported as
unverified. Each of these has its own test (`test/trust-attest.test.ts`, `test/trust-141.test.ts`). A
signed note cannot be moved into another namespace either: a namespace-pinned import rewrites the
namespace, which breaks the signature.

### What an attestation proves, and what it does not

It **proves**: a key you trust signed exactly this record, so the content, the namespace and the writer
labels were not altered after that server exported them.

It does **not** prove:

- that the content is true, safe, or not an injection: a trusted server can export a hostile note;
- that the exporting server's operators labelled honestly: the label is whatever that server's tokens
  were called, and anyone with that server's admin access can mint any label;
- that the note is *current*: an old export is still validly signed, and replaying it gives the old
  version. `not_after` retires a whole key from a date on; there is no per-note revocation or
  freshness;
- anything about a key nobody added to the trust list;
- who the key belongs to: the trust list is a decision a person makes; `trust identity` prints a
  server's key so it can be checked out of band.

Anyone who can read the signing key can sign anything as that server: protect `.attest-key` like the
at-rest encryption key (do not put the data directory in a synced folder). If it leaks, set
`not_after` on (or remove) its entry in every trust list, then `onememory trust rotate` (the old key
is kept as `.attest-key.<key_id>.old`; the new key has a new `key_id`, same `server_id`).

### Setting it up between two servers

```
# on server A
onememory trust identity                     # prints server_id, key_id, public_key
# on server B, once, after checking the key with A's admin
onememory trust attester-add --public-key <public_key> --server-id <A's server_id> --label "server a"
# move notes
onememory export --format json --attest --out a.json   # on A
onememory import --file a.json                          # on B  (or POST /import)
```

The same pair as an environment variable on B: `ONEMEMORY_TRUSTED_ATTESTERS=<A's server_id>=<public_key>`
(a bare key is refused and logged: it would be a key with no pin).

### Keys, backups and restores

- `onememory backup` leaves `.attest-key` out by default and says so; `--include-attest-key` copies it
  (mode 0600) like `--include-approval-key` does. Guard such a backup like the encryption key.
- Restoring a database **file** keeps `server_id` but, without the key, the new machine makes a **new**
  key (and warns, because the database already holds notes): peers must add its public key. To keep
  the identity, restore the key too (`trust export-key --out <file>` writes a 0600 copy to keep
  somewhere safe).
- A restored database that imports its **own** earlier export verifies it with its own key, for its
  own server id only.

## Upgrading and rolling back

Schema v14 adds columns and three small tables; no note text is touched. The first time a database at
v1 to v13 is opened by 1.4.x, OneMemory writes a consistent snapshot to
`<database>.pre-v14-backup.<pid>.partial`, **checks it** (non-empty, the old schema version, the same
number of notes, an integrity check) and only then renames it to `<database>.pre-v14-backup`. A crash
leaves a `.partial` file (swept at the next upgrade), never a half-written backup under the real name.
A valid copy already there is kept (it is the original pre-upgrade state); an empty, truncated or
unreadable one is replaced. The upgrade refuses to start when the disk lacks room for the copy. The
upgrade runs in one transaction. `onememory doctor` lists the copies with size and age. To roll back:
stop every onememory process, **move** the backup file over the database (remove its `-wal` / `-shm`
files; a copy would leave the original), install the older version. Writes made after the upgrade are
not in the backup. When you are happy: `onememory backup --prune-premigration`. If you later turn on
at-rest encryption (`onememory encrypt enable`), those copies are still **plaintext**: it tells you to
prune them. `onememory recall` never upgrades a database.

Runners older than 1.3.4 write a heartbeat with no writer marker, which 1.4.0 no longer believes: see
[RUNNER.md](https://github.com/calasdan-sketch/onememory/blob/main/docs/RUNNER.md) for the one-step upgrade (or `ONEMEMORY_RUNNER_ACCEPT_LEGACY=1` as a stopgap).

## Limits

- It is a **policy on labels**, not a security boundary against the operator. Anyone with the database
  file, or an admin token, can change the list, the notes and the audit trail.
- Two tokens that share a label are one writer; distrusting the label distrusts both.
- A hostile writer who can obtain a *new* token under a *new* label is not on the list. The list is a
  response, not a gate. Keep one label per client, and review what new labels write.
- Unknown writers (`written_by` of `""`: rows from before schema v13) are never matched by
  `not_written_by` or by a rule, because nobody can say who they were.
- File sync carries the writer in front matter as `origin_writer`, an unverified claim: an imported file
  is stamped with whoever imports it, the claim is shown as `imported_written_by`, and it is added to
  the taint set. **A file that simply omits every writer field carries no taint**: an unsigned file
  cannot prove who wrote it; only a verified attestation can.
- The taint set is capped (200 names per note), and a rule list is bounded (50 per namespace).
- Performance: with rules, `list`/`changes` evaluate the policy per row. Measured on a 300,000-note
  database (median of 7): `list` (all namespaces, first page) 74 ms with no rules, 378 ms with 10 and
  659 ms with 100 (1.4.0: 811 and 4267 ms); `/changes` over a year 577 / 929 / 1458 ms (1.4.0: 552 /
  1317 / 5101 ms). Typical deployments have a handful of rules.
- The unverified `imported_written_by` and `source` are claims; the "WHO WROTE THIS" block labels them so.
