# Install OneMemory in your agent

OneMemory speaks the standard **MCP** protocol, so it drops into any
MCP-capable agent. They all launch it the same way — a local command over
"stdio" — they just keep their config in different places. Pick yours below.

> **One-time setup first** (Node.js 24+):
> ```bash
> npm install -g onememory-mcp
> ```
> That puts the `onememory` command on your PATH; every client below runs
> `onememory mcp`. Your memory lives in `~/.onememory` (override with
> `ONEMEMORY_HOME`), so it survives upgrades.
>
> Working from a git clone instead? `npm install && npm run build && npm link`
> gives you the same `onememory` command.

---

## The easy way: `onememory setup`

```bash
npx onememory-mcp setup --dry-run     # shows exactly what it would change; writes nothing
npx onememory-mcp setup               # does it, after you type y; backs up every file; --undo reverses it
```

It finds Claude Code, Claude Desktop, Cursor, Codex CLI, Gemini CLI, Muse, VS Code and Zed, adds only the OneMemory entry, and can move an old `claude-bridge` entry across keeping your data.
Details and troubleshooting: [docs/live-claude-code.md](./docs/live-claude-code.md). The manual steps for each app follow.

## Claude Code

```bash
claude mcp add onememory -- onememory mcp
```

## Claude Desktop

Edit `claude_desktop_config.json` (Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "onememory": {
      "command": "onememory",
      "args": ["mcp"]
    }
  }
}
```

## Cursor

Create `.cursor/mcp.json` in your project (or the global one in `~/.cursor/`):

```json
{
  "mcpServers": {
    "onememory": {
      "command": "onememory",
      "args": ["mcp"]
    }
  }
}
```

## GitHub Copilot (VS Code)

Create `.vscode/mcp.json` in your project, or use the user one (`MCP: Open User Configuration`; `setup` writes
`%APPDATA%\Code\User\mcp.json` on Windows, `~/Library/Application Support/Code/User/mcp.json` on macOS,
`~/.config/Code/User/mcp.json` on Linux):

```json
{
  "servers": {
    "onememory": {
      "type": "stdio",
      "command": "onememory",
      "args": ["mcp"]
    }
  }
}
```

## Codex CLI

`~/.codex/config.toml` (or `$CODEX_HOME/config.toml`). `setup` adds only this table and leaves the rest of the file as it is:

```toml
[mcp_servers.onememory]
command = "onememory"
args = ["mcp"]
```

With `--capture`, `setup` also writes `~/.codex/hooks.json` (SessionStart, UserPromptSubmit, PostToolUse, Stop). Codex
runs a new hook only after you trust it: type `/hooks` in Codex and approve the OneMemory ones.

## Gemini CLI

`~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "onememory": {
      "command": "onememory",
      "args": ["mcp"]
    }
  }
}
```

With `--capture`, `setup` adds hooks under `"hooks"` in the same file (SessionStart, BeforeAgent, AfterTool, AfterAgent, SessionEnd).

## Muse (Meta Muse Code)

`~/.config/muse/settings.json` (or `$XDG_CONFIG_HOME/muse/settings.json`). Muse will not start without
`"schema_version": 1`; `setup` adds it when it is missing. If the file already uses `"mcpServers"`, `setup` keeps that
spelling; otherwise it uses `"mcp_servers"` (Meta's documented key):

```json
{
  "schema_version": 1,
  "mcp_servers": {
    "onememory": {
      "transport": "stdio",
      "command": "onememory",
      "args": ["mcp"],
      "mode": "optional"
    }
  }
}
```

With `--capture`, `setup` adds hooks under `"hooks"` in the same file. Each OneMemory hook group holds only its command
(Muse skips a group that has a key it does not know). Muse has not published its hook input fields, so recording there
is best effort.

## Zed

`settings.json` (`%APPDATA%\Zed\settings.json` on Windows, `~/.config/zed/settings.json` elsewhere; `zed: open settings file`):

```json
{
  "context_servers": {
    "onememory": {
      "command": "onememory",
      "args": ["mcp"]
    }
  }
}
```

## Windsurf / Cline / Continue / other MCP agents

They all accept the same stdio launch. Find the client's MCP config and add
a server whose command is `onememory` and whose argument is `mcp`. Example (Windsurf `~/.codeium/windsurf/mcp_config.json`):

```json
{
  "mcpServers": {
    "onememory": {
      "command": "onememory",
      "args": ["mcp"]
    }
  }
}
```

---

## Also reach Claude web & mobile (optional)

Everything above is local. To let Claude on the web or your phone read/write
the **same** store, run the HTTP server and expose it over an HTTPS tunnel —
see [INFRA.md](./INFRA.md) for the Cloudflare Tunnel + token walkthrough.

## Any other app or language

There's also a plain HTTP JSON API (`POST /notes`, `GET /search`, etc.), so
any script or model that can make a web request can use the same store — no
MCP required. See [docs/architecture.md](./docs/architecture.md) for the routes.
