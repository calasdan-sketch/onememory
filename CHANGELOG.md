# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project aims
to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.7.0] - 2026-10-25

Easy, safe connection to Claude Code and an easy way in for what Claude Code already knows. **No schema change** (still v15).

### Added
- **`onememory setup`** (also `npx onememory-mcp setup`). Finds Claude Code (`~/.claude.json`), Claude Desktop (per OS) and Cursor, shows a plain-language
  plan and the exact lines it will change (secrets masked), writes only after you type `y` (`--yes` for scripts), saves a timestamped backup of every
  file, and writes atomically. It edits the file *in place*: only the OneMemory entry changes; other servers, comments, number formats, line endings,
  BOM, indentation and key order stay byte for byte. It re-reads the file right before writing and applies its change to what is there now (Claude Code
  rewrites `~/.claude.json` while it runs), reads it back afterwards and checks again a moment later. Symlinked configs are edited at their target.
  Opens the database and writes/reads back a test note before touching any config. `--dry-run`, `--undo`, `--only`, `--project`, `--db`, `--hook`/`--no-hook`.
  Checks the Node version with a plain message. The optional SessionStart hook is merged (never overwritten) and only with your agreement.
- **Moving from claude-bridge.** An old `claude-bridge` entry (by name, path or `CLAUDE_BRIDGE_*` variables, including per-project entries) is replaced by
  `onememory` in the same place; `CLAUDE_BRIDGE_DB_PATH` becomes `ONEMEMORY_DB_PATH` with the same value; the old install folder is never touched; the
  database upgrade keeps its verified `.pre-v15-backup`.
- **The old `CLAUDE_BRIDGE_*` variables now work** (every `CLAUDE_BRIDGE_<NAME>` is read as `ONEMEMORY_<NAME>`; the new name wins). Before this release they
  were silently ignored, so a client still configured with `CLAUDE_BRIDGE_DB_PATH` would have started on an empty database. `doctor` says when it maps one.
- **`onememory import --claude [--dry-run]`.** Imports `CLAUDE.md` files (user, project, local) and Claude Code auto memory
  (`~/.claude/projects/*/memory/*.md`), cut at headings, tagged with source and project, written by `import:claude`, idempotent by a stable key. The
  secret linter runs on every section; flagged sections are skipped and counted, never printed. Refuses links that leave the memory folder or do not lead
  to Markdown, does not follow `@imports`, never opens the network. A dry run never creates or upgrades a database.
- **`onememory sync --git <repo>`.** The Markdown export/import over a private git repository you own: fetch, merge, three-way merge into the database,
  write back, commit, push, with a retry if another computer pushed first. `--encrypt` seals every file (AES-256-GCM, opaque names) before commit; the key
  stays in a file on your computers and a key inside the repository is refused. No hosted server. Deletes do not propagate (as with file sync).
- **Dashboard "Review" view**: notes agents wrote that nobody has looked at (filter by writer; Accept adds the tag `reviewed` without changing the author;
  delete). The page now says OneMemory instead of claude-bridge.
- `onememory recall --db <file>` (used by the hook that setup writes when your database is not in the default place).
- Docs: README "Install in 60 seconds", [docs/live-claude-code.md](./docs/live-claude-code.md), a git section in docs/file-sync.md.

### Changed
- `doctor` recognises hooks written by `setup` (which call `node <cli.js> recall`) as well as `onememory recall`.

## [1.6.0] - 2026-10-25

Closes every gap the 1.5.0 benchmark recorded, without ever changing a memory silently. **Schema v15** (a verified
`<db>.pre-v15-backup` is made first; no downgrade path). Everything else is additive.

### Added
- **Replacing a memory is always two steps** (CLI `onememory supersede`, REST `POST /supersede/{preview,confirm,undo}`, MCP
  `memory_supersede_preview` / `_confirm` / `_undo`). The preview changes nothing and shows "ARE YOU SURE YOU WANT TO REPLACE THIS?" in plain
  words: each old note's text, writer, dates, tags, how many notes are similar to it and how many tasks depend on it, what you lose, what you do
  **not** lose, and a **RED FLAG** when it applies. The confirm needs the preview's one-time code: it works once, expires (10 minutes;
  `ONEMEMORY_SUPERSEDE_TTL_SECONDS`), is bound to the caller, to the exact notes and revisions previewed and to the exact replacement text, and
  fails if anything changed in between. On the command line you type the number of notes you are replacing (or `yes`); a script must pass
  `--confirm-token`. There is no `--yes`.
- **Nothing is deleted.** The old note becomes `superseded` with a `superseded_by` link, leaves search, lists, `relevant` and
  similar-note suggestions, and shows (always labelled) with `include_superseded`. `supersede undo` brings it back; both are recorded, and a write token can undo only a replacement it made itself (an administrator can undo any). Hard delete
  is unchanged, except that hard-deleting a note that *replaced* others brings those back rather than leaving them hidden for good. Details: [docs/replacing-memories.md](./docs/replacing-memories.md).
- **Trust guard.** A distrusted writer is refused outright; a replacement that claims lower confidence than the note it hides needs an
  administrator and an explicit `acknowledge_risk` (on the CLI, typing `i accept the risk`). Confidence never overrides trust.
