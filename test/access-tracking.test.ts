// Access tracking -> importance weighting (Tier 2).
//
// Covers: migration v3 columns + defaults, touch(), read() trackAccess opt,
// search-result bumps (top N only), the ranking boost math, accessStats,
// and the memory_stats MCP tool (including namespace scoping).
import { test, describe, beforeEach, before, after } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Store } from "../src/store.js";
import { createMcpServer } from "../src/mcp-server-core.js";
import { runSearch, ACCESS_BOOST_FACTOR } from "../src/search-service.js";

describe("access tracking: store", () => {
  let store: Store;

  beforeEach(() => {
    store = new Store(":memory:");
  });

  test("new notes start unread: access_count 0, last_accessed null", () => {
    const note = store.create({ title: "fresh", body: "never read" });
    assert.equal(note.access_count, 0);
    assert.equal(note.last_accessed, null);
  });

  test("touch() bumps access_count and sets an ISO last_accessed", () => {
    const note = store.create({ title: "t", body: "b" });
    store.touch(note.id);
    const after1 = store.read(note.id)!;
    assert.equal(after1.access_count, 1);
    assert.ok(after1.last_accessed);
    assert.ok(!Number.isNaN(Date.parse(after1.last_accessed!)));

    store.touch(note.id);
    const after2 = store.read(note.id)!;
    assert.equal(after2.access_count, 2);
    assert.ok(Date.parse(after2.last_accessed!) >= Date.parse(after1.last_accessed!));
  });

  test("touch() on a missing id is a silent no-op", () => {
    store.touch(999999); // must not throw
  });

  test("read() without trackAccess does not bump", () => {
    const note = store.create({ title: "t", body: "b" });
    store.read(note.id);
    store.read(note.id);
    const fetched = store.read(note.id)!;
    assert.equal(fetched.access_count, 0);
    assert.equal(fetched.last_accessed, null);
  });

  test("read() with trackAccess bumps and returns the bumped record", () => {
    const note = store.create({ title: "t", body: "b" });
    const fetched = store.read(note.id, { trackAccess: true })!;
    assert.equal(fetched.access_count, 1);
    assert.ok(fetched.last_accessed);
    // The counter persisted, not just echoed.
    assert.equal(store.read(note.id)!.access_count, 1);
  });

  test("internal reads do not inflate counts (update re-read)", () => {
    const note = store.create({ title: "t", body: "b" });
    const updated = store.update(note.id, { body: "b2" })!;
    assert.equal(updated.access_count, 0);
    assert.equal(updated.last_accessed, null);
  });

  test("a read is not a write: updated_at untouched by touch()", () => {
    const note = store.create({ title: "t", body: "b" });
    const before = note.updated_at;
    store.touch(note.id);
    assert.equal(store.read(note.id)!.updated_at, before);
  });
});

