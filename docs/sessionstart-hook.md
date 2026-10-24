# OneMemory SessionStart hook

Injects your recent OneMemory notes into the agent's context **before its
first message** — pre-prompt memory, no model opt-in needed.

## What it does

`onememory recall` reads the most recently updated notes from your local
SQLite store and prints them as a Claude Code hook JSON payload:

```json
{"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": "..."}}
```

`additionalContext` is a compact human-readable summary, e.g.:

```
Recent memory (3 notes):
- [Release cadence]: Ship weekly on Thursdays (decided 2026-10-14)
- [API base URL]: https://api.acme.example/v2
- [Pref]: Keep replies short and concrete.
```

Recency is the recall signal at session start — no embeddings, no query,
one cheap SQL query (`ORDER BY updated_at DESC`). Flags:

- `--budget-ms 800` — soft budget in milliseconds (default 800). If the
  recall work exceeds it, what was fetched is returned anyway; nothing hangs.
- `--limit 10` — max notes included (default 10).

Total output is capped at ~8000 characters so the hook never blows up your
context window.

## Install (Claude Code settings)

### Prerequisites: how will the hook invoke `onememory`?

The hook command runs in a plain shell at session start. `onememory recall`
on PATH is **not** guaranteed -- pick the invocation that matches how you
installed it, and verify it (next section) before wiring the hook:

| Install path | Hook command to use |
|---|---|
| `npm i -g onememory` | `onememory recall --budget-ms 800` -- **only if** `command -v onememory` prints a path (npm's global bin dir must be on your PATH; check that `$(npm prefix -g)/bin` is on your PATH; `npm bin -g` was removed in npm 9+) |
| Source checkout | `node /abs/path/to/onememory/dist/src/cli.js recall --budget-ms 800` (absolute path; run `npm run build` first) |
| npx (no install) | `npx -y onememory recall --budget-ms 800` (adds startup latency; prefer a real install) |
| Docker only | The hook runs on your **host**, not in the container -- use one of the rows above, pointed at the same SQLite file (`ONEMEMORY_DB_PATH`), or `docker exec <container> node dist/src/cli.js recall` |

If the command from your row doesn't work in a fresh terminal, the hook
will fail silently (by design) and you'll get no memory with no error --
so verify first.

Claude Code itself needs hook support: SessionStart hooks shipped in 2025
builds. If hooks in `settings.json` are silently ignored, upgrade Claude
Code (`claude --version`, then reinstall from anthropic.com) before
debugging anything else.

### Wiring it up (merge, don't clobber)

`~/.claude/settings.json` may already have hooks or other settings.
**Merge** the SessionStart entry in; never overwrite the file. With `jq`:

```bash
jq '.hooks.SessionStart += [{
  "matcher": "startup|clear",
  "hooks": [{ "type": "command", "command": "onememory recall --budget-ms 800" }]
}]' ~/.claude/settings.json > /tmp/settings.json \
  && mv /tmp/settings.json ~/.claude/settings.json
```

(Replace the `command` with your row's invocation from the table above.)
Or edit by hand -- the result should look like:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|clear",
        "hooks": [
          { "type": "command", "command": "onememory recall --budget-ms 800" }
        ]
      }
    ]
  }
}
```

### Why `matcher: "startup|clear"` — NOT on compact

Fire the hook on **startup** (new session) and **clear** (`/clear` wipes
context, so re-injection is useful). Do **not** fire it on `compact`:
after compaction the model already has full context, and re-injecting the
same notes just wastes tokens. Omit the matcher only if you understand that
trade-off.

## Fail-silent by design

This hook **blocks session start**, so it is engineered to never break it:

- Exit code is always `0`, on any failure.
- On failure stdout is still valid hook JSON with empty `additionalContext`
  (`""`) — never a stack trace. Diagnostics go to stderr only.
- A missing or corrupt database, a missing config, a thrown error, or a
  timeout all degrade to the empty-context payload.
- Hard timeout of 5s via `Promise.race` — the hook cannot hang
  indefinitely. Honest caveat: `Promise.race` cannot preempt synchronous
  SQLite work, so this is a cooperative timeout, not a true preemption.
  The recall path is one cheap indexed query, so in practice the race only
  fires if an awaited step hangs; the 800ms soft budget is the one that
  matters day to day.

Safe to install and forget: if OneMemory is ever broken or uninstalled,
your sessions start normally, just without injected memory.

## Verifying it works

```bash
command -v onememory || echo "NOT ON PATH -- use the node /abs/path form from the table above"
onememory recall                       # pretty-prints nothing; it's JSON
onememory recall | python3 -m json.tool
ONEMEMORY_DB_PATH=/nope/db.sqlite onememory recall   # fail-silent check
echo $?                                # 0
onememory recall --limt 5 2>&1 >/dev/null  # unknown-flag warning goes to stderr
```

Then the "did it actually fire" check — the common silent failure is a
working `recall` that never runs:

1. Write a distinctive note via the API, dashboard, or MCP (title it
   something unmistakable, e.g. `hook-probe-9417`).
2. Start a **new** Claude Code session (the `startup` matcher only fires
   on new sessions and `/clear`).
3. Ask the agent: "What's the most recent thing in my memory?"
   If it mentions `hook-probe-9417`, the hook fired. If not, re-check the
   command row from the prerequisites table — the usual cause is
   `onememory` not resolving on the hook's PATH.
4. `onememory doctor` also runs a recall smoke test, a budget check, and
   reports whether the SessionStart hook is present in
   `~/.claude/settings.json`.

## Notes for other agents

The same payload works anywhere a SessionStart-style hook is supported.
The namespace is resolved server-side when available
(`src/namespace.ts`, optional); without it the hook recalls across all
namespaces.
