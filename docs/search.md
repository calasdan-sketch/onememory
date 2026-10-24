# Search, recall and memory hygiene

## Semantic search (optional)

Keyword (FTS5) search is the default and needs nothing extra. Turn on
meaning-based search and the bridge will also embed each note so a query like
*"canine companion"* finds a note about your dog that shares no words with it:

```bash
export ONEMEMORY_EMBEDDINGS=on
export ONEMEMORY_EMBED_URL=http://localhost:11434/v1/embeddings  # Ollama default
export ONEMEMORY_EMBED_MODEL=nomic-embed-text
node dist/src/cli.js reindex   # backfill embeddings for existing notes
```

Embeddings come from **your own** OpenAI-compatible endpoint (local Ollama,
or any OpenAI-shaped `/v1/embeddings` API) — still zero native modules, still
nothing sent to a third party you didn't configure. `state_search` /
`GET /search` then accept `mode=keyword | semantic | hybrid` (hybrid fuses
both with Reciprocal Rank Fusion). If the endpoint is unavailable, search and
writes silently fall back to keyword — an optional embedder can never fail a
write or a query.

## Time-aware search

`state_search` takes an optional `when` parameter (and `GET /search` takes
`?when=`) with a natural-language time phrase. It scopes results to notes
**created** in that window; keywords still rank within it. An unrecognized
phrase is ignored — the query runs unscoped rather than erroring.

```
state_search({ query: "budget", when: "yesterday evening" })
state_search({ query: "",      when: "last week" })   # time-only: newest-first list of the range
GET /search?q=invoice&when=Oct+14
```

Supported phrases (case-insensitive, found anywhere in the string, so
`"yesterday about the budget"` works — the time part scopes, the rest ranks):

- `today`, `yesterday`, `3 days ago`, `a day ago`
- `last week` / `this week` (weeks start **Monday**), `last month` / `this month`
- `in july`, `in july 2025` (bare month = most recent such month, never future)
- Dayparts: `this morning`, `yesterday evening`, `tonight`, `last night`
  (morning 05–12, afternoon 12–17, evening 17–22, night 22–05 next day;
  `tonight` = 17:00 → 05:00 next day)
- Clock times: `around 3pm`, `at 14:30`, `3pm yesterday` (±30 min window)
- Absolute: `2026-10-14`, `Oct 14`, `October 14 2025`, `10/14/2026`
  (numeric dates are **MM/DD**; a missing year means the most recent past occurrence)

Day boundaries are computed in your timezone: set `ONEMEMORY_TIMEZONE`
(e.g. `America/Winnipeg`, default: the host's system timezone). Invalid names fall back to UTC.

## Relevant-memory search

Don't know the exact wording? `state_relevant` takes a natural conversational
message, extracts keywords from it (lowercase, stop-words removed, hashtags
like `#status` kept as-is), and returns notes matching **any** of them —
a deliberately permissive OR search, unlike `state_search`'s AND conjunction.
Results rank by most keyword hits first, then newest. The extracted keywords
are returned alongside the results so you can see what was searched.

```
state_relevant({ message: "what did we decide about the acme launch?" })
# -> { keywords: ["decide", "acme", "launch"], results: [...] }
```

Same over HTTP: `POST /relevant` with `{ message, limit?, namespace? }`
(read-scoped), and on the CLI: `onememory relevant "some message" [--limit 5]`.

## Staleness detection

Facts go stale. `state_read` and `state_search` (and `GET /notes/:id`,
`GET /search`) annotate every note with `stale: boolean` and
`ageDays: number` (whole days since `updated_at` — the most recent write
wins). When a note is stale, a `staleWarning` string is included, e.g.:

> "This note is 45 days old (tagged #status, expires after 30 days).
> Verify against current state before acting on it."

Stale notes are never hidden or deleted — they stay findable, but search
ranks them slightly lower (their score is multiplied by 0.9), so a fresh
note with comparable relevance wins. Agents should verify a stale note
against current state before acting on it.

Thresholds (env vars, read live — no restart needed to retune):

| Variable | Default | Meaning |
|---|---|---|
| `ONEMEMORY_STALE_DAYS` | `90` | Notes older than this (by `updated_at`) are stale |
| `ONEMEMORY_STALE_TAGS` | `#status` | Comma-separated tags that expire faster (matched with or without `#`) |
| `ONEMEMORY_STALE_TAG_DAYS` | `30` | Expiry for notes carrying a stale tag |
| `ONEMEMORY_ACCESS_BOOST` | on | Set to `0` to turn off the access-count boost and staleness penalty in search ranking (results then follow native relevance only, as in 1.0.0); access counts are still recorded |

Invalid values fall back to the defaults. Staleness is per-note and
namespace-agnostic — it never crosses (or needs to know about) namespace
isolation boundaries.

## Consolidation (dedup)

Agents re-storing the same fact ("our API base URL is …" saved three times
in slightly different words) bloats the store and muddies search results.
Consolidation finds near-duplicates by **cosine similarity over
term-frequency vectors** (title + body, lowercase, stopwords removed;
Jaccard available as a secondary metric — zero new dependencies) and merges
them: longest title wins, bodies are deduplicated and joined with `---`,
tags are unioned.

**Candidate detection never crosses namespaces** — namespaces are an
isolation boundary, so a pair is only ever suggested when both notes live in
the same one. Detection is O(n²) and capped: beyond 2,000 notes (or ~2 MB
of title + body text) only the most recently created notes are scanned.

MCP tools:

| Tool | Scope | What it does |
|---|---|---|
| `memory_consolidation_candidates` | **admin** | Lists near-duplicate pairs (score ≥ threshold, default 0.95) with both titles so the model can judge. Admin because the scan is O(n²) CPU; one scan runs at a time, under a 15 s budget, and stops if the client disconnects |
| `memory_consolidate` | **admin** | Merges 2+ ids into one note. `dry_run: true` previews the merge without writing; `keep_sources: true` skips deleting the originals. Gated at admin because it deletes, like `state_delete`. |

CLI (safe by default — reports only, unless you opt in):

```bash
node dist/src/cli.js consolidate                          # list candidates
node dist/src/cli.js consolidate --dry-run                # preview each merge
node dist/src/cli.js consolidate --yes                    # actually merge
node dist/src/cli.js consolidate --threshold 0.98 --namespace acme
```

**Scheduled auto-consolidation** (opt-in):

```bash
export ONEMEMORY_AUTO_CONSOLIDATE_INTERVAL=24h   # or "30m", "90s", "3600" (seconds)
```

When set, `onememory start` runs a background pass on that interval that
**logs** every candidate pair ≥ 0.95 for review — and only auto-merges pairs
scoring **≥ 0.99** (near-identical notes, e.g. the same fact saved twice
verbatim). Weaker duplicates are never merged blindly; review them with
`memory_consolidation_candidates` or the CLI. The scheduler never throws: a
background janitor must not take down the server.
