import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Store, ValidationError } from "../src/store.js";
import { runSearch } from "../src/search-service.js";

describe("panel fixes", () => {
  test("update() invalidates a stale embedding", () => {
    const s = new Store(":memory:");
    const id = s.create({ title: "Paris travel tips", body: "cafes and museums" }).id;
    s.setVector(id, Float32Array.from([1, 0, 0]), "test");
    assert.equal(s.vectorCount(), 1);

    // Editing the note must drop the now-stale vector so a failed re-embed
    // can't leave a permanently wrong vector that semantic search returns.
    s.update(id, { body: "Docker networking notes" });
    assert.equal(s.vectorCount(), 0);
    assert.deepEqual(s.noteIdsMissingVectors(), [id]);
  });

  test("importNotes preserves provenance (source)", async () => {
    const src = new Store(":memory:");
    src.create({ title: "n1", body: "b", source: "agent:hermes" });
    const dump = src.exportAll();
    assert.equal(dump[0].source, "agent:hermes");

    const fresh = new Store(":memory:");
    await fresh.importNotes(dump);
    assert.equal(fresh.exportAll()[0].source, "agent:hermes");
  });

  test("create() throws a ValidationError (not a generic Error) for a missing title", () => {
    const s = new Store(":memory:");
    assert.throws(() => s.create({ title: "" }), (e) => e instanceof ValidationError);
  });

  test("runSearch clamps a zero/negative limit instead of returning []", async () => {
    const s = new Store(":memory:");
    s.create({ title: "alpha widget" });
    s.create({ title: "alpha gadget" });
    // Embeddings are off in tests -> keyword path; a bad limit must still clamp.
    const zero = await runSearch(s, "alpha", { limit: 0 });
    assert.ok(zero.length >= 1, "limit 0 should clamp to >=1, not return []");
    const neg = await runSearch(s, "alpha", { limit: -5 });
    assert.ok(neg.length >= 1, "negative limit should clamp, not misorder/empty");
  });
});
