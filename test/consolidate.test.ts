// Feature: auto-consolidation / dedup (cosine-similarity candidate
// detection + note merging), MCP tools, and interval parsing.
import { test, describe, beforeEach, before, after } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Store, ValidationError } from "../src/store.js";
import { createMcpServer } from "../src/mcp-server-core.js";
import {
  cosineSimilarity,
  jaccardSimilarity,
  tokenize,
  findCandidates,
  consolidateNotes,
  buildConsolidationPreview,
  groupCandidateIds,
  clampThreshold,
} from "../src/consolidate.js";
import { parseIntervalToMs } from "../src/config.js";

const BODY =
  "We agreed to launch the pilot in March with the downtown crew handling " +
  "onboarding and weekly checkins throughout the quarter";

describe("text similarity", () => {
  test("cosineSimilarity: identical strings score 1", () => {
    assert.equal(cosineSimilarity("hello world foo", "hello world foo"), 1);
  });

  test("cosineSimilarity: totally different strings score near 0", () => {
    const s = cosineSimilarity(
      "Project kickoff plan " + BODY,
      "Grocery list for the weekend barbecue party at the lake house"
    );
    assert.ok(s < 0.1, `expected near 0, got ${s}`);
  });

  test("cosineSimilarity: symmetric", () => {
    const a = "the quick brown fox jumps";
    const b = "brown fox jumps over fences";
    assert.equal(cosineSimilarity(a, b), cosineSimilarity(b, a));
  });

  test("cosineSimilarity: near-duplicate scores high", () => {
    const s = cosineSimilarity(
      "Project kickoff plan " + BODY,
      "Project kickoff plan draft " + BODY
    );
    assert.ok(s >= 0.95, `expected >= 0.95, got ${s}`);
    assert.ok(s < 1, `expected < 1, got ${s}`);
  });

  test("jaccardSimilarity: identical -> 1, disjoint -> 0, symmetric", () => {
    assert.equal(jaccardSimilarity("alpha beta gamma", "alpha beta gamma"), 1);
    assert.equal(jaccardSimilarity("alpha beta", "gamma delta"), 0);
    assert.equal(
      jaccardSimilarity("alpha beta", "beta gamma"),
      jaccardSimilarity("beta gamma", "alpha beta")
    );
  });

  test("tokenize drops short tokens and stopwords", () => {
    const toks = tokenize("The cat and a dog ran to the park");
    assert.ok(!toks.includes("the"), "stopword dropped");
    assert.ok(!toks.includes("a"), "single-char dropped");
    assert.ok(toks.includes("cat") && toks.includes("park"));
  });

  test("clampThreshold clamps instead of throwing", () => {
    assert.equal(clampThreshold(undefined), 0.95);
    assert.equal(clampThreshold(99), 1.0);
    assert.equal(clampThreshold(-1), 0.5);
    assert.equal(clampThreshold(0.8), 0.8);
    assert.equal(clampThreshold(NaN), 0.95);
  });
});

describe("findCandidates", () => {
  let store: Store;

  beforeEach(() => {
    store = new Store(":memory:");
  });

  function seedDupPair(): [number, number] {
    const a = store.create({ title: "Project kickoff plan", body: BODY });
    const b = store.create({ title: "Project kickoff plan draft", body: BODY });
    return [a.id, b.id];
  }

  test("finds a near-identical pair at the default 0.95 threshold", () => {
    const [idA, idB] = seedDupPair();
    const pairs = findCandidates(store.exportAll());
    assert.equal(pairs.length, 1);
    assert.equal(pairs[0].idA, Math.min(idA, idB));
    assert.equal(pairs[0].idB, Math.max(idA, idB));
    assert.ok(pairs[0].score >= 0.95);
  });

  test("different notes produce no candidates", () => {
    store.create({ title: "Grocery list", body: "eggs milk bread for the weekend" });
    store.create({ title: "DNS migration", body: "move the zone to the new registrar" });
    assert.deepEqual(findCandidates(store.exportAll()), []);
  });

  test("cross-namespace pairs are never returned", () => {
    store.create({ title: "Same title", body: "Same body text here", namespace: "proj-a" });
    store.create({ title: "Same title", body: "Same body text here", namespace: "proj-b" });
    assert.deepEqual(findCandidates(store.exportAll()), []);
  });

  test("threshold is respected", () => {
    seedDupPair(); // near-identical: 0.95 <= score < 1
    assert.equal(findCandidates(store.exportAll(), { threshold: 0.95 }).length, 1);
    assert.equal(findCandidates(store.exportAll(), { threshold: 1.0 }).length, 0);
    // Exact duplicates score exactly 1 and survive threshold 1.0.
    store.create({ title: "Ditto", body: "word for word the same note" });
    store.create({ title: "Ditto", body: "word for word the same note" });
    const exact = findCandidates(store.exportAll(), { threshold: 1.0 });
    assert.equal(exact.length, 1);
    assert.equal(exact[0].score, 1);
  });

  test("limit caps the results, sorted by score desc", () => {
    // Distinct per-pair word (2+ chars — single-char tokens are dropped by
    // the tokenizer, so `${i}` alone would make all six notes identical).
    const words = ["rivers", "mountains", "deserts"];
    for (const w of words) {
      store.create({ title: `Ditto ${w}`, body: `word for word the same note about ${w}` });
      store.create({ title: `Ditto ${w}`, body: `word for word the same note about ${w}` });
    }
    const all = findCandidates(store.exportAll());
    assert.equal(all.length, 3);
    const capped = findCandidates(store.exportAll(), { limit: 2 });
    assert.equal(capped.length, 2);
    for (const p of capped) assert.ok(p.idA < p.idB, "idA < idB");
  });
});

