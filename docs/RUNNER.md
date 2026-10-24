# The command runner — controlling your PC from your phone

OneMemory on its own is a mailbox. You can drop a note in it from anywhere,
but nothing at home opens the mail. The runner is the other half: a small loop
on your PC that watches for command notes, runs the ones it trusts, and writes
the answer back where your phone can read it.

That is the whole point of the feature. You are in another country, your PC is
at home, and you want it to do something.

## Install: from the repo

The runner is **not** part of the published `onememory-mcp` package. A plain
memory install contains no runner code and does not serve the signing page.
Run it from a clone of this repository (a separate `onememory-runner` package
is coming soon):

```
git clone https://github.com/calasdan-sketch/onememory.git
cd onememory
npm ci
npm run build
```

## Upgrading from the first version (format v2)

Commands are now signed in format **v2** (canonical JSON instead of
`key=value&key=value` text, which could be ambiguous). The runner accepts v2
only. After updating:

- **Reload the signing page on your phone** (pull to refresh, or clear the
  cached page). An old copy signs v1 and every command is silently ignored.
- Results and the heartbeat are now signed too. Use the page's
  **Check a result** box to confirm a reply really came from your PC.
- The API only serves `/sign` when `ONEMEMORY_ENABLE_SIGN_PAGE=1` is set.
  `scripts\api.cmd` sets it for you.
- Allowlist entries must use full program paths (see below). An entry the
  runner refuses is named in its console output at startup.

## What it refuses to do

The store can be reached over a public tunnel, so the runner assumes every
note might be from an attacker. Three separate checks must all pass before
anything runs:

1. **It must be signed.** Each command carries an HMAC signature made with a
   secret only you and the PC know. Having a store token is *not* enough to
   run commands — that is a deliberate second lock. Unsigned notes are
   ignored silently, so nobody can use the runner to probe what works.
2. **It must be recent.** Default five minutes. Someone who copies a valid
   command today cannot replay it tomorrow, and a command id never runs twice.
3. **It must be on the allowlist.** There is no "run this text" option. The
   runner never starts a shell itself: it launches the exact program you
   named with a fixed list of arguments. You declare the exact programs it
   may run; anything else is refused in writing so you see the refusal.

Where a command takes a value from you (a repo name, a script name), you also
declare a pattern that value must match completely. That is what stops
something like `repo; rm -rf /` from getting through.

### Rules the allowlist loader enforces

- **Full paths only.** `"file"` must be an absolute path such as
  `C:\Program Files\Git\cmd\git.exe`, so nothing on `PATH` or in the
  working folder can stand in for it. The one exception is a bare `cmd` on
  an entry that takes **no** parameters.
- **Shell programs are special.** `cmd.exe`, `powershell`, `pwsh` and
  `.bat`/`.cmd` files read their own command line and treat characters like
  `& | < > ^ % " ' ; ! ( )` as instructions. So for those programs, an
  entry is refused at startup if a parameter pattern would accept any of
  them, and at run time such a character is refused regardless of the
  pattern. Prefer pointing `"file"` at the real program (`git.exe`,
  `node.exe`) rather than at `cmd /c`.

Refused entries are listed in the runner's console output at startup; the
rest still load.

## Keeping it running after a reboot

    powershell -ExecutionPolicy Bypass -File scripts\install-runner-task.ps1

That registers a Scheduled Task that starts the runner at logon. It
deliberately does not run as administrator — the runner executes whatever the
allowlist names, and that should not come with admin rights by default.

## Setting it up

**1. Pick a secret** and set it on the PC. Without it the runner refuses to
start at all.

```
setx ONEMEMORY_RUNNER_SECRET "a-long-random-string-you-keep-private"
```

**2. Say what it's allowed to do.** Copy `data/runner-allow.example.json` to
`data/runner-allow.json` and edit it. Start with one harmless action and add
more once you trust it. An empty file means nothing is allowed.

**3. Start it** (from your clone of the repo).

```
npm run build
npm run runner
```

To have it running all the time, use `scripts\install-runner-task.ps1`
(above). Only one copy can run at once — a second one sees the lock and exits.

