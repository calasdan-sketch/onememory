// Staleness detection: isStale() thresholds, warning text, config parsing,
// search-ranking penalty, and the MCP/API annotation surface.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Store, type NoteRecord } from "../src/store.js";
import { runSearch } from "../src/search-service.js";
import { createMcpServer } from "../src/mcp-server-core.js";
import {
  isStale,
  staleWarning,
  annotateStaleness,
  STALE_SCORE_PENALTY,
  stalenessConfig,
  type StalenessConfig,
} from "../src/staleness.js";

const DAY_MS = 86_400_000;
const daysAgo = (d: number): string => new Date(Date.now() - d * DAY_MS).toISOString();

function fakeNote(updated_at: string, tags: string[] = []): NoteRecord {
  return {
    id: 1,
    namespace: "default",
    title: "t",
    body: "b",
    tags,
    rev: 1,
    source: "",
    written_by: "",
    created_by: "",
    created_at: updated_at,
    updated_at,
    access_count: 0,
    last_accessed: null,
  };
}

const DEFAULTS: StalenessConfig = { staleDays: 90, staleTags: ["#status"], staleTagDays: 30 };

/** created_at has no override on store.create(); reach the private handle in
 *  tests only, like the time-range tests do. */
function backdate(store: Store, id: number, iso: string): void {
  const db = (store as unknown as { db: DatabaseSync }).db;
  db.prepare("UPDATE notes SET created_at = ?, updated_at = ? WHERE id = ?").run(iso, iso, id);
}

describe("staleness: isStale()", () => {
  test("fresh note is not stale", () => {
    const info = isStale(fakeNote(daysAgo(2)), DEFAULTS);
    assert.equal(info.stale, false);
    assert.equal(info.ageDays, 2);
    assert.equal(info.reason, undefined);
  });

  test("note older than staleDays is stale", () => {
    const info = isStale(fakeNote(daysAgo(100)), DEFAULTS);
    assert.equal(info.stale, true);
    assert.equal(info.ageDays, 100);
    assert.equal(info.reason, "older than 90 days");
  });

  test("#status note expires after staleTagDays", () => {
    const info = isStale(fakeNote(daysAgo(45), ["#status"]), DEFAULTS);
    assert.equal(info.stale, true);
    assert.equal(info.ageDays, 45);
    assert.equal(info.reason, "#status older than 30 days");
  });

  test("#status note younger than staleTagDays is not stale", () => {
    const info = isStale(fakeNote(daysAgo(20), ["#status"]), DEFAULTS);
    assert.equal(info.stale, false);
    assert.equal(info.ageDays, 20);
  });

  test("tag matches with or without the leading '#', case-insensitively", () => {
    assert.equal(isStale(fakeNote(daysAgo(45), ["status"]), DEFAULTS).stale, true);
    assert.equal(isStale(fakeNote(daysAgo(45), ["Status"]), DEFAULTS).stale, true);
    // The reason reports the tag as configured.
    assert.equal(
      isStale(fakeNote(daysAgo(45), ["status"]), DEFAULTS).reason,
      "#status older than 30 days"
    );
  });

  test("tag expiry wins over the general threshold", () => {
    // 45 days < 90-day general threshold, but #status expired at 30.
    const info = isStale(fakeNote(daysAgo(45), ["#status"]), DEFAULTS);
    assert.equal(info.stale, true);
    assert.ok(info.reason!.includes("#status"));
  });

  test("exactly at the threshold is not stale (strict >)", () => {
    assert.equal(isStale(fakeNote(daysAgo(30), ["#status"]), DEFAULTS).stale, false);
  });

  test("custom thresholds", () => {
    const cfg: StalenessConfig = { staleDays: 10, staleTags: ["#wip"], staleTagDays: 5 };
    assert.equal(isStale(fakeNote(daysAgo(12)), cfg).reason, "older than 10 days");
    assert.equal(isStale(fakeNote(daysAgo(9)), cfg).stale, false);
    const tagHit = isStale(fakeNote(daysAgo(7), ["wip"]), cfg);
    assert.equal(tagHit.stale, true);
    assert.equal(tagHit.reason, "#wip older than 5 days");
    assert.equal(isStale(fakeNote(daysAgo(4), ["wip"]), cfg).stale, false);
  });

  test("ageDays is floored, never negative, robust to bad timestamps", () => {
    // 45.9 days old -> 45.
    const partial = new Date(Date.now() - 45.9 * DAY_MS).toISOString();
    assert.equal(isStale(fakeNote(partial), DEFAULTS).ageDays, 45);
    // Future updated_at (clock skew) -> 0 days, not stale.
    const future = new Date(Date.now() + DAY_MS).toISOString();
    const f = isStale(fakeNote(future), DEFAULTS);
    assert.equal(f.ageDays, 0);
    assert.equal(f.stale, false);
    // Unparseable updated_at -> treated as 0 days old, not stale.
    const bad = isStale(fakeNote("not-a-date"), DEFAULTS);
    assert.equal(bad.ageDays, 0);
    assert.equal(bad.stale, false);
  });

  test("STALE_SCORE_PENALTY is the named 0.9 constant", () => {
    assert.equal(STALE_SCORE_PENALTY, 0.9);
  });
});

