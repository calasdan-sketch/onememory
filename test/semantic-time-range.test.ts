// Regression tests for the panel's critical finding:
// "Time-scoped semantic/hybrid search silently returns nothing".
//
// Old behavior: store.semanticSearch() accepted no time range, so runSearch
// fetched the global top-200 cosine hits and discarded out-of-window notes
// in JS. With 290 older notes outscoring 10 "yesterday" notes, the pool was
// full of old notes before the filter ran -> 0 results despite 10 true
// positives. The fix pushes the window into the vector SQL
// (notes.created_at >= ? AND notes.created_at < ?), so the ranking is
// computed within the window.
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { Store } from "../src/store.js";
import { runSearch } from "../src/search-service.js";

const realFetch = globalThis.fetch;
function stubFetch(fn: () => unknown): void {
  globalThis.fetch = (async () => fn()) as typeof fetch;
}
function openaiResponse(vec: number[]) {
  return { ok: true, status: 200, json: async () => ({ data: [{ embedding: vec }] }) };
}

/** UTC [start, end) window for "yesterday". */
function yesterdayWindow(): { start: Date; end: Date } {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return { start, end };
}

/**
 * created_at has no override on store.create(); reach the private handle
 * in tests only. This keeps the public API unchanged while letting tests
 * plant notes at specific timestamps.
 */
function backdate(store: Store, id: number, iso: string): void {
  const db = (store as unknown as { db: DatabaseSync }).db;
  db.prepare("UPDATE notes SET created_at = ?, updated_at = ? WHERE id = ?").run(iso, iso, id);
}

const VEC = Float32Array.from([1, 0, 0]);

describe("time-scoped semantic search (panel blocker #1)", () => {
  let store: Store;
  const SAVE = process.env.ONEMEMORY_EMBEDDINGS;
  let window: { start: Date; end: Date };

  beforeEach(() => {
    process.env.ONEMEMORY_EMBEDDINGS = "on";
    store = new Store(":memory:");
    window = yesterdayWindow();
    const inWindowISO = new Date(window.start.getTime() + 12 * 3600_000).toISOString();
    const oldISO = new Date(window.start.getTime() - 30 * 24 * 3600_000).toISOString();

    // 290 OLD notes first -- same vector as the in-window notes, so every
    // old note ties the in-window notes on cosine. Old code ranked them all
    // globally and the in-window notes never survived into the top-200 pool.
    for (let i = 0; i < 290; i++) {
      const n = store.create({ title: `old budget note ${i}`, body: "budget planning" });
      backdate(store, n.id, oldISO);
      store.setVector(n.id, VEC, "test");
    }
    // The 10 true positives: "yesterday" notes about "budget".
    for (let i = 0; i < 10; i++) {
      const n = store.create({ title: `yesterday budget note ${i}`, body: "budget planning" });
      backdate(store, n.id, inWindowISO);
      store.setVector(n.id, VEC, "test");
    }
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    if (SAVE === undefined) delete process.env.ONEMEMORY_EMBEDDINGS;
    else process.env.ONEMEMORY_EMBEDDINGS = SAVE;
    store.close();
  });

  test("store.semanticSearch with startISO/endISO returns only the 10 in-window notes", () => {
    const hits = store.semanticSearch(VEC, {
      startISO: window.start.toISOString(),
      endISO: window.end.toISOString(),
    });
    assert.equal(hits.length, 10);
    for (const h of hits) {
      assert.match(h.note.title, /^yesterday budget note /);
    }
  });

  test("store.semanticSearch without a range still sees all 300 notes", () => {
    const hits = store.semanticSearch(VEC, { limit: 200 });
    assert.equal(hits.length, 200); // limit cap, unchanged behavior
  });

  test("store.semanticSearch honors namespace + range together", () => {
    const n = store.create({ title: "other ns budget", body: "budget", namespace: "work" });
    backdate(store, n.id, new Date(window.start.getTime() + 3600_000).toISOString());
    store.setVector(n.id, VEC, "test");
    const hits = store.semanticSearch(VEC, {
      namespace: "work",
      startISO: window.start.toISOString(),
      endISO: window.end.toISOString(),
    });
    assert.equal(hits.length, 1);
    assert.equal(hits[0].note.id, n.id);
  });

  test("runSearch semantic mode with timeRange returns the 10 true positives (not 0)", async () => {
    stubFetch(() => openaiResponse([1, 0, 0])); // the query embedding
    const res = await runSearch(store, "budget", {
      mode: "semantic",
      timeRange: window,
    });
    assert.equal(res.length, 10);
    for (const n of res) {
      assert.match(n.title, /^yesterday budget note /);
    }
  });

  test("runSearch hybrid mode with timeRange returns the 10 true positives (not 0)", async () => {
    stubFetch(() => openaiResponse([1, 0, 0]));
    const res = await runSearch(store, "budget", {
      mode: "hybrid",
      timeRange: window,
    });
    assert.equal(res.length, 10);
    for (const n of res) {
      assert.match(n.title, /^yesterday budget note /);
    }
  });

  test("keyword branch was already SQL-scoped: search() with the range returns the 10", () => {
    const res = store.search("budget", {
      startISO: window.start.toISOString(),
      endISO: window.end.toISOString(),
      limit: 200,
    });
    assert.equal(res.length, 10);
  });
});
