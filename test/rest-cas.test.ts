// REST compare-and-swap (1.5.0): PUT /notes/:id takes `if_rev`, like the MCP tool state_write. Found by benchmark
// scenario B16: a stale REST edit used to replace a newer write without a word.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Store, StaleWriteError, ValidationError } from "../src/store.js";
import { createApiServer } from "../src/api.js";
import { createMcpServer } from "../src/mcp-server-core.js";

describe("PUT /notes/:id with if_rev", () => {
  let store: Store;
  let srv: Server;
  let base = "";
  const TOKEN = "cas-test-token-0123456789abcdef";

  before(async () => {
    store = new Store(":memory:");
    srv = createApiServer(store, [{ token: TOKEN, scope: "write", label: "writer" }]);
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  });
  after(async () => {
    srv.closeAllConnections();
    await new Promise<void>((r) => srv.close(() => r()));
    store.close();
  });

  const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> => {
    const res = await fetch(base + path, { method, headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, json: await res.json() };
  };
  const create = async (body: string): Promise<{ id: number; rev: number }> => (await call("POST", "/notes", { title: "cas note", body })).json.note;

  test("a matching if_rev succeeds and bumps the revision", async () => {
    const n = await create("v1");
    const r = await call("PUT", `/notes/${n.id}`, { body: "v2", if_rev: n.rev });
    assert.equal(r.status, 200);
    assert.equal(r.json.note.rev, n.rev + 1);
    assert.equal(r.json.note.body, "v2");
  });

  test("a stale if_rev is refused with 409 and the newer write survives", async () => {
    const n = await create("v1");
    await call("PUT", `/notes/${n.id}`, { body: "newer" });
    const r = await call("PUT", `/notes/${n.id}`, { body: "late", if_rev: n.rev });
    assert.equal(r.status, 409);
    assert.match(r.json.error, /stale write/);
    const now = (await call("GET", `/notes/${n.id}`)).json.note;
    assert.equal(now.body, "newer");
  });

  test("without if_rev the last write still wins (nothing changed for existing clients)", async () => {
    const n = await create("v1");
    await call("PUT", `/notes/${n.id}`, { body: "second" });
    const r = await call("PUT", `/notes/${n.id}`, { body: "third" });
    assert.equal(r.status, 200);
    assert.equal(r.json.note.body, "third");
  });

  test("if_rev may be sent as a numeric string, like forget_after", async () => {
    const n = await create("v1");
    const r = await call("PUT", `/notes/${n.id}`, { body: "v2", if_rev: String(n.rev) });
    assert.equal(r.status, 200);
  });

  test("a bad if_rev is a 400, and a null one is ignored", async () => {
    const n = await create("v1");
    for (const bad of ["abc", 0, -1, 1.5, true, [1]]) {
      const r = await call("PUT", `/notes/${n.id}`, { body: "x", if_rev: bad });
      assert.equal(r.status, 400, `if_rev ${JSON.stringify(bad)}`);
    }
    assert.equal((await call("GET", `/notes/${n.id}`)).json.note.body, "v1", "no bad request changed the note");
    assert.equal((await call("PUT", `/notes/${n.id}`, { body: "ok", if_rev: null })).status, 200);
  });

  test("if_rev is a guard, not content: it is never stored on the note", async () => {
    const n = await create("v1");
    const r = await call("PUT", `/notes/${n.id}`, { body: "v2", if_rev: n.rev });
    assert.ok(!("if_rev" in r.json.note));
    assert.equal(JSON.stringify(r.json.note).includes("if_rev"), false);
  });

  test("a stale edit to a missing note is still 404", async () => {
    assert.equal((await call("PUT", "/notes/999999", { body: "x", if_rev: 1 })).status, 404);
  });

  test("a stale write changes nothing about who wrote the note", async () => {
    const n = await create("v1");
    await call("PUT", `/notes/${n.id}`, { body: "newer" });
    const before = (await call("GET", `/notes/${n.id}`)).json.note;
    await call("PUT", `/notes/${n.id}`, { body: "late", if_rev: n.rev });
    const after = (await call("GET", `/notes/${n.id}`)).json.note;
    assert.equal(after.rev, before.rev);
    assert.equal(after.updated_at, before.updated_at);
    assert.equal(after.written_by, before.written_by);
  });
});

describe("the stale-write error keeps its old shape for other surfaces", () => {
  test("StaleWriteError is a ValidationError (library callers and MCP see the same class and message)", () => {
    const s = new Store(":memory:");
    const n = s.create({ title: "t", body: "a" });
    s.update(n.id, { body: "b" });
    try {
      s.update(n.id, { body: "c" }, { ifRev: n.rev });
      assert.fail("should have thrown");
    } catch (e) {
      assert.ok(e instanceof StaleWriteError);
      assert.ok(e instanceof ValidationError);
      assert.match((e as Error).message, /stale write: note \d+ is at rev 2 \(you have 1\)/);
    }
    s.close();
  });

  test("the MCP tool still refuses a stale if_rev with the same words", async () => {
    const s = new Store(":memory:");
    const n = s.create({ title: "t", body: "a" });
    s.update(n.id, { body: "b" });
    const server = createMcpServer(s, "write");
    const [c, sv] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "1.0.0" });
    await Promise.all([client.connect(c), server.connect(sv)]);
    const res = (await client.callTool({ name: "state_write", arguments: { id: n.id, body: "late", if_rev: n.rev } })) as { isError?: boolean; content: Array<{ text: string }> };
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /stale write/);
    await client.close();
    s.close();
  });
});
