// state_search on a whole question: FTS5 needs every term, so it used to find
// nothing. keywordWithFallback tops up with any-keyword hits, below full matches.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { keywordWithFallback, runSearch } from "../src/search-service.js";

test("a natural-language question finds notes that match some of its words", async () => {
  const store = new Store(":memory:");
  const region = store.create({ title: "Deploy region", body: "Production deploys to ca-central-1." });
  store.create({ title: "Lunch", body: "Pizza on Fridays." });
  assert.equal(store.searchRanked("which region do we deploy production to", { limit: 10 }).length, 0);
  const hits = await runSearch(store, "which region do we deploy production to", { mode: "keyword", limit: 5 });
  assert.equal(hits[0]?.id, region.id);
  assert.ok(!hits.some((n) => n.title === "Lunch"), "unrelated note stays out");
});

test("full matches always rank above partial ones, and single words are unchanged", () => {
  const store = new Store(":memory:");
  const partial = store.create({ title: "Stripe", body: "stripe stripe stripe stripe webhook" });
  const full = store.create({ title: "Retry", body: "stripe webhook retry policy" });
  const hits = keywordWithFallback(store, "stripe webhook retry", 10, {});
  assert.equal(hits[0].note.id, full.id);
  assert.equal(hits[1].note.id, partial.id);
  assert.ok(hits[1].score < hits[0].score);
  assert.deepEqual(
    keywordWithFallback(store, "stripe", 10, {}).map((h) => h.note.id),
    store.searchRanked("stripe", { limit: 10 }).map((h) => h.note.id)
  );
});
