# Who wrote this? (provenance)

One memory that every agent reads means whatever one agent writes, the next one
trusts. Since 1.3.3 a note says which connection wrote it, and the writer cannot
fake that.

## The fields

| Field | Set by | Meaning |
|---|---|---|
| `written_by` | **the server** | the last writer: create or update |
| `created_by` | **the server** | the first writer; never changes on update |
| `imported_written_by` | the import payload | only on a restored note: who the *payload claimed* wrote it. Unverified. |
| `source` | **the client** | free text. A claim, not a fact. |

`written_by` is, in order:

1. the **label of the authenticated token** behind the call (REST, MCP over HTTP);
2. else a fixed marker for the process: `stdio` (the local MCP stdio server), `cli` (an
   `onememory ...` command, including `import --dir` and `consolidate`), `server` (the
   long-running server's own background jobs);
3. else `""` (unknown): a library caller with no identity, or any row written before
   schema v13.

It is read from the connection, never from the request. Sending `written_by`,
`created_by` or `imported_written_by` in a create, update or import body does nothing
(the MCP tools do not even declare them). A token whose label is `stdio`, `cli` or
`server` is stored as `token:<label>` so it cannot pass as a marker; an unlabeled token
is stored as `(unlabeled)`. Labels are cut to 100 characters and stripped of control
characters.

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
- **Change feed**: every entry has `written_by` (who made *that change*). The dashboard shows it.

## Filtering: ignore yourself, distrust a client

`written_by=X` keeps only notes whose last writer is exactly `X`; `not_written_by=X` drops them.
They exist on `state_list`, `state_search` (MCP) and `GET /notes`, `GET /search`
(REST), and on the change feed (`memory_since`, `memory_ack`, `GET /changes`, `POST /ack`).
`not_written_by` does **not** exclude unknown-writer (`""`) rows, because it cannot tell who wrote
them. Filters run inside the caller's namespace scope, so a pinned token cannot use them to see
another namespace. On the feed the filter applies to change events (see
[change-feed.md](./change-feed.md)).

## Import and export

Export includes `written_by`, `created_by` and (if set) `imported_written_by`. An import never
trusts them: the **importing caller** becomes `written_by` and `created_by`, and the payload's
value is kept in `imported_written_by`, clearly labelled as a claim. Re-importing an export keeps the
original claim. A write the linter quarantined keeps its real author when an admin approves it.
A note made by consolidation is written by whoever ran the consolidation.

## Limits (read these)

- This is **attribution, not a trust policy**. OneMemory tells you who wrote a note; it does not
  decide whether to believe them. Treat every note as untrusted data, as the banner says.
- Anyone with the database file, or any admin token, can change anything. `written_by` guards against
  a *client* lying; it is not tamper-proof against the operator.
- File sync (`export --format md` / `import --dir`) writes notes as whoever runs the command (`cli`);
  front matter is not trusted for identity.
- Plaintext: like title and tags, `written_by` is **not** encrypted, so it can be filtered on (see
  [encryption-retention.md](./encryption-retention.md)). It is a label, not note content.
- Old rows read `""`. They are never back-filled from `source`, because `source` is forgeable.
  `change_log.actor` (1.3.0) is a separate, older record kept for `exclude_self`.

## Follow-up ideas (not built)

A per-token `distrust_writers` list or per-note trust flag that downgrades or hides notes from
named writers automatically; signed writer attestations for notes moved between servers.