describe("access tracking: search bumps + ranking boost", () => {
  let store: Store;

  beforeEach(() => {
    store = new Store(":memory:");
  });

  test("runSearch bumps only the returned notes (top N), not all scanned", async () => {
    const a = store.create({ title: "alpha zebra", body: "first" });
    const b = store.create({ title: "alpha zebra", body: "second" });
    const c = store.create({ title: "alpha zebra", body: "third" });
    const results = await runSearch(store, "alpha zebra", { mode: "keyword", limit: 1 });
    assert.equal(results.length, 1);
    const returned = results[0];
    assert.equal(store.read(returned.id)!.access_count, 1);
    for (const other of [a, b, c]) {
      if (other.id !== returned.id) {
        assert.equal(store.read(other.id)!.access_count, 0, `note ${other.id} must stay at 0`);
      }
    }
  });

  test("hot memory outranks a cold one with identical relevance", async () => {
    // Identical title+body => identical FTS5 bm25 scores: a pure tie the
    // access boost must break toward the frequently-read note.
    const cold = store.create({ title: "tie breaker", body: "same content here" });
    const hot = store.create({ title: "tie breaker", body: "same content here" });
    for (let i = 0; i < 10; i++) store.touch(hot.id);

    const results = await runSearch(store, "tie breaker", { mode: "keyword" });
    assert.ok(results.length >= 2);
    assert.equal(results[0].id, hot.id);
    assert.equal(results[1].id, cold.id);
  });

  test("with zero accesses, native ordering is preserved exactly", async () => {
    const first = store.create({ title: "stable order", body: "word" });
    const second = store.create({ title: "stable order", body: "word" });
    const baseline = await runSearch(store, "stable order", { mode: "keyword" });
    assert.equal(baseline[0].id, first.id);
    assert.equal(baseline[1].id, second.id);
  });

  test("boost math: score * (1 + 0.1 * log10(1 + access_count))", async () => {
    const cold = store.create({ title: "math check", body: "identical words" });
    const hot = store.create({ title: "math check", body: "identical words" });
    for (let i = 0; i < 10; i++) store.touch(hot.id);

    // Re-derive the expected multiplier from the public constant.
    const expected = 1 + ACCESS_BOOST_FACTOR * Math.log10(1 + 10);
    const ranked = store.searchRanked("math check", {});
    assert.equal(ranked.length, 2);
    const base = ranked[0].score;
    assert.ok(Math.abs(ranked[1].score - base) < 1e-9, "identical docs score identically");
    assert.ok(Math.abs(expected - 1.10414) < 1e-4);

    // The boosted search must place `hot` first even though base scores tie.
    const results = await runSearch(store, "math check", { mode: "keyword" });
    assert.equal(results[0].id, hot.id);
    assert.equal(results[1].id, cold.id);
  });

  test("time-only search bumps results but keeps newest-first order", async () => {
    const old = store.create({
      title: "old note",
      body: "x",
      created_at: "2026-01-01T00:00:00.000Z",
    });
    const recent = store.create({
      title: "recent note",
      body: "x",
      created_at: "2026-10-01T00:00:00.000Z",
    });
    // Make the old note hot: newest-first must survive the boost.
    for (let i = 0; i < 50; i++) store.touch(old.id);
    const results = await runSearch(store, "", {
      timeRange: { start: new Date("2025-01-01"), end: new Date("2027-01-01") },
    });
    assert.equal(results[0].id, recent.id);
    assert.equal(results[1].id, old.id);
    assert.equal(store.read(old.id)!.access_count, 51);
    assert.equal(store.read(recent.id)!.access_count, 1);
  });
});

describe("access tracking: accessStats", () => {
  let store: Store;

  beforeEach(() => {
    store = new Store(":memory:");
  });

  test("totals, mostAccessed ordering, neverAccessed count", () => {
    const a = store.create({ title: "hot", body: "x" });
    const b = store.create({ title: "warm", body: "x" });
    const c = store.create({ title: "cold", body: "x" });
    for (let i = 0; i < 5; i++) store.touch(a.id);
    for (let i = 0; i < 2; i++) store.touch(b.id);

    const stats = store.accessStats();
    assert.equal(stats.totalNotes, 3);
    assert.equal(stats.totalAccesses, 7);
    assert.equal(stats.neverAccessed, 1);
    assert.equal(stats.mostAccessed.length, 3);
    assert.deepEqual(stats.mostAccessed[0], { id: a.id, title: "hot", access_count: 5 });
    assert.deepEqual(stats.mostAccessed[1], { id: b.id, title: "warm", access_count: 2 });
    assert.deepEqual(stats.mostAccessed[2], { id: c.id, title: "cold", access_count: 0 });
    // mostAccessed leaks no bodies.
    for (const m of stats.mostAccessed) {
      assert.deepEqual(Object.keys(m).sort(), ["access_count", "id", "title"]);
    }
  });

  test("namespace scoping", () => {
    const a = store.create({ title: "in a", body: "x", namespace: "a" });
    store.create({ title: "in b", body: "x", namespace: "b" });
    store.touch(a.id);

    const scoped = store.accessStats(["a"]);
    assert.equal(scoped.totalNotes, 1);
    assert.equal(scoped.totalAccesses, 1);
    assert.equal(scoped.neverAccessed, 0);

    const all = store.accessStats();
    assert.equal(all.totalNotes, 2);
    assert.equal(all.totalAccesses, 1);
    assert.equal(all.neverAccessed, 1);
  });

  test("empty store reports zeros", () => {
    // Field-level assertions (not a whole-object deepEqual): the stats
    // shape is co-owned with other features (e.g. staleness adds staleCount).
    const stats = store.accessStats();
    assert.equal(stats.totalNotes, 0);
    assert.equal(stats.totalAccesses, 0);
    assert.deepEqual(stats.mostAccessed, []);
    assert.equal(stats.neverAccessed, 0);
  });
});

