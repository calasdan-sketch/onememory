import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Store, cosineSim } from "../src/store.js";
import { rrfMerge, parseMode } from "../src/search-service.js";

describe("cosine similarity", () => {
  test("identical vectors score ~1", () => {
    const a = Float32Array.from([1, 2, 3]);
    assert.ok(Math.abs(cosineSim(a, a) - 1) < 1e-6);
  });
  test("orthogonal vectors score 0", () => {
    assert.equal(cosineSim(Float32Array.from([1, 0]), Float32Array.from([0, 1])), 0);
  });
  test("mismatched lengths score 0 (never throw)", () => {
    assert.equal(cosineSim(Float32Array.from([1, 0, 0]), Float32Array.from([1, 0])), 0);
  });
});

describe("Store semantic vectors", () => {
  let store: Store;
  let a: number;
  let b: number;
  let c: number;

  beforeEach(() => {
    store = new Store(":memory:");
    a = store.create({ title: "apples" }).id;
    b = store.create({ title: "bananas", namespace: "fruit" }).id;
    c = store.create({ title: "cherries" }).id;
    store.setVector(a, Float32Array.from([1, 0, 0]), "test");
    store.setVector(b, Float32Array.from([0, 1, 0]), "test");
    store.setVector(c, Float32Array.from([0, 0, 1]), "test");
  });

  test("semanticSearch ranks the nearest vector first", () => {
    const hits = store.semanticSearch(Float32Array.from([0.9, 0.1, 0]));
    assert.equal(hits[0].note.id, a);
    assert.ok(hits[0].score > hits[1].score);
  });

  test("semanticSearch honors the namespace filter", () => {
    const hits = store.semanticSearch(Float32Array.from([0, 1, 0]), { namespace: "fruit" });
    assert.equal(hits.length, 1);
    assert.equal(hits[0].note.id, b);
  });

  test("vectors whose dimension differs from the query are skipped", () => {
    const hits = store.semanticSearch(Float32Array.from([1, 0]));
    assert.equal(hits.length, 0);
  });

  test("deleting a note cascades to its vector", () => {
    assert.equal(store.vectorCount(), 3);
    store.delete(a);
    assert.equal(store.vectorCount(), 2);
    const hits = store.semanticSearch(Float32Array.from([1, 0, 0]));
    assert.ok(!hits.some((h) => h.note.id === a));
  });

  test("noteIdsMissingVectors lists only notes without an embedding", () => {
    const d = store.create({ title: "dates" }).id;
    const missing = store.noteIdsMissingVectors();
    assert.deepEqual(missing, [d]);
  });
});

describe("search service", () => {
  test("rrfMerge fuses rankings, rewarding agreement", () => {
    // id 5 is top of BOTH lists -> clearly the highest fused score.
    const fused = rrfMerge([
      [5, 1, 2, 3],
      [5, 3, 2, 1],
    ]);
    assert.equal(fused[0], 5);
    assert.equal(fused.length, 4);
  });

  test("parseMode defaults to keyword when embeddings are off", () => {
    // Embeddings env is unset in the test runner.
    assert.equal(parseMode(undefined), "keyword");
    assert.equal(parseMode("semantic"), "semantic");
    assert.equal(parseMode("hybrid"), "hybrid");
    assert.equal(parseMode("garbage"), "keyword");
  });
});