describe("staleness: warning text", () => {
  test("tag-expiry warning matches the spec example", () => {
    const n = fakeNote(daysAgo(45), ["#status"]);
    assert.equal(
      staleWarning(n, DEFAULTS),
      "This note is 45 days old (tagged #status, expires after 30 days). " +
        "Verify against current state before acting on it."
    );
  });

  test("generic-age warning", () => {
    const n = fakeNote(daysAgo(100));
    assert.equal(
      staleWarning(n, DEFAULTS),
      "This note is 100 days old. Verify against current state before acting on it."
    );
  });

  test("fresh note has no warning", () => {
    assert.equal(staleWarning(fakeNote(daysAgo(2)), DEFAULTS), undefined);
  });

  test("singular day grammar", () => {
    assert.ok(staleWarning(fakeNote(daysAgo(1)), { ...DEFAULTS, staleDays: 0 })!.includes("1 day old"));
  });
});

describe("staleness: annotateStaleness()", () => {
  test("fresh note gets stale/ageDays, no staleWarning key", () => {
    const a = annotateStaleness(fakeNote(daysAgo(2)), DEFAULTS);
    assert.equal(a.stale, false);
    assert.equal(a.ageDays, 2);
    assert.ok(!("staleWarning" in a));
    assert.equal(a.title, "t"); // note fields preserved
  });

  test("stale note gets staleWarning", () => {
    const a = annotateStaleness(fakeNote(daysAgo(45), ["#status"]), DEFAULTS);
    assert.equal(a.stale, true);
    assert.equal(a.ageDays, 45);
    assert.ok(a.staleWarning!.includes("tagged #status"));
  });

  test("does not mutate the input record", () => {
    const n = fakeNote(daysAgo(100));
    annotateStaleness(n, DEFAULTS);
    assert.ok(!("stale" in n));
  });
});

