# Shared task board, handoffs and catch-up

The goal: start a job in one chat, walk away, add an idea from your phone,
and every other session (your PC, another model) knows about it **without you
copying anything around**.

Three small pieces, all built on ordinary notes, so they are encrypted,
namespaced, searchable, backed up and visible in the change feed exactly like
everything else you store. There is no new table.

## 1. Tasks

A task is a note tagged `task`. Fields:

| Field | Meaning |
|---|---|
| `title` | Short name (max 200 chars). Required when creating. |
| `status` | `idea`, `planned`, `running`, `blocked` or `done` (default `idea`). |
| `next_step` | The one concrete thing to do next. One line, max 500 chars. |
| `owner` | Which device, chat or model has it right now (`phone`, `pc-claude-code`, ...). Letters, digits, space and `. _ @ : + -`, max 64. |
| `notes` | Anything else (max 20,000 chars). |

```
task_put({ title: "Hoodie line", status: "idea", owner: "phone", next_step: "sketch 3 logos" })
task_put({ id: 12, status: "running", owner: "pc-claude-code" })   // only what you pass changes
task_put({ id: 12, status: "done", if_rev: 3 })                     // refuse if someone else edited it
task_list({})                                  // everything except done, newest change first
task_list({ status: "blocked" })               // one status ("all" includes done)
task_list({ owner: "phone" })                  // what one device is holding
```

Updating with `if_rev` (the `rev` from your last read) fails with a
"stale write" error if another session changed the task in the meantime, so
two sessions cannot silently overwrite each other. Leave it out to force.

REST: `POST /tasks` (create), `PUT /tasks/:id` (update, `409` on a stale
`if_rev`, `404` if the id is not a task you may write), `GET /tasks?status=&owner=&limit=`.

Every change shows up in `memory_since` / `GET /changes` (as a note with the
task's title) and in `state_search`.

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

REST: `POST /handoffs`, `GET /handoffs?surface=&limit=`.

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
- **tasks**: the open ones (not `done`), newest change first.
- **handoffs**: the latest three.

Use a stable `consumer` label per device or model (`phone`, `claude-code-pc`).

### Automatically at session start

`onememory recall` (the Claude Code SessionStart hook, see
[sessionstart-hook.md](./sessionstart-hook.md)) now puts the open tasks (up to
10) and the latest handoff **before** the recent notes, within the same size
budget. Tasks and handoffs are not repeated in the recent-notes list. Nothing
to configure.

### Seeing changes the moment they happen

A session that is waiting can park on the change feed instead of polling:
`memory_since({ since: "last", consumer: "pc", wait_seconds: 30 })` or
`GET /changes?since=last&consumer=pc&wait=30` returns as soon as anything
changes in your scope. See [change-feed.md](./change-feed.md#live-wait).

## Security

- Same tokens, scopes and namespaces as notes: `task_put` and `session_handoff`
  need **write**; `task_list` and `catch_up` need **read**. A namespace-pinned
  token only sees and writes its own namespace (writes always land there; a
  task id from another namespace answers "no task").
- `task_put` only updates notes that are tasks, never an ordinary note.
- Content passes through the memory linter like any note (secrets are refused,
  injection-like text is quarantined). Task and handoff text is untrusted data:
  MCP results carry the same untrusted-data banner as notes.
- Sizes and field formats are validated; bad input is a clear `400` / tool error.
