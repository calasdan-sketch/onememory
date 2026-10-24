# Configuration

All environment variables are optional:

| Variable | Default | Purpose |
|---|---|---|
| `ONEMEMORY_HOME` | `~/.onememory` (Windows `%USERPROFILE%\.onememory`) | Data directory: database, `.token`, `tokens.json`, `spaces.json`. A git checkout that already has `./data/state.db` keeps using `./data`. 1.0.x data found inside the package is copied here once on start. Created owner-only (`0700`, files `0600`) on POSIX and re-tightened on every start |
| `ONEMEMORY_DB_PATH` | `<data dir>/state.db` | SQLite file path (overrides the data dir for the database only) |
| `ONEMEMORY_NO_CHMOD` | unset | `1` = never tighten data-dir permissions to 0700/0600 (for deliberately shared dirs) |
| `ONEMEMORY_TOKEN` | auto-generated → `<data dir>/.token` | Primary (admin) bearer token; required to bind a public interface |
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
| `ONEMEMORY_AUDIT_LOG` | `~/.onememory/audit.log` (`$ONEMEMORY_HOME/audit.log`) | Append-only audit log path (records operations, never note content) |
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
| `ONEMEMORY_IMPORT_MAX_BYTES` | `268435456` (256 MB) | Request-body cap for `POST /import` (clamped to 1 MB - 2 GB). Other routes keep the 1 MB cap |
| `ONEMEMORY_URL` | unset | Base URL (e.g. `http://localhost:8790`) used only by the runner signing helper's `--post` mode, together with `ONEMEMORY_TOKEN`. Not read by the server |
| `ONEMEMORY_LINT` | `secrets=block,injection=quarantine` | Write-time memory linter policy: `block`, `quarantine`, `warn`, or per category (`secrets=block,injection=warn`). See [memory-linter.md](./memory-linter.md) |
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
