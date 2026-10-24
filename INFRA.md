---
type: guide
status: active
---
# OneMemory — Infra & Ops Guide

Setup and operations guide for exposing OneMemory to Claude's remote
surfaces (web, mobile) over the public internet. This document covers the
infra side only — tunnel setup, auth verification, connector setup, and a
smoke test. See the main [README](./README.md) for what the project is and
how to build/run it locally.

## Real values (from `src/config.ts`)

| Name | Value |
|---|---|
| HTTP API port | `8790` (env `ONEMEMORY_PORT`) |
| MCP-over-HTTP port | `8791` (env `ONEMEMORY_MCP_PORT`) |
| MCP-over-HTTP path | `/mcp` |
| Bearer token env var | `ONEMEMORY_TOKEN` (auto-generated and persisted to `~/.onememory/.token` if unset; a from-source git checkout that already has `./data/state.db` keeps using `./data/`) |
| DB path env var | `ONEMEMORY_DB_PATH` (defaults to `~/.onememory/state.db`, or `$ONEMEMORY_HOME/state.db`) |

Placeholders used below that are specific to *your* setup:

| Placeholder | Meaning |
|---|---|
| `<TUNNEL_HOSTNAME>` | The public hostname the tunnel exposes, e.g. `onememory.yourdomain.com` |
| `<ONEMEMORY_TOKEN>` | The bearer token value (from `ONEMEMORY_TOKEN` or the auto-generated `~/.onememory/.token` file) |

---

## 1. Cloudflare Tunnel setup

### Prerequisite: a domain

