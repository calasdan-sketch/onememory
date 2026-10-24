# Shared task board, handoffs and catch-up

The goal: start a job in one chat, walk away, add an idea from your phone,
and every other session (your PC, another model) knows about it **without you
copying anything around**.

Three small pieces, all built on ordinary notes, so they are namespaced,
searchable, backed up and visible in the change feed exactly like everything
else you store, and their bodies are encrypted at rest when you turn encryption
on (titles and tags are not: see the caveat under Security). There is no new table.

## 1. Tasks

A task is a note tagged `task`. Fields:

| Field | Meaning |
|---|---|
| `title` | Short single-line name (max 200 chars, no line breaks or control characters). Required when creating. |
| `status` | `idea`, `planned`, `running`, `blocked`, `done`, plus `queued` / `failed` for command tasks (default `idea`). |
| `next_step` | The one concrete thing to do next. One line, max 500 chars. |
| `owner` | Which device, chat or model has it right now (`phone`, `pc-claude-code`, ...). Letters, digits, space and `. _ @ : + -`, max 64. Clearing it resets the provenance `source` to `task`. |
| `notes` | Anything else (max 20,000 chars). |
| `priority` | Whole number 0-9 (you decide which way is urgent); `null` clears. |
| `due` | `YYYY-MM-DD` or an ISO time; `null` / `""` clears. |
| `parent_id` | Id of a parent task in the same namespace (cycles refused); `null` clears. |
| `blocked_by` | Up to 20 task ids that must finish first (validated); `[]` clears. |

```
task_put({ title: "Hoodie line", status: "idea", owner: "phone", next_step: "sketch 3 logos", client_key: "phone-2026-10-24-1" })
task_put({ id: 12, status: "running", owner: "pc-claude-code" })   // only what you pass changes
task_put({ id: 12, status: "done", if_rev: 3 })                     // refuse if someone else edited it
task_get({ id: 12 })                           // the whole task, notes included
task_list({})                                  // everything except done, newest change first
task_list({ status: "blocked" })               // one status ("all" includes done)
task_list({ owner: "phone" })                  // what one device is holding
```

**Retry-safe creates.** Pass `client_key` (any unique string, e.g. a UUID your
client invents once per intended task) when creating. A retry with the same key
in the same namespace returns the existing task with `replayed: true` (REST
`200` instead of `201`) instead of a duplicate. The key is stored only as a
hash. It is for creating; to guard an update use `if_rev`. `session_handoff`
takes `client_key` the same way.

**Claiming.** `task_claim({ id, owner, ttl_seconds })` takes a task so no other
session works it at the same time. The check and the write are one
revision-guarded update (compare-and-swap): if two sessions race, one wins and
the other gets a conflict naming the holder and the expiry (REST `409`). Claiming
a task you already hold extends the lease (call it again before it runs out as a
heartbeat); `release: true` gives it up; an expired lease can be taken by anyone.
Claiming also sets `owner` and moves an `idea` / `planned` task to `running`.
A claim is cooperative: it stops other *claimers* and stops anyone changing
`owner` while it is live; it does not lock the task against a plain `task_put`
edit of its other fields.

Updating with `if_rev` (the `rev` from your last read) fails with a
"stale write" error if another session changed the task in the meantime, so
two sessions cannot silently overwrite each other. Leave it out to force.

REST: `POST /tasks` (create), `PUT /tasks/:id` (update, `409` on a stale
`if_rev` or a live claim by someone else, `404` if the id is not a task you may
write), `GET /tasks?status=&owner=&parent_id=&limit=`, `GET /tasks/:id`,
`POST /tasks/:id/claim`.

