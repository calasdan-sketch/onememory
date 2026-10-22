// Change feed: Store.changes (tombstones, grouping, cursor paging), the
// changes.ts service ("since" parsing, the per-consumer "last" marker), the
// memory_since MCP tool (scope + namespace gating) and REST GET /changes.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Store, ValidationError } from "../src/store.js";
import { resolveSince, runChanges, consumerKey } from "../src/changes.js";
import { createMcpServer } from "../src/mcp-server-core.js";
import { createApiServer } from "../src/api.js";

// Tool payloads may carry the untrusted-data banner before the JSON.
function parseTool(r: any): any {
  const t: string = r.content[0].text;
  return JSON.parse(t.slice(t.indexOf("{")));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("resolveSince", () => {
  const now = Date.parse("2026-10-16T12:00:00.000Z");
  test("durations count back from now", () => {
    assert.equal(resolveSince("24h", now), "2026-10-15T12:00:00.000Z");
    assert.equal(resolveSince("30m", now), "2026-10-16T11:30:00.000Z");
    assert.equal(resolveSince("7d", now), "2026-10-09T12:00:00.000Z");
    assert.equal(resolveSince("2w", now), "2026-10-02T12:00:00.000Z");
    assert.equal(resolveSince("90s", now), "2026-10-16T11:58:30.000Z");
  });
  test("ISO timestamps are normalized to UTC", () => {
    assert.equal(resolveSince("2026-10-15T09:00:00-05:00", now), "2026-10-15T14:00:00.000Z");
    assert.equal(resolveSince("2026-10-15", now), "2026-10-15T00:00:00.000Z");
  });
  test('"last" is handled by the caller (null)', () => {
    assert.equal(resolveSince("last", now), null);
    assert.equal(resolveSince("LAST", now), null);
  });
  test("garbage is a ValidationError, never a silent full dump", () => {
    for (const bad of ["", "yesterday-ish", "5", "24 hours", "-3h"]) {
      assert.throws(() => resolveSince(bad, now), ValidationError, bad);
    }
  });
  test("consumer labels are validated", () => {
    assert.equal(consumerKey(undefined), "default");
    assert.equal(consumerKey("phone"), "phone");
    assert.throws(() => consumerKey("a|b"), ValidationError);
    assert.throws(() => consumerKey("x".repeat(65)), ValidationError);
  });
});

describe("Store.changes", () => {
  let store: Store;
  let t0: string;
  before(async () => {
    store = new Store(":memory:");
    store.create({ title: "old note", source: "desktop" });
    // SQLite's trigger stamps changed_at in whole milliseconds. Sleep so the
    // seed note is stamped strictly BEFORE t0 -- otherwise a same-millisecond
    // capture makes `changed_at >= t0` include it and the sanity check below
    // fails intermittently (seen ~1-in-10 standalone).
    await sleep(5);
    t0 = new Date().toISOString();
  });
  after(() => store.close());

  test("reports created, updated and deleted notes grouped by source", async () => {
    await sleep(5);
    const since = new Date().toISOString();
    const pre = store.create({ title: "pre-existing", source: "desktop" });
    await sleep(5);
    const mid = new Date().toISOString();
    const a = store.create({ title: "made on phone", source: "phone" });
    store.update(pre.id, { body: "edited on phone", source: "phone" });
    const gone = store.create({ title: "doomed", source: "desktop" });
    store.delete(gone.id);

    const page = store.changes({ since: mid, graceMs: 0 });
    const kinds = Object.fromEntries(page.changes.map((c) => [c.title, c.kind]));
    assert.equal(kinds["made on phone"], "created");
    assert.equal(kinds["pre-existing"], "updated");
    assert.equal(kinds[""], "deleted", "a deleted note's title is blanked (privacy)");
    assert.equal(page.changes.find((c) => c.id === gone.id)?.kind, "deleted");
    assert.equal(kinds["old note"], undefined, "unchanged notes are not in the feed");
    assert.deepEqual(page.counts, { created: 1, updated: 1, deleted: 1, total: 3 });
    assert.deepEqual(page.bySource.phone, { created: 1, updated: 1, deleted: 0 });
    assert.deepEqual(page.bySource.desktop, { created: 0, updated: 0, deleted: 1 });
    assert.equal(page.nextCursor, null);
    // A wider window sees "pre-existing" as created (it was born inside it).
    const wide = store.changes({ since, graceMs: 0 });
    assert.equal(wide.changes.find((c) => c.id === pre.id)?.kind, "created");
    // Entries carry no bodies.
    for (const c of page.changes) assert.equal("body" in c, false);
    assert.equal(page.changes.find((c) => c.id === a.id)?.rev, 1);
    assert.equal(page.changes.find((c) => c.kind === "deleted")?.rev, undefined);
  });

  test("cursor paging is stable and complete", async () => {
    const s = new Store(":memory:");
    const since = new Date(Date.now() - 1000).toISOString();
    const ids = Array.from({ length: 7 }, (_, i) => s.create({ title: `n${i}` }).id);
    const seen: number[] = [];
    let page = s.changes({ since, limit: 3 });
    assert.equal(page.counts.total, 7, "counts cover the whole window, not the page");
    seen.push(...page.changes.map((c) => c.id));
    while (page.nextCursor) {
      // A write landing mid-paging is outside the frozen window.
      await sleep(3);
      s.create({ title: "late" });
      page = s.changes({ cursor: page.nextCursor, limit: 3 });
      seen.push(...page.changes.map((c) => c.id));
    }
    assert.deepEqual(seen, ids);
    assert.throws(() => s.changes({ cursor: "not-a-cursor" }), ValidationError);
    s.close();
  });

  test("namespace and source filters", () => {
    const s = new Store(":memory:");
    const since = new Date(Date.now() - 1000).toISOString();
    s.create({ title: "w1", namespace: "work", source: "a" });
    s.create({ title: "h1", namespace: "home", source: "b" });
    const d = s.create({ title: "w2", namespace: "work", source: "b" });
    s.delete(d.id);
    assert.deepEqual(
      s.changes({ since, namespaces: ["work"] }).changes.map((c) => c.title),
      ["w1", ""] // w2 was deleted: its title is blanked
    );
    assert.deepEqual(s.changes({ since, source: "b" }).changes.map((c) => c.title).sort(), ["", "h1"]);
    assert.equal(s.changes({ since, namespaces: [] }).counts.total, 0);
    s.close();
  });

  test("consolidation shows up as one create plus the deleted sources", () => {
    const s = new Store(":memory:");
    const a = s.create({ title: "API base URL is api.example.com", body: "x" });
    const b = s.create({ title: "API base URL is api.example.com", body: "x" });
    const since = new Date().toISOString();
    return import("../src/consolidate.js").then(({ consolidateNotes }) => {
      consolidateNotes(s, [a.id, b.id]);
      const page = s.changes({ since });
      assert.equal(page.counts.created, 1);
      assert.equal(page.counts.deleted, 2);
      s.close();
    });
  });

  test("t0 sanity: the seed note is older than every window above", () => {
    assert.ok(store.changes({ since: t0, graceMs: 0 }).changes.every((c) => c.title !== "old note"));
  });
});

describe('runChanges "last" marker', () => {
  test("first read covers 24h; each completed read advances the marker", async () => {
    const s = new Store(":memory:");
    s.create({ title: "first" });
    await sleep(3);
    const r1 = runChanges(s, { since: "last", consumer: "phone" });
    assert.equal(r1.consumer, "phone");
    assert.deepEqual(r1.changes.map((c) => c.title), ["first"]);
    const r2 = runChanges(s, { since: "last", consumer: "phone" });
    assert.equal(r2.changes.length, 0, "nothing new since the last read");
    assert.equal(r2.since, r1.until, "windows tile exactly: no gap, no overlap");
    s.create({ title: "second" });
    await sleep(3);
    assert.deepEqual(
      runChanges(s, { since: "last", consumer: "phone" }).changes.map((c) => c.title),
      ["second"]
    );
    // Another consumer has its own marker.
    assert.equal(runChanges(s, { since: "last", consumer: "desktop" }).changes.length, 2);
    s.close();
  });

  test("the marker only advances once the final page is served", async () => {
    const s = new Store(":memory:");
    for (let i = 0; i < 5; i++) s.create({ title: `n${i}` });
    await sleep(3);
    const p1 = runChanges(s, { since: "last", consumer: "c", limit: 2 });
    assert.ok(p1.nextCursor);
    // Abandon paging: the next "last" read starts over from the old marker.
    const again = runChanges(s, { since: "last", consumer: "c", limit: 10 });
    assert.equal(again.changes.length, 5);
    // Paging to the end via the cursor advances it.
    const q1 = runChanges(s, { since: "last", consumer: "d", limit: 2 });
    let page = q1;
    while (page.nextCursor) page = runChanges(s, { cursor: page.nextCursor, limit: 2 });
    assert.equal(page.consumer, "d");
    assert.equal(runChanges(s, { since: "last", consumer: "d" }).changes.length, 0);
    s.close();
  });

  test("markers are per namespace scope", async () => {
    const s = new Store(":memory:");
    s.create({ title: "w", namespace: "work" });
    s.create({ title: "h", namespace: "home" });
    await sleep(3);
    runChanges(s, { since: "last", namespaces: ["work"] });
    assert.deepEqual(
      runChanges(s, { since: "last", namespaces: ["home"] }).changes.map((c) => c.title),
      ["h"]
    );
    s.close();
  });
});

describe("memory_since MCP tool", () => {
  async function connect(store: Store, scope: "read" | "write" | "admin", opts = {}) {
    const server = createMcpServer(store, scope, opts);
    const [c, s] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "1.0.0" });
    await Promise.all([client.connect(c), server.connect(s)]);
    return client;
  }

  test("read scope can use it; output is untrusted-bannered", async () => {
    const store = new Store(":memory:");
    store.create({ title: "hello", source: "phone" });
    const client = await connect(store, "read");
    const r: any = await client.callTool({ name: "memory_since", arguments: { since: "1h" } });
    assert.ok(!r.isError);
    assert.match(r.content[0].text, /UNTRUSTED DATA/);
    const out = parseTool(r);
    assert.equal(out.counts.created, 1);
    assert.deepEqual(out.bySource, { phone: { created: 1, updated: 0, deleted: 0 } });
    const bad: any = await client.callTool({ name: "memory_since", arguments: { since: "whenever" } });
    assert.equal(bad.isError, true);
    await client.close();
    store.close();
  });

  test("namespace resolution confines the feed to readable namespaces", async () => {
    const store = new Store(":memory:");
    store.create({ title: "mine", namespace: "work" });
    store.create({ title: "granted", namespace: "shared" });
    store.create({ title: "secret plans", namespace: "home" });
    const client = await connect(store, "read", { namespace: "work", readsFrom: { work: ["shared"] } });
    const all = parseTool(await client.callTool({ name: "memory_since", arguments: { since: "1h" } }));
    assert.deepEqual(all.changes.map((c: any) => c.title).sort(), ["granted", "mine"]);
    assert.deepEqual(all.searchedNamespaces, ["work", "shared"]);
    // An unreadable hint falls back to the readable set, never leaks "home".
    const hinted = parseTool(
      await client.callTool({ name: "memory_since", arguments: { since: "1h", namespace: "home" } })
    );
    assert.ok(hinted.changes.every((c: any) => c.namespace !== "home"));
    await client.close();
    store.close();
  });
});

