// Tier 2 HIGH/MEDIUM fixes: regression tests (Database + Search/IR).
//
// D-HIGH-2  create() edge computation is atomic (SAVEPOINT).
// D-HIGH-3  importNotes() skips per-note edge scoring + one terminal rebuild.
// D-MEDIUM-1 reverse-direction edge index exists.
// D-MEDIUM-2 tokenize-once: precomputeTfMaps shared helper.
// D-MEDIUM-4 active edge threshold persisted in _meta; all write paths read it.
// I-HIGH-1  TF-IDF cosine + >=2-shared-token floor; threshold from the
//           150-pair sweep (reviews/tier2-threshold-sweep/).
// I-HIGH-2  recency-aware access boost + graded stale penalty.

import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  Store,
  EDGE_SIMILARITY_THRESHOLD,
  type NoteRecord,
  type RebuildEdgesResult,
} from "../src/store.js";
import {
  precomputeTfMaps,
  computeDocFreqs,
  cosineTfIdf,
  sharedTokenCount,
  termFreq,
  tokenize,
  MIN_SHARED_TOKENS_FOR_EDGE,
} from "../src/consolidate.js";
import { runSearch, ACCESS_BOOST_FACTOR, ACCESS_BOOST_TAU_DAYS } from "../src/search-service.js";
import {
  stalePenaltyFactor,
  STALE_PENALTY_PER_BAND,
  STALE_PENALTY_BAND_DAYS,
  stalenessConfig,
} from "../src/staleness.js";

/** Reach the private DatabaseSync handle in tests only (same pattern as staleness.test.ts). */
function dbOf(store: Store): DatabaseSync {
  return (store as unknown as { db: DatabaseSync }).db;
}

function edgeCount(store: Store): number {
  return (dbOf(store).prepare("SELECT COUNT(*) AS c FROM note_edges").get() as { c: number }).c;
}

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

/** Age a note's content-write and fabricate its read history via SQL. */
function ageNote(store: Store, id: number, updatedDaysAgo: number, accesses: number, accessedDaysAgo: number): void {
  dbOf(store)
    .prepare("UPDATE notes SET updated_at = ?, last_accessed = ?, access_count = ? WHERE id = ?")
    .run(daysAgoIso(updatedDaysAgo), daysAgoIso(accessedDaysAgo), accesses, id);
}

describe("D-HIGH-2: create() edge computation is atomic", () => {
  let store: Store;
  beforeEach(() => {
    store = new Store(":memory:");
  });

  test("crash mid edge-loop leaves no partial edge set and a usable connection", () => {
    const n1 = store.create({ title: "alpha shared words here", body: "more shared content" });
    const db = dbOf(store);
    const stub = (store as unknown as { recomputeEdgesFor: (...a: never[]) => void });
    const orig = stub.recomputeEdgesFor;
    // Simulate a crash AFTER one edge insert but BEFORE the loop finishes.
    stub.recomputeEdgesFor = (id: number) => {
      db.prepare("INSERT INTO note_edges (note_id, neighbor_id, score) VALUES (?, ?, ?)").run(
        id,
        n1.id,
        0.9
      );
      throw new Error("simulated crash mid edge loop");
    };
    try {
      assert.throws(
        () =>
          store.create({ title: "alpha shared words here", body: "more shared content" }),
        /simulated crash/
      );
    } finally {
      stub.recomputeEdgesFor = orig;
    }
    // The note and its edges are one transaction now (rc BLOCKER 1): a
    // failure rolls back the note too, so a retry never duplicates it ...
    assert.equal(store.list({}).total, 1);
    // ... but the edge work is all-or-nothing: the partial insert rolled back.
    assert.equal(edgeCount(store), 0);
    // The savepoint was released: the connection still takes writes, and a
    // later create() links edges normally.
    const n3 = store.create({ title: "alpha shared words here", body: "more shared content" });
    assert.ok(n3.id > 0);
    assert.ok(edgeCount(store) > 0, "edges link normally after the rolled-back create");
  });

  test("create() inside an outer transaction still nests the savepoint safely", () => {
    // consolidateNotes calls create() inside store.transaction(); the
    // SAVEPOINT must nest, not error.
    const s2 = new Store(":memory:");
    s2.transaction(() => {
      s2.create({ title: "nesting probe one two", body: "three four" });
      s2.create({ title: "nesting probe one two", body: "three four five" });
    });
    assert.equal(s2.list({}).total, 2);
    assert.ok(edgeCount(s2) > 0);
  });
});