describe("access tracking: MCP memory_stats + read-path fields", () => {
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

  function parseToolText(result: any): any {
    const text = (result.content[0] as { text: string }).text;
    const start = text.indexOf("{");
    return JSON.parse(start >= 0 ? text.slice(start) : text);
  }

  test("memory_stats returns totals, mostAccessed, neverAccessed", async () => {
    const hot = store.create({ title: "hot note", body: "x" });
    store.create({ title: "cold note", body: "y" });
    store.touch(hot.id);
    store.touch(hot.id);

    const result = await client.callTool({ name: "memory_stats", arguments: {} });
    const stats = parseToolText(result);
    assert.equal(stats.totalNotes, 2);
    assert.equal(stats.totalAccesses, 2);
    assert.equal(stats.neverAccessed, 1);
    assert.deepEqual(stats.mostAccessed[0], {
      id: hot.id,
      title: "hot note",
      access_count: 2,
    });
  });

  test("memory_stats honors a namespace hint (no resolution active)", async () => {
    store.create({ title: "ns note", body: "x", namespace: "team" });
    const result = await client.callTool({
      name: "memory_stats",
      arguments: { namespace: "team" },
    });
    const stats = parseToolText(result);
    assert.equal(stats.totalNotes, 1);
    assert.equal(stats.neverAccessed, 1);
  });

  test("memory_stats is namespace-scoped under server-side resolution", async () => {
    const scopedStore = new Store(":memory:");
    scopedStore.create({ title: "own", body: "x", namespace: "agent1" });
    scopedStore.create({ title: "granted", body: "x", namespace: "agent2" });
    scopedStore.create({ title: "foreign", body: "x", namespace: "stranger" });
    const server = createMcpServer(scopedStore, "admin", {
      namespace: "agent1",
      readsFrom: { agent1: ["agent2"] },
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const scopedClient = new Client({ name: "scoped", version: "1.0.0" });
    await Promise.all([scopedClient.connect(ct), server.connect(st)]);
    try {
      const result = await scopedClient.callTool({ name: "memory_stats", arguments: {} });
      const stats = parseToolText(result);
      // Only agent1 + granted agent2 count; "stranger" is invisible.
      assert.equal(stats.totalNotes, 2);
    } finally {
      await scopedClient.close();
      scopedStore.close();
    }
  });

  test("state_read bumps the counter and returns access fields", async () => {
    const created = store.create({ title: "read me", body: "x" });
    const result = await client.callTool({
      name: "state_read",
      arguments: { id: created.id },
    });
    const { note } = parseToolText(result);
    assert.equal(note.access_count, 1);
    assert.ok(note.last_accessed);
    assert.equal(store.read(created.id)!.access_count, 1);
  });

  test("state_search results include access_count and last_accessed", async () => {
    store.create({ title: "searchable fields", body: "unique-zyx" });
    const result = await client.callTool({
      name: "state_search",
      arguments: { query: "unique-zyx", mode: "keyword" },
    });
    const { results } = parseToolText(result);
    assert.ok(results.length >= 1);
    for (const r of results) {
      assert.ok(typeof r.access_count === "number");
      assert.ok(r.last_accessed === null || typeof r.last_accessed === "string");
    }
  });
});
