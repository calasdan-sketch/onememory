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

Create `.vscode/mcp.json`:

```json
{
  "servers": {
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
