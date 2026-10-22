# Encryption at rest, retention, and retrieval visibility

Three additions aimed at running OneMemory as a *shared* memory service,
where "my notes" may be read by several agents and devices. Each section
leads with the tradeoff, not the marketing.

---

## Encryption at rest (AES-256-GCM)

Note **bodies** are encrypted on disk with AES-256-GCM. The key is a
32-byte file at `~/.onememory/.key` (mode `0600`), created on first
`onememory encrypt enable`.

```bash
onememory encrypt enable     # create the key, encrypt existing bodies
onememory encrypt status     # on/off, key path, encrypted note count
onememory encrypt disable    # decrypt bodies and remove the key
```

### What is protected, and what is not

This is the part most tools omit, so read it before enabling:

| | Protected? | Why |
|---|---|---|
| Note **body** | **Yes** — AES-256-GCM at rest | The sensitive part (pasted secrets, private context) |
| Note **title** | No | Keyword search and namespace isolation both need it in plaintext |
| **Tags**, timestamps, namespace | No | Same: filtering, search and isolation read them directly |
| Access counters | No | Ranking input; not sensitive |
| **The FTS search index** | No — and **body text is not indexed at all** when encryption is on | See below |

**The search tradeoff, stated plainly.** `notes_fts` is a SQLite
external-content FTS5 index over `notes(title, body, tags)`, maintained by
SQL triggers. You cannot index encrypted text. So when encryption is on,
the plaintext `body` column is left **empty**, ciphertext lives in a
separate `body_enc` column, and **keyword search covers title + tags only**.
Search still works; it just searches less. This is the honest cost of
at-rest encryption with a plaintext index — any tool claiming both full-text
body search *and* encrypted-at-rest bodies without a native SQLite extension
is quietly storing your body text in plaintext somewhere.

For **full-file** protection (titles included, search index included), use
OS disk encryption — BitLocker (Windows), FileVault (macOS), LUKS (Linux) —
in addition to, not instead of, this.

### Guarantees and failure modes

- Each write draws a **fresh 12-byte IV**, so the same note written twice
  produces different ciphertext (no deterministic leak).
- The GCM **auth tag** binds the ciphertext: tampering in the database
  fails loudly on read rather than handing an agent corrupted memory. A
  wrong/tampered key throws — it is never swallowed.
- The key file is written via **temp file + atomic rename**, so a crash
  cannot leave a truncated key that silently fails to decrypt existing
  notes.
- **Losing the key file loses the bodies.** Back it up. There is no
  recovery path, by design.
- A corrupt (wrong-size) key file is a **hard error at startup**, not a
  silent fallback — degrading would write new notes with no key while old
  ones stay encrypted.

### Export

`GET /export` returns **decrypted** bodies (it requires an admin token).
An export is therefore plaintext; store it accordingly. Re-importing into
an encrypted store re-encrypts.

---

## Retention controls

Per-note time-to-live with **soft archive**, never silent deletion.

```bash
# Set a TTL when writing (days)
curl -X POST localhost:8790/notes -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title":"Scratch","body":"temp context","forget_after":7}'
```

- `forget_after` (days) is stored as an absolute `expires_at` deadline.
- `forget_after: 0` clears a deadline; omitting it on update **preserves**
  the existing one (an unrelated edit never silently drops your TTL).
- The sweep archives every past-due note. It is idempotent and returns the
  count, so it is safe on a timer.

```bash
curl -X POST localhost:8790/sweep-expired -H "Authorization: Bearer $TOKEN"
# {"archived": 3}

curl -X POST localhost:8790/notes/42/archive -H "Authorization: Bearer $TOKEN"  # forget
curl -X POST localhost:8790/notes/42/restore -H "Authorization: Bearer $TOKEN"  # bring back
```

An **archived** note is excluded from `list`, keyword search, semantic
search and the SessionStart recall hook — it is genuinely forgotten by
every read surface — but it stays on disk and is restorable. This is the
reversible alternative to `DELETE` for "forget this".

`GET /notes` hides archived notes by default; `?includeArchived=1` shows
them all, `?archived=1` shows only the archive (the restore view).

> A TTL's deadline is computed from `updated_at`, so **editing a note resets
> its clock**. That is the intended semantic for "forget this N days after I
> last touched it"; set an absolute deadline via the API if you need
> otherwise.

---

## Retrieval visibility ("why did I get this?")

Search ranking is three multiplicative stages — native relevance
(bm25 / cosine / RRF) → recency-decayed access boost → graded staleness
penalty — and every intermediate used to be discarded. An agent could see
*which* notes came back but never *why* one outranked another.

`GET /search?q=...&explain=1` attaches a `breakdown` to each result,
computed from the **same functions the scorer uses**, so the explanation
cannot drift from the ranking:

```json
{
  "results": [
    {
      "id": 12,
      "title": "VPN setup for office",
      "breakdown": {
        "finalScore": 3.412,
        "baseScore": 3.1,
        "accessBoost": 1.09,
        "stalePenalty": 1.0,
        "accessCount": 4,
        "daysSinceAccess": 1.2,
        "ageDays": 3,
        "stale": false,
        "explanation": "strong text match; read 4x, last 1d ago (boost x1.090); fresh (3d old)."
      }
    }
  ]
}
```

The identity `finalScore = baseScore × accessBoost × stalePenalty` holds
exactly (verified in `test/explain.test.ts`). Results and their **order are
identical** with and without `explain=1` — explaining never reorders.

---

## The evaluation set

`evals/cross-device-tasks.json` is a small set of *repeated cross-device
memory tasks*: a fact written from one surface (desktop, phone, claude.ai,
cursor) and recalled later from a different one. `test/evalset.test.ts`
seeds a fresh store per task, runs each query, and scores retrieval with
recall@1, recall@5 and MRR, gating so a ranking or schema change that
quietly degrades retrieval fails CI.

It exercises **both** retrieval paths, because an agent has both:

- `state_search` — keyword, **AND**-conjunction of prefix tokens. Precise,
  but a natural-language question ("what did we ship in standup") matches
  nothing, because common words like "what"/"we"/"did" are not in the note.
- `state_relevant` — **OR** semantics with keyword extraction, built
  exactly for vague messages.

The gate is measured **best-of-both-paths** (what a user experiences), and
the harness *reports* keyword-only recall alongside it so the AND-search
limitation stays visible instead of papered over:

```
[eval] cross-device retrieval over 10 tasks (best of keyword+relevant): recall@1=1.000 recall@5=1.000 mrr=1.000
[eval] keyword-only (state_search, AND) recall@1=0.700
```

To grow the set, add `{ query, expected, why }` entries. `expected` is the
exact title of the note that should rank for `query`. Keep queries
realistic and the expected note unambiguous; the harness is deterministic
(access boost disabled, fresh store per task) so results reproduce exactly.
