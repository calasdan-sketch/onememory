# Security & Threat Model — OneMemory

OneMemory is a note store exposed over MCP + HTTP. **Treat all stored
content as untrusted input to your agents** — see "Memory safety" below.

## Controls

- **Network:** binds `127.0.0.1` by default. Public exposure is opt-in
  (`ONEMEMORY_BIND`) and the server **refuses to start** on a non-loopback
  address unless you set an explicit `ONEMEMORY_TOKEN`. Public deployments
  are expected to sit behind an authenticated tunnel (e.g. Cloudflare Tunnel +
  Cloudflare Access). The **Origin** header is validated (DNS-rebinding
  defense); browser origins are blocked unless listed in
  `ONEMEMORY_ALLOWED_ORIGINS`.
- **Auth:** a bearer token is required on every route except `/health` and
  `/ready`. Each token is compared in constant time (a minor side-channel on
  token length/count is not fully eliminated, which is immaterial for the
  high-entropy tokens this uses behind a tunnel). Tokens are never placed in
  URLs and are never logged. The primary token file is created `0600` and is
  git-ignored.
- **Scoped tokens:** besides the primary (admin) token, you can define extra
  `read` / `write` / `admin` tokens via `ONEMEMORY_TOKENS` (a JSON array)
  or a `~/.onememory/tokens.json` file, so a leaked read-only token can't write, delete
  or dump the store. Scopes are enforced identically on the REST API and the
  MCP tools; `/export` (a full-store dump), `/import` and all deletes require
  `admin`. If you use `~/.onememory/tokens.json`, it is re-`chmod`ed `600` on every start (POSIX) — it holds credentials
  and the app reads but does not set its permissions.
- **Rate limiting:** per-client fixed-window limiter (defaults configurable via
  `ONEMEMORY_RATE_MAX` / `ONEMEMORY_RATE_WINDOW_MS`) so a leaked token
  can't be brute-forced or hammered. Over-limit requests get `429`.
- **Input validation:** per-note size caps (title/body/tags), a 1MB request
  body cap, and parameterized SQL only (no string-built queries).
- **Secret guard:** writes are scanned for high-confidence credentials (AWS
  keys, private-key blocks, provider API tokens, etc.) and **rejected** by
  default (`ONEMEMORY_LINT`), since a memory store is where secrets get pasted
  by accident.
- **Audit log:** an append-only log records every mutation (op, id, namespace,
  byte count) — **no note content and no secrets** are logged.
- **Supply chain:** committed lockfile + `npm ci`, Dependabot, `npm audit` in
  CI, and MIT-licensed with only two production dependencies.

## Threat model (short)

- **Assets:** note bodies, and the bearer tokens.
- **Attackers considered:** someone who obtained a token (leak, shared
  device); malicious text inside a note (stored prompt injection); a person
  who steals a disk image or backup.
- **Trusted:** the CLI and the stdio MCP transport run with full local trust
  and use no token. Anyone with shell access to the machine and its data
  directory owns the store.
- **Not covered:** a live attacker holding a valid admin token; an attacker
  who can read both the database and the key file; prompt injection is
  mitigated, not eliminated (OWASP GenAI #1); there is no OAuth, only static
  bearer tokens.

## Encryption at rest (shipped in 1.2.0)

`onememory encrypt enable` encrypts note **bodies** with AES-256-GCM. The
limits, stated plainly:

- **Titles, tags and timestamps stay plaintext.** Search and namespace
  isolation need them. Keyword search covers title + tags only while
  encryption is on.
- **Embeddings bypass encryption.** If you enable semantic search, the
  decrypted body is sent to your `ONEMEMORY_EMBED_URL` endpoint, and the
  resulting vectors are stored unencrypted (vectors can leak information
  about the text). Leave embeddings off if that matters.
- **The key sits beside the database** (`~/.onememory/.key`, mode `0600`, or
  `ONEMEMORY_KEY_FILE`). A backup of the whole data directory contains both,
  so encryption protects against a stolen database file or a backup of the
  database alone, not against someone who gets the whole directory. There is
  no re-key command.
- **Binding of ciphertext to its row (AAD):** 1.2.0 did not bind a body's
  ciphertext to its note id and namespace, so someone who could write to the
  SQLite file could copy ciphertext between rows. 1.2.1 addresses this (see
  the CHANGELOG; confirm for the version you run).
- Quarantined (linter-held) writes are sealed too in 1.2.1; in 1.2.0 they
  were stored in plaintext.
- `GET /export` returns decrypted bodies, so treat exports as sensitive.
- Details: [docs/encryption-retention.md](./docs/encryption-retention.md).

## Namespaces and tokens

- Besides the primary admin token you can define `read` / `write` / `admin`
  tokens. A token can also be **pinned to one namespace**; a pinned token
  (even an admin one) cannot read or write another namespace. See
  [docs/token-namespaces.md](./docs/token-namespaces.md).
- Rotate by setting a new `ONEMEMORY_TOKEN` or deleting
  `~/.onememory/.token`; a leaked token works until you do.

## Memory safety

A note store whose contents are read back by autonomous agents is a **stored
prompt-injection / "memory poisoning"** channel. Layers:

- **Write-time linter:** secrets (API keys, private keys, JWTs,
  high-entropy tokens) are blocked; prompt-injection phrasing is
  **quarantined**, invisible to search and recall until an admin approves it
  (`onememory quarantine`). It is a pattern linter: it will miss novel
  phrasing and can flag harmless text. See
  [docs/memory-linter.md](./docs/memory-linter.md).
- **Untrusted-data banner on every MCP read** (and `onememory recall`).
  REST responses do not carry it; REST callers must apply the same rule.
- **SKILL.md** tells agents to treat note content as data, never as
  instructions. If you integrate the tools yourself, enforce the same rule.

## Limitations (stated honestly)

- Single-user, single-node SQLite. No clustering, no multi-tenant isolation
  beyond namespaces on one process.
- Only the latest revision of each note is kept; there is no edit history to
  roll back to. Backups are snapshots.
- The similarity-edge graph rebuild is O(n^2); large imports defer it.
- Keyword extraction for recall is English-oriented.
- Requires Node.js 24+ (built-in `node:sqlite`).
- **Restore into an empty store.** `POST /import` does not de-duplicate:
  importing a backup into a store that already holds those notes creates
  duplicates.
- Rate limiting is per client address and runs before authentication;
  behind a shared tunnel, clients share a bucket.
- The audit log records operations, never note content.
- Encryption limits are listed above.

## Reporting a vulnerability

Please open a private security advisory on the GitHub repository, or email the
maintainer. Do not file public issues for security reports.
