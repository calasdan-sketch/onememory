// HTTP-level guards on the remote MCP transport (the tunnel surface reaching
// phone/web). These sit in front of the MCP transport and are the controls a
// regression could silently drop; mcp.test.ts only exercises the tools over an
// in-memory transport and never touches this server.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { Store } from "../src/store.js";
import { createMcpHttpServer } from "../src/mcp-http.js";

const TOKEN = "mcp-http-token";

describe("MCP-over-HTTP server guards", () => {
  let store: Store;
  let server: ReturnType<typeof createMcpHttpServer>;
  let base: string;

  before(async () => {
    store = new Store(":memory:");
    server = createMcpHttpServer(store, TOKEN);
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
  });

  test("GET /health needs no auth", async () => {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
  });

  test("POST /mcp with no token is 401", async () => {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(res.status, 401);
  });

  test("a disallowed browser Origin is 403 (before auth)", async () => {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://evil.com" },
      body: "{}",
    });
    assert.equal(res.status, 403);
  });

  test("an unknown path is 404", async () => {
    const res = await fetch(`${base}/nope`);
    assert.equal(res.status, 404);
  });

  test("a valid token passes auth and reaches the MCP transport", async () => {
    // Accept lacks text/event-stream, so the Streamable HTTP transport answers
    // 406 -- which proves the request got PAST auth (not 401) and routing (not
    // 404) into the transport itself.
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    assert.notEqual(res.status, 401);
    assert.notEqual(res.status, 403);
    assert.notEqual(res.status, 404);
  });

  test("a body over 1MB is 413 (consistent with the REST API, not a 500)", async () => {
    const big = "a".repeat(1_100_000);
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "x", params: { big } }),
    });
    assert.equal(res.status, 413);
  });
});