Every change shows up in `memory_since` / `GET /changes` (as a note with the
task's title) and in `state_search`.

### Command tasks: phone to PC

`task_put({ command: { action, params }, target })` creates a task in status
`queued` for the PC's [command runner](./RUNNER.md#command-tasks-the-task-board-in-front-of-the-runner).
It does **not** run by itself: an admin must `task_approve({ id, command_hash })`
(REST `POST /tasks/:id/approve` with `{ "command_hash": ... }`, admin scope; `rev` as
`if_rev` also works), echoing the `command_hash` that `task_get` / `task_list` showed,
so the approval is refused if the command changed after the admin read it. The task must be addressed to that
runner's own id and live in the runner's configured task namespace, and the action
must be on the PC's allowlist. The approval is bound to a hash of the command, so any
edit voids it, it expires (default 24 h), and it is single-use (removed in the write
that marks the task running). A command task cannot be claimed; approve / revoke clear
any lease on it. A namespace holds at most 100 queued command tasks. A write token can queue a task and nothing
more; the runner's signing secret is never stored or exposed. Full rules, and what
is deliberately not supported, in [RUNNER.md](./RUNNER.md#command-tasks-the-task-board-in-front-of-the-runner).

### Reserved tags

`task`, `handoff` and every tag starting with `task.` (`task.priority:`,
`task.due:`, `task.parent:`, `task.blocked_by:`, `task.ckey:`, `task.lease:`,
`task.approval:`) are written only by `task_put` / `session_handoff` /
`task_claim` / `task_approve`. A plain note write (`POST /notes`, `PUT
/notes/:id`, `state_write`, a synced file) that tries to create a note with one
of them, or to add or remove one on an existing note, is **rejected** with a
`400` that points at `task_put`. This keeps anyone with a write token from
forging a "latest handoff", crowding real tasks off the board, or faking a lease
or approval. Compatible by design: an existing note that already carries these
tags can still have its title, body and *other* tags edited, and the
`status:`, `surface:` and `owner:` tags are not reserved on their own (they mean
nothing without `task` / `handoff`). `onememory import` (Markdown files) is a local
admin command, not reachable with a token, so it restores such notes as they are
(a restore from an export loses no tasks or handoffs); approvals are never imported.
Any rejected file makes the command print a loud count and exit 1.

## 2. Handoffs

Before you stop, leave a note for the next session:

```
session_handoff({
  surface: "claude-code on pc",
  summary: "Built the live-wait endpoint.",
  done: ["wait param", "tests"],
  pending: ["docs", "release"],
  decisions: ["cap waits at 55 seconds"],
  next_step: "write the CHANGELOG"
})
```

`surface` (who is handing off) is required and at least one other field must
have content. Lists hold up to 25 short items. It is stored as a note tagged
`handoff` (and `surface:<name>`).

REST: `POST /handoffs`, `GET /handoffs?surface=&limit=`. Pass `client_key` to make a
retry return the same handoff instead of writing a second one.

## 3. Catch-up: one call at the start of a session

```
catch_up({ consumer: "claude-code-pc" })
GET /catch-up?consumer=claude-code-pc
```

Returns, in one compact result:

- **changes** since this `consumer` last called (titles only, newest 30 shown,
  totals for the whole gap; the marker then advances, so the next call shows only
  newer changes). The first call for a label covers the last 24 hours.
  Pass `include_changes: false` (`?changes=0`) to skip this part and leave the marker alone.
  However large the gap (tens of thousands of changes), it is one query: the
  marker reaches the true end and "newest 30" really are the newest.
  If your client can die before it has handled the result, pass
  `ack_mode: "manual"` and send the returned `ack_token` back (see
  [change-feed.md](./change-feed.md#do-not-lose-changes-acknowledged-reads)); `exclude_self`
  hides writes made by your own token (see change-feed.md).
- **tasks**: the open ones (not `done`), newest change first, **compact**: id,
  title, status, owner, next step, priority, due, parent, blockers, rev. No notes or
  command text; fetch one with `task_get`.
- **handoffs**: the latest three.

Use a stable `consumer` label per device or model (`phone`, `claude-code-pc`).

### Automatically at session start

`onememory recall` (the Claude Code SessionStart hook, see
[sessionstart-hook.md](./sessionstart-hook.md)) now puts the open tasks (up to
10) and the latest handoff **before** the recent notes, within the same size
budget. Tasks and the handoff each get their own budget, so a long task list
never cuts the handoff, and the header counts all open tasks, not just those shown.
Every field is reduced to one printable line (line breaks, ESC and other control
characters removed), so a hostile title cannot forge extra lines. Tasks and handoffs are not repeated in the recent-notes list. Nothing
to configure.

### Seeing changes the moment they happen

A session that is waiting can park on the change feed instead of polling:
`memory_since({ since: "last", consumer: "pc", wait_seconds: 25 })` or
`GET /changes?since=last&consumer=pc&wait=25` returns as soon as anything
changes in your scope. See [change-feed.md](./change-feed.md#live-wait).

## Security

- Same tokens, scopes and namespaces as notes: `task_put`, `task_claim` and
  `session_handoff` need **write**; `task_get`, `task_list`, `catch_up` and
  `runner_status` need **read**; `task_approve` needs **admin**. A namespace-pinned
  token only sees and writes its own namespace (writes always land there; a
  task id from another namespace answers "no task").
- `task_put` only updates notes that are tasks, never an ordinary note, and the
  task / handoff tags can only be written through these tools (see Reserved tags).
- Content passes through the memory linter like any note (secrets are refused,
  injection-like text is quarantined). Task and handoff text is untrusted data:
  MCP results carry the same untrusted-data banner as notes, and the SessionStart
  board strips control characters and line breaks from every field.
- Sizes and field formats are validated; bad input is a clear `400` / tool error.
- **Encryption caveat.** With at-rest encryption on, a task's or handoff's
  *body* is encrypted (next step, notes, command, result, handoff sections). The
  *title*, the tags (status, owner, priority, due, parent, blockers, surface),
  the source label, timestamps and the titles shown in the change feed
  (`memory_since`, `catch_up`) stay plaintext in the database, exactly like any
  note's title and tags. Do not put secrets in task titles, owners or tags.
- The audit log records `task.put`, `task.claim`, `task.approve`, `handoff.write`,
  `catch_up` and `changes.ack` entries with the token's **label** and a `kind`
  (never the token or any text); command tasks are kind `command-task`.
