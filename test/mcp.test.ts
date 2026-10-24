// Exercises the MCP tool wrappers end-to-end: a real Client talks to a real
// McpServer over the SDK's InMemoryTransport, which in turn calls straight
// into the same Store used by the HTTP API tests. This is not a mock --
// state_write really inserts into the store, state_read/search/list really
// query it back.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Store } from "../src/store.js";
import { createMcpServer } from "../src/mcp-server-core.js";

function parseToolText(result: any): any {
  const item = result.content[0];
  assert.equal(item.type, "text");
  // Retrieval results are prefixed with an untrusted-data SECURITY NOTICE
  // banner; strip anything before the JSON payload before parsing.
  const text = item.text as string;
  const start = text.indexOf("{");
  return JSON.parse(start >= 0 ? text.slice(start) : text);
}

describe("MCP tool wrappers", () => {
  let store: Store;
  let client: Client;

  before(async () => {
    store = new Store(":memory:");
    const server = createMcpServer(store);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test-client", version: "1.0.0" });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  });

  after(async () => {
    await client.close();
    store.close();
  });

  test("server advertises exactly the twenty-two tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "catch_up",
      "memory_ack",
      "memory_consolidate",
      "memory_consolidation_candidates",
      "memory_quarantine",
      "memory_rebuild_edges",
      "memory_since",
      "memory_stats",
      "runner_status",
      "session_handoff",
      "state_delete",
      "state_list",
      "state_read",
      "state_relevant",
      "state_search",
      "state_write",
      "task_approve",
      "task_claim",
      "task_get",
      "task_list",
      "task_put",
      "trust_policy",
    ]);
  });

  test("state_delete removes a note from the real store", async () => {
    const created = store.create({ title: "to delete", body: "bye" });
    const result = await client.callTool({
      name: "state_delete",
      arguments: { id: created.id },
    });
    const { deleted } = parseToolText(result);
    assert.equal(deleted, created.id);
    assert.equal(store.read(created.id), null);
  });

  test("state_delete on a missing id errors", async () => {
    const result: any = await client.callTool({
      name: "state_delete",
      arguments: { id: 999999 },
    });
    assert.equal(result.isError, true);
  });

  test("state_write creates a note that lands in the real store", async () => {
    const result = await client.callTool({
      name: "state_write",
      arguments: { title: "From MCP", body: "written via tool", tags: ["mcp"] },
    });
    const { note } = parseToolText(result);
    assert.equal(note.title, "From MCP");

    // Verify directly against the store, not just via another tool call.
    const direct = store.read(note.id);
    assert.equal(direct?.body, "written via tool");
  });

  test("state_write without id and without title errors", async () => {
    const result: any = await client.callTool({
      name: "state_write",
      arguments: { body: "no title" },
    });
    assert.equal(result.isError, true);
  });

  test("state_write with id updates the existing note", async () => {
    const created = store.create({ title: "Will update", body: "old" });
    const result = await client.callTool({
      name: "state_write",
      arguments: { id: created.id, body: "new" },
    });
    const { note } = parseToolText(result);
    assert.equal(note.id, created.id);
    assert.equal(note.body, "new");
    assert.equal(note.title, "Will update");
  });

  test("state_write with unknown id errors instead of silently creating", async () => {
    const result: any = await client.callTool({
      name: "state_write",
      arguments: { id: 987654, body: "ghost" },
    });
    assert.equal(result.isError, true);
  });

  test("state_read returns a note written directly through the store", async () => {
    const note = store.create({ title: "Direct write", body: "seen by MCP?" });
    const result = await client.callTool({ name: "state_read", arguments: { id: note.id } });
    const parsed = parseToolText(result);
    assert.equal(parsed.note.body, "seen by MCP?");
  });

  test("state_read on missing id errors", async () => {
    const result: any = await client.callTool({ name: "state_read", arguments: { id: 555555 } });
    assert.equal(result.isError, true);
  });

  test("state_search finds notes written via state_write, not a mock", async () => {
    const unique = `mcpneedle${Date.now()}`;
    await client.callTool({
      name: "state_write",
      arguments: { title: "Searchable", body: unique },
    });

    const result = await client.callTool({
      name: "state_search",
      arguments: { query: unique },
    });
    const { results } = parseToolText(result);
    assert.equal(results.length, 1);
    assert.ok(results[0].body.includes(unique));
  });

  test("state_search does not return stale content after state_write updates it", async () => {
    const created = store.create({ title: "Stale check", body: "originalphrase" });
    let search = await client.callTool({ name: "state_search", arguments: { query: "originalphrase" } });
    assert.equal(parseToolText(search).results.length, 1);

    await client.callTool({
      name: "state_write",
      arguments: { id: created.id, body: "updatedphrase" },
    });

    search = await client.callTool({ name: "state_search", arguments: { query: "originalphrase" } });
    assert.equal(parseToolText(search).results.length, 0, "stale result after MCP update");

    search = await client.callTool({ name: "state_search", arguments: { query: "updatedphrase" } });
    assert.equal(parseToolText(search).results.length, 1);
  });

  test("state_list reflects notes created via state_write", async () => {
    const ns = `mcp-ns-${Date.now()}`;
    await client.callTool({ name: "state_write", arguments: { title: "L1", namespace: ns } });
    await client.callTool({ name: "state_write", arguments: { title: "L2", namespace: ns } });

    const result = await client.callTool({ name: "state_list", arguments: { namespace: ns } });
    const { notes, total } = parseToolText(result);
    assert.equal(total, 2);
    assert.equal(notes.length, 2);
  });
});
