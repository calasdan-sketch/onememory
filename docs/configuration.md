# Configuration

All environment variables are optional. This table lists **every** `ONEMEMORY_*` variable the code reads (a test fails when one is missing):

| Variable | Default | Purpose |
|---|---|---|
| `ONEMEMORY_HOME` | `~/.onememory` (Windows `%USERPROFILE%\.onememory`) | Data directory: database, `.token`, `tokens.json`, `spaces.json`. A git checkout that already has `./data/state.db` keeps using `./data`. 1.0.x data found inside the package is copied here once on start. Created owner-only (`0700`, files `0600`) on POSIX and re-tightened on every start |
| `ONEMEMORY_DB_PATH` | `<data dir>/state.db` | SQLite file path (overrides the data dir for the database only) |
| `ONEMEMORY_WAIT_POLL_MS` | `1000` | Live wait (`wait` / `wait_seconds`): how often a parked request checks for writes made by another process. Same-process writes wake it immediately. 20-60000 |
| `ONEMEMORY_WAIT_MAX_PER_TOKEN` | `16` | Live wait: max parked requests per token (more: REST 429 / MCP tool error that names the limit) |
| `ONEMEMORY_WAIT_MAX_PER_NAMESPACE` | `32` | Live wait: max parked requests per namespace scope, across all tokens |
| `ONEMEMORY_WAIT_MAX_TOTAL` | `64` | Live wait: max parked requests per process |
| `ONEMEMORY_AUDIT_LOG` | `<data dir>/audit.log` | Audit log path (create/update/delete, task / handoff / catch_up / approve entries with the token label and kind; never note text or tokens) |
| `ONEMEMORY_AUDIT_MAX_BYTES` | `5000000` | Rotate audit.log when it reaches this size (`0` = never) |
| `ONEMEMORY_AUDIT_KEEP` | `5` | Rotated audit files kept (`audit.log.1` ... `.N`) |
| `ONEMEMORY_RUNNER_TASK_NAMESPACE` | unset | Runner and server: namespace whose admin-approved command tasks the runner executes. Unset = command tasks off. See [RUNNER.md](https://github.com/calasdan-sketch/onememory/blob/main/docs/RUNNER.md) |
| `ONEMEMORY_RUNNER_STALE_SECONDS` | `600` (30 s - 7 d) | API/MCP/CLI side: heartbeat age after which `runner_status` calls the runner stale. Never less than three of the runner's own beat intervals (the heartbeat publishes its interval), so a slow beat cannot read as permanently offline. See [RUNNER.md](https://github.com/calasdan-sketch/onememory/blob/main/docs/RUNNER.md) |
| `ONEMEMORY_APPROVAL_TTL_SECONDS` | `86400` (60 s - 30 d) | How long an admin approval of a command task stays valid before it expires and needs approving again |
| `ONEMEMORY_RUNNER_ID` | `COMPUTERNAME`, else `HOSTNAME`, else `default` | The runner's machine name (the runner's own heartbeat wins). Server side: fallback for the name when no heartbeat has been seen. Counted commands are the ones whose `target` is this name. Note: `COMPUTERNAME` is set on Windows and `HOSTNAME` is usually **not exported** by Linux/macOS shells, so on those set `ONEMEMORY_RUNNER_ID` explicitly or the name is `default` |
| `ONEMEMORY_RUNNER_ACCEPT_LEGACY` | unset | Server side: `1` = also believe runner heartbeats with no writer marker (runners older than 1.3.4). Default off since 1.4.0; a stopgap until the runners are updated. See [RUNNER.md](https://github.com/calasdan-sketch/onememory/blob/main/docs/RUNNER.md) |
| `ONEMEMORY_TRUSTED_ATTESTERS` | unset | Export signers whose note attestations an import believes. Either comma/space/newline separated `<server_id>=<public key>` entries (the server id is a UUID, the key 43 characters of base64url), or a JSON array `[{"public_key":"<key>","server_id":"<uuid>","label":"text"}]`. **A bare public key is not accepted**: a key must be pinned to the one server it speaks for. The server logs a loud warning (once) naming every entry it ignored, and when the variable yields nothing at all. Merged with the list an admin keeps in the database (`onememory trust attester-add --server-id ...`). A server's own current key is always trusted for its own server id only; an entry naming **this** server's id is a *retired own key* (see `trust rotate`), exactly like `attester-add` with this server's id. Keys on the revocation list (`trust attester-revoke`) are ignored here too. **EXPERIMENTAL.** See [trust.md](./trust.md) |
| `ONEMEMORY_ATTEST_KEY_FILE` | `<db dir>/.attest-key` | Where the database's Ed25519 signing key lives (created mode `0600` on first signed export or `onememory trust identity`, never exported; tightened back to `0600` at every start; not in `onememory backup` unless `--include-attest-key`). Two databases in one directory share the default file: use one directory per database or set this per database. If the location cannot be created, imports of unsigned files still work |
| `ONEMEMORY_RUNNER_HEARTBEAT_PRUNE_DAYS` | `30` (`0` = never; empty = `30`) | Housekeeping (server start, the runner's own sweep): delete the heartbeat note of a runner id that has not beaten for this many days (renamed hosts, containers, CI). A live runner re-creates its note on its next beat |
| `ONEMEMORY_RUNNER_HEARTBEAT_MS` | `180000` | Runner: how often it publishes its heartbeat. Server side: fallback for the runner's beat interval when a heartbeat does not carry one |
| `ONEMEMORY_RUNNER_NAMESPACE` | `commands` | Runner and signing helper: namespace holding signed command notes (not the command-task namespace) |
| `ONEMEMORY_RUNNER_RESULTS_NAMESPACE` | `results` | Runner: namespace its results are written to |
| `ONEMEMORY_RUNNER_POLL_MS` | `30000` | Runner: how often it polls for work |
| `ONEMEMORY_RUNNER_FRESHNESS_MS` | `300000` | Runner: signed commands older than this are refused |
| `ONEMEMORY_RUNNER_TIMEOUT_MS` | `120000` | Runner: default time-out for one action |
| `ONEMEMORY_RUNNER_MAX_REJECTS_PER_POLL` | `200` | Runner: rejected notes handled per poll |
| `ONEMEMORY_RUNNER_MAX_PER_POLL` | `10` | Runner: actions run per poll |
| `ONEMEMORY_RUNNER_MAX_PER_WINDOW` | `60` | Runner: actions run per rate window |
| `ONEMEMORY_RUNNER_WINDOW_MS` | `600000` | Runner: the rate window for `ONEMEMORY_RUNNER_MAX_PER_WINDOW` |
| `ONEMEMORY_RUNNER_RETENTION_DAYS` | `30` | Runner: days result notes are kept |
| `ONEMEMORY_RUNNER_PRUNE_EVERY_MS` | `3600000` | Runner: how often it prunes old results |
| `ONEMEMORY_RUNNER_ALLOW` | `data/runner-allow.json` | Runner: the allow-list (JSON) of actions it may run; none = nothing runs |
| `ONEMEMORY_RUNNER_SECRET` | unset | Runner and signing helper: the shared secret that signs and verifies command notes. Required to run or sign anything |
| `ONEMEMORY_TASK_COMMAND_QUOTA` | `100` | Most queued command tasks per namespace; more are refused |
| `ONEMEMORY_CHANGE_LOG_PURGE_MS` | `3600000` (min `100`) | How often the server prunes the 90-day change log and stale runner heartbeats. Shortened by tests only |
| `ONEMEMORY_TARPIT_STEP_MS` | `250` | Authentication failures from one client are delayed by this much more each time ... |
| `ONEMEMORY_TARPIT_CAP_MS` | `2000` | ... up to this ceiling (brute-force slow-down) |
| `ONEMEMORY_ENABLE_SIGN_PAGE` | unset (off) | `1` serves the runner signing page (`/sign`, `/signer.js`); otherwise both paths 404 |
| `ONEMEMORY_CONSUMER` | set by `onememory watch` | Not a setting: `onememory watch` puts the consumer name in the environment of the command it runs |
| `ONEMEMORY_CHANGE_COUNT` | set by `onememory watch` | Not a setting: the number of changes handed to the command `onememory watch` runs |
| `ONEMEMORY_ATTEST_MIN_VERSION` | `1` (at most the current version, `2`) | Oldest attestation version an import believes. `2` once every peer exports with 1.4.1 or later (a version-1 attestation signs fewer fields). **EXPERIMENTAL** (see [trust.md](./trust.md)) |
| `ONEMEMORY_SUPERSEDE_TTL_SECONDS` | `600` | How long the one-time confirmation code from a replace preview stays valid, in seconds (1 to 3600). See [replacing-memories.md](./replacing-memories.md) |
| `ONEMEMORY_HISTORY_VERSIONS` | `20` | Earlier versions of a note kept per note (0 = keep none, at most 500). The original version is never dropped |
| `ONEMEMORY_HISTORY_MAX_BYTES` | `2000000` | Most bytes of earlier text kept per note (10,000 to 50,000,000); stops a flood of big edits growing the database |
| `ONEMEMORY_SKIP_PREMIGRATION_BACKUP` | unset (off) | `1` = upgrade a database to a new schema even when the safety copy (`<db>.pre-vN-backup`) cannot be made. By default the upgrade stops with an error instead (no room on the disk, a failed copy). Take your own `onememory backup` first: there is no way back without a copy. See [upgrading.md](./upgrading.md) |
| `ONEMEMORY_IMPORT_REQUIRE_ATTESTATION` | unset (off) | `1` = an import (`onememory import --file`, `POST /import`) rejects every note that does not come with an attestation that verifies against a trusted key. Off by default: notes imported without one are accepted and flagged `imported_unverified`. Per import: `--require-attestation`, `?require_attestation=1`. See [trust.md](./trust.md) |
| `ONEMEMORY_NO_CHMOD` | unset | `1` = never tighten data-dir permissions to 0700/0600 (for deliberately shared dirs) |
| `ONEMEMORY_TOKEN` | auto-generated → `<data dir>/.token` | Primary bearer token; required to bind a public interface. **It is always an admin token**, so an agent holding it can switch the distrust policy off (`include_distrusted`): give agents a `write` or `read` token from `ONEMEMORY_TOKENS` and keep the primary one off them (`onememory doctor` warns when distrust rules exist and no other token does) |
| `ONEMEMORY_TOKENS` | unset | Optional JSON array of extra scoped tokens: `[{"token":"…","scope":"read\|write\|admin","label":"…","namespace":"…"}]` (also readable from `<data dir>/tokens.json`). `namespace` optionally pins a token to one namespace — per-token isolation on a shared server, so several agents can share one bridge without seeing each other's notes. See [token-namespaces.md](./token-namespaces.md) |
| `ONEMEMORY_BIND` | `127.0.0.1` | Interface to bind (`0.0.0.0` inside Docker) |
| `ONEMEMORY_PORT` | `8790` | HTTP API + dashboard port |
| `ONEMEMORY_MCP_PORT` | `8791` | MCP-over-HTTP port (tunnel this one) |
| `ONEMEMORY_TRUST_PROXY` | unset | Set to `1` only behind a trusted proxy that sets `x-forwarded-for` |
| `ONEMEMORY_TRUST_CLOUDFLARE` | unset | Set to `1` behind Cloudflare so per-client rate limiting keys on `cf-connecting-ip` |
| `ONEMEMORY_EMBEDDINGS` | unset (off) | `on` to enable optional semantic search |
| `ONEMEMORY_EMBED_URL` | `http://localhost:11434/v1/embeddings` | OpenAI-compatible embeddings endpoint |
| `ONEMEMORY_EMBED_MODEL` | `nomic-embed-text` | Embedding model name |
| `ONEMEMORY_EMBED_KEY` | unset | Optional bearer token for the embeddings endpoint |
| `ONEMEMORY_EMBED_TIMEOUT_MS` | `30000` | Timeout per embedding call; raise if a local model's first (cold) call is slow |
| `ONEMEMORY_ALLOWED_ORIGINS` | unset | Comma-separated browser Origins allowed to call the API (for a browser on the tunnel domain); loopback is always allowed |
| `ONEMEMORY_RATE_MAX` | `120` | Max requests per client per window |
| `ONEMEMORY_RATE_WINDOW_MS` | `10000` | Rate-limit window in milliseconds |
| `ONEMEMORY_TIMEZONE` | system timezone | IANA timezone for interpreting `when` time phrases in search (e.g. `America/Winnipeg`); invalid names fall back to `UTC` |
| `ONEMEMORY_AUTO_CONSOLIDATE_INTERVAL` | unset (off) | Background dedup interval: `24h`, `30m`, `90s`, or bare seconds (`3600`). Logs candidates ≥ 0.95; auto-merges only near-identical pairs ≥ 0.99 |
| `ONEMEMORY_STALE_DAYS` | `90` | Notes older than this (by `updated_at`) are flagged stale |
| `ONEMEMORY_STALE_TAGS` | `#status` | Comma-separated tags that expire faster (matched with or without `#`) |
| `ONEMEMORY_STALE_TAG_DAYS` | `30` | Expiry for notes carrying a stale tag |
| `ONEMEMORY_ACCESS_FLUSH_MS` | `5000` | Read counts (`access_count` / `last_accessed`) are buffered in memory and written in one transaction this often (and on shutdown); `0` writes on every read |
| `ONEMEMORY_EDGE_INDEX_MAX_NOTES` | `50000` | Most notes kept in the in-memory similarity index across namespaces; least-recently-used namespaces are released beyond it (rebuilt on next use) |
| `ONEMEMORY_EDGE_INDEX_IDLE_MS` | `600000` | A namespace's similarity index is released after this long unused |
| `ONEMEMORY_ACCESS_BOOST` | on | Set to `0` to turn off the access-count boost and staleness penalty in search ranking (results then follow native relevance only, as in 1.0.0); access counts are still recorded |
| `ONEMEMORY_ENCRYPT` | unset | `0` = hard-disable at-rest encryption even if a key file exists (used by tests). It never turns encryption **on**: that is decided by the presence of the key file, created by `onememory encrypt enable`. See [encryption-retention.md](./encryption-retention.md) |
| `ONEMEMORY_KEY_FILE` | `<data dir>/.key` | Path of the 32-byte encryption key file. Keep it with the same care as the database: anyone holding both can read the notes |
| `ONEMEMORY_SYNC_KEY_FILE` | your at-rest key if you have one, else `<data dir>/.sync-key` | The 32-byte key file `onememory sync --git --encrypt` seals files with (see [file-sync.md](./file-sync.md)). It must be outside the repository (a key inside it is refused); copy it to your other computers yourself |
| `ONEMEMORY_IMPORT_MAX_BYTES` | `268435456` (256 MB) | Request-body cap for `POST /import` (clamped to 1 MB - 2 GB). Other routes keep the 1 MB cap |
| `ONEMEMORY_URL` | unset | Base URL (e.g. `http://localhost:8790`) used only by the runner signing helper's `--post` mode, together with `ONEMEMORY_TOKEN`. Not read by the server |
| `ONEMEMORY_LINT` | `secrets=block,injection=quarantine` | Write-time memory linter policy: `block`, `quarantine`, `warn`, or per category (`secrets=block,injection=warn`). See [memory-linter.md](./memory-linter.md) |
| `ONEMEMORY_CAPTURE` | on (once the hooks are installed) | `off` = the capture hooks record nothing (the session-start context still works). Also readable from `<data dir>/capture.json` as `{"capture":"off"}`; the variable wins |
| `ONEMEMORY_CAPTURE_EXCLUDE` | unset | Comma-separated globs (`*`, `**`) on the working directory; sessions in a matching folder are not recorded (e.g. `**/secret-*,C:/clients/**`) |
| `ONEMEMORY_CAPTURE_SKIP_TOOLS` | unset | Comma-separated tool names the capture hooks ignore (e.g. `TodoWrite,WebFetch`). OneMemory's own `mcp__onememory__*` tools are always skipped |
| `ONEMEMORY_CAPTURE_RETENTION_DAYS` | `7` | Raw captured events are deleted after this many days (the observations distilled from them are kept like notes) |
| `ONEMEMORY_LLM_URL` | unset (off) | Optional local model for session summaries: base URL of an OpenAI-compatible server (Ollama `http://127.0.0.1:11434`, LM Studio, llama.cpp). One call per session at session-end; on any failure the automatic summary stays. Needs `ONEMEMORY_LLM_MODEL`. Only loopback hosts are accepted |
| `ONEMEMORY_LLM_MODEL` | unset | The model name sent to `ONEMEMORY_LLM_URL` (e.g. `qwen2.5:7b`) |
| `ONEMEMORY_LLM_TIMEOUT_MS` | `30000` | Upper bound on the one summary call (1000 - 300000) |
| `ONEMEMORY_LLM_ALLOW_REMOTE` | unset | `1` = allow an `ONEMEMORY_LLM_URL` that is not this machine. Session text then leaves the PC; leave unset unless you mean it |
| `ONEMEMORY_RECALL_TOKENS` | `1500` | Token budget (about 4 characters each) of the context the session-start hook injects |
| `ONEMEMORY_HOOK_URL` | unset | Optional: when the local database cannot be opened, the capture hooks POST the event to `<url>/capture` instead of spooling it (2 s timeout). Needs `ONEMEMORY_HOOK_TOKEN` |
| `ONEMEMORY_HOOK_TOKEN` | unset | A write-scope token for `ONEMEMORY_HOOK_URL` |
| `ONEMEMORY_SPACES` | unset (feature off) | Optional JSON namespace config: `{"spaces":{"/home/you/work":"work"},"default_namespace":"default","reads_from":{"work":["shared"]}}` (or `<data dir>/spaces.json`; env wins). Enables server-side namespace resolution |
| `ONEMEMORY_SPACE` | unset | Explicit namespace override: when set, the server uses this namespace directly instead of resolving from the working directory (only meaningful with a spaces config present) |

## Server-side namespace resolution (optional)

By default the `namespace` parameter on MCP tools and the REST API is
model-supplied — convenient, but prompt-injected text in context can steer
it. Namespace resolution closes that vector: the server resolves its
namespace **once at startup** from the process working directory against a
`spaces` map, and that resolution is authoritative for the whole process.

```bash
# Option 1: env var (wins if both are set)
export ONEMEMORY_SPACES='{"spaces":{"/home/you/work":"work","/home/you/personal":"home"},"default_namespace":"default","reads_from":{"work":["shared"]}}'
# Option 2: ~/.onememory/spaces.json (the data dir) with the same shape
```

How it works:

- **Resolution order:** (1) `ONEMEMORY_SPACE` if set (explicit operator
  override wins); (2) the longest matching `spaces` path pattern for the
  startup working directory; (3) `default_namespace`.
- **Patterns are directories with prefix semantics:** `"/home/you/work"`
  matches that directory and everything under it — no wildcard needed.
  A trailing `*` (`"/home/you/work/*"`) is accepted as explicit prefix
  syntax and behaves identically.
- **Ambiguity is a hard error:** if two patterns match at equal depth but
  map to different namespaces, the server refuses to start rather than
  silently picking one.
- **Writes always land in the server-resolved namespace.** The
  model-supplied `namespace` is ignored on `state_write` / `POST /notes`,
  and stripped from updates (a note keeps its existing namespace).
- **`namespace` on reads is an untrusted hint:** `state_search`,
  `state_list`, `GET /notes`, `GET /search` only honor it when it names a
  namespace this server may read; otherwise they search/list the readable
  set. `state_read` / `state_delete` (and `GET`/`DELETE /notes/:id`) return
  a uniform "not found" for notes outside it, so denied namespaces are not
  an existence oracle.
- **`reads_from` grants are one-directional:** `{"work": ["shared"]}` lets
  the `work` server read `shared`, not the reverse. Grants never confer
  write access. Grant changes require a **server restart** to take effect --
  the config is read once at startup; there is no reload signal.
- **Fail-open, but loud:** with no config present everything behaves
  exactly as before (model-supplied namespaces keep working). Invalid
  JSON/shape is logged to stderr and disables the feature. `onememory
  doctor` validates that configured space paths exist on disk.

**Old names.** OneMemory used to be called claude-bridge. Every `CLAUDE_BRIDGE_<NAME>` variable is read as the matching `ONEMEMORY_<NAME>` one (for example `CLAUDE_BRIDGE_DB_PATH` as the database path), so an old client configuration keeps its data. When both are set the new name wins. `onememory doctor` says when it mapped an old name, and `onememory setup` rewrites an old claude-bridge entry with the new names.
