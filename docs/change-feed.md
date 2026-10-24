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
never per write). An admin can empty the whole log (and every `last`
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