## Sending a command from your phone

Open `https://<your-tunnel>/sign` on the phone. The API serves this page
only when it is started with `ONEMEMORY_ENABLE_SIGN_PAGE=1` (`scripts\api.cmd`
does that); otherwise `/sign` is a 404. You can also open `docs/sign.html`
as a local file. Enter your runner secret once, pick an
action, and it signs the command on the device — the secret is used there and
never sent to the store. It can either print the JSON for you to paste into a
note, or post it straight to the store if you give it your tunnel URL and a
store token.

The secret and store token are **not** saved unless you tick "remember on
this device", and unticking wipes them. A phone gets lost or lent out.

The same thing from a terminal on the PC:

    npm run runner:sign -- status
    npm run runner:sign -- site-pull repo=calas-site --target DANITA
    npm run runner:sign -- __actions --post
    npm run runner:sign -- verify-result "{...result note body...}"

## Is this reply really from my PC?

Anyone who holds a store token can write into the `results` and `runner`
namespaces. So the runner signs every result and every heartbeat with your
runner secret (under a different label from commands, so one can never be
passed off as the other). A note without a valid signature is not from
your PC, whatever it says.

On the phone page, put a command id (or the word `heartbeat`) in **Check a
result**. It fetches the matching notes and tells you whether one is
authentic. You can also paste a note body. On the PC:
`npm run runner:sign -- verify-result -` reads a body from stdin.

What a token holder can still do: delete notes, or put back an *older*
signed copy of the same note (for example the "running" version of a
result, or an old heartbeat, which only ever looks staler). They cannot
make a command look like it succeeded, or make a dead PC look alive now.

## Namespaces and tokens

The runner reads `commands` and writes `results` and `runner` **directly
in its own database file**, not through the API. Your phone, however, goes
through the API with a store token, so:

- The token you use on the phone must be able to **write** to `commands`
  and **read** `results` and `runner`.
- If the API process has namespace resolution turned on
  (`ONEMEMORY_SPACES`, `ONEMEMORY_SPACE`, or `data/spaces.json`), every note
  it writes is forced into **that process's own namespace**, whatever the
  page asks for, and reads are limited to it plus its read grants. Commands
  posted from the phone then never land in `commands` and the runner never
  sees them. Namespaces are decided **per API process, not per token**: run
  the API that serves the phone without namespace resolution, or with
  `ONEMEMORY_SPACE=commands` and a read grant on `results` and `runner`.

## The raw format

Post a note to the `commands` namespace whose body is the signed command.
`buildCommand()` in `src/runner.ts` produces one:

```json
{
  "v": 2,
  "cmd_id": "9f1c...",
  "action": "site-pull",
  "params": {},
  "issued_at": "2026-10-16T15:00:00.000Z",
  "nonce": "4b2e...",
  "sig": "hex-hmac"
}
```

The signature is HMAC-SHA256 with your secret over the text
`onememory-cmd-v2`, a newline, and the command's fields (`v`, `cmd_id`,
`action`, `params`, `target`, `issued_at`, `nonce`) as JSON with keys sorted
and no spaces. Control characters are refused in every field.

Within one poll (30s by default) a note appears in the `results` namespace
titled `result <cmd_id>`, containing the exit code, the output, how long
it took, and a `sig`. Read it from your phone.

## Asking what it can do

You will forget what the allowlist says while you are away. Send the reserved
action `__actions` and the PC replies with every action it accepts and the
parameters each takes. It runs nothing — it just answers.

## Seeing a command in progress

A result note appears the moment a command *starts*, with `"status":
"running"` and the time it began. When the command finishes, that same note
is updated to `ok`, `failed` or `timed_out`.

This matters more than it sounds. If the PC loses power halfway through, the
note stays on `running` forever — so you can tell "it is still working" from
"it died mid-job" from "it never heard me", all from your phone.

## Knowing it's actually listening