Cloudflare named tunnels (the kind that survive a restart with the same
public URL) need a **hostname under a domain that is added as a zone in your
Cloudflare account**. A free `*.workers.dev` subdomain doesn't count — you
need an actual domain (purchased or transferred elsewhere and pointed at
Cloudflare's nameservers).

- **Quick Tunnels** (`cloudflared tunnel --url http://localhost:8791`, no
  login needed) hand you a random `*.trycloudflare.com` URL that **changes
  every time cloudflared restarts** — fine for a five-minute test, useless
  for a connector you configure once on your phone and forget about.
- **Named Tunnels** (below) restart with the same URL, but need
  `cloudflared tunnel route dns`, which requires a zone in your account.

The steps below assume you have a domain added as a zone; swap in your real
one wherever you see `yourdomain.com`.

### Step 1 — Install cloudflared

Windows (winget):

```powershell
winget install --id Cloudflare.cloudflared -e
```

Close and reopen the terminal, then confirm:

```powershell
cloudflared --version
```

macOS/Linux: see [Cloudflare's install docs](https://developers.cloudflare.com/cloudflared/get-started/).

### Step 2 — Authenticate

```powershell
cloudflared tunnel login
```

Opens a browser. Log in with your Cloudflare account and pick the domain
(zone) to authorize. This drops a cert at `~/.cloudflared/cert.pem`.

### Step 3 — Create the named tunnel

```powershell
cloudflared tunnel create onememory
```

Note the **Tunnel ID** it prints (a UUID). This also writes a credentials
file to `~/.cloudflared/<TUNNEL_ID>.json` — treat that file as a secret.

### Step 4 — Config file

Create `~/.cloudflared/config.yml`:

```yaml
tunnel: <TUNNEL_ID>
credentials-file: /path/to/home/.cloudflared/<TUNNEL_ID>.json

ingress:
  - hostname: <TUNNEL_HOSTNAME>
    service: http://localhost:8791
  - service: http_status:404
```

`8791` is the MCP-over-HTTP port (see table above). The catch-all 404 rule
at the bottom is required by cloudflared syntax — every ingress list needs
a final rule with no hostname.

### Step 5 — Route DNS

```powershell
cloudflared tunnel route dns onememory <TUNNEL_HOSTNAME>
```

Creates a CNAME in Cloudflare DNS pointing `<TUNNEL_HOSTNAME>` at the
tunnel. Cloudflare terminates TLS for you — the public URL is
`https://<TUNNEL_HOSTNAME>/mcp` with a real cert, no extra work.

### Step 6 — Test it manually

```powershell
cloudflared tunnel run onememory
```

Leave it running, then from another machine (or your phone off wifi) hit
`https://<TUNNEL_HOSTNAME>/health` and confirm you get `{"status":"ok"}`,
not a Cloudflare error page. Ctrl+C to stop once confirmed.

### Step 7 — Restart-on-boot

**Option A — Windows Service (recommended, needs an elevated shell once):**

```powershell
cloudflared service install
```

Registers `cloudflared` as a Windows service that starts at boot, before
any user logs in. Manage it afterwards with:

```powershell
Get-Service Cloudflared
Restart-Service Cloudflared
```

**Option B — Scheduled Task at logon (no elevation needed, weaker guarantee):**

```powershell
schtasks /create /tn "CloudflaredTunnel-OneMemory" /tr "cloudflared tunnel run onememory" /sc onlogon /rl limited
```

Caveat: this only starts the tunnel once you log into Windows, not at raw
machine boot. Fine as a stopgap, not a substitute for Option A.

On macOS/Linux, `cloudflared service install` similarly registers a
launchd/systemd unit.

---

## 2. Token auth checklist

**Do not expose the bridge endpoint unauthenticated.** Verify this before
telling anyone the endpoint is safe to use.

### What "done" looks like

1. The MCP-over-HTTP server (`dist/src/mcp-http.js`) reads a bearer token
   from `ONEMEMORY_TOKEN` (or the auto-generated `~/.onememory/.token` file)
   and rejects any request whose `Authorization: Bearer <token>` header
   doesn't match, before touching the SQLite store or returning any MCP
   capability/tool list.
2. cloudflared itself adds **no auth** — it's a dumb TCP/HTTP proxy from
   `<TUNNEL_HOSTNAME>` to `http://localhost:8791`. Anyone with the URL can
   reach the local server unless the server's own code checks the token.
   The check lives in the app, not the tunnel.
3. The token is never printed to a log beyond the one-time generation
   message, never committed to version control, and should be stored the
   same way you store any other secret (a password manager or OS keychain
   entry), not pasted into notes or docs.

### How to verify

Run these from the machine itself (localhost, no tunnel needed for the
first two):

```powershell
# 1. No token at all — must fail (expect 401, not 200)
curl.exe -i http://localhost:8791/mcp

# 2. Wrong token — must fail (expect 401)
curl.exe -i http://localhost:8791/mcp -H "Authorization: Bearer wrong-token-obviously"

# 3. Correct token — must succeed
curl.exe -i http://localhost:8791/mcp -H "Authorization: Bearer <ONEMEMORY_TOKEN>"
```

Then repeat all three through the public tunnel URL
(`https://<TUNNEL_HOSTNAME>/mcp`) from a network that isn't this machine
(phone on cellular data works) to confirm the tunnel isn't somehow
bypassing the check.

**Don't consider this done, and don't call the endpoint safe to expose,
until all three checks above have actually been run and produced the
expected status codes.**

### Recommended second layer — Cloudflare Access (defense in depth)

**Cloudflare Access** (part of the free Zero Trust plan, up to 50 users)
puts a login wall in front of the tunnel hostname so a request has to pass
Cloudflare *before* it ever reaches the bridge — protection on top of the
bearer token, in case the token leaks.

Enable it (Cloudflare dashboard → **Zero Trust** → **Access** →
**Applications**):

1. **Add an application → Self-hosted.**
2. **Application domain:** your `<TUNNEL_HOSTNAME>` (the same host the
   tunnel exposes). You can scope the path too — e.g. protect `/` and
   `/dashboard.js` for the human dashboard but leave `/mcp` to the bearer
   token (see the gotcha below).
3. **Add a policy:** Action **Allow**, rule **Emails** → your own email.
   That's the whole allowlist — only you get in.
4. Save. Browser visits to the host now hit a Cloudflare email-OTP login
   first.

**Important gotcha — don't lock out your own agents.** Access challenges
*every* request, including the Claude web/mobile connectors and n8n hitting
`/mcp`. A browser can do the email-OTP login; an automated client **cannot**
— it must send a **service token** instead (two headers,
`CF-Access-Client-Id` and `CF-Access-Client-Secret`, created under
Zero Trust → **Access → Service Auth → Service Tokens**, then allowed in the
app's policy).

So, in practice:

- **n8n** can send those two headers alongside the bearer token, so Access
  works fine for it.
- **Claude's web/mobile connectors** may not let you add arbitrary headers.
  If they can't send a service token, putting Access on `/mcp` will block
  them. In that case either (a) scope Access to the dashboard paths only and
  rely on the bearer token for `/mcp`, or (b) add a **Bypass** policy /
  service token for `/mcp`. The bearer token is still enforced either way —
  it's in the app, not the tunnel.

Test your Claude connectors still work right after enabling Access; if they
break, that's this gotcha, not the bridge.

---

## 3. Connector setup — all four Claude surfaces

Two surfaces (Code, Desktop) are **local**: they run on your machine and
talk to the bridge over local stdio, no tunnel needed. The other two (web,
mobile) are **remote** and must go over the public HTTPS tunnel URL from
Section 1.

### Claude Code (local, stdio)

Claude Code reads MCP servers from a `.mcp.json` file (project-level, at
the repo root you're working in):

```json
{
  "mcpServers": {
    "onememory": {
      "command": "node",
      "args": ["/absolute/path/to/onememory/dist/src/mcp-stdio.js"],
      "env": {
        "ONEMEMORY_TOKEN": "<ONEMEMORY_TOKEN>"
      }
    }
  }
}
```

Or generate it with the CLI:

```powershell
claude mcp add onememory -- node /absolute/path/to/onememory/dist/src/mcp-stdio.js
```

(`claude mcp add --help` shows the current flags for passing env vars.)

### Claude Desktop (local, stdio)

Config file: `%APPDATA%\Claude\claude_desktop_config.json` (Windows) or
`~/Library/Application Support/Claude/claude_desktop_config.json` (macOS).
Install/launch Desktop at least once before this file exists to edit.

Same `mcpServers` shape as Code:

```json
{
  "mcpServers": {
    "onememory": {
      "command": "node",
      "args": ["/absolute/path/to/onememory/dist/src/mcp-stdio.js"],
      "env": {
        "ONEMEMORY_TOKEN": "<ONEMEMORY_TOKEN>"
      }
    }
  }
}
```

Desktop's newer builds also expose **Settings → Connectors → Add custom
connector** for remote (HTTP) MCP servers, if you'd rather point Desktop at
the same tunnel URL the web/mobile surfaces use instead of local stdio.
Either works; local stdio is faster and doesn't depend on the tunnel being
up. Check your installed version's settings UI directly — menu placement
moves between releases.

### Claude web (remote, HTTPS)

Claude web only supports remote MCP servers added as a custom connector
through the UI. As currently documented: **claude.ai → Settings →
Connectors → Add custom connector**, then supply:

- Name: `onememory` (or whatever you like)
- URL: `https://<TUNNEL_HOSTNAME>/mcp`
- Auth: however the connector UI asks for the bearer token (a header field
  or an OAuth-style flow, depending on the current UI)

Verify the exact menu path and field names against the live product —
connector UIs change between releases.

### Claude mobile (remote, HTTPS)

Same remote connector mechanism as web, reached through the mobile app's
own settings: **Claude app → Settings → Connectors → Add custom
connector**, same URL and token as the web setup above.

---

## 4. Smoke test — Definition of Done

The real acceptance test: *write a note from Claude Code on the desktop,
then read that same note back from Claude mobile.* Run it exactly like
this once both halves are live — don't accept a partial pass.

### Preconditions (all must be true first)

- [ ] Backend built and running: `npm run build && npm start` in
      `onememory/` completes with no errors, and the process stays up.
- [ ] `npm run mcp:stdio` and `npm run mcp:http` both start cleanly.
- [ ] cloudflared tunnel is running (Section 1) and
      `https://<TUNNEL_HOSTNAME>/health` responds from outside this
      machine.
- [ ] Token auth verified with the three curl checks in Section 2 — all
      three gave the expected status code.
- [ ] Claude Code has the `.mcp.json` entry from Section 3 and lists
      `onememory` as a connected server (`claude mcp list`).
- [ ] Claude mobile has the custom connector from Section 3 added and
      showing as connected in its settings.

### The test itself

1. **On Claude Code, on the desktop**, in a fresh conversation, ask it to
   use the bridge's write tool to save a note with unmistakable, one-off
   content, e.g.:

   > "Using the OneMemory MCP server, write a note titled
   > `smoke-test-<date>` with the body `bridge smoke test — written from
   > Claude Code desktop at <exact current time>`."

   Confirm Claude Code reports the write succeeded (tool call returned
   success, not an error).

2. **Independently confirm the write landed**, not just that the tool
   claimed success — e.g. hit `https://<TUNNEL_HOSTNAME>/mcp` with curl
   and the bearer token, or check `~/.onememory/state.db` for the new row
   directly. "The tool said it worked" is not evidence the shared store
   actually persisted it.

3. **On Claude mobile**, start a brand-new conversation and ask:

   > "Using the OneMemory connector, read back the note titled
   > `smoke-test-<date>` and show me its exact contents."

4. **Pass criteria — all of these, not just "it returned something":**
   - The body text mobile returns is **character-for-character identical**
     to what was written from desktop, including the timestamp.
   - It came back on the first ask, no retries, no "connector not
     responding" errors.
   - Repeat once more in the other direction (write from mobile, read from
     Code) to confirm it's genuinely bidirectional.

5. **Negative check (don't skip this):** temporarily change the bearer
   token Claude mobile's connector is using to something wrong, retry the
   read, and confirm it fails. Put the correct token back afterward.

If all of the above holds, the Definition of Done is met. If a step fails,
the failure point tells you which half broke — Section 1 for anything
tunnel/network-shaped, Section 2 for anything auth-shaped, Section 3 for
anything connector-config-shaped, or the server code itself if the
write/read tools misbehave.


---

## 5. Use with n8n

n8n can read and write the shared store too, which lets you wire the bridge
into automations (e.g. "when a form comes in, save a note"; "every morning,
pull notes tagged `standup`"). Two ways, simplest first.

### A — HTTP Request node (works today, recommended)

The bridge's plain REST API is the surest path. In an **HTTP Request** node:

- **Write a note** — Method `POST`, URL `https://<TUNNEL_HOSTNAME-or-localhost:8790>/notes`,
  Authentication → Header Auth (or a Header parameter) `Authorization: Bearer <ONEMEMORY_TOKEN>`,
  Body (JSON):

  ```json
  { "title": "{{ $json.title }}", "body": "{{ $json.body }}", "tags": ["n8n"] }
  ```

- **Search** — Method `GET`, URL `.../search?q={{ $json.query }}` (add
  `&mode=hybrid` if you've enabled semantic search), same Authorization header.
- **List / read / delete** — `GET /notes`, `GET /notes/:id`, `DELETE /notes/:id`.

If n8n runs on a different machine than the bridge, point it at the public
tunnel URL and keep the bearer token in an n8n credential, not hard-coded in
the node. If both run on the same machine, `http://localhost:8790` is fine
and needs no tunnel.

> Behind Cloudflare Access? Add the two service-token headers
> (`CF-Access-Client-Id`, `CF-Access-Client-Secret`) to the same node — see
> Section 2.

### B — MCP Client node (newer n8n)

Recent n8n versions ship an **MCP Client** node. Point it at the
MCP-over-HTTP endpoint (`https://<TUNNEL_HOSTNAME>/mcp`) with the bearer
token, and the bridge's tools (`state_write`, `state_search`, …) appear as
callable operations — the same tools Claude and Cursor use.

*Status — both routes tested on n8n 2.43.6 against this server:*

- *Route A (HTTP Request node): verified end to end. A workflow with an
  HTTP Request node wrote a note to `POST /notes` and read it back from
  `GET /search`; n8n reported the run successful and the note was present in
  the store.*
- *Route B (MCP Client node): the `/mcp` endpoint was verified compatible
  with the node's transport — a client using the same Streamable HTTP + Bearer
  transport the MCP Client node wraps (`httpStreamable` + `bearerAuth`)
  listed the tools, called `state_write` and `state_search` successfully, and
  had a wrong token correctly rejected. The MCP Client node is an AI-tool
  sub-node driven by an Agent node, so exercising it needs an LLM-backed
  agent; the transport and auth it uses are confirmed working here. If your
  n8n build's MCP node behaves differently, fall back to the HTTP Request
  node (Route A).*


---

## 6. Running it always-on

OneMemory is one Node process (`onememory start`: API on 8790, MCP on 8791). If
it dies, your phone and every connector lose it, so run it under something that
restarts it. The recipes below were written against the process's real
behaviour (it exits 0 on SIGTERM and non-zero on a fatal error); the service
definitions themselves could not be run in the environment they were written in
(no systemd, no Windows), so check them once on your machine: **verify with
`systemd-analyze verify` / `Get-ScheduledTask`, then reboot once.**

### Linux: systemd

`/etc/systemd/system/onememory.service` (adjust `User`, the `onememory` path
from `which onememory`, and the data dir):

```ini
[Unit]
Description=OneMemory
After=network-online.target
Wants=network-online.target

[Service]
User=onememory
Environment=ONEMEMORY_HOME=/var/lib/onememory
# Optional: ONEMEMORY_TOKEN, ONEMEMORY_BIND, ports ... (see docs/configuration.md)
EnvironmentFile=-/etc/onememory.env
ExecStart=/usr/bin/onememory start
Restart=always
RestartSec=3
# SIGTERM ends parked live-waits at once and the process exits in well under a second
TimeoutStopSec=10
# Hardening that does not get in the way of a single-file SQLite store:
NoNewPrivileges=true
ProtectSystem=full
ProtectHome=true
ReadWritePaths=/var/lib/onememory
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

```bash
sudo useradd --system --home /var/lib/onememory --create-home onememory
sudo systemctl daemon-reload && sudo systemctl enable --now onememory
systemctl status onememory
journalctl -u onememory -f
```

`Restart=always` brings it back after a crash or an out-of-memory kill; a clean
`systemctl restart` drains parked waiters first (they get `timedOut: true`).

### Windows: Task Scheduler for OneMemory itself

The tunnel recipe in section 1 only keeps *cloudflared* alive. This keeps
OneMemory alive: it starts at logon and Task Scheduler restarts it if it exits.
PowerShell (run once, normal user; adjust the path from `where.exe onememory`):

```powershell
$exe = (Get-Command onememory).Source
$action   = New-ScheduledTaskAction -Execute $exe -Argument "start"
$trigger  = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
            -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName "OneMemory" -Action $action -Trigger $trigger -Settings $settings
Start-ScheduledTask -TaskName "OneMemory"
```

Caveats: it starts when you log in, not at raw boot (use NSSM or a service
wrapper for that), and if your PC sleeps the store sleeps, which also pauses
phone-to-other-session sync. For something that must stay reachable, run it on a
small always-on host (a VPS, Fly.io/Railway, or a Raspberry Pi) instead; a
`docker-compose.yml` ships in the repo.

---

## 7. Backups

State is a single SQLite file plus, when at-rest encryption is on, the key.

```bash
onememory backup --out ~/om-backup/2026-10-24
```

- Takes a consistent snapshot with SQLite `VACUUM INTO`, so it is **safe while
  the server is running and writing**; it never overwrites an existing backup.
- Writes `state.db`, a `README.txt`, and a copy of **`.key`** (mode 0600) when
  encryption is enabled, and checks the copy with `PRAGMA integrity_check`.
- **Store the key separately from the backup.** Encrypted note bodies are
  unreadable without `.key`; a backup kept next to its key is no longer
  protected by the encryption. Put the key in a password manager or another
  drive, keep a second copy, and never lose it: there is no recovery without it.
- The command-task **approval key** (in the database's `_meta`, not in `.key`) is
  left out of the backup unless you add `--include-approval-key`. After restoring
  such a backup, existing approvals read as stale (they fail closed) and an admin
  re-approves queued command tasks. Include the key only if you need approvals to
  survive a restore, and then guard the backup like the key.
- Do not just copy `state.db` while the server runs: without `state.db-wal` /
  `state.db-shm` the copy can be inconsistent.
- Restore: stop the server, put `state.db` (and `.key` if you use encryption) in
  the data dir, delete any stale `state.db-wal` / `state.db-shm`, start it.
- Schedule it (systemd timer, cron, or Task Scheduler running `onememory backup
  --out <dated folder>`), and test a restore once.
- The JSON route (`onememory export --format json`, admin token) is
  independent of the database file format; use both if you like.

Other housekeeping that runs by itself: `audit.log` rotates at 5 MB keeping 5
files (`ONEMEMORY_AUDIT_MAX_BYTES`, `ONEMEMORY_AUDIT_KEEP`; rotation is locked so several
processes cannot lose lines), and the change log
is pruned hourly (90-day retention) by the server, not just when the feed is read.

---

## 8. Live wait behind a proxy or tunnel

`memory_since { wait_seconds }` / `GET /changes?wait=` hold an HTTP request open
and send nothing until it ends. A proxy that cuts idle responses at 30 seconds
(common for tunnels and corporate proxies) therefore kills a long wait: measured
here, `wait=25` returned normally at 25.1s, `wait=55` died at exactly 30.0s behind
a 30s proxy, and a direct connection or a 60s proxy held 55s. **Use 25.** If a
wait dies, the symptom is a dropped connection, not an error from OneMemory.
Each parked request holds one of 16 slots per token (32 per namespace scope, 64
per process); when they run out you get a 429 that says which limit it was.

---

## 9. Deploy in 15 minutes (one person, one box)

Steps marked (verified) were run end to end against this build on Linux, Node
24, without network access; steps marked (not verified here) need the internet
or a service manager and were not run.

```bash
node -v                                  # (verified) must print v24 or newer
npm install -g onememory-mcp                 # (not verified here: needs the npm registry)
onememory start                          # (verified) creates ~/.onememory/.token and state.db, API :8790, MCP :8791
curl localhost:8790/health               # (verified) {"status":"ok"}
T=$(cat ~/.onememory/.token)             # (verified)
curl -s -H "Authorization: Bearer $T" "localhost:8790/changes?since=last&consumer=pc&wait=25"   # (verified) parks, then returns timedOut:true
curl -s -H "Authorization: Bearer $T" -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -X POST localhost:8791/mcp \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"memory_since","arguments":{"since":"last","consumer":"pc","wait_seconds":25}}}'   # (verified)
onememory backup --out ~/om-backup       # (verified) hot copy, works while the server runs
onememory doctor                         # (verified) checks Node, database, token, hook
cloudflared tunnel --url http://localhost:8791   # (not verified here) quick tunnel, TESTING ONLY: the URL changes on restart
```

Then: make it a service (section 6), set up a named tunnel and add Cloudflare
Access (sections 1-2), schedule `onememory backup` (section 7), and run the three
auth checks from section 2 against the public URL before you trust it.

Where to host (CAD, check current prices): your own PC with a free Cloudflare
Tunnel is about $0 plus a domain at roughly $15/year, but it must stay on; a small
VPS is roughly $5-8/month; Fly.io or Railway roughly $5-10/month; a Raspberry Pi is
about $100 once and about $1/month in power.