describe("D-HIGH-3: importNotes skips per-note scoring, links only imported notes", () => {
  test("create(skipEdges: true) writes no edges; importNotes never runs a full rebuild", async () => {
    const s = new Store(":memory:");
    s.create({ title: "solar panel installers winnipeg", body: "residential quotes" });
    const n2 = s.create(
      { title: "solar panel maintenance", body: "winnipeg residential" },
      { skipEdges: true }
    );
    assert.ok(n2.id > 0);
    assert.equal(edgeCount(s), 0);

    let rebuildCalls = 0;
    const stub = s as unknown as {
      rebuildEdgesCooperative: (o?: never) => Promise<RebuildEdgesResult>;
    };
    const orig = stub.rebuildEdgesCooperative.bind(s);
    stub.rebuildEdgesCooperative = async (o?: never) => {
      rebuildCalls++;
      return orig(o);
    };
    await s.importNotes([
      { title: "solar panel installers winnipeg", body: "residential quotes" },
      { title: "solar panel maintenance", body: "winnipeg residential" },
      { title: "unrelated dentist appointment", body: "thursday afternoon" },
    ]);
    // v1.1: a full-store rebuild per import was O(n^2) on the whole store
    // (a 1-note import into 20k notes took minutes); only the imported
    // notes are scored now.
    assert.equal(rebuildCalls, 0, "import must not trigger a full rebuild");
    assert.ok(edgeCount(s) > 0, "imported notes were linked into the graph");
  });

  test("importNotes edge set matches a manual per-note create + rebuild", async () => {
    const notes = [
      { title: "solar panel installers winnipeg", body: "residential quotes comparison" },
      { title: "solar panel maintenance schedule", body: "winnipeg residential cleaning" },
      { title: "unrelated dentist appointment", body: "thursday afternoon" },
    ];
    const a = new Store(":memory:");
    await a.importNotes(notes);
    const b = new Store(":memory:");
    for (const n of notes) b.create(n);
    await b.rebuildEdgesCooperative();
    assert.ok(edgeCount(a) > 0);
    assert.equal(edgeCount(a), edgeCount(b));
    // No self-edges, no cross-namespace edges, edges are bidirectional.
    const db = dbOf(a);
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS c FROM note_edges WHERE note_id = neighbor_id").get() as { c: number }).c,
      0
    );
    const fwd = db
      .prepare("SELECT note_id, neighbor_id, score FROM note_edges ORDER BY note_id, neighbor_id")
      .all() as Array<{ note_id: number; neighbor_id: number; score: number }>;
    for (const e of fwd) {
      const back = db
        .prepare("SELECT score FROM note_edges WHERE note_id = ? AND neighbor_id = ?")
        .get(e.neighbor_id, e.note_id) as { score: number } | undefined;
      assert.ok(back, "every edge has its reverse direction");
      assert.equal(back!.score, e.score);
    }
  });
});

describe("D-MEDIUM-1: reverse-direction edge index", () => {
  test("idx_note_edges_neighbor and the (note_id, score) composite exist", () => {
    const s = new Store(":memory:");
    const names = (
      dbOf(s)
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('idx_note_edges_neighbor', 'idx_note_edges_note_score')"
        )
        .all() as Array<{ name: string }>
    ).map((r) => r.name);
    assert.ok(names.includes("idx_note_edges_neighbor"), "neighbor-direction index");
    assert.ok(names.includes("idx_note_edges_note_score"), "composite (note_id, score DESC)");
    const v = (dbOf(s).prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    assert.ok(v >= 6, `migration v6 ran (user_version=${v})`);
  });
});