describe("REST GET /changes", () => {
  let store: Store;
  let base: string;
  let server: ReturnType<typeof createApiServer>;
  const ADMIN = "admin-token-changes";
  const READ = "read-token-changes";
  before(async () => {
    store = new Store(":memory:");
    server = createApiServer(store, [
      { token: ADMIN, scope: "admin", label: "admin" },
      { token: READ, scope: "read", label: "read" },
    ]);
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
  });

  test("auth required; read scope allowed; mirrors the MCP tool", async () => {
    assert.equal((await fetch(`${base}/changes?since=1h`)).status, 401);
    store.create({ title: "via rest", source: "curl" });
    const res = await fetch(`${base}/changes?since=1h&limit=1`, {
      headers: { Authorization: `Bearer ${READ}` },
    });
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.equal(j.counts.created, 1);
    assert.equal(j.changes[0].title, "via rest");
    assert.deepEqual(j.searchedNamespaces, []);
  });

  test("bad input is a 400", async () => {
    const h = { headers: { Authorization: `Bearer ${READ}` } };
    assert.equal((await fetch(`${base}/changes`, h)).status, 400);
    assert.equal((await fetch(`${base}/changes?since=soon`, h)).status, 400);
    assert.equal((await fetch(`${base}/changes?since=1h&limit=abc`, h)).status, 400);
    assert.equal((await fetch(`${base}/changes?cursor=zzz`, h)).status, 400);
  });

  test("since=last with a consumer advances its marker", async () => {
    await sleep(3);
    const h = { headers: { Authorization: `Bearer ${READ}` } };
    const a = await (await fetch(`${base}/changes?since=last&consumer=rest`, h)).json();
    assert.equal(a.consumer, "rest");
    const b = await (await fetch(`${base}/changes?since=last&consumer=rest`, h)).json();
    assert.equal(b.changes.length, 0);
  });
});