Each runner keeps its own note in the `runner` namespace called **runner
heartbeat: <machine name>** (since 1.4.0; one per runner, so a dead PC is never hidden by another PC
that is still beating), updated every few minutes with the time, the host and the
process id. If the heartbeat is stale, the PC is not listening — that is
different from a command being refused, and you can tell the two apart from
across an ocean.

## Is the PC asleep? Commands waiting

Approving a command task from your phone does not wake the PC. If the PC is
off or asleep, the task stays approved and waits. Nothing is lost and nothing
runs early; the runner takes it on its first poll after waking. The catch is
the approval clock: an approval lapses (24 h by default,
`ONEMEMORY_APPROVAL_TTL_SECONDS`), and an expired one needs an admin to
approve again.

The store tells you instead of leaving you guessing:

```
runner_status()                       # MCP, read scope
GET /runner/status[?namespace=ns]     # REST, read token
onememory runner-status [--json]      # CLI on the machine holding the store
```

It returns the runner's state (`online`, `stale` or `never_seen`), a `targets` list with the same
state and the waiting / expiring / expired counts **for each runner separately** (a command is judged
against the runner it is addressed to, by its `target`), and, for each namespace you
can read: `waiting` (approved, not started), `expiring_soon` (approval ends within an hour),
`expired` (a genuine approval that lapsed before the runner took the task), and the age and id
of the oldest waiting task. Only counts, ages and ids: never command text, parameters, targets or
the host name (`task_get` is still the only place those are read). Past 2,000 queued approved
tasks the counts are "at least" (`truncated: true`).

**What counts as waiting.** The same rule the runner uses to pick tasks, shared in the code
(`classifyQueuedCommand`): the task is in the one namespace this runner serves
(`ONEMEMORY_RUNNER_TASK_NAMESPACE`), is addressed to this runner (`target` = its machine name),
carries an approval whose signature checks out, is not leased, and is not expired. A command for another
machine, or in another namespace, is not "waiting" and never triggers the offline notice. The runner
publishes its machine name, task namespace and beat interval in its heartbeat; the server reads them from
there (and falls back to its own `ONEMEMORY_RUNNER_ID` / `ONEMEMORY_RUNNER_TASK_NAMESPACE`). A runner
that has never been seen and has no such settings on the server counts nothing: there is nothing to say
which machine the commands are for. Expired approvals are shown even when the runner is online, because
they need a person to approve again. (The runner's rate window is a runtime limit and is not part of the
count.)

When commands are waiting and the runner is not online, or approvals have expired, the same fact is one
line at the top of `catch_up` (`runner_notice`), in the SessionStart recall and on the dashboard, for example:
`Runner offline (last seen 3 h ago): 2 approved commands waiting, 1 expiring within 1 h.`

