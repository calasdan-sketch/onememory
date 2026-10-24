// Tier 1 hardening pass: HIGH/MEDIUM/LOW panel findings below the blocker
// line -- time-parser fixes, merge date preservation, similarity tweaks,
// threshold warnings, cooperative candidate scan.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import {
  cosineSimilarity,
  jaccardSimilarity,
  tokenize,
  findCandidates,
  findCandidatesCooperative,
  consolidateNotes,
  clampThreshold,
  thresholdWasClamped,
  THRESHOLD_MIN,
  THRESHOLD_MAX,
} from "../src/consolidate.js";
import {
  parseTimePhrase,
  resolveTimeZone,
  type TimeRange,
} from "../src/time-parse.js";

// Fixed reference instant: 2026-10-16T12:00:00Z (UTC; also the wall clock
// when timeZone is "UTC"). Every boundary below is an exact UTC instant.
const NOW = new Date("2026-10-16T12:00:00Z");
const TZ = "UTC";
const iso = (d: Date) => d.toISOString();

function parse(phrase: string): TimeRange | null {
  return parseTimePhrase(phrase, { now: NOW, timeZone: TZ });
}

describe("hardening: time parser", () => {
  test("'the day before yesterday' parses as 2 days back, not yesterday", () => {
    const r = parse("the day before yesterday");
    assert.ok(r, "expected a range");
    assert.equal(iso(r.start), "2026-10-14T00:00:00.000Z");
    assert.equal(iso(r.end), "2026-10-15T00:00:00.000Z");
  });

  test("'day before yesterday morning' anchors the daypart 2 days back", () => {
    const r = parse("day before yesterday morning");
    assert.ok(r, "expected a range");
    assert.equal(iso(r.start), "2026-10-14T05:00:00.000Z");
    assert.equal(iso(r.end), "2026-10-14T12:00:00.000Z");
  });

  test("invalid dates never produce a range under a lying label", () => {
    assert.equal(parse("Feb 30"), null);
    assert.equal(parse("2026-02-30"), null);
    assert.equal(parse("2/30/2026"), null);
    assert.equal(parse("Oct 32"), null);
    assert.equal(parse("13/40/2026"), null);
  });

  test("'Feb 29' with no year in a non-leap year finds the last leap day", () => {
    const r = parse("Feb 29");
    assert.ok(r, "expected a range");
    assert.equal(iso(r.start), "2024-02-29T00:00:00.000Z");
    assert.equal(iso(r.end), "2024-03-01T00:00:00.000Z");
  });

  test("valid dates still parse after the round-trip guard", () => {
    const r = parse("2026-10-14");
    assert.ok(r);
    assert.equal(iso(r.start), "2026-10-14T00:00:00.000Z");
    const r2 = parse("10/14");
    assert.ok(r2);
    assert.equal(iso(r2.start), "2026-10-14T00:00:00.000Z");
    const r3 = parse("October 14 2025");
    assert.ok(r3);
    assert.equal(iso(r3.start), "2025-10-14T00:00:00.000Z");
  });

  test("'1/2 cup flour' is not January 2nd", () => {
    assert.equal(parse("1/2 cup flour"), null);
    assert.equal(parse("add 3/4 cup sugar"), null);
    assert.equal(parse("2 tbsp flour"), null); // no date at all -> null
  });

  test("'around 12:15am' spills into the previous evening, not truncated", () => {
    const r = parse("around 12:15am");
    assert.ok(r, "expected a range");
    assert.equal(iso(r.start), "2026-10-15T23:45:00.000Z");
    assert.equal(iso(r.end), "2026-10-16T00:45:00.000Z");
  });

  test("end-of-day spill still works ('at 11:45pm')", () => {
    const r = parse("at 11:45pm");
    assert.ok(r, "expected a range");
    assert.equal(iso(r.start), "2026-10-16T23:15:00.000Z");
    assert.equal(iso(r.end), "2026-10-17T00:15:00.000Z");
  });

  test("'last night at 9pm': clock wins when disjoint from the daypart", () => {
    const r = parse("last night at 9pm");
    assert.ok(r, "expected a range");
    // 9pm is not inside "night" (22:00-05:00): the explicit clock wins,
    // anchored to the daypart's day (yesterday).
    assert.equal(iso(r.start), "2026-10-15T20:30:00.000Z");
    assert.equal(iso(r.end), "2026-10-15T21:30:00.000Z");
  });

  test("'yesterday evening at 6pm': daypart and clock intersect", () => {
    const r = parse("yesterday evening at 6pm");
    assert.ok(r, "expected a range");
    assert.equal(iso(r.start), "2026-10-15T17:30:00.000Z");
    assert.equal(iso(r.end), "2026-10-15T18:30:00.000Z");
  });

  test("'tonight at 9pm' intersects the tonight window", () => {
    const r = parse("tonight at 9pm");
    assert.ok(r, "expected a range");
    assert.equal(iso(r.start), "2026-10-16T20:30:00.000Z");
    assert.equal(iso(r.end), "2026-10-16T21:30:00.000Z");
  });

  test("plain dayparts are unchanged by the clock-intersection logic", () => {
    const r = parse("yesterday evening");
    assert.ok(r);
    assert.equal(iso(r.start), "2026-10-15T17:00:00.000Z");
    assert.equal(iso(r.end), "2026-10-15T22:00:00.000Z");
    const r2 = parse("last night");
    assert.ok(r2);
    assert.equal(iso(r2.start), "2026-10-15T22:00:00.000Z");
    assert.equal(iso(r2.end), "2026-10-16T05:00:00.000Z");
  });

  test("'noon' is a +/-30min window around 12:00", () => {
    const r = parse("noon");
    assert.ok(r, "expected a range");
    assert.equal(iso(r.start), "2026-10-16T11:30:00.000Z");
    assert.equal(iso(r.end), "2026-10-16T12:30:00.000Z");
  });

  test("'midnight' spills into the previous evening", () => {
    const r = parse("midnight");
    assert.ok(r, "expected a range");
    assert.equal(iso(r.start), "2026-10-15T23:30:00.000Z");
    assert.equal(iso(r.end), "2026-10-16T00:30:00.000Z");
  });

  test("'tomorrow' is the whole next day; anchors work", () => {
    const r = parse("tomorrow");
    assert.ok(r, "expected a range");
    assert.equal(iso(r.start), "2026-10-17T00:00:00.000Z");
    assert.equal(iso(r.end), "2026-10-18T00:00:00.000Z");
    const r2 = parse("yesterday noon");
    assert.ok(r2);
    assert.equal(iso(r2.start), "2026-10-15T11:30:00.000Z");
    assert.equal(iso(r2.end), "2026-10-15T12:30:00.000Z");
  });

  test("resolveTimeZone memoizes and logs an invalid zone only once", () => {
    const seen: string[] = [];
    const orig = console.error;
    console.error = (m: string) => seen.push(m);
    try {
      assert.equal(resolveTimeZone("Not/AZone"), "UTC");
      assert.equal(resolveTimeZone("Not/AZone"), "UTC");
      assert.equal(resolveTimeZone("Not/AZone"), "UTC");
    } finally {
      console.error = orig;
    }
    assert.equal(seen.length, 1, `expected 1 warning, got ${seen.length}`);
    assert.equal(resolveTimeZone("UTC"), "UTC");
  });
});

