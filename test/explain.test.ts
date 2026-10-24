// Retrieval visibility: the explain layer that answers "why was this memory
// retrieved?" Verifies the breakdown reports the real factors the scorer
// used, that describeBreakdown reads naturally, and -- critically -- that
// adding explain never reorders results versus the plain search path.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import {
  runSearch,
  runSearchExplained,
  describeBreakdown,
  accessBoostFactor,
  ACCESS_BOOST_FACTOR,
  type ScoreBreakdown,
} from "../src/search-service.js";

function freshStore(): { store: Store; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "om-explain-"));
  const saved = process.env.ONEMEMORY_KEY_FILE;
  process.env.ONEMEMORY_KEY_FILE = join(dir, "no-such-key");
  const store = new Store(join(dir, "state.db"));
  if (saved === undefined) delete process.env.ONEMEMORY_KEY_FILE;
  else process.env.ONEMEMORY_KEY_FILE = saved;
  return { store, dir };
}

function cleanup(dir: string, store: Store): void {
  store.close();
  rmSync(dir, { recursive: true, force: true });
}

describe("explain: accessBoostFactor", () => {
  test("is 1.0 (no boost) for a never-read note", () => {
    assert.equal(accessBoostFactor(0, null), 1);
  });

  test("grows with access count and matches the documented formula", () => {
    const recent = new Date().toISOString();
    const expected = 1 + ACCESS_BOOST_FACTOR * Math.log10(1 + 5) * 1;
    assert.ok(Math.abs(accessBoostFactor(5, recent) - expected) < 1e-9);
  });

  test("decays toward 1.0 as the last access gets older", () => {
    const now = Date.now();
    const today = accessBoostFactor(10, new Date(now).toISOString());
    const lastYear = accessBoostFactor(10, new Date(now - 365 * 86_400_000).toISOString());
    assert.ok(today > lastYear, "recent reads boost more than old reads");
    assert.ok(lastYear >= 1, "boost never goes below 1.0");
  });
});

describe("explain: describeBreakdown()", () => {
  const base = {
    finalScore: 1,
    baseScore: 0.5,
    accessBoost: 1,
    stalePenalty: 1,
    accessCount: 0,
    daysSinceAccess: null,
    ageDays: 3,
    stale: false,
  };

  test("fresh never-read note reads naturally", () => {
    const s = describeBreakdown(base);
    assert.match(s, /never read/);
    assert.match(s, /fresh/);
    assert.ok(s.endsWith("."), "ends with a period");
  });

  test("read note reports the count and boost factor", () => {
    const s = describeBreakdown({ ...base, accessCount: 7, daysSinceAccess: 2, accessBoost: 1.09 });
    assert.match(s, /read 7x/);
    assert.match(s, /2d ago/);
    assert.match(s, /boost x1\.090/);
  });

  test("stale note reports the demotion factor", () => {
    const s = describeBreakdown({ ...base, stale: true, ageDays: 120, stalePenalty: 0.9025 });
    assert.match(s, /120d old/);
    assert.match(s, /demoted x0\.902/);
  });
});

describe("explain: parity with plain search", () => {
  test("explained results match plain results in content AND order", async () => {
    const { store, dir } = freshStore();
    try {
      store.create({ title: "kubernetes deploy", body: "kubectl apply -f" });
      store.create({ title: "kubernetes rollback", body: "kubectl rollout undo" });
      store.create({ title: "grocery list", body: "milk eggs" });

      const plain = await runSearch(store, "kubernetes");
      const explained = await runSearchExplained(store, "kubernetes");

      assert.equal(explained.length, plain.length, "same number of hits");
      for (let i = 0; i < plain.length; i++) {
        assert.equal(explained[i].note.id, plain[i].id, `hit ${i} is the same note in the same order`);
        assert.equal(explained[i].note.title, plain[i].title);
      }
    } finally {
      cleanup(dir, store);
    }
  });

  test("every hit carries a breakdown with a base score and explanation", async () => {
    const { store, dir } = freshStore();
    try {
      store.create({ title: "alpha project", body: "alpha details" });
      const hits = await runSearchExplained(store, "alpha");
      assert.ok(hits.length > 0, "found at least one hit");
      for (const h of hits) {
        const b: ScoreBreakdown = h.breakdown;
        assert.ok(Number.isFinite(b.baseScore), "baseScore is a number");
        assert.ok(Number.isFinite(b.finalScore), "finalScore is a number");
        assert.ok(b.accessBoost >= 1, "accessBoost >= 1");
        assert.ok(b.stalePenalty > 0 && b.stalePenalty <= 1, "stalePenalty in (0,1]");
        assert.ok(typeof b.ageDays === "number", "ageDays present");
        assert.ok(b.explanation.length > 0, "explanation text present");
      }
    } finally {
      cleanup(dir, store);
    }
  });

  test("finalScore = baseScore x accessBoost x stalePenalty when rerank is on", async () => {
    const { store, dir } = freshStore();
    try {
      store.create({ title: "repeatedly read note", body: "content" });
      // Read it a few times so the access boost is non-trivial.
      const n = store.list({}).notes[0];
      for (let i = 0; i < 8; i++) store.read(n.id, { trackAccess: true });

      const hits = await runSearchExplained(store, "repeatedly");
      const b = hits[0].breakdown;
      const product = b.baseScore * b.accessBoost * b.stalePenalty;
      assert.ok(
        Math.abs(product - b.finalScore) < 1e-6,
        `breakdown must multiply to the final score (got ${product} vs ${b.finalScore})`
      );
    } finally {
      cleanup(dir, store);
    }
  });

  test("ONEMEMORY_ACCESS_BOOST=0 yields boost and penalty of exactly 1", async () => {
    const { store, dir } = freshStore();
    const prev = process.env.ONEMEMORY_ACCESS_BOOST;
    try {
      process.env.ONEMEMORY_ACCESS_BOOST = "0";
      store.create({ title: "native ranking note", body: "native" });
      const hits = await runSearchExplained(store, "native");
      assert.equal(hits[0].breakdown.accessBoost, 1);
      assert.equal(hits[0].breakdown.stalePenalty, 1);
    } finally {
      if (prev === undefined) delete process.env.ONEMEMORY_ACCESS_BOOST;
      else process.env.ONEMEMORY_ACCESS_BOOST = prev;
      cleanup(dir, store);
    }
  });
});