describe("D-MEDIUM-4: active edge threshold is persisted, not per-call", () => {
  let s: Store;
  beforeEach(() => {
    s = new Store(":memory:");
  });

  test("default is the swept constant; set/get round-trips; garbage rejected", () => {
    assert.equal(s.getEdgeThreshold(), EDGE_SIMILARITY_THRESHOLD);
    s.setEdgeThreshold(0.6);
    assert.equal(s.getEdgeThreshold(), 0.6);
    assert.throws(() => s.setEdgeThreshold(0), /threshold/);
    assert.throws(() => s.setEdgeThreshold(1.5), /threshold/);
    assert.throws(() => s.setEdgeThreshold(NaN), /threshold/);
  });

  test("create()/planEdges() honor the stored threshold (no mixed-threshold graphs)", () => {
    // Pair scores ~0.847 TF-IDF (5 shared tokens, 2-doc corpus): links at
    // the 0.25 default, not at 0.99.
    s.create({ title: "aaa bbb ccc", body: "ddd eee" });
    const atDefault = s.planEdges("default", "aaa bbb ccc", "ddd eee fff", s.getEdgeThreshold());
    assert.ok(atDefault.pairs.length > 0, "links at the default threshold");
    s.setEdgeThreshold(0.99);
    const atHigh = s.planEdges("default", "aaa bbb ccc", "ddd eee fff", s.getEdgeThreshold());
    assert.equal(atHigh.pairs.length, 0, "stored 0.99 suppresses the pair");
    const n = s.create({ title: "aaa bbb ccc", body: "ddd eee fff" });
    const edgesForN = (
      dbOf(s).prepare("SELECT COUNT(*) AS c FROM note_edges WHERE note_id = ?").get(n.id) as { c: number }
    ).c;
    assert.equal(edgesForN, 0, "create() read the stored threshold, not the default");
  });

  test("rebuildEdgesCooperative with an explicit threshold persists it", async () => {
    s.create({ title: "aaa bbb ccc", body: "ddd eee" });
    s.create({ title: "aaa bbb ccc", body: "ddd eee fff" });
    await s.rebuildEdgesCooperative({ threshold: 0.6 });
    assert.equal(s.getEdgeThreshold(), 0.6);
    // ...and a rebuild without a threshold reuses the stored one.
    await s.rebuildEdgesCooperative();
    assert.equal(s.getEdgeThreshold(), 0.6);
  });
});

describe("D-MEDIUM-2 + I-HIGH-1: tokenize-once TF-IDF edge scoring", () => {
  test("precomputeTfMaps tokenizes once per note and matches termFreq(tokenize())", () => {
    const notes = [
      { id: 1, title: "Hello World", body: "foo bar foo" },
      { id: 2, title: "", body: "" },
    ];
    const maps = precomputeTfMaps(notes);
    assert.deepEqual(maps.get(1), termFreq(tokenize("Hello World foo bar foo")));
    assert.equal(maps.get(2)!.size, 0);
  });

  test("computeDocFreqs counts documents containing each term", () => {
    const maps = precomputeTfMaps([
      { id: 1, title: "alpha beta", body: "" },
      { id: 2, title: "beta gamma", body: "" },
    ]);
    const df = computeDocFreqs(maps.values());
    assert.equal(df.get("alpha"), 1);
    assert.equal(df.get("beta"), 2);
    assert.equal(df.get("gamma"), 1);
    assert.equal(df.get("missing"), undefined);
  });

  test("cosineTfIdf: identical -> 1, disjoint -> 0, empty -> 0", () => {
    const df = new Map([["a", 1], ["b", 1]]);
    const m = new Map([["a", 2], ["b", 1]]);
    assert.equal(cosineTfIdf(m, new Map(m), df, 2), 1);
    assert.equal(cosineTfIdf(m, new Map([["c", 1]]), df, 2), 0);
    assert.equal(cosineTfIdf(new Map(), m, df, 2), 0);
  });

  test("cosineTfIdf weights rare shared terms above common ones", () => {
    // Same TF shape; only document frequency differs.
    const mk = (t: string) => new Map([[t, 1], ["x", 1]]);
    const df = new Map([["rare", 1], ["common", 90], ["x", 50], ["y", 50]]);
    const rareScore = cosineTfIdf(mk("rare"), new Map([["rare", 1], ["y", 1]]), df, 100);
    const commonScore = cosineTfIdf(mk("common"), new Map([["common", 1], ["y", 1]]), df, 100);
    assert.ok(rareScore > commonScore, `rare ${rareScore} > common ${commonScore}`);
  });

  test("sharedTokenCount counts the intersection", () => {
    const a = new Map([["x", 2], ["y", 1]]);
    const b = new Map([["y", 3], ["z", 1]]);
    assert.equal(sharedTokenCount(a, b), 1);
    assert.equal(sharedTokenCount(a, new Map()), 0);
  });

  test("fewer than MIN_SHARED_TOKENS_FOR_EDGE shared tokens never earns an edge", () => {
    const s = new Store(":memory:");
    s.create({ title: "unrelated filler note", body: "nothing in common here" });
    // One shared content token ("dentist"); raw-TF cosine scored this 0.408.
    // Even at a near-zero threshold the floor must hold.
    const plan = s.planEdges("default", "Dentist appointment", "see dentist thursday", 0.01);
    assert.equal(plan.pairs.length, 0);
    assert.equal(MIN_SHARED_TOKENS_FOR_EDGE, 2);
  });

  test("default threshold is the swept 0.25 (see reviews/tier2-threshold-sweep/results.json)", () => {
    assert.equal(EDGE_SIMILARITY_THRESHOLD, 0.25);
  });
});

