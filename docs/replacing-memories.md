# Replacing a memory, history and confidence (1.6.0)

Plain version: when a note is out of date, you can **replace** it with a newer one. OneMemory never does that
quietly. It first shows you exactly what would stop appearing in search, you say yes, and only then does it
happen. Nothing is deleted, and you can undo it.

## Replacing a memory is always two steps

1. **Preview.** Changes nothing. It shows a warning headed **ARE YOU SURE YOU WANT TO REPLACE THIS?** with, for each
   old note: what it says, who wrote it, when it was first saved and last changed, its tags, how many other notes are
   very similar to it, and how many tasks depend on it. It also says what you lose (the old note stops showing up in
   search, lists and "what is relevant" lookups), what you do **not** lose (nothing is deleted; the old note keeps its
   text, writer, dates and tags and can be brought back), and, if it applies, a **RED FLAG** (see below).
   It returns a one-time **confirmation code**.
2. **Confirm.** The only step that changes anything. It needs that code. The code
   - works **once**,
   - expires (10 minutes by default; `ONEMEMORY_SUPERSEDE_TTL_SECONDS`, 1 to 3600),
   - works **only for the person who asked** (same writer, same scope, same tenant),
   - is tied to the exact notes and versions you were shown: if any of them is edited after the preview, the confirm is
     refused ("something changed; run the preview again"), and
   - is tied to the exact replacement text: if you previewed one text, you cannot confirm a different one.
   A damaged, made-up or copied-wrongly code is refused with the same short message, so a code cannot be probed.

The whole confirm is one database transaction: either every old note is retired and the replacement exists, or
nothing changed.

### Where you do it

| Surface | Preview | Confirm |
|---|---|---|
| Command line | `onememory supersede --old 12[,13] --title "..." --body "..." [--tags a,b] [--confidence 0.8]` (or `--new-id 40` to use a note that already exists) | At a terminal it asks you to **type the number of notes** you are replacing (or `yes`); anything else cancels and changes nothing. With no terminal (a script) it only previews, prints the code, and exits 2. A script must run `onememory supersede --confirm-token <code> --title ... --body ...` (the same text). There is deliberately **no `--yes`**. |
| REST | `POST /supersede/preview` `{ old_ids, new_note \| new_id }` | `POST /supersede/confirm` `{ token, new_note?, acknowledge_risk? }` |
| MCP | `memory_supersede_preview` | `memory_supersede_confirm` |
| Undo | `onememory supersede undo <id>` | `POST /supersede/undo` `{ id }` · `memory_supersede_undo` (recorded) |

At most 20 notes can be replaced in one go. Tasks and handoffs are managed with the task tools and cannot be replaced.
Replacing needs a write or admin token; a read token is refused.

**A limit you should know about.** For MCP and REST, the "Are you sure?" step is enforced by the code (nothing happens
without a valid code from a preview), but it is the **agent** that talks to you. A careless agent could show you a
shortened warning, or confirm without asking. The tool descriptions tell the agent to show the full warning and wait for
you. The command line is the strongest gate: it asks you, at your own keyboard, and cannot be answered by an agent.
For notes you care about, replace from the command line.

## Nothing is deleted

A confirmed replacement marks the old note **superseded** and links it to the note that replaced it
(`status: "superseded"`, `superseded_by`). Superseded notes are left out of search, lists, "what is relevant", similar-note
suggestions. To see them anyway, ask for them: `?include_superseded=1` on
`GET /search` and `GET /notes`, `?superseded=1` for only those, `include_superseded` on `state_search` / `state_list`.
They are always labelled. A superseded note cannot be edited until it is brought back.

**Undo** brings the note back exactly as it was. Undo is recorded (who, when, which note) like the replacement itself. A write token can undo only a replacement
it made itself; undoing someone else's (for example an administrator's, made to hide a bad note) needs an administrator.
**Hard delete is unchanged**: `DELETE /notes/:id` still deletes for good (admin), and takes the note's history with it. One exception, so nothing
is lost by accident: if you hard-delete a note that *replaced* others, those notes come back (logged), because nothing would be left to point at.

## The trust guard

Replacing hides a note, so it is held to the same trust rules as everything else:

- A writer an administrator has **distrusted** is refused outright ("NOT ALLOWED"), with the reason in plain words.
- A replacement that **claims lower confidence** than the note it replaces carries a **RED FLAG**.
- For a red flag the preview is only given to an **administrator**, the warning says so, and the confirm must also say
  `acknowledge_risk` (on the command line you must type `i accept the risk`). A write token cannot confirm a code that
  carries a red flag, even one an administrator previewed.
- Flags are judged again at confirm time, so a rule or a confidence that changed in between is caught.
- Confidence is only ever **what the writer claimed**. It is never used to override trust: a distrusted writer is
  blocked whatever confidence it claims.
- The warning also names notes written by **other** writers and notes a trusted server vouched for.

## Version history

Every edit that changes a note's title or body keeps the text it replaces (and the writer, tags, source and confidence it had).

- Bounded: `ONEMEMORY_HISTORY_VERSIONS` (default 20 per note; 0 turns it off; at most 500) and
  `ONEMEMORY_HISTORY_MAX_BYTES` (default 2,000,000 per note). When a note is over a limit, the **original version is
  never dropped**, a writer's older copies go before another writer's newest one (so one writer flooding edits cannot push out
  someone else's version), and otherwise the oldest goes.
- **Administrators only.** Old text can hold something that was taken out on purpose. `GET /notes/:id/history`, `memory_history`,
  `onememory history <id>`. Versions written by a distrusted writer are left out unless the admin asks for them.
- **Restore**: `POST /notes/:id/history/restore` `{ version, if_rev? }`, `memory_restore_version`, `onememory history restore <id> <version>`.
  A restore makes a **new version**; the text it replaces goes into the history, so a restore can itself be undone.
  A version written by a distrusted writer cannot be restored. Restoring a version this server saw being written takes the note's
  taint back to what that text had then (this is how an admin recovers a trusted original after distrusting an overwriter);
  a version that arrived by import is only a claim and can only add names.
- **Forget**: `DELETE /notes/:id/history`, `memory_history_purge`, `onememory history purge <id>` (asks first) removes the kept versions
  (use it after a secret was removed from a note). A hard delete of the note removes its history too.
- Encrypted at rest like note bodies when encryption is on, and bound to their own row.
- Carried by `export` (turn off with `?history=0` / `--no-history`) and `import` (every entry is a **claim**: names in the file are kept as
  `claimed_writer`, never as a verified writer; size and content checks apply).

## Confidence (a claim, never a check)

A note may carry `confidence`, a number from 0 to 1 that the writer **claims** for how sure it is. It is validated (anything
else is refused), labelled with who claimed it (`confidence_claimed_by`), kept through edits, export and import, shown in
search results, and used in the replace warning. A `null` clears it. OneMemory never ranks by it and never lets it override
the trust rules.

## Ranking: the newer of two near-identical notes comes first

When two notes are about the same thing (very similar, as in "similar-note suggestions") and the older one is flagged stale, the older one now stays
behind the newer one in search, even if it matches the words slightly better. It is still returned (and still flagged) so nothing disappears.

## Upgrading

The first start on 1.6.0 upgrades the database to schema v15 (columns for confidence and the replaced link, and tables for history and
one-time codes). As for every schema change, a verified copy of the old database is kept first at `<database>.pre-v16-backup`; the upgrade
does not run if the copy cannot be made. There is no downgrade path: to go back, stop everything, put that copy back as the database,
and install the older version. Upgrading from 1.3.x or 1.4.x: [upgrading.md](./upgrading.md).
