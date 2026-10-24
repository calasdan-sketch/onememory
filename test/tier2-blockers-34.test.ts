// Tier 2 panel regressions: BLOCKER 3 (touch() best-effort under write
// contention; edge scoring moved outside the write transaction; batched
// access bumps) and BLOCKER 4 (authorization gate before access tracking)
// plus S-LOW-2 (memory_consolidate uniform errors under ns resolution).
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Store } from "../src/store.js";
import { createMcpServer } from "../src/mcp-server-core.js";
import { createApiServer } from "../src/api.js";
import { consolidateNotes } from "../src/consolidate.js";

function parseToolText(result: any): any {
  const text = (result.content[0] as { text: string }).text;
  const start = text.indexOf("{");
  return JSON.parse(start >= 0 ? text.slice(start) : text);
}

// --- BLOCKER 3 -------------------------------------------------------------

describe("blocker 3: touch() is best-effort under write contention", () => {
  test("touch() never throws and fails fast while another connection holds the write lock", () => {
    const dir = mkdtempSync(join(tmpdir(), "om-b3-"));
    try {
      const dbPath = join(dir, "state.db");
      const store = new Store(dbPath);
      const note = store.create({ title: "contended", body: "x" });

      // A second connection grabs the write lock and holds it uncommitted.
      const blocker = new DatabaseSync(dbPath);
      blocker.exec("BEGIN IMMEDIATE;");
      blocker.prepare("UPDATE notes SET body = ? WHERE id = ?").run("held", note.id);

      const start = Date.now();
      store.touch(note.id); // must not throw SQLITE_BUSY...
      const elapsed = Date.now() - start;
      // ...and must not sit out the 5s busy_timeout: contention fails fast.
      assert.ok(elapsed < 2000, `touch() took ${elapsed}ms under contention`);

      // The read path survives: SELECT works under WAL while the lock is held.
      const fetched = store.read(note.id, { trackAccess: true });
      assert.ok(fetched, "read must succeed under write contention");
      assert.equal(fetched.id, note.id);
      // Reads are buffered (r3): a flush under contention fails fast and
      // keeps the counts instead of erroring or losing them.
      const t1 = Date.now();
      store.flushAccess();
      assert.ok(Date.now() - t1 < 2000, "flush fails fast under contention");
      assert.equal(store.read(note.id)!.access_count, 2);

      blocker.exec("ROLLBACK;");
      blocker.close();

      // Once the lock releases, the buffered counts land.
      store.flushAccess();
      const raw = new DatabaseSync(dbPath);
      assert.equal((raw.prepare("SELECT access_count FROM notes WHERE id = ?").get(note.id) as any).access_count, 2);
      raw.close();
      store.touch(note.id);
      assert.equal(store.read(note.id)!.access_count, 3);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("touchMany() bumps every id in one call, dedupes, and never throws", () => {
    const store = new Store(":memory:");
    const a = store.create({ title: "a", body: "x" });
    const b = store.create({ title: "b", body: "x" });
    const c = store.create({ title: "c", body: "x" });
    store.touchMany([a.id, b.id, b.id, 999999]); // duplicate + missing id
    assert.equal(store.read(a.id)!.access_count, 1);
    assert.equal(store.read(b.id)!.access_count, 1, "duplicate id bumps once");
    assert.equal(store.read(c.id)!.access_count, 0, "untouched note stays at 0");
    store.touchMany([]); // empty: no-op, no throw
    store.close();
  });
});

describe("blocker 3: edge scoring outside the write transaction", () => {
  test("update() applies pre-transaction edge scores correctly", () => {
    const store = new Store(":memory:");
    const a = store.create({ title: "alpha beta gamma delta", body: "one" });
    const b = store.create({ title: "alpha beta gamma delta", body: "two" });
    const c = store.create({ title: "zeta eta theta iota", body: "three" });
    // a~b share 4/5 tokens (cosine 0.8); a!~c share none.
    assert.ok(store.listNeighbors(a.id).some((n) => n.id === b.id));
    assert.ok(!store.listNeighbors(a.id).some((n) => n.id === c.id));

    // Retitle a to match c: edges must follow the new text, not the old.
    store.update(a.id, { title: "zeta eta theta iota" });
    const neighbors = store.listNeighbors(a.id);
    assert.ok(
      neighbors.some((n) => n.id === c.id),
      "a-c edge must exist after retitle"
    );
    assert.ok(
      !neighbors.some((n) => n.id === b.id),
      "stale a-b edge must be gone"
    );
    // Symmetric direction too.
    assert.ok(store.listNeighbors(c.id).some((n) => n.id === a.id));
    store.close();
  });

  test("consolidateNotes() applies pre-scored edges and drops the sources' edges", () => {
    const store = new Store(":memory:");
    const a = store.create({ title: "dup", body: "alpha beta gamma" });
    const b = store.create({ title: "dup", body: "alpha beta gamma" });
    const c = store.create({ title: "other", body: "alpha beta gamma delta epsilon" });

    const merged = consolidateNotes(store, [a.id, b.id]);
    assert.equal(store.read(a.id), null, "source a deleted");
    assert.equal(store.read(b.id), null, "source b deleted");

    // Merged body dedups to "alpha beta gamma": shares 3 tokens with c
    // (cosine ~0.77 >= 0.35), so the merged note links to c both ways.
    assert.ok(
      store.listNeighbors(merged.id).some((n) => n.id === c.id),
      "merged-c edge must exist"
    );
    assert.ok(
      store.listNeighbors(c.id).some((n) => n.id === merged.id),
      "c-merged edge must exist"
    );
    // No dangling edges point at the deleted sources.
    for (const n of store.listNeighbors(c.id)) {
      assert.ok(n.id !== a.id && n.id !== b.id, "no edge to a deleted source");
    }
    store.close();
  });
});

// --- BLOCKER 4 -------------------------------------------------------------

describe("blocker 4: MCP state_read gates before tracking", () => {
  let store: Store;
  let client: Client;
  let ownId: number;
  let secretId: number;

  before(async () => {
    store = new Store(":memory:");
    ownId = store.create({ namespace: "agent-a", title: "own", body: "x" }).id;
    secretId = store.create({ namespace: "secret", title: "secret", body: "y" }).id;
    const server = createMcpServer(store, "read", { namespace: "agent-a" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "b4-client", version: "1.0.0" });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  });

  after(async () => {
    await client.close();
    store.close();
  });

  test("50 denied state_read calls leave the foreign note's counters at zero", async () => {
    // The panel's empirical probe: 50 denied reads moved access_count 0->50.
    for (let i = 0; i < 50; i++) {
      const denied: any = await client.callTool({
        name: "state_read",
        arguments: { id: secretId },
      });
      assert.equal(denied.isError, true);
      assert.match(parseToolText(denied).error, /no note with id/);
    }
    const after = store.read(secretId)!;
    assert.equal(after.access_count, 0, "denied reads must not bump access_count");
    assert.equal(after.last_accessed, null, "denied reads must not set last_accessed");
  });

  test("denied state_read with neighbors:true leaves no trace either", async () => {
    const denied: any = await client.callTool({
      name: "state_read",
      arguments: { id: secretId, neighbors: true },
    });
    assert.equal(denied.isError, true);
    assert.equal(store.read(secretId)!.access_count, 0);
    assert.equal(store.read(secretId)!.last_accessed, null);
  });

  test("authorized state_read still bumps and returns the bumped counters", async () => {
    const res: any = await client.callTool({
      name: "state_read",
      arguments: { id: ownId },
    });
    assert.ok(!res.isError);
    const { note } = parseToolText(res);
    assert.equal(note.access_count, 1, "returned record includes this read");
    assert.ok(note.last_accessed);
    assert.equal(store.read(ownId)!.access_count, 1);
  });
});

describe("blocker 4: REST GET /notes/:id gates before tracking", () => {
  test("denied GET leaves counters at zero; authorized GET bumps", async () => {
    const store = new Store(":memory:");
    const ownId = store.create({ namespace: "agent-a", title: "own", body: "x" }).id;
    const secretId = store.create({ namespace: "secret", title: "s", body: "y" }).id;
    const server = createApiServer(store, "b4-token", { namespace: "agent-a" });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;
    const headers = { Authorization: "Bearer b4-token" };
    try {
      const denied = await fetch(`${base}/notes/${secretId}`, { headers });
      assert.equal(denied.status, 404);
      assert.equal(store.read(secretId)!.access_count, 0);
      assert.equal(store.read(secretId)!.last_accessed, null);

      const ok = await fetch(`${base}/notes/${ownId}`, { headers });
      assert.equal(ok.status, 200);
      const { note } = (await ok.json()) as any;
      assert.equal(note.access_count, 1);
      assert.ok(note.last_accessed);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
    }
  });
});

// --- S-LOW-2 ---------------------------------------------------------------

describe("S-LOW-2: memory_consolidate errors are uniform under ns resolution", () => {
  let store: Store;
  let client: Client;
  let o1: number;
  let foreign: number;
  const MISSING = 999999999;

  before(async () => {
    store = new Store(":memory:");
    o1 = store.create({ namespace: "agent-a", title: "o1", body: "x" }).id;
    store.create({ namespace: "agent-a", title: "o2", body: "y" });
    foreign = store.create({ namespace: "secret", title: "f", body: "z" }).id;
    const server = createMcpServer(store, "admin", { namespace: "agent-a" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "slow2-client", version: "1.0.0" });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  });

  after(async () => {
    await client.close();
    store.close();
  });

  async function consolidateError(ids: number[]): Promise<string> {
    const res: any = await client.callTool({
      name: "memory_consolidate",
      arguments: { ids, dry_run: true },
    });
    assert.equal(res.isError, true);
    return parseToolText(res).error as string;
  }

  test("missing, foreign, and mixed ids all collapse to the uniform 'no note' error", async () => {
    const eForeign = await consolidateError([o1, foreign]);
    const eMissing = await consolidateError([o1, MISSING]);
    const eBothBad = await consolidateError([foreign, MISSING]);
    for (const e of [eForeign, eMissing, eBothBad]) {
      // Uniform shape: the old distinguishable errors are gone.
      assert.match(e, /^no note with id \d+$/, `not uniform: ${e}`);
      assert.doesNotMatch(e, /different namespaces|access denied/);
    }
  });

  test("without namespace resolution the detailed validation errors are unchanged", async () => {
    const legacyStore = new Store(":memory:");
    const a = legacyStore.create({ namespace: "a", title: "a", body: "x" });
    legacyStore.create({ namespace: "b", title: "b", body: "y" });
    const server = createMcpServer(legacyStore, "admin"); // no ns opts
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const legacyClient = new Client({ name: "legacy", version: "1.0.0" });
    await Promise.all([legacyClient.connect(ct), server.connect(st)]);
    try {
      const res: any = await legacyClient.callTool({
        name: "memory_consolidate",
        arguments: { ids: [a.id, MISSING], dry_run: true },
      });
      assert.match(parseToolText(res).error, /no note with id/);
    } finally {
      await legacyClient.close();
      legacyStore.close();
    }
  });
});
