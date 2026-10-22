# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project aims
to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
  Requested by Otherwise_Wave9374: repeated cross-device tasks scored with
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

Answering u/pastoral_theology's question on r/ClaudeAI.

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
  note pairs (dataset + script in `reviews/tier2-threshold-sweep/`): F1 peaks
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
