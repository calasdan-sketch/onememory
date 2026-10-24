// A read-scoped MCP server must refuse writes and deletes but still allow
// reads/search/list. Same InMemoryTransport harness as mcp.test.ts.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Store } from "../src/store.js";
import { createMcpServer } from "../src/mcp-server-core.js";

describe("MCP scope enforcement (read-only token)", () => {
  let store: Store;
  let client: Client;

  before(async () => {
    store = new Store(":memory:");
    store.create({ title: "seed", body: "hello" });
    const server = createMcpServer(store, "read"); // read-only principal
    const [c, s] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test-client", version: "1.0.0" });
    await Promise.all([client.connect(c), server.connect(s)]);
  });

  after(async () => {
    await client.close();
    store.close();
  });

  test("state_list is allowed under read scope", async () => {
    const r: any = await client.callTool({ name: "state_list", arguments: {} });
    assert.ok(!r.isError, "read scope should allow listing");
  });

  test("state_write is refused under read scope", async () => {
    const r: any = await client.callTool({
      name: "state_write",
      arguments: { title: "nope" },
    });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /scope/i);
    // And nothing was written.
    assert.equal(store.list({}).total, 1);
  });

  test("state_delete is refused under read scope", async () => {
    const r: any = await client.callTool({
      name: "state_delete",
      arguments: { id: 1 },
    });
    assert.equal(r.isError, true);
    assert.equal(store.read(1)?.title, "seed"); // still there
  });
});

describe("MCP scope enforcement (write token)", () => {
  let store: Store;
  let client: Client;

  before(async () => {
    store = new Store(":memory:");
    store.create({ title: "seed" });
    const server = createMcpServer(store, "write"); // write principal
    const [c, s] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test-client", version: "1.0.0" });
    await Promise.all([client.connect(c), server.connect(s)]);
  });

  after(async () => {
    await client.close();
    store.close();
  });

  test("state_write is allowed under write scope", async () => {
    const r: any = await client.callTool({
      name: "state_write",
      arguments: { title: "ok" },
    });
    assert.ok(!r.isError, "write scope should allow state_write");
    assert.equal(store.list({}).total, 2);
  });

  test("state_delete is refused under write scope (needs admin)", async () => {
    const r: any = await client.callTool({
      name: "state_delete",
      arguments: { id: 1 },
    });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /scope/i);
    assert.equal(store.read(1)?.title, "seed"); // still there
  });
});

describe("MCP scope enforcement: Tier 2 tools", () => {
  let store: Store;
  let readClient: Client;
  let writeClient: Client;

  before(async () => {
    store = new Store(":memory:");
    store.create({ title: "seed", body: "hello world" });
    const mkClient = async (scope: "read" | "write") => {
      const server = createMcpServer(store, scope);
      const [c, s] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "test-client", version: "1.0.0" });
      await Promise.all([client.connect(c), server.connect(s)]);
      return client;
    };
    readClient = await mkClient("read");
    writeClient = await mkClient("write");
  });

  after(async () => {
    await readClient.close();
    await writeClient.close();
    store.close();
  });

  test("read scope allows memory_stats", async () => {
    const r: any = await readClient.callTool({ name: "memory_stats", arguments: {} });
    assert.ok(!r.isError, "read scope should allow memory_stats");
  });

  test("read scope allows state_relevant", async () => {
    const r: any = await readClient.callTool({
      name: "state_relevant",
      arguments: { message: "hello world" },
    });
    assert.ok(!r.isError, "read scope should allow state_relevant");
  });

  test("read scope is refused memory_consolidation_candidates (admin-only since 1.1)", async () => {
    // The scan is O(n^2) CPU over the whole store: a read token must not be
    // able to burn the server's CPU with it.
    const r: any = await readClient.callTool({
      name: "memory_consolidation_candidates",
      arguments: {},
    });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /admin/);
  });

  test("read scope allows state_read with neighbors:true", async () => {
    const r: any = await readClient.callTool({
      name: "state_read",
      arguments: { id: 1, neighbors: true },
    });
    assert.ok(!r.isError, "read scope should allow state_read with neighbors");
  });

  test("read scope denies memory_rebuild_edges (needs admin)", async () => {
    const r: any = await readClient.callTool({
      name: "memory_rebuild_edges",
      arguments: {},
    });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /scope/i);
  });

  test("read scope denies memory_consolidate (needs admin)", async () => {
    const r: any = await readClient.callTool({
      name: "memory_consolidate",
      arguments: { ids: [1, 1], dry_run: true },
    });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /scope/i);
  });

  test("write scope denies memory_rebuild_edges (needs admin)", async () => {
    const r: any = await writeClient.callTool({
      name: "memory_rebuild_edges",
      arguments: {},
    });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /scope/i);
  });

  test("write scope denies memory_consolidate (needs admin)", async () => {
    const r: any = await writeClient.callTool({
      name: "memory_consolidate",
      arguments: { ids: [1, 1], dry_run: true },
    });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /scope/i);
  });
});