describe("I-HIGH-2: recency-aware boost, graded stale penalty", () => {
  const cfg = stalenessConfig();

  function fakeNote(updatedDaysAgo: number): NoteRecord {
    const iso = daysAgoIso(updatedDaysAgo);
    return {
      id: 1, namespace: "default", title: "t", body: "b", tags: [], rev: 1,
      source: "", created_at: iso, updated_at: iso, access_count: 0, last_accessed: null,
    };
  }

  test("stalePenaltyFactor: fresh -> 1, graded by 90-day bands", () => {
    assert.equal(stalePenaltyFactor(fakeNote(2), cfg), 1);
    assert.equal(stalePenaltyFactor(fakeNote(100), cfg), STALE_PENALTY_PER_BAND);
    const four = stalePenaltyFactor(fakeNote(400), cfg);
    assert.ok(Math.abs(four - Math.pow(STALE_PENALTY_PER_BAND, 4)) < 1e-12);
    assert.equal(STALE_PENALTY_BAND_DAYS, 90);
  });

  for (const accesses of [10, 100, 1000]) {
    test(`fresh note outranks stale note with ${accesses} old accesses`, async () => {
      const s = new Store(":memory:");
      // Identical title+body => identical FTS5 bm25 base scores: a pure tie
      // the boost/penalty must break toward the fresh note.
      const fresh = s.create({ title: "saturn probe", body: "identical payload words" });
      const stale = s.create({ title: "saturn probe", body: "identical payload words" });
      ageNote(s, stale.id, 120, accesses, 120); // stale content, stale reads
      const results = await runSearch(s, "saturn probe", { mode: "keyword" });
      assert.ok(results.length >= 2);
      assert.equal(results[0].id, fresh.id, `fresh must win at ${accesses} accesses`);
      assert.equal(results[1].id, stale.id);
    });
  }

  test("a stale note re-read TODAY still outranks a never-read fresh note (recency is signal)", async () => {
    const s = new Store(":memory:");
    const stale = s.create({ title: "saturn probe", body: "identical payload words" });
    const fresh = s.create({ title: "saturn probe", body: "identical payload words" });
    ageNote(s, stale.id, 120, 100, 0); // stale content, but read today
    const results = await runSearch(s, "saturn probe", { mode: "keyword" });
    assert.equal(results[0].id, stale.id);
    assert.equal(results[1].id, fresh.id);
  });

  test("older stale notes rank below newer stale notes at equal accesses (graded penalty)", async () => {
    const s = new Store(":memory:");
    const newer = s.create({ title: "saturn probe", body: "identical payload words" });
    const older = s.create({ title: "saturn probe", body: "identical payload words" });
    ageNote(s, newer.id, 100, 0, 100);
    ageNote(s, older.id, 400, 0, 400);
    const results = await runSearch(s, "saturn probe", { mode: "keyword" });
    assert.equal(results[0].id, newer.id, "100d stale (0.95) beats 400d stale (0.95^4)");
    assert.equal(results[1].id, older.id);
  });

  test("access boost decays with days since last read", async () => {
    const s = new Store(":memory:");
    const oldHot = s.create({ title: "saturn probe", body: "identical payload words" });
    const newHot = s.create({ title: "saturn probe", body: "identical payload words" });
    ageNote(s, oldHot.id, 1, 10, 60); // 10 reads, but 60 days ago
    for (let i = 0; i < 10; i++) s.touch(newHot.id); // 10 reads today
    const results = await runSearch(s, "saturn probe", { mode: "keyword" });
    assert.equal(results[0].id, newHot.id, "recent reads beat equally-many old reads");
    assert.equal(results[1].id, oldHot.id);
  });

  test("recency constants are sane", () => {
    assert.equal(ACCESS_BOOST_FACTOR, 0.1);
    assert.equal(ACCESS_BOOST_TAU_DAYS, 30);
  });
});
