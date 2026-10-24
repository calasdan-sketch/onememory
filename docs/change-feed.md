# Change feed — "what changed while I was away"

Ask the store what happened since a point in time: which notes were
**created**, **updated** or **deleted**, by which source (client/agent), with
counts. Useful at the start of a session on a second device, or for an agent
that wants to catch up before acting.

```
memory_since({ since: "24h" })
memory_since({ since: "last", consumer: "phone" })
GET  /changes?since=2026-10-15T09:00:00Z&namespace=work&limit=50
onememory changes --since last --consumer laptop
```

The dashboard has a **Changes** button (last 24 hours).

## Parameters

| Param | Meaning |
|---|---|
| `since` | An ISO time (`2026-10-15T09:00:00Z`, `2026-10-15`), a duration back from now (`90s`, `30m`, `24h`, `7d`, `2w`), or `last`. Anything else is a 400 / tool error — never a silent full dump. |

> A time-based `since` reaches back an extra 2 seconds, because the time on your device and the store's clock can differ slightly. A change near the boundary may appear in two polls, but none is missed. For exact, gap-free polling use `since: "last"` with a `consumer`, or follow `nextCursor`.

| `cursor` | `nextCursor` from the previous page (then `since` is not needed). |
| `namespace` | Restrict to one namespace. Under server-side namespace resolution it is an untrusted hint, intersected with the readable set, exactly like `/search`. |
| `source` | Only notes with this provenance `source`. |
| `limit` | Page size, default 100, max 500. |
| `wait` / `wait_seconds` | Live wait, 0-55 seconds (REST `wait`, MCP `wait_seconds`). See [Live wait](#live-wait). |
| `consumer` | Label for the `last` marker (`phone`, `claude-code`, …; default `default`). 1–64 chars of `A-Za-z0-9._@-`. |

Scope: **read** (REST and MCP).

## Response

```json
{
  "since": "2026-10-15T21:00:00.000Z",
  "until": "2026-10-16T21:00:00.000Z",
  "counts": { "created": 2, "updated": 1, "deleted": 1, "total": 4 },
  "bySource": {
    "phone":       { "created": 1, "updated": 1, "deleted": 0 },
    "claude-code": { "created": 1, "updated": 0, "deleted": 1 }
  },
  "quarantined": 0,
  "changes": [
    { "kind": "created", "id": 41, "namespace": "work", "title": "Release cadence",
      "source": "claude-code", "at": "2026-10-16T09:12:03.120Z", "rev": 1 },
    { "kind": "deleted", "id": 17, "namespace": "work", "title": "",
      "source": "claude-code", "at": "2026-10-16T10:01:44.500Z" }
  ],
  "nextCursor": null,
  "consumer": "phone",
  "searchedNamespaces": []
}
```

- **Titles only, never bodies** — read a note (`state_read`) for its content.
  Over MCP the payload carries the untrusted-data banner (titles are
  attacker-writable).
- Entries are oldest first. A note created *and* edited in the window shows
  once, as `created`, with its current title; created-then-deleted shows only
  the delete. Consolidation shows as one `created` plus the deleted sources.
- `counts` / `bySource` cover the **whole window**, not just the page.
  `quarantined` counts linter-held writes queued in the window (they are not
  notes; see [memory-linter.md](./memory-linter.md)).
- The window is frozen when the first page is requested (it ends at the
  newest change at that moment) and travels inside the cursor, so writes
  that land while you page never shift or duplicate entries. Cursors are
  signed by the store and only valid with the same `namespace` / `source`
  filter they were issued for.

## Live wait

Instead of polling, park on the feed and be answered the moment something
changes in your scope:

```
GET /changes?since=last&consumer=pc&wait=25
memory_since({ since: "last", consumer: "pc", wait_seconds: 25 })
```

- Something new already? You get it immediately. Otherwise the call is held
  open until a write lands (including archive, restore and delete), or until
  the wait runs out, in which case you get the normal empty page plus
  `"timedOut": true`. Then just call again.
- `wait` (alias `wait_seconds`) is a whole number of seconds, 0-55. **Use 25.**
  A wait sends nothing until it ends, and many proxies and tunnels cut an idle
  HTTP response at 30 seconds: a 55-second wait behind such a proxy was seen to
  die at exactly 30.0s (25 came back normally at 25.1s; direct connections and
  60-second proxies held the full 55). So 55 is only the ceiling for a path you
  have tested; 25 survives the common ones. Longer is never needed: a
  `timedOut` answer just means "call again", which costs one request per 25s.
  Anything outside 0-55 is a 400 / tool error.
- Use it with `since` (best: `since=last`), not with `cursor`: a cursor's
  window is frozen, so nothing new can appear in it (400).
- Scope is the same as an ordinary read: a write in a namespace you cannot
  read never wakes you or shows up.
- Writes made through this server wake waiters immediately; writes made by
  another process on the same database (e.g. the CLI) are noticed within
  about a second (`ONEMEMORY_WAIT_POLL_MS`).
- Limits: at most 16 parked requests per token (`ONEMEMORY_WAIT_MAX_PER_TOKEN`),
  32 per namespace scope across all tokens (`ONEMEMORY_WAIT_MAX_PER_NAMESPACE`)
  and 64 per process (`ONEMEMORY_WAIT_MAX_TOTAL`). Past that REST answers 429
  and MCP returns a tool error whose text names the limit that was hit and the
  variable that raises it. A parked request holds its slot until it returns, times
  out or the client disconnects (which frees it at once); one wait loop per
  consumer is plenty. Parked requests poll SQLite on a jittered ~1s cycle, so a
  crowd of them does not hit the database in lockstep.
- On shutdown (SIGTERM / Ctrl+C) every parked request is woken and answers
  `timedOut: true`, so a restart drains in milliseconds instead of resetting
  sockets.
- Over MCP, make sure your client's tool-call timeout is longer than the wait.

### Do not lose changes: acknowledged reads

By default (`ack_mode` "auto") the `last` marker advances the moment the final
page is **served**. If your client then dies (a phone changing networks, a
crashed session) before it has acted on that page, those changes are not shown
again. When that matters, ask for manual acks:

```
GET /changes?since=last&consumer=pc&ack_mode=manual&wait=25   ->  { ..., "ack_token": "..." }
GET /changes?since=last&consumer=pc&ack_mode=manual&ack_token=<token>   (acks, then reads on)
POST /ack  { "consumer": "pc", "ack_token": "<token>" }
memory_since({ since: "last", consumer: "pc", ack_mode: "manual", ack_token })   memory_ack({ consumer, ack_token })
```

The marker then moves only when the token comes back, so an unprocessed page is
delivered again. Tokens are signed by the store, bound to the consumer and the
namespace/source scope they were issued for, and never move a marker backwards.
The default stays "auto" so existing clients behave exactly as before; the
trade-off is at-most-once (auto) versus at-least-once (manual: handle changes
idempotently). `catch_up` takes the same `ack_mode` / `ack_token`.

`exclude_self=1` (`exclude_self: true`) hides changes **written by** the token (or
MCP connection) whose label equals the `consumer` label, so a device does not wake
itself with its own writes. The server records the writer itself (`change_log.actor`,
schema v12); the note's `source` is free text any client can set, so it is not what
is compared, except for writes with no recorded writer (CLI, scripts, rows from
before v12), which fall back to `source`. Give each device its own token label and
use that label as its `consumer`; devices sharing a label hide each other's writes.

A consumer whose `last` marker is older than the change-log retention (90 days) gets
`markerReset: true` with whatever is still retained, rather than silently skipping
the purged events.

### React from a script: `onememory watch`

```
onememory watch --consumer pc                       # print each change as it lands
onememory watch --consumer pc --exec notify-send OneMemory
```

A long-poll loop on the local store. With `--exec`, the program (and its
arguments, taken verbatim from the command line) runs once per batch **without
a shell**; the changes arrive as JSON on stdin and in no argument, so a hostile
note title cannot inject anything. The marker moves only after the program
exits 0; a failing handler gets the same batch again after a pause.

## How it is recorded

Every note create, content update and delete appends a row to a local
`change_log` table (schema v8), written by SQLite triggers inside the
writing transaction. Each row gets a monotonic local sequence number and a
`changed_at` stamped under the write lock, and the feed pages on that
sequence -- never on the writer-supplied `updated_at`. So restores via
`/import`, Markdown imports that keep an old `updated_at`, consolidation,
and even writes made by an older binary on the same database file all show
up. Delete rows keep id, namespace and source -- no body, and no title:
deleting a note blanks the title on every log row for it, and renaming a
note blanks its older titles, so the log only ever holds a note's current
title. Rows older than 90 days are pruned periodically (at most hourly,
never per write). The running server also prunes on its own hourly timer, so
the log stays bounded even if nobody reads the feed. An admin can empty the whole log (and every `last`
marker) at once with `onememory changes --purge`.
`since=<time>` maps to the first change stamped at or after that time.

## How `last` works

One marker per `(consumer, namespace scope, source filter)`. The store
computes the marker's key itself (under a fixed `changes_seen:` prefix);
callers never name storage keys. The marker records the change sequence
the consumer has read up to. A consumer with no marker gets the last 24
hours, and the response carries `"markerReset": true` (first read, or the
marker was evicted or purged) so the client knows older changes may have
been missed. The marker moves **only when the final page has been served**, so a
reader that stops half-way sees the rest next time; consecutive windows
tile exactly (no gap, no overlap). At most 256 markers are kept; beyond
that the least recently read marker that has not been read for 7 days is
dropped. Markers read within the last 7 days are never evicted -- if all
256 are that fresh, a new label's marker is simply not stored (its next
read reports `markerReset` again).

Why a caller-chosen label instead of "per token": OneMemory tokens are bare
secrets with a scope, not identities, and several devices often share one
token. A label also lets one device keep separate markers for separate jobs.
Anyone who can read the feed can move a label's marker; that only affects
what *that label* sees next as "new" — it never hides or deletes data.

## Limits

- Changes made before upgrading to 1.1.0 are seeded from each note's
  `updated_at` (last 90 days) plus any 1.1.0-rc delete records; deletes made
  under 1.0.x are not in the feed.
- Access-count bumps (reads) are not changes.