describe("staleness: stalenessConfig()", () => {
  const KEYS = ["ONEMEMORY_STALE_DAYS", "ONEMEMORY_STALE_TAGS", "ONEMEMORY_STALE_TAG_DAYS"] as const;
  const saved = new Map<string, string | undefined>();

  function snapshot(): void {
    saved.clear();
    for (const k of KEYS) saved.set(k, process.env[k]);
    for (const k of KEYS) delete process.env[k];
  }
  function restore(): void {
    for (const k of KEYS) {
      const v = saved.get(k);
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }

  test("defaults", () => {
    snapshot();
    try {
      assert.deepEqual(stalenessConfig(), {
        staleDays: 90,
        staleTags: ["#status"],
        staleTagDays: 30,
      });
    } finally {
      restore();
    }
  });

  test("env overrides", () => {
    snapshot();
    try {
      process.env.ONEMEMORY_STALE_DAYS = "60";
      process.env.ONEMEMORY_STALE_TAGS = "#status, #wip ,todo";
      process.env.ONEMEMORY_STALE_TAG_DAYS = "14";
      assert.deepEqual(stalenessConfig(), {
        staleDays: 60,
        staleTags: ["#status", "#wip", "todo"],
        staleTagDays: 14,
      });
    } finally {
      restore();
    }
  });

  test("invalid values fall back to defaults", () => {
    snapshot();
    try {
      process.env.ONEMEMORY_STALE_DAYS = "banana";
      process.env.ONEMEMORY_STALE_TAGS = " , ,";
      process.env.ONEMEMORY_STALE_TAG_DAYS = "-5";
      assert.deepEqual(stalenessConfig(), {
        staleDays: 90,
        staleTags: ["#status"],
        staleTagDays: 30,
      });
    } finally {
      restore();
    }
  });
});

describe("staleness: search ranking penalty", () => {
  test("keyword: stale note ranks below an equally-relevant fresh note, stays findable", async () => {
    const store = new Store(":memory:");
    try {
      const fresh = store.create({
        title: "quarterly widget budget report",
        body: "widget budget numbers for the quarter",
      });
      const stale = store.create({
        title: "quarterly widget budget report",
        body: "widget budget numbers for the quarter",
      });
      backdate(store, stale.id, daysAgo(100));
      // Identical text -> identical FTS scores; the 0.9 penalty is the only
      // thing that can separate them, so the fresh note must come first.
      const results = await runSearch(store, "quarterly widget", { mode: "keyword" });
      assert.equal(results.length, 2);
      assert.equal(results[0].id, fresh.id);
      assert.equal(results[1].id, stale.id);
    } finally {
      store.close();
    }
  });

  test("keyword: penalty never drops the stale note from results", async () => {
    const store = new Store(":memory:");
    try {
      const stale = store.create({ title: "ancient widget lore", body: "widget history" });
      backdate(store, stale.id, daysAgo(200));
      const results = await runSearch(store, "widget lore", { mode: "keyword" });
      assert.ok(results.some((n) => n.id === stale.id));
    } finally {
      store.close();
    }
  });

  test("semantic: stale note ranks below an equally-similar fresh note", async () => {
    const realFetch = globalThis.fetch;
    const SAVE = process.env.ONEMEMORY_EMBEDDINGS;
    const store = new Store(":memory:");
    try {
      process.env.ONEMEMORY_EMBEDDINGS = "on";
      // Constant embedding: every note ties on cosine, so the stale penalty
      // alone decides the order.
      globalThis.fetch = (async () => ({
        ok: true,
        status: 200,
        json: async () => ({ data: [{ embedding: [1, 0, 0] }] }),
      })) as unknown as typeof fetch;
      const vec = Float32Array.from([1, 0, 0]);
      const fresh = store.create({ title: "fresh semantic note", body: "vector content" });
      const stale = store.create({ title: "stale semantic note", body: "vector content" });
      store.setVector(fresh.id, vec, "test");
      store.setVector(stale.id, vec, "test");
      backdate(store, stale.id, daysAgo(100));
      const results = await runSearch(store, "vector content", { mode: "semantic" });
      assert.equal(results.length, 2);
      assert.equal(results[0].id, fresh.id);
      assert.equal(results[1].id, stale.id);
    } finally {
      globalThis.fetch = realFetch;
      if (SAVE === undefined) delete process.env.ONEMEMORY_EMBEDDINGS;
      else process.env.ONEMEMORY_EMBEDDINGS = SAVE;
      store.close();
    }
  });
});

describe("staleness: MCP annotation surface", () => {
  let store: Store;
  let client: Client;

  function parseToolJson(result: any): any {
    const item = result.content[0];
    assert.equal(item.type, "text");
    const text = item.text as string;
    const start = text.indexOf("{");
    return JSON.parse(start >= 0 ? text.slice(start) : text);
  }

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

  test("state_read annotates a stale note", async () => {
    const n = store.create({ title: "old status", body: "x", tags: ["#status"] });
    backdate(store, n.id, daysAgo(45));
    const result = await client.callTool({ name: "state_read", arguments: { id: n.id } });
    const note = parseToolJson(result).note;
    assert.equal(note.stale, true);
    assert.equal(note.ageDays, 45);
    assert.ok(note.staleWarning.includes("tagged #status"));
  });

  test("state_read annotates a fresh note without a warning", async () => {
    const n = store.create({ title: "fresh note", body: "x" });
    const result = await client.callTool({ name: "state_read", arguments: { id: n.id } });
    const note = parseToolJson(result).note;
    assert.equal(note.stale, false);
    assert.equal(note.ageDays, 0);
    assert.ok(!("staleWarning" in note));
  });

  test("state_search annotates every hit", async () => {
    const fresh = store.create({ title: "searchable gadget", body: "gadget info" });
    const stale = store.create({ title: "searchable gadget archive", body: "gadget info" });
    backdate(store, stale.id, daysAgo(100));
    const result = await client.callTool({
      name: "state_search",
      arguments: { query: "searchable gadget" },
    });
    const results = parseToolJson(result).results;
    assert.equal(results.length, 2);
    const byId = new Map<number, any>(results.map((r: any) => [r.id, r]));
    assert.equal(byId.get(fresh.id).stale, false);
    assert.equal(byId.get(stale.id).stale, true);
    assert.ok(byId.get(stale.id).staleWarning.includes("100 days old"));
  });
});
