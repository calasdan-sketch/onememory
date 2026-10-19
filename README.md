# OneMemory

**One small, self-hosted memory store that every AI agent you use can share — over MCP or plain REST, from your desktop, the web, or your phone.**

[![CI](https://github.com/calasdan-sketch/onememory/actions/workflows/ci.yml/badge.svg)](https://github.com/calasdan-sketch/onememory/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/onememory-mcp)](https://www.npmjs.com/package/onememory-mcp)
![License](https://img.shields.io/badge/license-MIT-blue)
![Node](https://img.shields.io/badge/node-%3E%3D24-green)

Write a note from Claude Code on your desktop; read it back from Claude on
your phone in a fresh chat. Same store for Claude Code, Claude Desktop,
claude.ai, Claude mobile, Cursor, Copilot, Cline, Continue, n8n — anything
that speaks MCP or HTTP.

---

## Quickstart

> **Requires Node.js 24 or newer.** OneMemory uses Node's built-in
> `node:sqlite`, which does not exist in Node 22 or older. Check with
> `node -v`. Can't upgrade? Use [Docker](#docker) instead.

```bash
npm install -g onememory-mcp                     # 1. install (or skip and use npx below)
claude mcp add onememory -- onememory mcp        # 2. wire it into your agent (stdio)
onememory start                                  # 3. optional: dashboard + REST + MCP-over-HTTP
```

No global install: `claude mcp add onememory -- npx -y onememory-mcp mcp`.
`onememory init` prints the config for Claude Desktop / Cursor / Copilot;
[INSTALL.md](./INSTALL.md) has every client. `onememory doctor` checks Node,
the database, the token and the hooks.

`onememory start` serves the dashboard and REST API on `:8790` and
MCP-over-HTTP on `:8791` (bound to `127.0.0.1`). To reach it from your phone
or claude.ai, put an authenticated tunnel (Cloudflare Tunnel + Access,
Tailscale, or your own TLS proxy) in front of `:8791` — see
[INFRA.md](./INFRA.md).

Plain REST works too (the token is in `~/.onememory/.token`):

```bash
TOKEN=$(cat ~/.onememory/.token)
curl -X POST localhost:8790/notes -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"title":"Deploy day","body":"Shipped v1.1"}'
curl -H "Authorization: Bearer $TOKEN" "localhost:8790/search?q=deploy"
```

### Where your data lives

Everything (database, token, scoped tokens, spaces config) lives in
`~/.onememory` (Windows: `%USERPROFILE%\.onememory`), outside the installed
package, so `npm update` and npx cache cleanups never touch it. Set
`ONEMEMORY_HOME` to put it elsewhere, or `ONEMEMORY_DB_PATH` for just the
database. On macOS/Linux the folder is owner-only (`0700`, files `0600`).
A from-source git checkout that already has `./data/state.db` keeps using
it. `onememory doctor` shows which directory is in use.

**Upgrading from 1.0.x**, whose data sat inside the package: `npm install -g
onememory-mcp` copies the old `data/state.db` and token files into
`~/.onememory` before npm removes the old version (and a first start that
still finds them copies them too), printing what it did. To be safe, copy
them yourself **before** upgrading (stop the server first):

```bash
mkdir -p ~/.onememory && cp -Rn "$(npm root -g)/onememory-mcp/data/." ~/.onememory/
```

(Windows: copy `%APPDATA%\npm\node_modules\onememory-mcp\data\*` to
`%USERPROFILE%\.onememory\`.) Then run `onememory rebuild-edges` once.

### Docker

```bash
cp .env.example .env     # set ONEMEMORY_TOKEN (openssl rand -hex 32)
docker compose up -d     # dashboard at http://localhost:8790
```

---

## What makes it different

- **Lightweight.** One Node process, one SQLite file, **2 direct runtime
  dependencies** (`@modelcontextprotocol/sdk`, `zod`; ~94 packages installed
  in total, mostly the MCP SDK's own), no native modules, no vector database,
  no Python. Back it up by copying one file.
- **Change feed.** `memory_since` / `GET /changes`: "what changed while I was
  away" — created, updated **and deleted** notes grouped by source, with a
  per-device "since I last looked" marker. Driven by a local change log, so
  restores, file-sync imports and deletes are never missed. → [docs/change-feed.md](./docs/change-feed.md)
- **Memory linter.** Every write is scanned for secrets (API keys, JWTs,
  private keys, high-entropy tokens) and prompt-injection instructions
  ("ignore previous instructions", chat-template markers, tool-call
  coercion). Secrets are blocked; injection is quarantined for admin review
  and invisible to search and recall until approved. Tuned and tested for low
  false positives. → [docs/memory-linter.md](./docs/memory-linter.md)
- **Plain-file sync.** `onememory export --format md --dir` writes one
  Markdown file per note with YAML front-matter, deterministic and
  git-friendly; `onememory import --dir` merges edits back three-way — newer
  wins, conflicts reported and the losing version kept, never silently lost.
  Works across machines through GitHub or Syncthing. → [docs/file-sync.md](./docs/file-sync.md)
- **Scoped tokens.** `read` / `write` / `admin` bearer tokens, enforced
  identically on REST and MCP — give your phone a read token and a leaked
  token can't wipe the store.
- **MCP *and* a plain REST API** on the same store, plus a small dashboard.

Also included: optional semantic / hybrid search with your own embeddings
endpoint (Ollama or any OpenAI-compatible API), natural-language time
filters ("yesterday evening"), staleness warnings, near-duplicate
consolidation, a similarity graph, access-based ranking, server-side
namespace isolation, and a Claude Code SessionStart recall hook.
→ [docs/search.md](./docs/search.md)

---

## How it works

```mermaid
flowchart LR
    subgraph Agents["Your agents"]
        CC["Claude Code"]
        CD["Claude Desktop"]
        PH["Phone / Web"]
        CU["Cursor / Copilot"]
    end
    subgraph OM["OneMemory (one Node process)"]
        MCP["MCP server\n(stdio + HTTP)"]
        REST["REST API + Dashboard"]
        LINT["Memory linter\n(secrets + injection scan)"]
        DB[("SQLite\n(one file)")]
    end
    CC <--> MCP
    CD <--> MCP
    CU <--> MCP
    PH <-->|tunnel| REST
    MCP --> LINT --> DB
    REST --> LINT
```

Write once from your desktop, read back from your phone — every agent
shares the same store.

## How it compares (as of October 2026)

Other good projects solve overlapping problems. This table only lists things
we could confirm from each project's own docs as of October 2026; "—" means
*not documented there as far as we found*, not "impossible", and "?" means we
could not verify it either way. Corrections welcome.

| | **OneMemory** | [mcp-memory-service](https://github.com/doobidoo/mcp-memory-service) | [Basic Memory](https://github.com/basicmachines-co/basic-memory) | [OpenMemory (mem0)](https://docs.mem0.ai/openmemory) | [Official MCP memory server](https://github.com/modelcontextprotocol/servers/tree/main/src/memory) |
|---|---|---|---|---|---|
| License | MIT | Apache-2.0 | AGPL-3.0 | open source; also hosted | MIT |
| Runtime | Node 24; 2 direct runtime deps (~94 packages installed incl. the MCP SDK) | Python | Python | Docker + OpenAI API key | Node |
| Storage | one SQLite file | SQLite-vec, Cloudflare, Milvus, or hybrid | Markdown files + index | local Docker service | JSONL knowledge graph |
| Self-hosted remote access (HTTP) | ✅ | ✅ (OAuth 2.1) | separate cloud product | hosted option | local process (stdio) |
| Semantic search | optional, your endpoint | ✅ local ONNX | ✅ hybrid | ✅ | — |
| Time-phrase queries | ✅ | ✅ | ✅ (`recent_activity` / `build_context` timeframe) | — | — |
| Consolidation / dedup | ✅ | ✅ | — | — | — |
| Change feed incl. deletes + per-device "since last" marker | ✅ | ? | — | — | — |
| Write-time secret + injection linter | ✅ | ? | — | — | — |
| Markdown files | export / three-way import | ingest only | ✅ native (source of truth) | — | — |
| Scoped read/write/admin tokens | ✅ | API keys + OAuth | — | client access controls (dashboard) | — |

**When to pick something else** (as of October 2026): if you want a mature Python stack with
local embeddings and cloud sync, look at **mcp-memory-service**; if you want
Markdown files to *be* the database and a knowledge-graph note system, use
**Basic Memory**; if you want a managed service, **OpenMemory**; if you just
need a minimal local knowledge graph, the **official memory server**.
OneMemory's niche: the smallest footprint that still gives you remote
access, safety rails on what agents write, and a way to see what changed.

---

## MCP tools

| Tool | Scope | |
|---|---|---|
| `state_write` / `state_read` / `state_delete` | write / read / admin | CRUD with compare-and-swap (`if_rev`) and provenance (`source`) |
| `state_search` / `state_relevant` / `state_list` | read | keyword, semantic or hybrid search; vague-message recall; listing |
| `memory_since` | read | change feed |
| `memory_stats` | read | totals, most-read, never-read, stale |
| `memory_quarantine` | admin | review linter-held writes |
| `memory_consolidation_candidates` / `memory_consolidate` / `memory_rebuild_edges` | admin | dedup and similarity-graph maintenance |

REST mirrors them (`/notes`, `/search`, `/relevant`, `/changes`, `/stats`,
`/export`, `/import`, …). Full reference: [docs/architecture.md](./docs/architecture.md).

## CLI

```
onememory start | mcp | doctor | init
onememory changes --since last --consumer laptop
onememory export --format md --dir ~/memory     onememory import --dir ~/memory
onememory quarantine [list | approve <id> | reject <id>]
onememory consolidate | rebuild-edges | reindex | relevant "…" | recall
```

`onememory help` explains each. The CLI runs with full local trust (no
token).

---

## Security in one paragraph

Loopback by default and fail-closed: it refuses to bind a public interface
without an explicit `ONEMEMORY_TOKEN`. Constant-time bearer auth on every
data route, scoped tokens, DNS-rebinding Origin checks, per-client rate
limits, size caps, an append-only audit log without note content, the
write-time linter above, and an untrusted-data banner on every read so
agents treat note content as data, not instructions. Your notes stay in one
file on your machine; a tunnel only carries requests. Details and known
limits: [SECURITY.md](./SECURITY.md).

## Documentation

| | |
|---|---|
| [INSTALL.md](./INSTALL.md) | every MCP client |
| [INFRA.md](./INFRA.md) | tunnels, phone/web access, n8n |
| [docs/configuration.md](./docs/configuration.md) | all environment variables, server-side namespace resolution |
| [docs/search.md](./docs/search.md) | semantic, time-aware and relevant search; staleness; consolidation |
| [docs/change-feed.md](./docs/change-feed.md) | `memory_since` / `GET /changes` |
| [docs/memory-linter.md](./docs/memory-linter.md) | `ONEMEMORY_LINT`, detection rules, quarantine |
| [docs/file-sync.md](./docs/file-sync.md) | Markdown export/import, GitHub and Syncthing workflows |
| [docs/sessionstart-hook.md](./docs/sessionstart-hook.md) | automatic recall at Claude Code session start |
| [docs/architecture.md](./docs/architecture.md) | modules, tools, REST API, schema |
| [SKILL.md](./SKILL.md) | when and how an agent should use the memory |
| [CHANGELOG.md](./CHANGELOG.md) | release notes |

## Credits

Several ideas were adapted from other open projects, with thanks:

- **[llmem](https://github.com/netrixone/llmem)** — consolidation candidates,
  the similarity-edge graph, access-count importance, `#status` staleness, and
  the context/relevant split with keyword extraction.
- **lontar** (rymanalu, described in *"One memory across AI agents: what it
  actually takes"* on dev.to) — the fail-silent SessionStart recall hook,
  server-side namespace resolution from the working directory, and
  one-directional `reads_from` grants.
- **[lossless-memory](https://github.com/aru-labs/lossless-memory)** —
  natural-language time phrases as a first-class query filter.

## License

MIT — see [LICENSE](./LICENSE). Built by Dan Calas / Calas Automations Inc.