describe("hardening: similarity", () => {
  test("'am' is a stopword", () => {
    assert.ok(!tokenize("I am happy").includes("am"));
  });

  test("both-empty token sets score 0, not 1.0", () => {
    assert.equal(cosineSimilarity("", ""), 0);
    assert.equal(cosineSimilarity("a the", ""), 0);
    assert.equal(jaccardSimilarity("", ""), 0);
    assert.equal(jaccardSimilarity("a", "the"), 0); // both reduce to nothing
  });

  test("non-empty identical strings still score ~1", () => {
    // FP rounding can put identical inputs a hair below 1 (the 1e-9 snap
    // lives in findCandidates, not here).
    assert.ok(cosineSimilarity("hello world", "hello world") > 1 - 1e-9);
    assert.equal(jaccardSimilarity("alpha beta", "alpha beta"), 1);
  });
});

describe("hardening: threshold clamping", () => {
  test("thresholdWasClamped detects rewrites", () => {
    assert.equal(thresholdWasClamped(99), true);
    assert.equal(thresholdWasClamped(-1), true);
    assert.equal(thresholdWasClamped(NaN), true);
    assert.equal(thresholdWasClamped(0.8), false);
    assert.equal(thresholdWasClamped(0.95), false);
    assert.equal(thresholdWasClamped(undefined), false);
    assert.equal(THRESHOLD_MIN, 0.5);
    assert.equal(THRESHOLD_MAX, 1.0);
  });

  test("clampThreshold still clamps as before", () => {
    assert.equal(clampThreshold(99), 1.0);
    assert.equal(clampThreshold(-1), 0.5);
    assert.equal(clampThreshold(undefined), 0.95);
  });
});

describe("hardening: cooperative candidate scan", () => {
  test("findCandidatesCooperative matches findCandidates exactly", async () => {
    const store = new Store(":memory:");
    try {
      const bodies = [
        "the quarterly budget review is scheduled for next tuesday morning",
        "quarterly budget review scheduled for next tuesday in the morning",
        "grocery list: eggs milk bread cheese butter",
        "grocery list eggs milk bread cheese and butter",
        "unrelated note about bird watching at the lake",
      ];
      for (let i = 0; i < bodies.length; i++) {
        store.create({ title: `note ${i}`, body: bodies[i] });
      }
      const notes = store.exportAll();
      const sync = findCandidates(notes, { threshold: 0.8 });
      const asyncRes = await findCandidatesCooperative(notes, { threshold: 0.8 });
      assert.deepEqual(asyncRes, sync);
      assert.ok(sync.length >= 2, "expected the two duplicate pairs");
    } finally {
      store.close();
    }
  });
});

describe("hardening: merge preserves date", () => {
  test("merged note keeps the oldest source created_at", () => {
    const store = new Store(":memory:");
    try {
      const a = store.create({
        title: "dup",
        body: "same body here",
        created_at: "2026-01-05T10:00:00.000Z",
      });
      const b = store.create({
        title: "dup",
        body: "same body here",
        created_at: "2026-03-20T10:00:00.000Z",
      });
      assert.ok(
        a.created_at < b.created_at,
        "precondition: test relies on distinct backdates"
      );
      const merged = consolidateNotes(store, [a.id, b.id], {
        deleteSources: false,
      });
      assert.equal(merged.created_at, "2026-01-05T10:00:00.000Z");
      // updated_at still reflects the merge itself.
      assert.ok(Date.parse(merged.updated_at) >= Date.parse(b.created_at));
    } finally {
      store.close();
    }
  });

  test("store.create backdates only on a parsable created_at", () => {
    const store = new Store(":memory:");
    try {
      const ok = store.create({ title: "t", created_at: "2025-05-05T05:05:05.000Z" });
      assert.equal(ok.created_at, "2025-05-05T05:05:05.000Z");
      const bad = store.create({ title: "t2", created_at: "not a date" });
      assert.ok(Math.abs(Date.now() - Date.parse(bad.created_at)) < 60_000);
    } finally {
      store.close();
    }
  });
});
