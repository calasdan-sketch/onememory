// Regression tests for panel blockers #3 and #5 (namespace isolation
// bypasses in the API/MCP layer).
//
// Blocker #3: update-by-id and DELETE gated on canRead(), so an agent with a
// `reads_from` grant to namespace B could overwrite or delete B's notes.
// Writes must require the note to live in the server's OWN namespace; read
// grants stay read-only. Denied cross-namespace writes report the same
// "not found" as a missing note (no existence oracle).
//
// Blocker #5: REST /export dumped every namespace and /import preserved
// client-supplied namespaces. With resolution active, /export filters to
// readable() namespaces and /import forces notes into the server's own
// namespace.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Store } from "../src/store.js";
import { createMcpServer } from "../src/mcp-server-core.js";
import { createApiServer } from "../src/api.js";

const TOKEN = "blocker-test-token";

function parseToolText(result: any): any {
  const item = result.content[0];
  assert.equal(item.type, "text");
  const text = item.text as string;
  const start = text.indexOf("{");
  return JSON.parse(start >= 0 ? text.slice(start) : text);
}

async function startApi(
  store: Store,
  opts?: { namespace?: string; readsFrom?: Record<string, string[]> }
) {
  const server = createApiServer(store, TOKEN, opts);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  const headers = {
    Authorization: `Bearer ${TOKEN}`,
    "Content-Type": "application/json",
  };
  const stop = () =>
    new Promise<void>((resolve) => server.close(() => resolve()));
  return { base, headers, stop };
}

const NS_OPTS = { namespace: "agent-a", readsFrom: { "agent-a": ["shared"] } };

describe("blocker #3: reads_from grants never confer write access (MCP)", () => {
  let store: Store;
  let client: Client;
  let ownId: number;
  let sharedId: number;

  before(async () => {
    store = new Store(":memory:");
    ownId = store.create({ namespace: "agent-a", title: "own", body: "own body" }).id;
    sharedId = store
      .create({ namespace: "shared", title: "shared", body: "shared body" }).id;
    const server = createMcpServer(store, "admin", NS_OPTS);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test-client", version: "1.0.0" });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  });

  after(async () => {
    await client.close();
    store.close();
  });

  test("state_write update-by-id on a granted-namespace note is denied", async () => {
    const denied: any = await client.callTool({
      name: "state_write",
      arguments: { id: sharedId, body: "pwned" },
    });
    assert.equal(denied.isError, true);
    assert.match(parseToolText(denied).error, /no note with id/);
    assert.equal(store.read(sharedId)?.body, "shared body", "granted note must be untouched");
  });

  test("state_write update-by-id on an own-namespace note still works", async () => {
    const res = await client.callTool({
      name: "state_write",
      arguments: { id: ownId, body: "own body edited" },
    });
    const { note } = parseToolText(res);
    assert.equal(note.body, "own body edited");
    assert.equal(note.namespace, "agent-a");
  });

  test("state_delete on a granted-namespace note is denied", async () => {
    const denied: any = await client.callTool({
      name: "state_delete",
      arguments: { id: sharedId },
    });
    assert.equal(denied.isError, true);
    assert.match(parseToolText(denied).error, /no note with id/);
    assert.ok(store.read(sharedId), "granted note must survive a denied delete");
  });

  test("state_delete on an own-namespace note still works", async () => {
    const scratch = store.create({ namespace: "agent-a", title: "temp", body: "x" });
    const res = await client.callTool({
      name: "state_delete",
      arguments: { id: scratch.id },
    });
    assert.equal(parseToolText(res).deleted, scratch.id);
    assert.equal(store.read(scratch.id), null);
  });

  test("granted-namespace notes remain readable (grants stay read-only)", async () => {
    const res = await client.callTool({
      name: "state_read",
      arguments: { id: sharedId },
    });
    assert.equal(parseToolText(res).note.namespace, "shared");
  });
});

describe("blocker #3: reads_from grants never confer write access (REST)", () => {
  let store: Store;
  let base: string;
  let headers: Record<string, string>;
  let stop: () => Promise<void>;
  let ownId: number;
  let sharedId: number;

  before(async () => {
    store = new Store(":memory:");
    ownId = store.create({ namespace: "agent-a", title: "own", body: "own body" }).id;
    sharedId = store
      .create({ namespace: "shared", title: "shared", body: "shared body" }).id;
    ({ base, headers, stop } = await startApi(store, NS_OPTS));
  });

  after(async () => {
    await stop();
    store.close();
  });

  test("PUT /notes/:id on a granted-namespace note is 404; own-namespace PUT works", async () => {
    const denied = await fetch(`${base}/notes/${sharedId}`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ body: "pwned" }),
    });
    assert.equal(denied.status, 404);
    assert.match(((await denied.json()) as any).error, /not found/);
    assert.equal(store.read(sharedId)?.body, "shared body", "granted note must be untouched");

    const ok = await fetch(`${base}/notes/${ownId}`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ body: "own body edited" }),
    });
    assert.equal(ok.status, 200);
    assert.equal(((await ok.json()) as any).note.body, "own body edited");
  });

  test("DELETE /notes/:id on a granted-namespace note is 404; own-namespace DELETE works", async () => {
    const denied = await fetch(`${base}/notes/${sharedId}`, {
      method: "DELETE",
      headers,
    });
    assert.equal(denied.status, 404);
    assert.ok(store.read(sharedId), "granted note must survive a denied delete");

    const scratch = store.create({ namespace: "agent-a", title: "temp", body: "x" });
    const ok = await fetch(`${base}/notes/${scratch.id}`, {
      method: "DELETE",
      headers,
    });
    assert.equal(ok.status, 200);
    assert.equal(store.read(scratch.id), null);
  });
});

