# The provenance benchmark (`onememory bench`)

A memory shared by several agents needs more than good search. It needs to say where a fact came from, when,
for whom, and what happens when it is wrong or old, so that one agent cannot quietly turn a weak guess into
shared truth. This benchmark checks that behaviour. It is deterministic, offline, uses no model, and runs on a
throwaway store, so it can gate CI.

```
onememory bench                 # human table; exit 1 if any scenario fails
onememory bench --json          # every scenario, every check, expected vs actual
npm run bench                   # same, from a checkout (builds first)
```

It never touches your own data: it creates a temporary folder, starts a private server on `127.0.0.1` with
random tokens, hides every `ONEMEMORY_*` setting while it runs, writes its audit log into the temporary
folder, and deletes everything when it ends.

## What it measures

Five suites, written as plain JSON files in [`bench/scenarios/`](https://github.com/calasdan-sketch/onememory/tree/main/bench/scenarios) (they ship in the package).

| Suite | Question | Headline numbers |
|---|---|---|
| **A  Stale memory** | After a fact is updated, replaced or deleted, does search return the current value first and never the old one (or flag it)? | `stale-hit-rate@1`, `stale-hit-rate@5`, `unflagged-stale-hit-rate@5`, `current-recall@1` |
| **B  Contradiction recovery** | Writer A says X, writer B says not-X, a trusted correction arrives. Does the state end up at the correction, does the loser stay visible with its writer, does distrusting the bad writer fix the answer, can a weak writer overwrite a trusted note silently? | resolved to the correction, loser still visible with provenance, weak overwrite protected |
| **C  Permission isolation** | Can tenant B read, write, search, export, import, merge, archive, sweep or learn anything about tenant A? Do tokens do exactly what their scope says? | `leakage-count` (must be 0) and `unexpected-denials` |
| **D  Provenance retention** | After export, import, merge, update, archive, expiry: is every field (source, writer, creator, timestamps, deletion deadline, confidence) still there? | `fields-checked`, `fields-lost`, `fields-kept-only-as-unverified-claim` |
| **E  Memory poisoning** | Do injected or malicious memories ever reach an agent as trusted content? Prompt-injection (plain, forged system/tool tags, zero-width-obfuscated) quarantined; a distrusted or low-trust writer cannot outrank or silently overwrite a trusted fact; secrets redacted on capture and blocked on write; a forged writer/namespace stamped with the real one; an unsigned import cannot pose as verified; a captured web fetch is not trusted memory; the SessionStart injection carries the untrusted-data banner and leaves distrusted notes out; mass near-duplicate flooding cannot bury the answer. | `poison-reach-count` (must be 0) over the suite's defended probes |

**How the numbers are counted.**

- A "stale hit" is a result whose title or body still carries the old value (or that is the old note), and an
  *unflagged* stale hit is one the system did not mark as stale. `stale-hit-rate@1` is the share of
  queries that name an old value whose first result is stale, `@5` the share with a stale value anywhere in the top five.
  `current-recall@1` is the share of queries (with a current note) where the current note is first. These are
  rates over a small, hand-written set (15 and 14 queries at 1.6.0; 14 and 13 at 1.5.0): read them as a checklist, not as statistics.
- A scenario passes only if all its checks hold. For stale-memory queries that means: current value first (when
  there is one) and no old value in the top five unless it is flagged stale.
- `leakage-count` is the number of failed attack probes (a cross-tenant read that worked, a secret that
  appeared in a result, a refusal that was not refused). `unexpected-denials` is the number of legitimate
  actions that were refused. Both are counted over the probes written in the scenarios, and the report says how many.
- `fields-lost` counts provenance checks that failed. `fields-kept-only-as-unverified-claim` counts a value that
  survived only as a labelled, unverified claim (what an import does by design with an unsigned export).
- `poison-reach-count` is the number of poison-suite probes (checks tagged `metric: "poison_reach"`) that failed — a poison that
  reached an agent as trusted content. It is counted only over scenarios the suite claims to defend (pass/fail), so a declared
  known gap is reported separately and never adds to it. It must be 0.

## What it does not measure

- **Not retrieval quality.** Search here is keyword search with made-up unique words. There are no embeddings,
  no paraphrases, no relevance judgements. For that, see [Retrieval: LongMemEval-S and LoCoMo](#retrieval-longmemeval-s-and-locomo)
  below and the retrieval evaluation set in `evals/`.
- **Not speed, scale or concurrency.** Each scenario is a handful of calls on an empty store.
- **Not proof of safety.** "0 leaks" means none of the probes written here leaked. It is a regression gate, not
  an audit.
- **A deployed server.** It runs one process on the loopback interface. TLS, proxies and tunnels are not involved.
- **One reading of "provenance".** The scenarios encode one opinion of what a good system does. Another system
  may reasonably choose differently; scenarios are plain JSON so they can be changed or replaced.
- Notes that must look old are placed in the past through the admin import path, so they are stamped with the
  importing admin as writer. The clock is real, so the benchmark never waits.

## Known gaps

A scenario that fails because OneMemory genuinely lacks the behaviour is **not hidden and not weakened**. It
carries `"known_gap": "GAP-..."`, and the gap is described in `bench/scenarios/known-gaps.json`. A known gap is
printed in its own section and does not fail the run (use `--strict-gaps` to fail on them). If a marked
scenario starts to pass, the run **fails** with "known gap now PASSES": remove the marker and mark the gap
`fixed`. The current list is in the README's "Benchmark" section.

**1.6.0 closed every gap 1.5.0 recorded** (`GAP-SUPERSEDE`, `GAP-RECENCY`, `GAP-HISTORY`, `GAP-CONFIDENCE`, all now `fixed`), so no
shipped scenario carries a marker any more. The mechanism stays for the next gap. Two honest notes on what "closed" means here:

- Five of the old gap scenarios (A05, A06, A10, A20, B03) now include the replace steps: the agent *replaces* the old note through
  the two-step preview and confirm. OneMemory still does **not** guess that a new note replaces an old one and hide the old one by
  itself; that is a deliberate safety choice (nothing disappears unless a person confirms). Run against the 1.5.0 scenario files,
  1.6.0 still returns both notes for those five.
- A11 (a 200-day-old twin) passes through the ranking fix alone, B08 through note history, D10 through the confidence field,
  and B09 through restoring the earlier version after distrusting the overwriter.

## Scenario files

One scenario per file, `bench/scenarios/<ID>-<slug>.json`. `<ID>` is the suite letter (A stale, B contradiction, E poison,
C isolation, D provenance) and a number. Add a file and it runs; no code change.

```json
{
  "id": "A01",
  "suite": "stale",
  "title": "A fact is corrected in place",
  "what": "One or two plain sentences: what this protects against.",
  "actors": { "alice": { "scope": "write" } },
  "steps": [
    { "op": "write",  "as": "alice", "ref": "n", "title": "Deploy region for {{proj}}", "body": "Deploys to {{old}}." },
    { "op": "update", "as": "alice", "ref": "n", "body": "Deploys to {{new}}." },
    { "op": "search", "as": "alice", "q": "{{proj}} deploys", "id": "now" }
  ],
  "expect": [
    { "check": "fresh_answer", "step": "now", "current": "n", "stale_text": ["{{old}}"],
      "desc": "The corrected note is first and nothing carries the old value" }
  ]
}
```

**Top level.** `id`, `suite` (`stale`, `contradiction`, `isolation`, `provenance`, `poison`), `title`, `what`, `actors`,
`steps`, `expect` are required. Optional: `grants` (tenant -> tenants it may also read), `distractors` (N
unrelated notes written first), `needs` (extra capabilities), `settings` (`{"supersede_ttl_seconds": 1}`: a very short confirmation window, for expiry scenarios), `known_gap`, `limit` (a documented limit shown
in the report).

**Placeholders.** `{{name}}` in any string becomes a made-up lowercase word plus two digits, the same every
run for the same `--seed` (default 1), scenario and name. Words are unique per name, so keyword search is never
the thing being tested. Adding a scenario never changes another scenario's words.

**Actors.** `"alice": { "scope": "write", "namespace": "tenantA", "writer": "agentA", "server": "main" }`.
`scope` is `read`, `write` or `admin` (default `write`). `namespace` confines the actor to a tenant. `writer`
is the identity the system should stamp (default: the actor's name). `server` puts the actor on another
instance (default `main`), which is how a note is moved between two servers.

**Steps.** Each step has `op` and `as` (an actor). Results are stored under `id`; `write`, `update`, `delete`,
`archive`, `unarchive`, `read`, `merge`, `distrust`, `undistrust` and `trust_server` get the default id
`<op>:<ref>` (or `<op>:<writer>`), so a check can say `"step": "write:n"`.

| `op` | Fields | What it does |
|---|---|---|
| `write` | `ref`, `title`, `body`, `tags`, `source`, `confidence`, `forget_after`, `namespace`, `age_days`, `expires_in_days` | Create a note. `ref` names it for later steps. `age_days` / `expires_in_days` (negative = already past) place it in time (needs `restore`). `namespace` is a claim that a tenant-confined system must ignore. `age_days` and `expires_in_days` go through the admin restore path, so the actor must be an admin (and is then the stamped writer). |
| `update` | `ref`, `title`, `body`, `tags`, `source`, `confidence`, `if_rev_of` | Partial update. `if_rev_of` is the id of an earlier `read` step whose revision is sent as a compare-and-swap guard. |
| `delete`, `archive`, `unarchive`, `read` | `ref` (`read` also `include_distrusted`) | Act on a note. |
| `search` | `q`, `id`, `limit`, `include_distrusted`, `include_superseded`, `namespace` | Search, best first. |
| `supersede_preview` | `id`, `old` (refs), `new_note` (`{title, body, tags, confidence}`) or `new_ref` | Step 1 of a replacement. Must change nothing. Stores the one-time code under `id`. |
| `supersede_confirm` | `id`, `from` (a preview step's id), `new_note`, `acknowledge_risk`, `ref`, `corrupt_code` | Step 2. Uses the code from `from` (the same new text unless `new_note` is given; `corrupt_code` damages the code). `ref` names the replacement note. Run it `as` another actor to test that a code works for nobody else. |
| `supersede_undo` | `ref` | Bring a replaced note back. |
| `history`, `restore_version` | `ref`, `id`; `version`, `if_rev_of` | A note's earlier versions; put one back as a new version. |
| `list`, `recall`, `changes`, `sweep` | `id` | List notes, "what is relevant to this message" (`q`), the change feed, run the expiry sweep. |
| `distrust`, `undistrust` | `writer`, `namespace` | Manage the distrust list. |
| `export`, `import` | `export`: `id`, `attest`. `import`: `from` (an export's id), `id`, `require_attestation`, `tamper` | Move notes between servers. `tamper` changes one field of the payload in transit. |
| `trust_server` | `of` | Make the actor's server believe signatures made by server `of`. |
| `merge` | `refs`, `ref` | Merge duplicate notes into a new one. |
| `capture` | `id`, `event`, `tool`, `input`, `output`, `session`, `namespace` | Record one automatic-memory hook event (a tool output, a web fetch) the way the capture hooks do. The step result's `text` is what was actually persisted after redaction, so a `no_text` / `contains_text` check can prove secrets never reach the capture store. Needs the `capture` capability. |
| `session_start` | `id`, `namespace` | Produce the SessionStart recall injection an agent is handed before its first prompt (the product's own path, so the untrusted-data banner and the distrusted-writer filter are the ones tested). The result's `text` is the injected context. Needs the `session_start` capability. |
| `wait` | `ms` | Pause (rarely needed, at most 2 s). |

**Checks** (`expect`). Every check has a plain-language `desc`, which is what the report prints. Optional
`metric` (`leak`, `unexpected_denial`, `field`, `resolution`, `loser_visible`, `silent_overwrite`, `poison_reach`) feeds the
suite's headline numbers.

| `check` | Passes when |
|---|---|
| `outcome` | step's outcome is `is` (one word or a list): `ok`, `denied`, `not_found`, `conflict`, `invalid`, `quarantined` |
| `top`, `has`, `lacks` | first hit is `ref` / `ref` is among the hits (optionally `within` N) / it is not |
| `fresh_answer` | `current` (a ref) is first, and no hit that is a `stale` ref or contains a `stale_text` string is in the top 5 unless the system flagged it stale |
| `hit_count` | number of hits equals `is`, or is within `min` / `max` |
| `field` | one field (`path`) of a note (`of` a ref, or by exact `title`, else the first) satisfies `equals`, `not_equals`, `includes`, `present`, `same_as` or `differs_from` |
| `no_text` / `contains_text` | a string does not appear / appears (in at least one of `steps`) anywhere in the step's result |
| `same_response` | two refused steps were refused with the same outcome and words (no existence oracle) |
| `recoverable` | `value` is found on the note in `verified_in` (verified) or `claim_in` (an unverified claim; accepted only with `"is": "claim"`) |

Note fields usable in `path`: `id`, `namespace`, `title`, `body`, `tags`, `source`, `writer`, `creator`,
`created_at`, `updated_at`, `expires_at`, `stale`, `distrusted`, `imported_unverified`, `claimed_writer`,
`attested_writer`, `taint`, `confidence`, `status`, `superseded_by`, `rev`. Timestamps are never printed in the report (they would make
two runs differ).

## Adapting another memory system

The engine knows nothing about OneMemory. It talks to a `MemoryAdapter`
([`src/bench/types.ts`](https://github.com/calasdan-sketch/onememory/blob/main/src/bench/types.ts)). Implement the four core calls and say which optional ones you
have:

```ts
interface MemoryAdapter {
  readonly name: string;
  readonly capabilities: ReadonlySet<Capability>;   // "read" "list" "restore" "retire" "trust" "export_import"
                                                    // "attestation" "merge" "recall" "changes" "tenants" "cas"
                                                    // "supersede" "history" "capture" "session_start"
  open(world: WorldSpec): Promise<void>;            // fresh empty store + the scenario's actors
  close(): Promise<void>;                           // delete everything; safe to call twice

  write(actor, { title, body, tags?, source?, ... }): Promise<OpResult>;
  update(actor, id, { title?, body?, tags?, source?, if_rev? }): Promise<OpResult>;
  delete(actor, id): Promise<OpResult>;
  search(actor, query, { limit?, include_distrusted?, namespace? }): Promise<OpResult>;
  // optional: read, list, recall, changes, archive, unarchive, sweep, distrust, undistrust,
  //           exportAll, importAll, trustServer, merge, supersedePreview, supersedeConfirm, supersedeUndo,
  //           history, restoreVersion
}
```

"As writer" and "as namespace" are the *actor*: `WorldSpec.actors[name]` carries `{ scope, writer, namespace,
server }`, and every call names the actor it is made as. Return `OpResult { outcome, note?, notes?, hits?, text?,
data? }` where `outcome` is one of `ok`, `denied`, `not_found`, `conflict`, `invalid`, `quarantined`,
`unsupported`, `error`, and notes use the benchmark's field names (`writer`, `creator`, `stale`, `taint`, ...;
leave out the ones your system does not have).

A scenario whose needed operations your adapter lacks is reported **skipped**, never passed. A field your
system does not have simply reads as absent, so a scenario about it fails honestly. Use it from code:

```ts
import { runBench } from "onememory-mcp/dist/src/bench/index.js";
const { report } = await runBench({ adapter: new MyAdapter(), suites: ["stale"] });
```

`test/bench.test.ts` contains a short in-memory adapter (`ToyAdapter`) used to prove the engine fails a
system that keeps stale versions or leaks across tenants.

## Using it in CI

```yaml
- run: npm ci
- run: npm run bench       # exit 1 on a failed scenario or a known gap that now passes
```

Exit codes: `0` all good (known gaps are listed but allowed), `1` a scenario failed, a known gap now passes, or
`--strict-gaps` found a gap, `2` bad command line.

## Retrieval: LongMemEval-S and LoCoMo

A second, separate benchmark measures **retrieval only** on two public long-conversation datasets. No LLM
reads anything and no judge grades anything: each conversation is written into a fresh throwaway store, the
question is searched, and the returned sessions (or turns) are compared with the dataset's own gold evidence.

```
onememory bench --longmemeval [--data file] [--limit N] [--mode keyword|hybrid] [--granularity session|turn] [--json]
onememory bench --locomo      [--data file] [--limit N] [--mode keyword|hybrid] [--granularity turn|session] [--json]
```

- **Data.** LongMemEval-S, cleaned release ([`xiaowu0162/longmemeval-cleaned`](https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned),
  `longmemeval_s_cleaned.json`, 264 MB) and LoCoMo ([`snap-research/locomo`](https://github.com/snap-research/locomo),
  `data/locomo10.json`). Without `--data` each file is downloaded once to `~/.cache/onememory-bench/`
  (outside the repository) and reused. The file is treated as untrusted data and only `JSON.parse`d.
- **Isolation.** The command points `ONEMEMORY_HOME` at a new temporary folder before the configuration
  loads, drops every other `ONEMEMORY_*` setting except the embedding ones, and refuses to run unless the
  resolved database path is inside that folder. Every haystack gets its own store, deleted afterwards.
- **Indexing.** LongMemEval: one store per question; one note per haystack session (title = session id, body =
  the turns as `role: content` lines), or with `--granularity turn` one note per turn, mapped back to its
  session for scoring. Notes are backdated to `haystack_dates` and written in one transaction, without
  similarity edges and without the write linter. LoCoMo: one store per conversation (all its questions);
  one note per dialog turn (`speaker: text`, plus the image caption when there is one), gold = the
  `evidence` dialog ids; `--granularity session` writes one note per session and scores sessions.
- **Questions.** LongMemEval's 30 abstention questions (`_abs`) have no gold session and are left out: 470 of
  500 are scored. LoCoMo questions with no usable evidence id are left out: 1,982 of 1,986.
- **Three searches are scored.** `keyword` is `runSearch(mode: "keyword")`, the path behind `state_search` and
  `GET /search`: FTS5/BM25 with every word first, then (since 2.0.0) notes matching some of the words, always ranked
  below full matches. `relevant` is `runRelevantSearch` (the `state_relevant` tool and `POST /relevant`): stop words
  dropped, any keyword qualifies, per-keyword BM25 rankings fused with RRF. `--mode hybrid` also scores
  `runSearch(mode: "hybrid")` (BM25 + embeddings, RRF) when an embedding server answers; otherwise it is reported as skipped.
- **Metrics.** `R@5`, `R@10`: any gold session (or turn) in the top k. `Rall@10`: every gold one in the top 10.
  `nDCG@10` with binary relevance. `MRR` over the top 50. Search latency p50/p95 per query; indexing time per
  haystack (single process, SQLite in a temp folder).

### Results, 2026-10-31

Machine: Windows 11 Home, RTX 5080 PC, Node v24.18.0, OneMemory 2.0.0. Embeddings for `hybrid`: `nomic-embed-text`
through a local Ollama (`ONEMEMORY_EMBEDDINGS=on`, `ONEMEMORY_EMBED_URL=http://127.0.0.1:11499/v1/embeddings`).
Commands exactly as above. Wall time with embeddings: LongMemEval session 15 min (embedding every session is the cost),
LoCoMo a few minutes; keyword-only runs take seconds.

**LongMemEval-S (cleaned), 470 questions, session granularity** (22,419 notes)

| Search | R@5 | R@10 | Rall@10 | nDCG@10 | MRR | search p50 / p95 |
|---|---|---|---|---|---|---|
| keyword (`state_search`) | 95.1 | 97.2 | 88.3 | 87.0 | 87.9 | 2.7 / 5.3 ms |
| relevant (`state_relevant`) | 95.3 | 97.4 | 88.5 | 87.1 | 88.0 | 1.4 / 3.0 ms |
| hybrid (BM25 + embeddings) | **96.8** | **98.5** | **93.0** | **90.4** | **91.4** | 21 / 30 ms |

Before the 2.0.0 fallback, `state_search` needed every word of the question and scored R@5 11.9 here.

Per question type, `relevant`:

| Type | n | R@5 | R@10 | Rall@10 | nDCG@10 |
|---|---|---|---|---|---|
| knowledge-update | 72 | 100.0 | 100.0 | 98.6 | 96.6 |
| multi-session | 121 | 97.5 | 98.3 | 77.7 | 85.6 |
| single-session-assistant | 56 | 100.0 | 100.0 | 100.0 | 96.3 |
| single-session-preference | 30 | 70.0 | 83.3 | 83.3 | 51.4 |
| single-session-user | 64 | 98.4 | 100.0 | 100.0 | 95.2 |
| temporal-reasoning | 127 | 92.9 | 96.1 | 83.5 | 83.4 |

**LongMemEval-S, turn granularity** (231,606 notes, keyword-only run): relevant R@5 95.3, R@10 97.7, Rall@10 87.9,
nDCG@10 87.5, MRR 88.6, search p50 1.7 ms.

**LoCoMo-10, 1,982 questions** (categories as numbered in the file; usually read as 1 multi-hop, 2 temporal,
3 open-domain, 4 single-hop, 5 adversarial)

| Granularity / search | R@5 | R@10 | Rall@10 | nDCG@10 | MRR | search p50 |
|---|---|---|---|---|---|---|
| session, keyword (`state_search`) | 89.1 | 95.0 | 86.4 | 77.3 | 75.0 | 1.3 ms |
| session, relevant | 89.1 | 95.0 | 86.5 | 77.2 | 74.9 | 1.0 ms |
| session, hybrid | 80.0 | 93.0 | 85.2 | 64.0 | 58.1 | 13 ms |
| turn (dialog id), keyword | 44.8 | 52.3 | 46.0 | 38.1 | 37.2 | 2.1 ms |
| turn (dialog id), relevant | 46.1 | 52.8 | 46.2 | 38.8 | 37.9 | 2.1 ms |
| turn (dialog id), hybrid | **52.1** | **64.1** | **54.8** | 38.9 | 35.1 | 27 ms |

### How to read these numbers

- **Natural-language questions to `state_search` used to fail.** Before 2.0.0 it needed every word ("what", "did",
  "I", ...) in one note and found the right session 12 % of the time on LongMemEval-S. The any-word fallback fixed it
  (95 %); full matches still rank first, so short exact queries behave as before.
- **Hybrid is not always better.** It helps when notes are short (LoCoMo turns: R@10 52 to 64) and on LongMemEval-S
  sessions (R@5 95 to 97), but on LoCoMo whole sessions it ranks worse than keywords alone (R@5 89 to 80): a long,
  many-topic session embeds as one blurred vector, and RRF weights both lists equally. Weighting the two lists is open work.
  Embeddings are off by default, so the default path is the keyword row.
- **LongMemEval-S is easy for retrieval.** Each haystack has about 50 sessions, most of them filler from
  unrelated chat datasets, so the evidence session is often the only one on its topic. High recall here does
  not mean high recall on a real single-topic memory. LoCoMo at turn level, where every turn is from the same
  two people, is the harder test (52.5 % R@10).
- **Published retrieval reference.** The LongMemEval paper (Wu et al., 2024, [arXiv:2410.10813](https://arxiv.org/abs/2410.10813),
  Appendix E.2, Table 9) reports flat BM25 with key = value at **session R@5 0.634 / R@10 0.710 (nDCG@10 0.540)**
  and **round (turn) R@5 0.472 / R@10 0.538**; Stella V5 1.5B (dense) reaches session R@5 0.720 / R@10 0.794.
  Its retrieval experiments use the larger **LongMemEval-M** setting (about 500 sessions per haystack) and index
  only the user side of each session, so they are **not directly comparable** with the -S numbers above.
  Running OneMemory on -M is the comparable experiment and has not been done yet.
- **End-to-end QA accuracy is a different metric.** Memory vendors usually publish LongMemEval or LoCoMo
  "accuracy" (an LLM answers from retrieved context and another LLM grades it). Those numbers depend on the
  answering model, the prompt and the judge, and **cannot be compared** with the retrieval recall here, in
  either direction.
- One run per configuration. Search is deterministic; latencies vary by a few tenths of a millisecond between
  runs. A few LoCoMo evidence entries hold several ids in one string (`"D8:6; D9:17"`) and are split; entries
  that are not of the form `D<n>:<n>` are dropped.
