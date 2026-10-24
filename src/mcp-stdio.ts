// MCP server over stdio, for local Claude Code / Claude Desktop config.
// Points at the same SQLite file the HTTP API uses (ONEMEMORY_DB_PATH
// or the default <data dir>/state.db, see config.ts) so state written here is immediately
// visible to the API and vice versa.
import "./quiet-sqlite.js"; // first: hide the node:sqlite ExperimentalWarning
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Store } from "./store.js";
import { createMcpServer } from "./mcp-server-core.js";
import { DB_PATH, prepareDataDir } from "./config.js";
import { resolveStartupNamespace } from "./namespace.js";

prepareDataDir();
const store = new Store(DB_PATH);
// Server-side namespace resolution: resolved ONCE at startup from the
// process working directory. Null when unconfigured (legacy behavior).
const nsOpts = resolveStartupNamespace(process.cwd());
const server = createMcpServer(store, "admin", nsOpts ?? undefined);
const transport = new StdioServerTransport();

await server.connect(transport);

// Blank / whitespace-only lines are keepalives, not messages: swallow them
// instead of answering -32700. (The SDK's line reader has no hook for this,
// so we wrap its readMessage and drop empty lines from the buffer first.)
{
  const rb = (transport as unknown as { _readBuffer?: { _buffer?: Buffer; readMessage: () => unknown } })._readBuffer;
  if (rb && typeof rb.readMessage === "function") {
    const orig = rb.readMessage.bind(rb);
    rb.readMessage = () => {
      for (;;) {
        const buf = rb._buffer;
        const nl = buf ? buf.indexOf(0x0a) : -1;
        if (!buf || nl === -1 || buf.toString("utf8", 0, nl).trim() !== "") break;
        rb._buffer = buf.subarray(nl + 1);
      }
      return orig();
    };
  }
}

// JSON-RPC requires an error reply to a request that cannot be parsed:
// -32700 for malformed JSON, -32600 for JSON that is not a valid message.
// The SDK only reports these to onerror (nothing goes back on stdout), so a
// client that sent `{bad` would wait forever. Chain after connect(), which
// installs its own handler.
const sdkOnError = transport.onerror;
transport.onerror = (err: Error) => {
  sdkOnError?.(err);
  const parseError = err instanceof SyntaxError;
  const invalid = err?.name === "ZodError";
  if (!parseError && !invalid) return;
  void transport
    .send({
      jsonrpc: "2.0",
      id: null,
      error: parseError
        ? { code: -32700, message: "Parse error: request is not valid JSON" }
        : { code: -32600, message: "Invalid Request: not a JSON-RPC 2.0 message" },
    } as unknown as Parameters<typeof transport.send>[0])
    .catch(() => {});
};

// eslint-disable-next-line no-console
console.error(`[onememory] MCP stdio server connected. DB: ${DB_PATH}`);
if (nsOpts) {
  // eslint-disable-next-line no-console
  console.error(`[onememory] namespace resolution ACTIVE: namespace="${nsOpts.namespace}"`);
}

function shutdown(): void {
  store.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