describe("groupCandidateIds", () => {
  test("chains group together, disjoint pairs stay separate", () => {
    const groups = groupCandidateIds([
      { idA: 1, idB: 2, score: 1 },
      { idA: 2, idB: 3, score: 1 },
      { idA: 10, idB: 11, score: 1 },
    ]);
    const sorted = groups.map((g) => g.join(",")).sort();
    assert.deepEqual(sorted, ["1,2,3", "10,11"]);
  });
});

describe("consolidateNotes", () => {
  let store: Store;
  let ids: number[];

  beforeEach(() => {
    store = new Store(":memory:");
    ids = [
      store.create({
        title: "Short",
        body: "alpha beta gamma delta",
        tags: ["a", "b"],
        source: "agent1",
      }).id,
      store.create({
        title: "A much longer title for the same fact",
        body: "alpha beta gamma delta", // exact-duplicate body
        tags: ["b", "c"],
        source: "agent2",
      }).id,
      store.create({
        title: "Third",
        body: "epsilon zeta eta theta",
        tags: ["c", "d"],
        source: "agent1",
      }).id,
    ];
  });

  test("merges 3 notes into 1: longest title, deduped body, union tags", () => {
    const merged = consolidateNotes(store, ids);
    assert.equal(merged.title, "A much longer title for the same fact");
    assert.equal(merged.body, "alpha beta gamma delta\n\n---\n\nepsilon zeta eta theta");
    assert.deepEqual(merged.tags, ["a", "b", "c", "d"]);
    assert.equal(merged.source, "agent1,agent2");
    assert.equal(merged.namespace, "default");
  });

  test("deletes sources by default", () => {
    consolidateNotes(store, ids);
    assert.equal(store.list({}).total, 1);
    for (const id of ids) assert.equal(store.read(id), null);
  });

  test("keep_sources:true keeps the source notes", () => {
    consolidateNotes(store, ids, { deleteSources: false });
    assert.equal(store.list({}).total, 4);
    for (const id of ids) assert.ok(store.read(id));
  });

  test("mergedTitle overrides the longest-title rule", () => {
    const merged = consolidateNotes(store, ids.slice(0, 2), {
      mergedTitle: "Custom title",
    });
    assert.equal(merged.title, "Custom title");
  });

  test("buildConsolidationPreview does not write", () => {
    const notes = ids.map((id) => store.read(id)!);
    buildConsolidationPreview(notes);
    assert.equal(store.list({}).total, 3);
  });

  test("different namespaces throw", () => {
    const other = store.create({ title: "Other ns", body: BODY, namespace: "proj-x" }).id;
    assert.throws(
      () => consolidateNotes(store, [ids[0], other]),
      (e: unknown) => e instanceof ValidationError && /different namespaces/.test(e.message)
    );
  });

  test("fewer than 2 ids (or dup ids) throw", () => {
    assert.throws(() => consolidateNotes(store, [ids[0]]), ValidationError);
    assert.throws(() => consolidateNotes(store, [ids[0], ids[0]]), ValidationError);
    assert.throws(() => consolidateNotes(store, [ids[0], 99999]), /no note with id/);
  });
});

// Same InMemoryTransport harness as mcp.test.ts: a real Client talks to a
// real McpServer, which calls straight into the Store.
function parseToolText(result: any): any {
  const item = result.content[0];
  assert.equal(item.type, "text");
  const text = item.text as string;
  const start = text.indexOf("{");
  return JSON.parse(start >= 0 ? text.slice(start) : text);
}