- **Version history.** Every edit keeps the text it replaces (bounded: `ONEMEMORY_HISTORY_VERSIONS` default 20, `ONEMEMORY_HISTORY_MAX_BYTES`;
  the original is never dropped and one writer cannot flood out another's version). Admin-only `GET /notes/:id/history`, `memory_history`,
  `onememory history`; `restore` makes a **new** version; `purge` forgets history. Encrypted at rest with note bodies; carried by export/import
  (as claims; `?history=0` / `--no-history` leaves it out).
- **Optional `confidence`** (0 to 1) on write and update (REST, MCP `state_write`): validated, labelled with who claimed it, kept through edits,
  export and import, shown in search and in the replace warning. A claim only.
- Six MCP tools (`memory_supersede_preview`, `memory_supersede_confirm`, `memory_supersede_undo`, `memory_history`, `memory_restore_version`,
  `memory_history_purge`; 28 tools in all), `include_superseded` on `state_search` / `state_list` and the REST `GET /search` / `GET /notes`.

### Changed
- **Ranking.** When two notes are about the same thing and the older one is flagged stale, it now stays behind the newer one in search even if it
  matches the words better (it is still returned and flagged). The retrieval evaluation set is unchanged: best-of-both recall@1 1.000, recall@5 1.000,
  MRR 1.000; keyword-only recall@1 0.700, before and after.
- **Benchmark: 109 deterministic scenarios** (was 75): A 32, B 31, C 27, D 19. All four known gaps are now `fixed`, and the scenarios that carried them pass
  (A05, A06, A10, A20, B03 include the confirmed replace steps; A11 passes by the ranking fix alone; B08, B09 by history; D10 by confidence). New
  scenarios cover: a preview writes nothing; a confirm needs a valid code; expired, reused, damaged and changed-revision codes fail; a code is useless to
  another writer or tenant; undo; history restore; the trust-guard cases; confidence round trip; and cross-tenant isolation of history, previews and undo.
  stale-hit-rate@1 36% to 0%, current-recall@1 62% to 100%, fields lost 1 to 0.
- The pre-upgrade copy is now named after the schema it upgrades to: `<db>.pre-v15-backup`.

### Known limits
- Over MCP and REST the "Are you sure?" text is relayed by the agent. The code makes it impossible to confirm without a preview, but only the command
  line asks the person directly. See [SECURITY.md](./SECURITY.md).
- OneMemory does not guess that a new note replaces an old one. Writing a second note and leaving the first still returns both (as before); replace
  explicitly if you want the old one out of sight.

## [1.5.0] - 2026-10-25

A benchmark for the question "can one agent silently turn a weak guess into shared truth?". Additive only: no
schema change, no change to any existing result shape or default.

### Added
- **`onememory bench`** (and `npm run bench`): 75 deterministic, offline, no-model scenarios in four suites, run on a
  throwaway store through the real REST API (plus the `memory_consolidate` MCP tool for merges). **A** stale memory
  (stale-hit-rate@1/@5, current-recall@1), **B** contradiction recovery, **C** permission isolation (leakage count,
  unexpected denials), **D** provenance retention (fields lost). `--json` gives every scenario with expected vs actual;
  exit 1 on a failure. Never reads or writes your own data (it hides `ONEMEMORY_*`, uses a temporary folder and its own
  audit log). Scenarios are JSON files in `bench/scenarios/` (shipped in the package), and a small adapter interface
  (write, update, delete, search, plus actor) lets the same scenarios run against another memory system.
  See [docs/BENCHMARK.md](./docs/BENCHMARK.md).

### Fixed
- **REST `PUT /notes/:id` now honours `if_rev`** (compare-and-swap), as the MCP tool `state_write` already did. An edit made on
  an out-of-date copy is refused with `409` ("stale write: ... re-read and retry") instead of silently replacing a newer write.
  Without `if_rev` nothing changes (last write wins). Found by benchmark scenario B16.

### Known gaps
- **Known gaps are recorded, not hidden.** Scenarios that fail because OneMemory lacks the behaviour carry a `known_gap`
  marker and are listed in the README: `GAP-SUPERSEDE`, `GAP-RECENCY`, `GAP-HISTORY`, `GAP-CONFIDENCE` (a fifth, `GAP-REST-CAS`, was found and fixed in this release).
  They do not fail the run; a marked scenario that starts to pass does.

## [1.4.2] - 2026-10-24

A third expert review of 1.4.1 (coding, security, architecture, developer experience, infrastructure) found
the holes below; every confirmed one is fixed. **Upgrading from 1.3.x: read
[docs/upgrading.md](./docs/upgrading.md).** The schema stays **v14** (one idempotent column,
`notes.imported_unverified`, is added on open). Result shapes only gained fields.

**EXPERIMENTAL:** signed attestations, cross-server writer ids, `trust rotate`, `trust attester-revoke` and
`--any-server` are marked as such in the docs, the CLI help and the MCP tool descriptions; their formats may
change in a minor release.

### Security
- **A distrusted but still-active write token can no longer edit the metadata (tags, source, namespace) of a
  trusted note** it did not write (it used to re-label it without touching the content). The edit path also caps
  the taint set at 200 names, keeping the names an active rule matches.
- **`include_distrusted` for a namespace-pinned admin is honoured only in the token's own namespace**
  (REST, MCP, by-id reads and tasks). Asking across a granted namespace is refused. The primary token is always
  an admin: documented, and `onememory doctor` warns when distrust rules exist and it is the only token.
- **Notes imported without a verified attestation are marked `imported_unverified`** (shown in reads and in the
  provenance banner). `--require-attestation`, `require_attestation` on `/import` and
  `ONEMEMORY_IMPORT_REQUIRE_ATTESTATION=1` reject them. The default import behaviour is unchanged.
- **Keys.** `trust rotate` takes effect in a running server (the key file is re-checked on use). The retired
  public key is recorded as a retired key of this server, so earlier exports keep verifying; the old private
  key is no longer kept unless `--keep-old-private`. `ONEMEMORY_TRUSTED_ATTESTERS` and `attester-add` follow
  the same rules (both accept a retired own key; neither accepts the current one). `not_after` is judged
  against the time of verification, so a backdated `exported_at` no longer bypasses it; it is documented as an
  **expiry, not a revocation**. New `trust attester-revoke` / `attester-unrevoke` (CLI, REST, MCP) and
  `ONEMEMORY_ATTEST_MIN_VERSION` (refuse version 1 attestations). `trust export-key` no longer writes through
  an existing file or a dangling symlink. The "restored without its key" warning fires only when the database
  remembers a previous key that is now missing.
- **Trust log:** pruned per namespace (a flooding namespace cannot push out another's history); `key-rotate`
  rows are hidden from pinned admins; namespace-specific rules cap at 450 in total so `*` rules always fit.
- `/stats` `totalNotes` and the other counters exclude hidden notes for non-admins; a task cannot name a hidden
  task as its parent or blocker (same error as a missing one); writer labels are NFKC-normalised with
  zero-width characters removed (case is still exact); a library `notWrittenBy: ""` no longer hides every note.
- `distrust` reports `matched_notes`, so a typo in a label (0 matches) is visible.
- **`POST /relevant`: one namespace for the gate and the search.** `?namespace=work` with `include_distrusted`
  in the body and no body namespace used to pass the pinned-admin check on the query namespace while the search
  fanned out over every readable namespace. The body namespace (else the query one) is now used for both.
- **Stored writer labels are cleaned once on open** (an idempotent migration, flag `labels_clean_v1` in `_meta`):
  rows written by 1.4.1 and earlier whose label NFKC or zero-width stripping changes (an emoji with a joiner, a
  trademark sign) are re-written, and distrust rules are re-stored in canonical form, so a rule keeps matching
  old notes. The cleaning itself is now idempotent (`e` + zero-width + accent used to give a different result on
  the second pass, leaving a rule that could never match).
- **`trust rotate` cannot lose the retired public key.** The retired key is committed first, then the key file is
  swapped, then the audit line is written; a failure at any step leaves the old key recognised. A rotation
  landing while a server loads its signing key can no longer leave the old key cached.
- A distrusted writer claiming a task now gets a refusal that says "claim"; `--not-after` is documented
  and described in the CLI help as what it is: from that time the key is believed for nothing, old exports
  included.

### Performance
- The distrust predicate uses **one `json_each` membership test per row** instead of one `instr` probe per
  label, with equivalence tests against the old predicate and the JS rule check (random data).
  Measured on 100,000 notes with a 30-name taint set on every note (median of 7, first page of `list`): 100 `*` rules 10.9 s -> 1.06 s, 10 rules 1.31 s -> 1.09 s, no rules unchanged (0.17 s). `/changes` with 100 rules 11.2 s -> 0.96 s.
- The markdown vault export was quadratic in the number of hidden notes; it is linear now.
- `import --file` streams the file in batches of 500 instead of parsing it whole. A 5,000-note, 4.3 MB file: peak memory 369 MB -> 135 MB and 16.9 s -> 2.0 s; a 30,000-note, 25.8 MB file imports in 11.9 s at a peak of 283 MB (the old path did not finish within 2 minutes). A multi-batch
  restore defers the similarity graph; run `onememory rebuild-edges` afterwards (the command says so).

### Changed
- Backups: the copy is built as `state.db.partial`, verified and renamed; stale `-journal` sidecars, partial
  copies and an existing pre-upgrade copy of a different state are handled (the old one is kept under a dated
  name); a copy is checked for integrity and for its note count. A read-only data directory gets a readable error
  for an existing database too (the WAL switch is inside the guarded block).
- **The upgrade now refuses to run when the pre-upgrade copy cannot be made** (no room on the disk, a failed
  copy), with an error that says what to do; `ONEMEMORY_SKIP_PREMIGRATION_BACKUP=1` upgrades without a copy.
  This is what docs/upgrading.md and docs/trust.md always said; the code used to continue with a warning.
  An existing copy that cannot be opened (permissions) is moved aside under a dated name, never deleted; only a
  file that is empty or not a database is replaced. `backup --prune-premigration` says it removes the dated
  copies too.
- **`import --file` is all-or-nothing on a bad file.** The whole file is checked first (valid JSON to the end,
  nesting depth, element size, text fields, tag lists and their limit) before the database is opened: a
  truncated or hostile file imports nothing and says so. If a later write fails, the message reports how many
  notes were imported and how many were not, and to re-run with `--dedupe`. Batches are also bounded by size
  (32 MB of text), and entries that are not objects are reported instead of silently ignored.
- `.github/workflows/publish.yml` waits for the full build and test matrix (ubuntu, windows, macos).
- The test script preloads `test/setup-env.ts`, so a developer's `ONEMEMORY_*` environment cannot change a
  result. The gate-guard test has positive controls, matches any receiver, uses a keyed allow-list and an admin
  client for the consolidation candidates.
- The CLI error for an unpinned attester names `--any-server` (`any_server: true` over the API).

### Documentation
- New [docs/upgrading.md](./docs/upgrading.md). `docs/configuration.md` lists every `ONEMEMORY_*` variable
  once with its real default (a test greps the code for them). README `attester-add` carries `--server-id`;
  `trust.md` no longer names a nonexistent command; the feed field names are in the glossary; the RUNNER_ID
  fallback text matches the code (`COMPUTERNAME`, then `HOSTNAME`, then `default`).

### Tests
- 1237 -> 1313 tests (new: `test/trust-142.test.ts`, `test/rv6-fixes.test.ts`, the rewritten gate guard); `npx tsc --noEmit` clean; the full suite, including the packed-tarball smoke test, passed three times in a row.

### Not done
- A lock for two processes migrating at once, an admin
  `clear-taint` command, hiding admin-only tools from a non-admin `tools/list`, and reserving the runner
  namespace were reviewed and left for a later version.

## [1.4.1] - 2026-10-24

A second expert review of 1.4.0 (coding, security, architecture, developer experience, infrastructure) found
real holes in the trust feature. All are fixed here; schema is **unchanged at v14** (an idempotent
`trust_attesters.not_after` column is added on open). Result shapes only gained fields.

### Security
- **Distrust can no longer be laundered.** `merged_from_writers` is now a monotonic *taint set*: a content
  rewrite adds the previous writer (and the attested author it carried) instead of dropping them, an import
  folds the file's claimed names into it, and a verified attestation's earlier hops stay. A trusted writer
  editing, tagging or re-exporting a distrusted writer's note leaves it hidden; stripping the attestation,
  deleting the attester or losing a key cannot remove taint. (Only lifting the rule shows it again.)
- **One gate for reads by id.** `Store.readVisible` / `filterVisible` are used by `GET /notes/:id`, `PUT`,
  archive/restore, `state_read`, `state_write` by id, `task_get`, the consolidation candidates and the janitor.
  A tags-only update of a hidden note no longer echoes its body (404 for non-admins). New
  `test/trust-gate-guard.test.ts` fails if a new GET route, MCP tool or raw store read is added unclassified
  and runs a canary note through every classified route.
- **The janitor and `memory_consolidate`** never merge a distrusted note into a trusted one (the pool excludes
  hidden notes; a mixed manual merge is refused).
- **`client_key` replay** (`task_put`, `session_handoff`) can no longer return, or be blocked by, a distrusted
  writer's task or handoff; `task_put` by id refuses a hidden task.
- **`include_distrusted` is admin-only** on REST (403), MCP (error), the CLI flags that need it and the
  dashboard (which unticks its box). A namespace-pinned admin sees only its own rules, trust-log lines and
  runner targets, never the attester list. Rules are capped per namespace (50) as well as in total (500); the
  trust log keeps its newest 1000 rows.
- **The markdown vault export** skips distrusted notes (and prunes their older files); `--include-distrusted`
  writes them marked `distrusted: true`. A vault file's `origin_writer` joins the taint set.
- **Attestations:** a trusted key is now **pinned** to one `server_id` (`attester-add` requires `--server-id`,
  or an explicit `--any-server` that is flagged everywhere and logged); an unpinned key cannot claim this
  database's own id; `server_id` in an attestation must be a UUID; `--not-after` retires a key; a
  `ONEMEMORY_TRUSTED_ATTESTERS` entry needs `<server_id>=<key>` (or the JSON form), a bare key is refused and
  logged. **Version-2 attestations** also sign `created_at`, `source`, `expires_at`, `archived_at`, `rev` and
  the export time; version-1 attestations from 1.4.0 still verify. The verifier caches parsed public keys.
- **Runner heartbeat forgery:** a tag-only edit (or any non-heartbeat write) by the `runner` label no longer
  refreshes liveness: the body's own `alive_at` must agree with the server stamp within 120 s, and a
  `runner` note without a valid body is ignored. A *future* `alive_at` is still never believed.
- **Import robustness:** a corrupt `.attest-key`, or a key location that cannot be created, no longer fails an
  import of unsigned notes; the CLI strips terminal escapes and control characters from every string it
  prints out of an import file and never builds a suggested command from file text.

### Changed
- **`GET /export` and `onememory export --format json` are back to the 1.3.x shape by default**:
  `{"notes": [...]}` (the same top-level shape; the notes themselves carry the newer fields). The header and signatures are opt-in: `?attest=1` / `--attest`
  (`--no-attest` and `?attest=0` are accepted no-ops). `POST /import` and `import --file` read the plain
  object, the attested envelope and a bare array. *(1.4.0 had made the envelope the default and described
  `?attest=0` wrongly; see the correction in that entry.)*
- `not_written_by` / `not_note_written_by` now also skip notes the writer touched earlier (the taint set), which
  is what an exclusion filter is for; `written_by` / `note_written_by` still match only the current writer.
- `parseWriterRef` split a `<server_id>/<label>` after truncating the whole string, so a label of about 64+
  characters lost its server id; the id is now split first and the label normalised like a stored `written_by`.
  Rules that can never match (an empty label, a bare server id) are refused. SQL and JS matching agree on
  quotes, backslashes, unicode and case (tested pairwise).
- **Faster policy checks.** The distrust predicate lost its `COALESCE` wrapper (every column it reads is
  `NOT NULL`) and probes the taint set only on rows that have one. On a 300,000-note database, `list` with 100
  rules went from 4267 ms to 659 ms, `/changes` from 5101 ms to 1458 ms; with 10 rules 811 to 378 ms and
  1317 to 929 ms; with no rules nothing changed (74 ms / 577 ms).
- **Runner status:** a runner that never sent a heartbeat now raises the "no heartbeat seen" notice for the
  commands addressed to it (its namespace is unknown, so they count in their own namespace and the target
  carries `namespace_unconfirmed: true`). Heartbeat notes of runner ids silent for 30 days are pruned
  (`ONEMEMORY_RUNNER_HEARTBEAT_PRUNE_DAYS`, `0` = never). Removed the dead `waitingCommandTasks` helper and the
  duplicate runner-id/namespace readers.
- `trust --help` prints help; `trust` rejects stray arguments (an unquoted `--namespace *` that the shell
  expanded) with a hint; `trust list` no longer creates a signing key; `trust export-key --out` and
  `trust rotate` are new; `attester-add --not-after`; a value flag no longer swallows a following known flag.
- `runner_status` and `not_written_by` tool descriptions say what they now do.

### Migration and backup
- The pre-upgrade copy is written to `<db>.pre-v14-backup.<pid>.partial`, checked (size, schema version, note
  count, integrity) and only then renamed; a crash leaves a sweepable `.partial`, never a truncated backup. A
  valid existing copy is kept, an empty or truncated one replaced. The disk space is checked first. The
  rollback text says to **move** the file back.
- `onememory doctor` reports the copies (size, age) and the key file mode; `onememory backup
  --prune-premigration` removes them; `onememory encrypt enable` warns that earlier copies are plaintext.
- `onememory backup --include-attest-key` (the key is left out, with a message, otherwise). Restoring a database
  without its key mints a new one and says so. `.attest-key`, `ONEMEMORY_ATTEST_KEY_FILE` and the pre-upgrade
  copies are re-tightened to 0600 at every start.

### Docs and tests
- docs/trust.md, provenance.md (a field glossary: which field answers which question, who sets it, whether
  distrust reads it, and why the fields were not collapsed), configuration.md (the real
  `ONEMEMORY_TRUSTED_ATTESTERS` format, the new variables), architecture.md (`trust_policy`, `/trust*`,
  `/runner/status`, schema v14), tasks.md, SECURITY.md (replay, synced folders) and SKILL.md (`trust_policy`,
  the admin-only option) updated. Shipped docs no longer link to `RUNNER.md` (which is not in the npm package);
  the links point at the repository, and a test checks every relative link in the packed markdown.
- Three tests that did not test what their names said were fixed: "survives a reopen" (now reopens a file),
  "two processes at once" (now two real child processes), "not named runner-*" (now checks that no shipped
  module imports a runner module). The pack smoke test extracts the tarball with Node (no `tar` binary).
- 51 new tests (1186 to 1237): `test/trust-141.test.ts`, `test/trust-gate-guard.test.ts` and additions in the liveness,
  migration and policy suites.

### Not covered (stated plainly)
The distrust list is still a policy on labels; a file that omits every writer field carries no taint; replaying
an old signed export is possible (`not_after` retires a key, not a note); the heartbeat check trusts the
`runner` label, which anyone holding that token can use. Windows and macOS were not exercised in this review.

## [1.4.0] - 2026-10-24

Trust. A server can now say whom not to believe, name writers across servers, and vouch for
the writers it exports; the runner liveness signal is per machine. **Schema v14** (was v13): read
[docs/trust.md](./docs/trust.md) before upgrading.

### Added
- **Stable writer identity.** Each database has a `server_id` (random UUID, kept in the file). Notes,
  tasks, handoffs and feed entries return `writer_id` = `<server_id>/<label>` beside `written_by`
  (additive). Filters and rules accept a label or a writer id. `server_id` is in every export.
- **`distrust_writers`**: an admin-managed per-namespace (or `*`) list, honoured by every read path
  (store list/search/semantic/neighbours/feed/stats, search and relevant services, tasks, handoffs,
  catch-up, MCP, REST, CLI `recall`/`relevant`/`changes`/`watch`, dashboard). Hidden by default with
  exact totals; `include_distrusted` opts in and marks `distrusted`. `task_claim`/`task_approve` refuse
  distrusted tasks and the runner never runs a distrusted command task (even one approved earlier). Matches
  current `written_by`, a verified `attested_writer`, and `merged_from_writers`. New: `trust_policy` MCP tool
  (admin, 22 tools now), `GET/POST/DELETE /trust*` (admin), `onememory trust ...`. Changes are logged
  (`trust_log`, audit).
- **Signed writer attestations.** Per-database Ed25519 key (`.attest-key` beside the database, mode 0600,
  never exported, not in `onememory backup`). `GET /export` and `export --format json` carry a header
  (`server_id`, `key_id`, public key) and a detached attestation per note (`?attest=0` / `--no-attest`
  switched them off, and then returned the pre-1.4.0 shape; 1.4.1 makes that the default, see below). Import verifies against the admin's attester list plus `ONEMEMORY_TRUSTED_ATTESTERS`; a verified
  note keeps `attested_writer` / `attested_by`, anything else imports exactly as before. Tamper tests cover
  content, writer, namespace, timestamp and id. `onememory import --file backup.json` is new.
- **Per-runner heartbeats and status.** Heartbeat note `runner heartbeat: <machine>`; `runner_status`,
  `GET /runner/status` and `onememory runner-status` gain a `targets` list (backward compatible totals
  and `runner` summary).
- **Feed and recall filters.** `written_by` / `not_written_by` / `include_distrusted` on `catch_up`,
  `state_relevant`/`POST /relevant`, handoffs and CLI; explicit `note_written_by` / `not_note_written_by`
  on the feed (event versus current-writer semantics, documented). Index `idx_change_log_writer`.
- **Durable authorship.** A delete records the original author (`note_written_by`); consolidation stores
  `merged_from_writers`, so `not_written_by` and distrust treat the merged note as touched by every source.
- File sync writes `origin_writer` in front matter (an unverified claim, shown as `imported_written_by`).
- Dashboard: runner banner per target, "distrusted" toggle with a DISTRUSTED badge, import result shows
  attestation counts.

### Changed
- **Breaking-ish: legacy runner heartbeats.** A heartbeat with no writer marker (runner older than 1.3.4) is
  no longer believed. Update the runner, or set `ONEMEMORY_RUNNER_ACCEPT_LEGACY=1` on the server meanwhile.
- `GET /export` JSON is now `{"export": {...header}, "notes": [...]}` (still streamed). *(Correction made in
  1.4.1: this entry said `?attest=0` kept the header with unsigned notes. It did not: `?attest=0` returned the
  pre-1.4.0 `{"notes": [...]}` exactly. 1.4.1 restores that shape as the default.)* `onememory import --file`
  and `POST /import` read both shapes.
- `catch_up` and the recall notice return early (no work) when no command task is queued.
- Removed the `tasks.ts` <-> `liveness.ts` import cycle (shared rule now in `task-core.ts`).

### Upgrade and rollback
First open of a v1 to v13 database copies it to `<db>.pre-v14-backup` (never overwritten), then upgrades in one
transaction. Roll back by stopping every process and putting the copy back (docs/trust.md). Tested from v11,
v12 and v13, plain and encrypted. Restoring a database file keeps its `server_id`, not its `.attest-key`.

### Not covered (stated plainly)
Attestations prove who signed what, not that content is true; they have no revocation or freshness.
The distrust list is a policy on labels, not a boundary against the operator. Cost of `not_written_by` and
`note_*` filters grows with the feed window (measured 110 to 580 ms on 300,000 events).

## [1.3.4] - 2026-10-24

"Runner offline, N commands waiting." An approved command task used to wait
silently when the PC was off or asleep. Now the store says so. No schema version
change from 1.3.3 (still v13). Also tightens 1.3.3's "who wrote this" after review.

### Added
- `runner_status` (MCP, read scope), `GET /runner/status` (REST, read token) and
  `onememory runner-status [--json]`: the runner's state (`online` / `stale` /
  `never_seen`) and, per readable namespace, the approved commands still waiting,
  those whose approval ends within an hour, approvals that already expired, and the
  oldest waiting age (human durations on the command line). Counts, ages and ids
  only: never command text, params, targets or the host name. Counts are "at least"
  (`truncated: true`) past 2,000 queued tasks.
- "Waiting" is decided by the runner's own selection rule, now one shared function
  (`classifyQueuedCommand`): the runner's task namespace, `target` = this runner,
  a valid unexpired approval, no live lease. A command for another machine or
  namespace is not counted and never triggers the offline notice. The runner's
  heartbeat now also publishes its task namespace and beat interval.
- The heartbeat is judged by the note's server timestamp, not the `alive_at` in the
  body, only when written by the runner process (new writer marker `runner`), and
  never from the future. Forged or clock-skewed heartbeats no longer keep a dead PC
  "online". Expired approvals are counted only when their signature verifies.
- `ONEMEMORY_RUNNER_STALE_SECONDS` (default 600, never below three beat intervals).
- One-line notice (waiting commands on a runner that is not online, or expired
  approvals even when it is): a `runner_notice` field on `catch_up`, a line in the
  SessionStart recall, and a banner on the dashboard. Absent otherwise.
- `note_written_by` (the note's current writer) on every `/changes` and `memory_since`
  entry; `written_by` / `not_written_by` on `task_list` and `GET /tasks`;
  `merged_from_writers` on a consolidate result.
- A pack smoke test: `npm pack`, unpack, run `runner-status` and the MCP stdio server
  to `tools/list` from the tarball, and check every relative import is packed.

### Changed
- **Fixed before release:** the `files` list in package.json drops `dist/src/runner*`,
  which would have stripped the new module from the npm package and crashed the MCP
  server and `runner-status`. The module is now `src/liveness.ts`.
- `written_by` now means who last changed the note's **content** (title or body).
  Tag-only edits, task claim / lease / approve / status, the runner's outcome write,
  archive / restore and `source` edits no longer take it over; the actor is still in
  the change log. Merges are stamped with the merger and report the sources' writers.
- Change-log triggers are permanent and copy the note's writer (a quarantined write that
  an admin approves now shows its author in the change feed, not the approver). Existing
  v13 files made by 1.3.3 are repaired on first open. Deletes are attributed to the deleter.
- The "WHO WROTE THIS" block JSON-quotes `source`, `created_by` and `imported_written_by`.
- Writer labels are normalised before the marker check (`" cli "`, `CLI`, `token:cli` can no
  longer collide with a marker or each other); labels over 100 characters get a hash suffix and
  the filters apply the same rule.
- The index on `notes(written_by)` is replaced by `(namespace, written_by, updated_at DESC)`.
- Upgrade safety: the first v12 to v13 migration of a non-empty database leaves
  `<db>.pre-v13-backup` (never overwritten). `onememory recall` never migrates a database.
- docs/RUNNER.md: the wait, the approval expiry and the status. docs/provenance.md: exactly what
  `written_by` means, upgrade and rollback, limits. Tool count in docs and test corrected to 21.

### Planned (not built)
`distrust_writers` policy, signed writer attestations, stable cross-server writer ids,
per-target runner heartbeats. See docs/provenance.md.

## [1.3.3] - 2026-10-24

"Who wrote this?" A note now records which connection wrote it, stamped by the
server so a client cannot forge it. **Schema is now v13** (additive columns; see
"Changed"): a database opened by 1.3.3 cannot be opened by 1.3.2 or older. Back up
before upgrading.

### Added
- `written_by` (last writer) and `created_by` (first writer) on every note: the
  authenticated token's label, or `stdio` / `cli` / `server` for writers with no
  token. Set on create and on every update, from the connection only: a
  `written_by` / `created_by` in a request body is ignored. A token labelled like a
  marker is stored as `token:<label>`.
- Returned on read, list, search, `state_relevant`, export, tasks, handoffs and in
  change-feed entries. MCP results get a second "WHO WROTE THIS" block (writer first,
  the writer's `source` claim labelled unverified); the SessionStart recall names the
  writer.
- `written_by` / `not_written_by` filters on `state_list`, `state_search`,
  `memory_since`, `memory_ack` and the REST equivalents (`GET /notes`, `/search`,
  `/changes`, `POST /ack`). They respect namespace scope.
- Import: the importing caller is stamped as the writer; an export's `written_by` is
  kept only as a separate `imported_written_by` claim. A quarantined write keeps its real
  author when approved.
- docs/provenance.md and a README section "Who wrote this?".

### Changed
- Schema v13: `notes.written_by`, `notes.created_by`, `notes.imported_written_by`
  (default `''`), `change_log.written_by`, `quarantine.written_by`, and an index on
  `notes.written_by`. Rows written before v13 read `''` (unknown); they are not
  guessed from `source`. Tested upgrading from v11 and v12 databases.
- `source` is documented, and described in the MCP tool schema, as an unverified claim.
- `written_by` is plaintext, like title and tags (so it can be filtered); it is not
  note content.

### Not included
- A `distrust_writers` trust policy or per-note trust flag (idea only; see docs/provenance.md).

## [1.3.2] - 2026-10-24

Test-only fix for Windows CI. No runner/allowlist change, no schema change (still v12).

### Fixed
- Root cause of the Windows command-task failures: GitHub's Windows temp directory is an 8.3 short path (`C:\Users\RUNNER~1\...`). The tests' marker-parameter pattern allowed `:` and `\` (1.3.1) but not `~`, so the runner correctly refused the parameter ("does not match the allowed pattern") and never spawned. The pattern now also allows `~` and space. The runner's anchored-pattern check, `shell:false` execution and allowlist strictness are unchanged. Real allowlists are operator-written, so a Windows install only needs a pattern that admits the paths it uses.

### Tests
- Added a regression test for the Windows-style path against the pattern (and injection strings still rejected); the main command-task test now prints the runner's result if the marker is missing.

## [1.3.1] - 2026-10-24

Fix release: package name, CI, and Windows. No schema change (still v12).

### Fixed
- Package name is `onememory-mcp` again everywhere (package.json, lockfile, README, INSTALL, INFRA, docs, publish workflow, the schema-too-new error message). 1.3.0 was published under this name; the repository had been pointing at a scoped name by mistake.
- `new Store(...)` that throws part-way (corrupt or directory-valued key file, schema newer than the code) now closes the SQLite handle it opened. Before, the file stayed locked, which on Windows made the data directory impossible to delete.
- Security audit: dependencies updated so `npm audit --audit-level=high` is clean (body-parser, fast-uri, hono via lockfile; `zod` raised to `^4.6.7`, 3.x has no patched release). Type-check and the full test suite pass on zod 4; this is a major-version bump of a direct dependency, so please report any schema-validation difference.

### Tests (Windows CI)
- Command-task tests allowed only POSIX path characters in the marker parameter, so a `C:\...` temp path was refused by the allowlist pattern and nothing ran. The pattern now allows `:` and `\`. The runner itself already ran commands without a shell; no runner change was needed.
- Tests that start a child process now wait for it to exit before deleting its directory, and temp-dir cleanup retries (Windows holds files open briefly).
- The SIGTERM graceful-drain test is skipped on Windows only, which has no SIGTERM (a kill there is a hard terminate). It still runs on Linux and macOS.
- Windows was not run locally; these fixes are reasoned from the CI log, not executed on Windows.

## [1.3.0] - 2026-10-24

Cross-device / cross-model awareness: every session can see what the others
did and plan, and a task can now drive the PC's runner. Tasks, handoffs, leases
and approvals are tagged notes (no new table). **Schema is now v12** (one added
column, `change_log.actor`; see "Changed"):
a database opened by 1.3.0 cannot be opened by 1.2.x. Back up before upgrading.
Existing behaviour is unchanged unless you use the new parameters and tools,
with the exceptions listed under "Changed".

### Added

- **Live wait on the change feed.** `GET /changes?...&wait=<0-55>` (alias
  `wait_seconds`) and `memory_since { wait_seconds }` (alias `wait`) hold the
  request until something changes in the caller's scope, then answer like a
  normal read; on timeout they return the empty page with `timedOut: true`.
  **Use 25**: a 55s wait died at exactly 30.0s behind a 30s-idle proxy (55 stays
  the cap). In-process writes wake it immediately; writes by another process are
  noticed by a jittered ~1s poll (`ONEMEMORY_WAIT_POLL_MS`). Caps: 16 per token,
  32 per namespace scope, 64 per process (`ONEMEMORY_WAIT_MAX_PER_TOKEN`,
  `_PER_NAMESPACE`, `_TOTAL`); the 429 / tool error names the limit. A client
  disconnect or a server shutdown frees the slot (shutdown returns `timedOut`
  cleanly and drains in milliseconds). Not combinable with `cursor` (400).
- **Task board.** MCP `task_put` / `task_get` / `task_list` / `task_claim` and REST
  `POST /tasks`, `PUT /tasks/:id`, `GET /tasks[/:id]`, `POST /tasks/:id/claim`:
  status, next step, owner, plus `priority` (0-9), `due`, `parent_id` and
  `blocked_by[]` (validated, cycles refused), `if_rev` compare-and-swap, and
  `client_key` idempotency (a retried create returns the existing task,
  `replayed: true`). `task_claim` is a compare-and-swap lease with heartbeat,
  release and expiry. Stored as tagged notes (no new table).
- **Session handoffs.** `session_handoff` / `POST|GET /handoffs`, with `client_key`.
- **`catch_up`** (MCP) / `GET /catch-up`: changes since this consumer last
  looked + open tasks (compact: no notes, no command text) + latest handoffs in
  one call.
- **Acknowledged reads.** `ack_mode: "manual"` on `memory_since` / `catch_up` /
  `GET /changes`: the "last" marker moves only when the returned `ack_token`
  comes back (`ack_token` on the next call, `memory_ack`, or `POST /ack`), so a
  client that dies mid-delivery gets the changes again. Default stays `auto`
  (marker moves on delivery, at-most-once); manual is at-least-once.
  `exclude_self` hides a consumer's own writes: changes whose recorded **writer**
  (the label of the token / MCP connection that made the write, `change_log.actor`)
  equals the consumer label. It is not the note's `source`, which any client can
  set freely. Writes with no recorded writer (CLI, scripts, rows from before v12)
  fall back to `source`. It only separates devices that use different token labels.
- **Command tasks** (see docs/RUNNER.md). `task_put({command, target})` queues a
  task; an **admin** `task_approve` is required before this PC's runner will
  run it, and only if the target is that runner's own id, the task is in
  `ONEMEMORY_RUNNER_TASK_NAMESPACE` (off by default) and the action passes the
  same allowlist as a signed command note. The approval is a MAC over namespace,
  id, a single-use nonce, an **expiry** (default 24 h, `ONEMEMORY_APPROVAL_TTL_SECONDS`)
  and a hash of the command and target. `task_approve` must echo the task's
  `command_hash` (shown by `task_get` / `task_list`) or its `rev`, and is refused
  if the command changed since the admin read it. The runner removes the approval in
  the same compare-and-swap write that marks the task running, so a crash or a lost
  ledger cannot replay it. Edits void the approval; the MAC is compared in constant
  time; the runner finds approved tasks with an SQL filter (paged until exhausted),
  and a namespace holds at most 100 queued command tasks
  (`ONEMEMORY_TASK_COMMAND_QUOTA`), so a write token cannot bury an approved task.
  A command task cannot be claimed, and approve / revoke clear any lease on it. The
  runner signs with its own secret in memory; no token can read or hold it. There
  is no "read-only skips approval" class: the allowlist has no such flag.
- **`onememory backup [--out dir] [--include-approval-key]`**: consistent hot copy
  (`VACUUM INTO`, safe while the server runs) plus the `.key` file (0600) with a loud
  warning to store it separately. The command-task **approval key is NOT copied**
  unless you pass `--include-approval-key`: a restored backup then has stale
  approvals (fail closed) and an admin re-approves what is still queued. (The key is
  stored unencrypted in the database's `_meta`; it is not covered by `.key`.) **`onememory watch [--exec prog args...]`**: long-poll loop that
  prints changes and optionally runs a program per batch (no shell; data on stdin;
  marker moves only on exit 0). SIGINT / SIGTERM kill the running handler and stop
  the loop; a second signal exits at once.
- **`onememory recall`** prints open tasks (up to 10) and the latest handoff before
  the recent notes, each with its own budget (a long task list never cuts the
  handoff), a header that counts all open tasks, and every field reduced to one
  printable line.
- `audit.log` records task / command-task / claim / approve / handoff / catch_up /
  ack events with the token **label** and a `kind`, and rotates by size
  (`ONEMEMORY_AUDIT_MAX_BYTES`, `ONEMEMORY_AUDIT_KEEP`). The server prunes the change
  log hourly on a timer, not only when the feed is read.
- `Store.list` accepts `withTags` / `withoutTags` (exact, case-sensitive tag filters);
  `Store.onChange` / `Store.changeHeadSeq` back the live wait.

### Changed (read before upgrading)

- **Reserved tags.** Plain note writes (`POST/PUT /notes`, `state_write`, synced
  files) can no longer create a note tagged `task`, `handoff` or `task.*`, or add /
  remove those tags (400, pointing at `task_put`). Existing tagged notes can still be
  edited as long as that tag set is unchanged. Notes that merely carry `status:`,
  `owner:` or `surface:` are unaffected.
- Task titles must be one line (no newlines or control characters); next steps and
  handoff text have control characters stripped.
- `catch_up` and `memory_since` are no longer annotated read-only (they advance the
  consumer marker), `catch_up` returns compact tasks (use `task_get` for notes), and
  the per-token wait cap is 16 (was 4 in the pre-release).
- `catch_up` no longer stalls with more than 10,000 pending changes: it reads the whole
  gap with one tail query, so the marker reaches the true end and `recent` is the true
  newest. Tag filters are case-sensitive in SQL, so notes tagged `Task` can no longer
  hide real tasks from `listTasks`.
- Clearing a task's `owner` now resets the provenance `source` to `task` (it kept the
  old owner).
- **Schema v12.** `change_log` gains an `actor` column (default empty). Each `Store`
  connection stamps it with a connection-local (TEMP) trigger, so nothing about the
  stored triggers changes and other tools writing the file still work (their rows
  have an empty actor). Rows from before the upgrade have an empty actor too.
- `task_approve` / `POST /tasks/:id/approve` now require `command_hash` or `if_rev`
  (and reject a mismatch); `approve: true` on create passes the new task's rev itself.
- `task_claim` is refused for `done` tasks and for command tasks (release still works).
  `due` must be a real calendar date (`2026-02-31` is rejected).
- **Markdown import (`onememory import`) is a local admin path and now restores
  notes carrying reserved tags** (tasks, handoffs, 1.2.x notes tagged `task`), so an
  export/import round trip loses nothing. Approvals never travel by file. It prints a
  loud rejected count and exits 1 when any file was rejected (it used to say so only
  in a summary line). Plain-note writes over REST/MCP remain restricted.
- Change-log retention now records how far it purged: a `since=last` consumer whose
  marker is older than that gets `markerReset: true` (and everything still retained),
  instead of silently skipping the purged events.
- `audit.log` rotation takes a lock directory (`audit.log.lock`), so several
  processes (server plus CLI) no longer lose lines in the rename chain.
- Fixed: `onememory watch` exited immediately in a bare terminal (its timers were
  unref'd and nothing held the event loop); it now stays up.
- Task `status` gains `queued` and `failed`.

### Notes

- The MCP server now advertises 21 tools (was 12). Clients that pin the tool
  list need to refresh it.
- Live wait holds an HTTP request open; if you front OneMemory with a proxy, use
  `wait=25` (see docs/change-feed.md and INFRA.md section 8).
- The command runner is not part of the published package (see docs/RUNNER.md), so
  `task_approve` is useful only on a checkout that runs it; the tools themselves ship.
- INFRA.md gains systemd and Windows Task Scheduler recipes for OneMemory itself,
  a backup section (including the key) and a 15-minute deploy recipe.
- Known limits: an approval is a bearer decision of one admin about one command text:
  `command_hash` binds it to what was read, but the admin must still read it. The
  approval key lives in the database's `_meta` (not in `.key`); anyone who can write
  the live database file can mint approvals, so protect the file and its backups.
  `exclude_self` keys on the token label; two devices sharing one token label hide
  each other's writes. A claim does not lock a task against plain `task_put` edits of its
  other fields; command tasks need the runner running on the PC (and the PC awake);
  `onememory watch` and live waits are for scripts and agent loops, not a push to a
  chat window (chat clients still act only on a user turn); the systemd and Task
  Scheduler recipes were written but not run.

## [1.2.1] - 2026-10-24

**Package name:** the npm package is `onememory-mcp` (the command is `onememory`). An earlier version of this note claimed a rename to a scoped name; that was wrong. Neither the plain `onememory` name nor a scoped name was ever published.

Hardening and honesty release from an independent multi-reviewer pass over
1.2.0 (crypto and namespaces, data and retention, retrieval and MCP, docs and
release). Docs were corrected to match what actually ships.

### Changed (read before upgrading)

- **Database schema is now v11.** A database opened by 1.2.1 cannot be
  opened by 1.2.0 or older. 1.2.1 refuses a database that is newer than it
  supports, with a clear message. Back up `~/.onememory` before upgrading.
- Encrypted notes use a new `v2:` envelope (bound to note id and namespace).
  Old `v1:` notes still read, and are upgraded by `onememory encrypt enable`.
- `scripts/preinstall.cjs` (the 1.0.x data rescue) is removed: no code runs at
  install time any more. If you still have 1.0.x data inside an old global
  package folder, copy it to `~/.onememory` by hand.
- Import duplicates: importing into a store that already has the notes still
  creates duplicates by default; pass `?dedupe=1` (or `{"dedupe":true}`) to
  skip notes already present. The response gains `skipped`.
- Rate limiting counts failed logins per IP and normal traffic per token, so
  garbage from one address no longer locks out a valid token.
- **REST validation is stricter (can break sloppy clients).** `limit`/`offset`
  that are not non-negative integers (`limit` >= 1), an unknown `mode`, an
  unrecognised `when`, and a `forget_after` that is negative, non-finite or
  non-numeric now return `400` instead of being ignored. Numeric strings such
  as `"5"` are still accepted. MCP `state_search`/`state_relevant` return the
  same error.
- **User-chosen bearer tokens must be at least 32 characters**
  (`openssl rand -hex 32`); shorter ones are rejected at startup. Failed
  logins are also slowed per IP (250 ms steps, up to 2 s).
- **Downgrading:** run `onememory encrypt disable` before going back to 1.2.0,
  which would otherwise read encrypted notes as raw `v2:...` text.
- `encrypt enable` holds the database write lock for about 9 s per 100,000
  notes; other writers may see "database is locked" on very large stores.
- `?skipUnreadable=1` export markers carry no body and are rejected on import.
- If `encrypt disable` is interrupted, opening the store restores the key from
  `.key.disabling-<pid>`; with no key, writes are refused rather than stored
  as plaintext. Old v1 ciphertext is upgraded to the row-bound v2 format when
  the store is opened.

### Fixed (code)

- **Encryption.** Ciphertext is bound to its row (AES-GCM additional
  authenticated data), so a copied `body_enc` no longer decrypts in another
  note or namespace. Quarantined writes are sealed when encryption is on. The
  key is looked up consistently when `ONEMEMORY_DB_PATH` points outside the
  data directory. Turning encryption on or off while a server is running is
  refused or handled safely instead of silently writing plaintext or
  unreadable notes.
- **Namespaces.** A token whose `namespace` is present but not a non-empty
  string is rejected instead of silently becoming unpinned. `POST /sweep-expired`
  respects a pinned token's namespace. One damaged row no longer hangs
  `/export` or breaks list calls for other namespaces.
- **Retention and backups.** The background consolidation no longer merges or
  deletes archived notes. Export/import now carries `archived_at` and
  `expires_at`. Archive and restore appear in the change feed. Restoring a
  note clears its old expiry so the next sweep does not re-archive it.
  Archived notes no longer show up as neighbours or in access/stale counts.
  `encrypt enable/disable` no longer loses an edit made while it runs.
- **MCP and REST.** The MCP server reports the real package version. Bad
  `forget_after`, `limit`, `mode` and `when` values return a clear `400`
  instead of being ignored. `onememory --version` works.

### Documentation

- `SECURITY.md` rewritten to match 1.2.0/1.2.1: encryption at rest is
  shipped, with its limits stated plainly (titles, tags, timestamps, and
  embeddings stay readable; the key file sits beside the database; the
  embedding request sends the decrypted body to your embeddings endpoint).
  Added a short threat model and a Limitations section.
- README: the untrusted-data banner is on every **MCP** read (REST responses
  do not carry it); the evaluation set is described honestly (10 tasks over
  10 notes, lexically easy; a perfect score is a regression gate, not a
  quality claim); the comparison table now lists only cells with a source and
  marks the rest unverified; quickstart shortened.
- Documented `ONEMEMORY_ENCRYPT`, `ONEMEMORY_KEY_FILE`,
  `ONEMEMORY_IMPORT_MAX_BYTES`, `ONEMEMORY_URL`, and the `/notes/:id/archive`,
  `/notes/:id/restore`, `/sweep-expired` routes. `GET /changes` requires
  `since`; `POST /relevant` is a POST.
- Restoring a backup is documented as "into an empty store": importing into a
  store that already has the notes creates duplicates.
- `docker-compose.yml` publishes ports on `127.0.0.1` only, matching the
  README. `npm bin -g` (removed from npm) replaced by `npm prefix -g`.
  Example paths use `/home/you`.
- Internal review memos, roadmap, competitor notes and benchmark scripts were
  removed from the public tree (they remain in git history).

### Release engineering

- `.gitattributes` forces LF line endings (and CRLF for `.cmd`).
- The publish workflow runs on `v*` tags or manually from a tag, refuses to
  publish unless the tag equals the `package.json` version, and documents the
  exact npm Trusted Publisher settings it depends on.

## [1.2.0] - 2026-10-22

### Encryption at rest, retention, per-token namespaces

See `docs/encryption-retention.md` and `docs/token-namespaces.md` for the
full detail, including the tradeoffs each one makes.

- **Encryption at rest (AES-256-GCM).** Note bodies are encrypted on disk;
  the key is a 32-byte `0600` file at `~/.onememory/.key`, created on first
  `onememory encrypt enable`. Enable, status and disable are CLI commands.
  The honest cost: a plaintext FTS5 index cannot index ciphertext, so with
  encryption on the body column stays empty, ciphertext lives in `body_enc`,
  and keyword search covers **title + tags only**. Titles, tags and
  timestamps stay plaintext for the same reason search and namespace
  isolation need to read them; use OS disk encryption for full-file cover.
- **Retention: TTL + archive.** `forget_after` (days) is stored as an
  absolute `expires_at`, computed from `updated_at` so editing a note resets
  its clock; `forget_after: 0` clears it and omitting it on update preserves
  it. `POST /sweep-expired` archives every past-due note (idempotent, returns
  the count, safe on a timer). An archived note is excluded from `list`,
  keyword search, semantic search and the SessionStart recall hook —
  genuinely forgotten by every read surface — but stays on disk and is
  restorable, the reversible alternative to `DELETE`. `GET /notes` hides
  archived notes by default (`?includeArchived=1`, `?archived=1`).
- **Per-token namespace permissions.** A token can now carry an optional
  `namespace`, so one shared server confines each agent to its own
  namespace instead of every token seeing the same one. This is the piece
  that makes a shared bridge safe: scoped tokens gated *actions* but never
  *which namespace*. Tokens without a namespace behave exactly as before.

### Retrieval quality: evaluation set and explain

- **A retrieval evaluation set (`evals/cross-device-tasks.json`).**
  Prompted by community feedback: repeated cross-device tasks scored with
  recall@1, recall@5 and MRR, seeding a fresh store per task so access-count
  feedback from one query cannot leak into another's ranking. It **gates**:
  a ranking, FTS or schema change that quietly degrades retrieval fails CI
  rather than shipping. Access boost is disabled during scoring for the
  same determinism reason.
- **Retrieval explain.** Search ranking is three multiplicative stages —
  native relevance (bm25 / cosine / RRF), recency-decayed access boost, then
  graded staleness penalty — and every intermediate used to be discarded.
  `GET /search?q=...&explain=1` now attaches a `breakdown` to each result
  computed from the same functions the scorer uses, so the explanation
  cannot drift from the ranking. `finalScore = baseScore × accessBoost ×
  stalePenalty` holds exactly, and results and their order are identical
  with and without `explain=1` — explaining never reorders.

### Backup / restore at scale — the "a few months of revisions piled up" case

Prompted by community feedback about stores with months of accumulated edits.

- **`GET /export` streams.** It used to materialize every row, record and the
  full JSON string at once (~3x the backup size in memory). It now pages the
  store by primary key (`exportBatch`, 500 notes/page) and writes each page as
  it is built, with socket backpressure respected. Peak memory is one page
  regardless of store size; the response body is byte-identical to before
  (`{"notes":[...]}`). `onememory export --format json` streams the same way
  to stdout or `--out`.
- **`POST /import` accepts a real backup.** The restore path had the general
  1MB request cap, so a ~2000-note backup could be exported but not restored
  (413). It now has its own cap (`IMPORT_BODY_BYTES`, 256MB), still admin-only.
- **Bulk restores land in seconds.** Importing wrote one transaction (one WAL
  fsync) per note, and then rebuilt the similarity graph inline — linking alone
  is O(n²) and measured at 88–97% of restore time (8000 notes: 3.6s of inserts
  vs 34.9s of linking). Inserts are now batched one transaction per 500 notes
  (`IMPORT_INSERT_BATCH`), and imports over 200 notes defer the graph rebuild
  and say so in the response — run `onememory rebuild-edges` afterwards.
  Search is unaffected by a deferred graph.
- **Revisions survive a restore.** `rev` is now part of the backup and is
  restored (sane values only; garbage falls back to 1), so a note with 25
  revisions behind it does not restart at 1 after a restore — compare-and-swap
  guards and the change feed stay accurate. Together with the existing
  `created_at` / `updated_at` preservation, a backup restores with its
  history intact.
- **What a backup is (documented):** OneMemory stores only the *latest*
  version of each note — `rev` is a counter, not a snapshot — so a
  revision-heavy store exports as one entry per note with its latest body,
  and export cost tracks note count, not edit count. Per-edit history lives
  in the `change_log` (metadata only, pruned after 90 days, not part of a
  JSON backup). See the README "Backups & restore" section.

### Tests & CI

- **Two CI flakes fixed at the root.** The change-feed tests captured a
  `since` boundary from the caller's clock while SQLite stamps `changed_at`
  from its own — a boundary could land on either side of the very write it
  was meant to include or exclude (~1-in-10 standalone, and it failed the
  Windows runner). Every boundary now has settle time on both sides:
  0/300 stress runs after the fix. And the `npm pack` guard read only the
  npm 11 array shape, so it broke as soon as a runner drifted onto npm 12
  (`npm pack --json` now returns an object keyed by package name, which the
  publish workflow installs on purpose); it now accepts both shapes, verified
  against npm 11.16.0 and 12.2.1.

## [1.1.0] - 2026-10-16

### Upgrade notes

- **Run `onememory rebuild-edges` once after upgrading a 1.0.0 store.**
  Migration v4 creates the similarity-edge table but does not score
  existing notes, so they have no neighbors until a rebuild (new writes are
  linked automatically). `onememory doctor` now warns when a store has
  notes but no edges.
- **Your data moves out of the package.** 1.0.x kept `state.db` and
  `.token` in the installed package's `data/` folder, which `npm update` or
  an npx cache cleanup deletes. 1.1.0 uses `~/.onememory`
  (`%USERPROFILE%\.onememory` on Windows; override with `ONEMEMORY_HOME`).
  `npm install -g onememory-mcp` deletes the old package folder (with its
  `data/`) before 1.1.0 ever runs, so a `preinstall` step copies the
  retiring copy's `state.db` (a consistent `VACUUM INTO` snapshot) and
  `.token`, `tokens.json`, `spaces.json` into `~/.onememory` first, if that
  has no `state.db` yet; it never fails the install. A start that still
  finds `<package>/data/state.db` (npx, local installs) copies it too, under
  a lock, and prints the move; the old copy is left in place.
  **Belt and braces — before upgrading**, copy the data yourself:
  `mkdir -p ~/.onememory && cp -Rn "$(npm root -g)/onememory-mcp/data/." ~/.onememory/`
  (stop the server first; Windows: copy `%APPDATA%\npm\node_modules\onememory-mcp\data\*`
  to `%USERPROFILE%\.onememory\`).
  A from-source git checkout that already has `./data/state.db` keeps using
  it. `ONEMEMORY_DB_PATH` still pins the database. `onememory doctor` shows
  the data directory and warns if it is inside `node_modules`. Docker
  images now set `ONEMEMORY_HOME=/data`, so the token persists on the volume.
- The data directory is owner-only on POSIX: `~/.onememory` is `0700`,
  `state.db` (+ `-wal`/`-shm`), `audit.log`, token files, migrated files,
  `export --out` dumps and sync temp files are `0600`; existing looser modes
  are tightened on every start.
- Schema migrations v1–v9 run automatically on first open; no manual step.
  The whole upgrade is one transaction, safe when several processes (agents,
  server, CLI) open the old database at the same moment. v7/v8 are additive
  (`quarantine`, `sync_map`, `sync_base`, an `updated_at` index, the
  `change_log` + its triggers; v9: `sync_deleted` and title-blanking
  change-log triggers). The change feed is seeded from notes changed
  in the last 90 days; deletes made under 1.0.x are not in it.
- **No downgrade after 1.1.0.** Once 1.1.0 has opened a database, don't
  run 1.0.x against it again (keep a copy of `state.db` from before the
  upgrade if you might need to roll back).

### Added

- **Change feed** — MCP `memory_since`, REST `GET /changes`, CLI
  `onememory changes`, dashboard "Changes" view. `since` is an ISO time, a
  duration (`24h`, `7d`) or `last` (a per-`consumer` marker, advanced only
  after the final page; first use = last 24h). Returns created/updated/
  deleted notes (titles only) with totals grouped by provenance source, a
  frozen window and signed cursor paging. Driven by a trigger-written local
  change log with a monotonic sequence, so imports/restores that keep an
  old `updated_at`, deletes, and writes by other processes are all
  captured. Read scope, namespace-gated like `/search`. See
  `docs/change-feed.md`.
- **Write-time memory linter** — every create/update/import is scanned for
  secrets and prompt-injection instructions. Policy via `ONEMEMORY_LINT`
  (`block` | `quarantine` | `warn`, or per category); default
  `secrets=block,injection=quarantine`. Quarantined writes are held in their
  own table (never notes, so never searchable or recalled) until an admin
  approves or rejects them: MCP `memory_quarantine` (admin), CLI
  `onememory quarantine`. See `docs/memory-linter.md`.
- **Plain-file sync** — `onememory export --format md --dir <path>` (one
  Markdown file per note, YAML front-matter, namespace folders,
  deterministic, prunes only its own files; `--format json` for a JSON
  backup) and `onememory import --dir <path> [--dry-run]` (three-way merge
  against a per-store sync base; newer side wins on conflict, the loser is
  saved under `.conflicts/`; cross-machine identity via a store UUID). See
  `docs/file-sync.md`.
- **Session recall hook** — `onememory recall` (Claude Code SessionStart),
  fail-silent with a hard timeout.
- **Server-side namespace resolution** (opt-in, `ONEMEMORY_SPACES` /
  `~/.onememory/spaces.json`): the model-supplied `namespace` becomes an untrusted
  hint; writes land in the resolved namespace, reads are limited to it plus
  one-directional `reads_from` grants.
- **Natural-language time filter** — `when` on `state_search` / `GET
  /search` ("yesterday evening", "last week", "Oct 14").
- **Consolidation** — `memory_consolidation_candidates`,
  `memory_consolidate` (dry-run, keep-sources), CLI `consolidate`, optional
  background janitor (`ONEMEMORY_AUTO_CONSOLIDATE_INTERVAL`).
- **Similarity edge graph** — same-namespace TF-IDF edges maintained on
  every write; `state_read` `neighbors: true`; `memory_rebuild_edges`,
  `POST /rebuild-edges`, CLI `rebuild-edges`.
- **Access tracking** — `access_count` / `last_accessed`, `memory_stats` /
  `GET /stats`.
- **Staleness** — stale/ageDays/staleWarning on read and search results
  (`ONEMEMORY_STALE_DAYS`, `ONEMEMORY_STALE_TAGS`, `ONEMEMORY_STALE_TAG_DAYS`).
- **`state_relevant` / `POST /relevant`** — keyword extraction from a
  conversational message with permissive OR matching.
- Signed command runner — **repo-only**: run it from a git checkout; it is
  not in the npm package (see `docs/RUNNER.md`).
- `ONEMEMORY_ACCESS_BOOST=0` turns off the access-boost + staleness
  re-rank (see Behavior changes).

### Behavior changes

- **The secret scanner is broader** (JWTs, Stripe keys, `github_pat_`, any
  PEM private-key block, `ASIA` AWS keys, high-entropy tokens) and now also
  scans tags. A write that 1.0.0 accepted can now be refused; set
  `ONEMEMORY_LINT=secrets=warn` to store with a warning instead.
- **Prompt-injection-like writes are quarantined by default.**
  `POST /notes` / `PUT /notes/:id` answer `202 { quarantined }` and
  `state_write` returns `{ quarantined }` (not an error) instead of storing.
  Set `ONEMEMORY_LINT=injection=warn` for the 1.0 behavior plus warnings.
- Write responses may carry an additive `warnings` array; `POST /import` may
  carry additive `quarantined` / `rejected` arrays. Existing fields are
  unchanged.

- **Search ranking** now multiplies native relevance by a recency-decayed
  access boost and a graded staleness penalty, so result order can differ
  from 1.0.0. Set `ONEMEMORY_ACCESS_BOOST=0` to rank by native relevance
  only (FTS bm25 / cosine / RRF), as in 1.0.0.
- **`memory_consolidation_candidates` requires the `admin` scope** (was
  `read`): one call is an O(n²) scan. It also runs one at a time
  (a concurrent call gets an error), stops after a 15 s budget or when the
  client disconnects/cancels, and scans at most 2,000 notes **and** ~2 MB
  of text (newest first).
- **`POST /rebuild-edges`** has the same confirmation gate as the MCP tool:
  above 2,000 notes in scope it answers `409` with `{ notes, pairs }`
  unless the body has `confirm: true`. A rebuild while another is running
  answers `409` (MCP: error result).
- **Time phrases default to the host's timezone** when
  `ONEMEMORY_TIMEZONE` is unset (was UTC).
- **`/import` restores `created_at` / `updated_at`** from the backup
  (valid dates only, normalized to UTC ISO); restored notes no longer look
  brand new.
- **Namespace path matching** is case-insensitive on Windows and macOS and
  compares real paths (symlinks resolved) when the directory exists.

### Fixed

- Change-feed cursors are HMAC-signed with a per-store key and bound to the
  filter they were issued for; "last" markers are keyed by the server
  (`changes_seen:` prefix only), consumer labels are validated, and at most
  256 markers are kept. (A 1.1.0-rc cursor could be edited to overwrite any
  `_meta` key, e.g. `store_uuid` or `edge_threshold`, with a read token.)
- Approving a quarantined update is pinned to the note revision it was held
  at — an edit in between makes approval a conflict instead of a silent
  overwrite — and it moves the note only if the original write named a
  namespace.
- Similarity-index memory is bounded: per-namespace indexes are released
  when idle or least-recently-used beyond a note budget
  (`ONEMEMORY_EDGE_INDEX_IDLE_MS`, `ONEMEMORY_EDGE_INDEX_MAX_NOTES`).
- Reads no longer write: access counters are buffered and flushed in one
  transaction every `ONEMEMORY_ACCESS_FLUSH_MS` (default 5 s) and on
  shutdown, so searches stop invalidating other processes' caches.
- The CLI and servers no longer print Node's `ExperimentalWarning: SQLite`
  line (only that warning is filtered).
- `onememory init` prints `onememory mcp` instead of an absolute path into
  the package; `onememory start` prints the token file and a sample `curl`.

- **Write latency no longer grows with the namespace.** Edge scoring used
  to re-select and re-tokenize every note in the namespace on each
  create/update (≈70–110 ms per write at 2,000 notes, growing linearly).
  A per-namespace inverted index (cached term frequencies, kept in sync
  incrementally and across connections via `PRAGMA data_version`) scores
  only notes that share tokens with the written one, capped at the 256
  strongest candidates: ≈5 ms per write at 2,000 notes. Scores are
  identical to the exhaustive scan below the cap.
- **Import no longer triggers a full-store rebuild.** A 1-note import into
  a 2,000-note store took ~23 s (20,000 notes: minutes) and bypassed the
  rebuild confirmation gate; only the imported notes are now scored against
  their namespace (≈5 ms at 2,000 notes).
- `state_list` / `GET /notes` across readable namespaces (namespace
  resolution) capped each namespace at 500 notes, reported a wrong `total`
  and returned empty pages past 500; they now page in SQL.
- Rebuilds are single-flight per process, and a note updated or deleted
  while a rebuild is scoring keeps its fresh edges (the rebuild skips notes
  whose revision moved since its snapshot, and loads each namespace right
  before wiping it).

### Release-candidate review fixes

- **Multi-process writes**: `create()` takes the write lock up front
  (`BEGIN IMMEDIATE`) for the note and its edges; it no longer fails with
  "database is locked" after the note was already saved (which duplicated
  notes on retry).
- **Upgrade from 1.0.x via `npm install -g`** keeps your data (`preinstall`
  rescue, see Upgrade notes). Concurrent first starts can't swap the
  migrated database under each other (lock file + non-replacing link).
- **File sync**: deleting a note imported from another machine is
  remembered; the next import skips it instead of re-creating it (export
  prunes the unedited file). Writes re-check the real path inside the sync
  folder right before write/rename/delete.
- **Linter**: "you are now in maintenance/dark/airplane mode" and docs that
  mention ChatML / `[INST]` in prose or inline code are no longer
  quarantined; real `<|im_start|>system` blocks still are. Scan
  normalization drops Default_Ignorable characters (variation selectors,
  Hangul fillers, U+034F) and folds Cyrillic/Greek look-alike letters.
- **Change feed**: deleting a note blanks its titles in the change log and
  renaming keeps only the latest title; `onememory changes --purge` empties
  the log. `last` markers are evicted least-recently-read first and only
  after 7 days unread; a `last` read with no marker returns
  `markerReset: true`.
- A port already in use prints which port and which variable
  (`ONEMEMORY_PORT` / `ONEMEMORY_MCP_PORT`) to change, and exits 1.
- Quarantined updates from before rev tracking (`if_rev` NULL) are refused
  on approval with a "reject and re-submit" error instead of being applied
  unguarded.
- Data directory and files are owner-only (see Upgrade notes).

### Tier 2 review fixes — Database + Search/IR (HIGH/MEDIUM)

- **Edge metric is now TF-IDF cosine** (was raw-TF cosine): rare shared terms
  count more than corpus-wide boilerplate, and pairs sharing fewer than 2
  content tokens never earn an edge (minimum-support floor). The old 0.35
  floor was cargo-culted from llmem's BM25-based scale and let single-token
  overlaps ("Dentist appointment" vs "see dentist thursday" scored 0.408)
  create junk edges.
- **Edge threshold re-tuned to 0.25** by sweeping 0.15–0.60 on 150 hand-labeled
  note pairs (dataset and script in the project history, under `reviews/tier2-threshold-sweep/`): F1 peaks
  at 0.851 on the 0.15–0.25 plateau (P 0.863, R 0.840); 0.25 is the top of the
  plateau, chosen to favor precision. 12/75 positives are unreachable by any
  token metric (no shared content tokens) — the documented recall ceiling.
- **Active edge threshold persisted** in the `_meta` table (created by
  migration v5; v6 adds the edge indexes below):
  `Store.getEdgeThreshold()` / `setEdgeThreshold()`;
  `create()`, `update()`, `consolidateNotes()` and `rebuildEdgesCooperative()`
  all read it, and an explicit rebuild threshold is persisted — no more
  mixed-threshold graphs.
- **`create()` edge computation is atomic** via `SAVEPOINT`/`RELEASE` (nests
  safely inside `consolidateNotes`' transaction): a crash mid-loop can no
  longer leave a partial edge set.
- **`importNotes()` is now async**: per-note edge scoring is skipped
  during the inserts (`create(..., { skipEdges: true })`) and the imported
  notes are linked afterwards (since 1.1.0: only the imported notes, never
  a whole-store rebuild).
- **Access boost is recency-aware**: `1 + 0.1·log10(1+c)·exp(-days/30)` — old
  popularity decays unless the note was actually re-read recently
  (`last_accessed`, previously tracked but unused in ranking, is now the
  decay signal). The flat 0.9 staleness penalty was arithmetically erased at
  ≥10 accesses; the penalty is now graded, 0.95 per 90-day age band
  (`stalePenaltyFactor()` in `staleness.ts`; `STALE_SCORE_PENALTY` kept
  exported for compatibility).
- **New indexes** (migration v6): `idx_note_edges_neighbor` fixes the
  O(E) reverse-direction edge `DELETE`; composite `(note_id, score DESC)`
  covers the neighbor query's `WHERE` + `ORDER BY`.
- Term-frequency maps are precomputed once per note via the shared
  `precomputeTfMaps()` helper — the tokenizer no longer runs inside any
  pair loop.

## [1.0.0] — 2026-10-15

First public version.

### Core
- SQLite note store (`node:sqlite`, no native modules) with FTS5 full-text
  search kept in sync by triggers; namespaces, tags, pagination, note
  revisions (compare-and-swap), provenance, and export/import.
- MCP server over stdio and MCP-over-HTTP (Streamable HTTP), plus a plain REST
  API and a small dashboard. `start` runs the REST API/dashboard **and** the
  MCP-over-HTTP endpoint in one process on a shared store.
- Scoped tokens: `read` / `write` / `admin`, via `ONEMEMORY_TOKENS` (JSON) or
  `data/tokens.json` (1.1.0: `~/.onememory/tokens.json`), enforced identically on the REST API and MCP tools.
- Optional semantic search (keyword / semantic / hybrid) using your own
  OpenAI-compatible or Ollama embeddings endpoint; off by default, with a
  `reindex` CLI command. Degrades to keyword search if the endpoint is down.
- One-command self-host: `Dockerfile` + `docker-compose.yml` (non-root user,
  `/ready` health check).
- CLI: `start`, `mcp`, `doctor`, `init`, `reindex`.
- `/health` (liveness) and `/ready` (touches the DB) endpoints.
- Docs: install for every MCP client, Cloudflare Access / tunnel setup, and
  "Use with n8n" in `INFRA.md`.

### Security
- Localhost-by-default / fail-closed exposure guard, bearer auth with
  constant-time (SHA-256 + `timingSafeEqual`) compare, DNS-rebinding Origin
  check (loopback + explicit allowlist, does not trust `Origin == Host`),
  per-client rate limiting (`x-forwarded-for` / `cf-connecting-ip` trusted only
  behind an opt-in flag), secret-scan-on-write (title/body/source),
  untrusted-data framing on read, request/response size caps, append-only audit
  log that records operations but never note content.

### Hardened per two rounds of external review
- Compare-and-swap is a single atomic `UPDATE` in a transaction (holds across
  connections/processes, not just in-process).
- Imported notes are embedded for semantic search; import is best-effort
  per-note (a bad note is skipped, not a half-committed batch).
- `/export` is exempt from the response-size cap so a grown store can still be
  backed up; the cap still applies to every other route.
- Oversized request bodies return `413` and malformed JSON `400` consistently
  on both the REST and MCP-over-HTTP front doors (shared body reader).
- MCP tools return a generic error for unexpected faults (no `node:sqlite`
  internals leaked); dashboard output is HTML-escaped under a CSP + `nosniff`.
- `/ready` is behind the rate limiter; rate-limiter memory is hard-bounded.
- Full test suite (154 tests) green on Node 24; 0 production dependency
  vulnerabilities (`npm audit`).