**How the heartbeat is judged.** The store does not hold the runner secret, so it cannot check the
signature inside the heartbeat. Instead the time is the server's own timestamp of the heartbeat note (the
`alive_at` in the body is ignored, so a wrong clock or a forged body cannot make the runner look alive),
a time in the future is not believed, and only a note stamped `written_by: runner` by the server counts
(a token holder's note carries their token label; a token named `runner` is stored as `token:runner`).
A runner older than 1.3.4 stamps no marker; since 1.4.0 that heartbeat is **not believed** (see
"Upgrading the runner" below). This is a strong hint, not a proof:
someone who can write the database file can still fake it; to prove a heartbeat, use the sign page's
"Check a result" with the word `heartbeat`. It is shown to any caller who can read a namespace, because
one runner serves the whole store; only its age and state are shown.

The runner counts as stale after `ONEMEMORY_RUNNER_STALE_SECONDS` without a heartbeat (default `600`),
and never less than three of its own beat intervals, so setting `ONEMEMORY_RUNNER_HEARTBEAT_MS` above
200000 does not cause a permanent false "offline". Results are cached for 5 seconds while nothing in the
store changes.

### Per-runner status (1.4.0)

With more than one PC, `runner_status`, `GET /runner/status` and `onememory runner-status` report each
runner on its own line. The top-level `runner`, `waiting_total`, `expiring_soon_total` and
`expired_total` fields keep their old meaning for older clients: `runner` describes the most worrying
runner that has commands waiting (a stale or never-seen one beats an online one), else the freshest.
A command addressed to a PC that has never beaten is reported under that PC as `never_seen`, not
silently counted against another machine. The offline notice names each affected PC when there is more
than one.

### Upgrading the runner (needed once, for runners older than 1.3.4)

A runner older than 1.3.4 writes its heartbeat with no writer marker, and one shared note. 1.4.0 does
not believe a heartbeat that cannot show it came from the runner process, so such a PC would read as
offline. The fix is only to update the runner on that PC (`npm install` the new version and restart it;
no setting changes, and its approved tasks are untouched). As a stopgap while you roll that out, set
`ONEMEMORY_RUNNER_ACCEPT_LEGACY=1` on the **server**: marker-less heartbeats then count again, with
the old caveat that anyone able to write a note with an empty writer could forge one (library callers
and rows from before schema v13 have no writer). Remove it once every runner is current.

## Which commands have been handled

The runner keeps its own record on the PC (`data/runner-seen.json`) of every
note it has looked at and every command id it has run. That record decides
what is new, not anything in the store, so someone with a store token cannot
stop a command by marking it `claimed`. (The `claimed` tag is still added as
a hint for you and for cleanup.)

If you run more than one runner against the same store, address commands
with `--target` / the page's "Target machine" field. An untargeted command
may be run by every runner that sees it.

## Flood and clutter control

If the signing secret ever leaked, an attacker could queue thousands of valid
commands. The runner executes at most 10 per poll and 60 per ten minutes.
Overflow is **deferred, not refused** — a genuine burst of your own commands
still runs, just spread over a few polls, and nothing is quietly dropped.

Only **verified** commands count toward those limits. Unsigned or forged
notes are looked at at most 200 per poll, recorded as rejected, and never
looked at again, so junk from someone without your secret cannot crowd out
your real commands.

Handled commands and old results are deleted after 30 days, so the namespaces
do not grow forever. Unclaimed commands are never pruned, however old.

## Settings

| Variable | Default | What it does |
| --- | --- | --- |
| `ONEMEMORY_RUNNER_SECRET` | *(required)* | Signing secret. No secret, no start. |
| `ONEMEMORY_RUNNER_ALLOW` | *(file)* | Allowlist as JSON, instead of the file. |
| `ONEMEMORY_RUNNER_NAMESPACE` | `commands` | Where it looks for commands. |
| `ONEMEMORY_RUNNER_RESULTS_NAMESPACE` | `results` | Where answers are written. |
| `ONEMEMORY_RUNNER_POLL_MS` | `30000` | How often it checks. |
| `ONEMEMORY_RUNNER_FRESHNESS_MS` | `300000` | How old a command may be. |
| `ONEMEMORY_RUNNER_TIMEOUT_MS` | `120000` | Hard limit on any one command. |
| `ONEMEMORY_RUNNER_HEARTBEAT_MS` | `180000` | Heartbeat refresh. |
| `ONEMEMORY_RUNNER_MAX_PER_POLL` | `10` | Commands run per poll; the rest wait. |
| `ONEMEMORY_RUNNER_MAX_PER_WINDOW` | `60` | Flood ceiling per window. |
| `ONEMEMORY_RUNNER_WINDOW_MS` | `600000` | Length of that window. |
| `ONEMEMORY_RUNNER_MAX_REJECTS_PER_POLL` | `200` | Unverified notes examined per poll. |
| `ONEMEMORY_ENABLE_SIGN_PAGE` | *(off)* | Set to `1` on the **API** process to serve `/sign`. |
| `ONEMEMORY_RUNNER_RETENTION_DAYS` | `30` | Delete handled notes older than this. `0` keeps everything. |
| `ONEMEMORY_RUNNER_PRUNE_EVERY_MS` | `3600000` | Minimum gap between cleanup sweeps. |
| `ONEMEMORY_RUNNER_STALE_SECONDS` | `600` | Heartbeat age after which `runner_status` reports the runner stale (30 s - 7 d, and never less than three beat intervals). Set on the **API/MCP** process. |
| `ONEMEMORY_RUNNER_ID` | machine name | This runner's name, matched against a command's `target`. |

## Honest limits

- The runner can only do what you allowlist. That is the design, not a gap to
  close later — an "run anything" mode would make a signed-note leak
  catastrophic instead of annoying.
- Output stored in a result note is capped (20k characters) and the store's
  secret scanner may refuse a result that looks like it contains a credential.
  You still get a note saying so, never silence.
- It does not run while the PC is off or asleep: an approved command simply
  waits until the PC wakes and the runner polls again, or until the approval
  expires (24 h by default), whichever comes first. You are told: see
  [Is the PC asleep? Commands waiting](#is-the-pc-asleep-commands-waiting).
- It runs commands as whatever user starts it. Do not start it as an
  administrator unless an allowlisted action genuinely needs that.

## Command tasks: the task board in front of the runner

Instead of signing a command on a phone page, you can queue it as a task and
approve it from any admin session. It reaches the same runner, through the
same allowlist.

```
task_put({ title: "pull the site", command: { action: "site-pull", params: { repo: "calas-site" } }, target: "DANITA" })
        // any write token: creates a task in status `queued`. It cannot run yet.
task_approve({ id: 41, command_hash: "<the command_hash task_get showed>" })
        // ADMIN token only. Read the task first (task_get); the approval is refused if the command changed since.
        // the PC's runner runs it within one poll and writes the result onto the task
```

REST: `POST /tasks` with `command` and `target`, `POST /tasks/:id/approve`
(admin), `GET /tasks/:id`. Pass `approve: true` when creating with an admin
token to do both in one call.

Switch it on at the PC by naming the namespace the runner should watch:

    setx ONEMEMORY_RUNNER_TASK_NAMESPACE "tasks"
    setx ONEMEMORY_RUNNER_ID "DANITA"

It is **off** until you do. The task must be created in that same namespace
(`namespace: "tasks"` in `task_put`; with namespace resolution on, the API
writes into its own namespace, so put your runner's namespace there).

### What has to be true before anything runs

1. The task lives in exactly the runner's task namespace. If namespace
   resolution sent it elsewhere, the runner never sees it (it fails closed).
2. `target` equals this runner's own id (`ONEMEMORY_RUNNER_ID`, else the
   machine name). Tasks for other machines are left alone.
3. An admin approved it. The approval is a MAC, made with a secret that lives
   only inside the store, over the namespace, the task id, a one-time nonce and
   an expiry (default 24 h, `ONEMEMORY_APPROVAL_TTL_SECONDS`) and a hash of the command, params and target.
   `task_approve` must echo the `command_hash` (or `rev`) the admin read. Editing any of those (through
   `task_put` or by hand) voids it; copying the approval tag to another task
   fails; a write token cannot write the approval tag at all (the `task.*` tags
   are reserved).
4. It is single-use: the approval is removed in the same compare-and-swap write
   that marks the task `running`, before anything executes (so a crash or a lost
   ledger cannot replay it), and the nonce also goes in the runner's local ledger.
   Queueing it again needs a fresh approval.
5. The action is on this PC's allowlist and the params match their patterns,
   exactly as for a command note. No shell is involved (`shell:false`, argv only).

Queue hygiene: the runner selects approved tasks in SQL and pages through all of
them, a namespace holds at most 100 queued command tasks
(`ONEMEMORY_TASK_COMMAND_QUOTA`), and a command task cannot be claimed; approve
and revoke clear any lease. The runner never overrides a lease held by someone else.

The runner signs the command with **its own** secret in memory. The secret is
never stored, never sent to the API, and no token (read, write or admin) can
read it. A low-privilege token can queue a task and nothing more.

**Read-only vs mutating actions:** the allowlist has no read-only flag, so there
is no "safe, skips approval" class. Every command task needs an explicit admin
approval, whatever the action does.

The outcome lands on the task (`status` done / failed, `result` with the exit
code and up to 4,000 characters of output) and, as before, as a signed note in
the `results` namespace.
