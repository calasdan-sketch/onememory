// Repetitive notes (captured observations) match hundreds of neighbors; only
// the top EDGE_STORE_LIMIT per write may be stored, highest score first.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Store, EDGE_STORE_LIMIT } from "../src/store.js";

test("a write stores at most EDGE_STORE_LIMIT edges, best scores kept", () => {
  const store = new Store(":memory:");
  const db = (store as unknown as { db: import("node:sqlite").DatabaseSync }).db;
  for (let i = 0; i < EDGE_STORE_LIMIT + 40; i++) {
    store.create({ title: `Edited src/api/routes.ts ${i}`, body: "Changed src/api/routes.ts and src/api/index.ts during session work." });
  }
  const last = Number((db.prepare("SELECT max(id) m FROM notes").get() as { m: number }).m);
  const own = db.prepare("SELECT count(*) c FROM note_edges WHERE note_id = ?").get(last) as { c: number };
  assert.ok(own.c > 0, "the new note is linked");
  assert.ok(own.c <= EDGE_STORE_LIMIT, `stored ${own.c} edges, limit ${EDGE_STORE_LIMIT}`);
  store.applyEdgePairs(last, Array.from({ length: EDGE_STORE_LIMIT + 5 }, (_, i) => ({ neighborId: i + 1, score: i / 100 })));
  const kept = db.prepare("SELECT min(score) s, count(*) c FROM note_edges WHERE note_id = ?").get(last) as { s: number; c: number };
  assert.equal(kept.c, EDGE_STORE_LIMIT);
  assert.equal(kept.s, 5 / 100, "the lowest five scores were dropped");
});