describe("MCP consolidation tools", () => {
  let store: Store;
  let client: Client;

  before(async () => {
    store = new Store(":memory:");
    const server = createMcpServer(store); // default scope = admin
    const [ct, st] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test-client", version: "1.0.0" });
    await Promise.all([client.connect(ct), server.connect(st)]);
  });

  after(async () => {
    await client.close();
    store.close();
  });

  beforeEach(() => {
    // Wipe between tests (fresh ids each time don't matter here).
    for (const n of store.exportAll()) store.delete(n.id);
  });

  test("memory_consolidation_candidates returns pairs with titles", async () => {
    store.create({ title: "Project kickoff plan", body: BODY });
    store.create({ title: "Project kickoff plan draft", body: BODY });
    store.create({ title: "Unrelated", body: "something completely different here" });
    const r: any = await client.callTool({
      name: "memory_consolidation_candidates",
      arguments: {},
    });
    assert.ok(!r.isError);
    const payload = parseToolText(r);
    assert.equal(payload.count, 1);
    assert.equal(payload.candidates.length, 1);
    const c = payload.candidates[0];
    assert.ok(c.idA < c.idB);
    assert.ok(c.score >= 0.95);
    assert.match(c.titleA, /kickoff/);
    assert.match(c.titleB, /kickoff/);
  });

  test("memory_consolidate dry_run writes nothing", async () => {
    const a = store.create({ title: "Ditto", body: "word for word the same note" });
    const b = store.create({ title: "Ditto", body: "word for word the same note" });
    const before = store.list({}).total;
    const r: any = await client.callTool({
      name: "memory_consolidate",
      arguments: { ids: [a.id, b.id], dry_run: true },
    });
    assert.ok(!r.isError);
    const payload = parseToolText(r);
    assert.equal(payload.dry_run, true);
    assert.ok(payload.would_create.title);
    assert.deepEqual(payload.would_delete, [a.id, b.id]);
    assert.equal(store.list({}).total, before, "dry run must not write");
  });

  test("memory_consolidate executes the merge", async () => {
    const a = store.create({ title: "Ditto", body: "word for word the same note", tags: ["x"] });
    const b = store.create({ title: "Ditto", body: "word for word the same note", tags: ["y"] });
    const r: any = await client.callTool({
      name: "memory_consolidate",
      arguments: { ids: [a.id, b.id] },
    });
    assert.ok(!r.isError);
    const payload = parseToolText(r);
    assert.ok(payload.merged.id > 0);
    assert.deepEqual(payload.merged.tags, ["x", "y"]);
    assert.equal(store.read(a.id), null, "source deleted");
    assert.equal(store.read(b.id), null, "source deleted");
  });

  test("memory_consolidate with keep_sources keeps sources", async () => {
    const a = store.create({ title: "Ditto", body: "word for word the same note" });
    const b = store.create({ title: "Ditto", body: "word for word the same note" });
    const r: any = await client.callTool({
      name: "memory_consolidate",
      arguments: { ids: [a.id, b.id], keep_sources: true },
    });
    assert.ok(!r.isError);
    assert.deepEqual(parseToolText(r).deleted, []);
    assert.ok(store.read(a.id) && store.read(b.id));
  });

  test("memory_consolidate is refused under read scope", async () => {
    const s2 = new Store(":memory:");
    s2.create({ title: "seed", body: "hello" });
    const server = createMcpServer(s2, "read");
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const c2 = new Client({ name: "t2", version: "1.0.0" });
    await Promise.all([c2.connect(ct), server.connect(st)]);
    const r: any = await c2.callTool({
      name: "memory_consolidate",
      arguments: { ids: [1, 2], dry_run: true },
    });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /scope/i);
    await c2.close();
    s2.close();
  });
});

describe("parseIntervalToMs", () => {
  test("parses h/m/s units", () => {
    assert.equal(parseIntervalToMs("24h"), 86_400_000);
    assert.equal(parseIntervalToMs("30m"), 1_800_000);
    assert.equal(parseIntervalToMs("90s"), 90_000);
    assert.equal(parseIntervalToMs("1d"), 86_400_000);
    assert.equal(parseIntervalToMs("500ms"), 500);
  });

  test("bare numbers mean seconds", () => {
    assert.equal(parseIntervalToMs("3600"), 3_600_000);
    assert.equal(parseIntervalToMs("60"), 60_000);
  });

  test("garbage returns null", () => {
    assert.equal(parseIntervalToMs(undefined), null);
    assert.equal(parseIntervalToMs(""), null);
    assert.equal(parseIntervalToMs("soon"), null);
    assert.equal(parseIntervalToMs("10x"), null);
    assert.equal(parseIntervalToMs("-5m"), null);
  });
});