describe("blocker #5: /export and /import respect namespace resolution", () => {
  let store: Store;
  let base: string;
  let headers: Record<string, string>;
  let stop: () => Promise<void>;

  before(async () => {
    store = new Store(":memory:");
    store.create({ namespace: "agent-a", title: "own", body: "a" });
    store.create({ namespace: "shared", title: "granted", body: "b" });
    store.create({ namespace: "secret", title: "unreadable", body: "c" });
    ({ base, headers, stop } = await startApi(store, NS_OPTS));
  });

  after(async () => {
    await stop();
    store.close();
  });

  test("GET /export with nsActive returns only readable namespaces", async () => {
    const res = await fetch(`${base}/export`, { headers });
    assert.equal(res.status, 200);
    const { notes } = (await res.json()) as any;
    const nss = new Set(notes.map((n: any) => n.namespace));
    assert.ok(nss.has("agent-a"), "own namespace must be exported");
    assert.ok(nss.has("shared"), "granted namespace stays exportable");
    assert.ok(!nss.has("secret"), "unreadable namespace must not leak into the export");
  });

  test("POST /import with nsActive forces notes into ownNs", async () => {
    const res = await fetch(`${base}/import`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        notes: [
          { title: "planted one", body: "x", namespace: "victim" },
          { title: "planted two", body: "y", namespace: "secret" },
          { title: "no supplied namespace", body: "z" },
        ],
      }),
    });
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as any).imported, 3);

    const own = store.list({ namespace: "agent-a" }).notes;
    for (const title of ["planted one", "planted two", "no supplied namespace"]) {
      const n = own.find((x) => x.title === title);
      assert.ok(n, `imported note "${title}" must land in ownNs`);
      assert.equal(n?.namespace, "agent-a");
    }
    assert.equal(store.list({ namespace: "victim" }).notes.length, 0);
    assert.equal(
      store.list({ namespace: "secret" }).notes.length,
      1,
      "only the pre-existing secret note may remain"
    );
  });
});

describe("blocker #5 backward compatibility: resolution inactive", () => {
  let store: Store;
  let base: string;
  let headers: Record<string, string>;
  let stop: () => Promise<void>;

  before(async () => {
    store = new Store(":memory:");
    store.create({ namespace: "alpha", title: "a", body: "x" });
    store.create({ namespace: "beta", title: "b", body: "y" });
    ({ base, headers, stop } = await startApi(store)); // no opts: legacy behavior
  });

  after(async () => {
    await stop();
    store.close();
  });

  test("GET /export without nsActive dumps every namespace", async () => {
    const res = await fetch(`${base}/export`, { headers });
    assert.equal(res.status, 200);
    const { notes } = (await res.json()) as any;
    const nss = new Set(notes.map((n: any) => n.namespace));
    assert.deepEqual([...nss].sort(), ["alpha", "beta"]);
  });

  test("POST /import without nsActive preserves client-supplied namespaces", async () => {
    const res = await fetch(`${base}/import`, {
      method: "POST",
      headers,
      body: JSON.stringify({ notes: [{ title: "kept", body: "x", namespace: "gamma" }] }),
    });
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as any).imported, 1);
    const gamma = store.list({ namespace: "gamma" }).notes;
    assert.equal(gamma.length, 1);
    assert.equal(gamma[0].title, "kept");
  });
});
