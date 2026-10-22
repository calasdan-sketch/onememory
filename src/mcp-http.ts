// MCP server over HTTP/SSE (the Streamable HTTP transport from the MCP
// spec), for the remote tunnel that reaches your phone/web. Runs stateless
// (no session id) -- one Store shared across all requests, a fresh
// McpServer+transport pair per request (the pattern the SDK docs use for
// stateless HTTP), so there is no per-session memory to leak or expire.
//
// Auth: same bearer token as the REST API, checked in front of the MCP
// transport on every request.
//
// This module exports a factory (createMcpHttpServer) so the combined
// `start` command can run it alongside the REST API sharing ONE Store.
// It also runs standalone when invoked directly (node dist/src/mcp-http.js).

import "./quiet-sqlite.js"; // first: hide the node:sqlite ExperimentalWarning
import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Store } from "./store.js";
import { createMcpServer } from "./mcp-server-core.js";
import { originAllowed, RateLimiter, clientKey, authenticateEntry } from "./security.js";
import { type TokenEntry } from "./config.js";
import { type ServerNamespaceOpts, resolveRequestNamespace } from "./namespace.js";
import { PayloadTooLargeError, readBody, normalizeTokens, exitOnListenError } from "./http-common.js";

// Small JSON writer that never writes to an already-finished response.
function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  if (res.headersSent || res.writableEnded) return;
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

/**
 * Build the MCP-over-HTTP server around an existing Store. Does not listen --
 * the caller decides host/port. The same `store` can be shared with the REST
 * API so both transports read and write one SQLite file in one process.
 * `opts` carries the startup-resolved namespace (see resolveStartupNamespace);
 * it is threaded into every per-request McpServer so resolution happens once,
 * not per request.
 */
export function createMcpHttpServer(
  store: Store,
  token: string | TokenEntry[],
  opts: ServerNamespaceOpts = {}
): Server {
  const tokens = normalizeTokens(token);
  const limiter = new RateLimiter();

  // Resolve the namespace context for ONE request: the token's own pin wins
  // over the server's startup-resolved namespace. A fresh McpServer is built
  // per request, so this is safe under concurrency -- nothing is shared.
  const resolveNsForRequest = (tokenNamespace?: string): ServerNamespaceOpts => {
    const resolved = resolveRequestNamespace(tokenNamespace, opts);
    return resolved.active
      ? { namespace: resolved.ownNamespace, readsFrom: resolved.readsFrom }
      : {};
  };

  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, { status: "ok" });
      return;
    }

    if (!originAllowed(req)) {
      sendJson(res, 403, { error: "origin not allowed" });
      return;
    }
    if (!limiter.check(clientKey(req))) {
      sendJson(res, 429, { error: "rate limit exceeded" });
      return;
    }

    if (url.pathname !== "/mcp") {
      sendJson(res, 404, { error: "no such route" });
      return;
    }

    const principal = authenticateEntry(req, tokens);
    if (!principal) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }
    const scope = principal.scope;

    try {
      let parsedBody: unknown;
      if (req.method === "POST") {
        // Shared body reader -> 413 on overflow (via the catch), same as REST.
        const raw = await readBody(req);
        if (raw) {
          try {
            parsedBody = JSON.parse(raw);
          } catch {
            sendJson(res, 400, { error: "invalid JSON body" });
            return;
          }
        }
      }

      // Stateless: fresh server + transport per request, same underlying Store.
      // The caller's token scope flows into the tools so a read-only token
      // can't write or delete over this transport.
      //
      // Per-request namespace: a token's own pin WINS over the server's
      // startup-resolved namespace (see resolveRequestNamespace). Because a
      // fresh McpServer is built per request here, threading the resolved
      // context in as `opts` is sufficient -- and concurrency-safe, since no
      // state is shared between requests.
      const server = createMcpServer(store, scope, resolveNsForRequest(principal.namespace));
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      res.on("close", () => {
        // Runs in an event callback outside the try/catch below; a throw here
        // (e.g. client vanished mid-connect) would be an uncaught exception.
        try {
          transport.close();
          server.close();
        } catch {
          /* already closing / not fully connected -- nothing to do */
        }
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, parsedBody);
    } catch (e) {
      // An over-cap body is a client problem -> 413, matching the REST API.
      if (e instanceof PayloadTooLargeError) {
        sendJson(res, 413, { error: "payload too large" });
        return;
      }
      console.error("[onememory] mcp error:", (e as Error).message);
      sendJson(res, 500, { error: "internal error" });
    }
  });
}

// --- standalone entry (node dist/src/mcp-http.js) ---------------------------
async function runStandalone(): Promise<void> {
  const { DB_PATH, MCP_HTTP_PORT, BIND_HOST, resolveTokens, assertSafeExposure, prepareDataDir } =
    await import("./config.js");
  const { resolveStartupNamespace } = await import("./namespace.js");
  prepareDataDir();
  assertSafeExposure();
  const tokens = resolveTokens();
  const store = new Store(DB_PATH);
  // Namespace resolution happens ONCE here, at startup, from the process cwd.
  const nsOpts = resolveStartupNamespace(process.cwd());
  if (nsOpts) {
    console.error(
      `[onememory] namespace resolution ACTIVE: namespace="${nsOpts.namespace}"`
    );
  }
  const httpServer = createMcpHttpServer(store, tokens, nsOpts ?? undefined);

  exitOnListenError(httpServer, MCP_HTTP_PORT, "ONEMEMORY_MCP_PORT", "MCP").listen(MCP_HTTP_PORT, BIND_HOST, () => {
    console.error(
      `[onememory] MCP HTTP/SSE server listening on http://${BIND_HOST}:${MCP_HTTP_PORT}/mcp`
    );
  });

  const shutdown = (): void => {
    httpServer.close(() => {
      store.close();
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// Only boot on its own when run directly, not when imported by start.ts.
// Compare real (symlink-resolved) paths, case-insensitively on Windows, so a
// drive-letter-case or bin-shim difference doesn't make the standalone entry
// silently fail to start.
function invokedDirectly(): boolean {
  if (!process.argv[1]) return false;
  try {
    const norm = (p: string): string => {
      let r: string;
      try {
        r = realpathSync(p);
      } catch {
        r = resolve(p);
      }
      return process.platform === "win32" ? r.toLowerCase() : r;
    };
    return norm(process.argv[1]) === norm(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  void runStandalone();
}
