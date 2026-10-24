import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { runSearch } from "../src/search-service.js";
import {
  parseTimePhrase,
  filterByTimeRange,
  resolveTimeZone,
  type TimeRange,
} from "../src/time-parse.js";

// Fixed reference instant: 2026-10-16T12:00:00Z, which is 07:00 wall-clock in
// America/Winnipeg (UTC-5, CDT still in effect mid-October). Every boundary
// below is asserted as an exact UTC instant -- no wall-clock dependence.
const NOW = new Date("2026-10-16T12:00:00Z");
const TZ = "America/Winnipeg";
const iso = (d: Date) => d.toISOString();

function parse(phrase: string): TimeRange {
  const r = parseTimePhrase(phrase, { now: NOW, timeZone: TZ });
  assert.ok(r, `expected "${phrase}" to parse`);
  return r;
}

describe("parseTimePhrase: relative days", () => {
  test("today", () => {
    const r = parse("today");
    assert.equal(iso(r.start), "2026-10-16T05:00:00.000Z");
    assert.equal(iso(r.end), "2026-10-17T05:00:00.000Z");
  });

  test("yesterday", () => {
    const r = parse("yesterday");
    assert.equal(iso(r.start), "2026-10-15T05:00:00.000Z");
    assert.equal(iso(r.end), "2026-10-16T05:00:00.000Z");
  });

  test("3 days ago", () => {
    const r = parse("3 days ago");
    assert.equal(iso(r.start), "2026-10-13T05:00:00.000Z");
    assert.equal(iso(r.end), "2026-10-14T05:00:00.000Z");
  });

  test("a day ago == yesterday", () => {
    const a = parse("a day ago");
    const b = parse("yesterday");
    assert.equal(iso(a.start), iso(b.start));
    assert.equal(iso(a.end), iso(b.end));
  });

  test("case-insensitive, surrounding whitespace trimmed", () => {
    const r = parse("  YESTERDAY  ");
    assert.equal(iso(r.start), "2026-10-15T05:00:00.000Z");
  });

  test("out-of-range day counts return null", () => {
    assert.equal(parseTimePhrase("0 days ago", { now: NOW, timeZone: TZ }), null);
    assert.equal(parseTimePhrase("366 days ago", { now: NOW, timeZone: TZ }), null);
  });
});

describe("parseTimePhrase: weeks and months", () => {
  test("last week is Monday-start (Oct 5 -> Oct 12)", () => {
    const r = parse("last week");
    assert.equal(iso(r.start), "2026-10-05T05:00:00.000Z");
    assert.equal(iso(r.end), "2026-10-12T05:00:00.000Z");
  });

  test("this week is Monday-start (Oct 12 -> Oct 19)", () => {
    const r = parse("this week");
    assert.equal(iso(r.start), "2026-10-12T05:00:00.000Z");
    assert.equal(iso(r.end), "2026-10-19T05:00:00.000Z");
  });

  test("last month", () => {
    const r = parse("last month");
    assert.equal(iso(r.start), "2026-09-01T05:00:00.000Z");
    assert.equal(iso(r.end), "2026-10-01T05:00:00.000Z");
  });

  test("this month", () => {
    const r = parse("this month");
    assert.equal(iso(r.start), "2026-10-01T05:00:00.000Z");
    assert.equal(iso(r.end), "2026-11-01T05:00:00.000Z");
  });

  test("in july -> July of the current year", () => {
    const r = parse("in july");
    assert.equal(iso(r.start), "2026-07-01T05:00:00.000Z");
    assert.equal(iso(r.end), "2026-08-01T05:00:00.000Z");
  });

  test("in july 2025 -> explicit year honored", () => {
    const r = parse("in july 2025");
    assert.equal(iso(r.start), "2025-07-01T05:00:00.000Z");
    assert.equal(iso(r.end), "2025-08-01T05:00:00.000Z");
  });

  test("in december from October -> previous December, never future", () => {
    const r = parse("in december");
    assert.equal(iso(r.start), "2025-12-01T06:00:00.000Z"); // CST (UTC-6) in December
    assert.equal(iso(r.end), "2026-01-01T06:00:00.000Z");
  });
});

describe("parseTimePhrase: dayparts", () => {
  test("yesterday evening = 17:00-22:00 wall clock", () => {
    const r = parse("yesterday evening");
    assert.equal(iso(r.start), "2026-10-15T22:00:00.000Z");
    assert.equal(iso(r.end), "2026-10-16T03:00:00.000Z");
  });

  test("this morning = 05:00-12:00 wall clock", () => {
    const r = parse("this morning");
    assert.equal(iso(r.start), "2026-10-16T10:00:00.000Z");
    assert.equal(iso(r.end), "2026-10-16T17:00:00.000Z");
  });

  test("tonight = today 17:00 -> tomorrow 05:00", () => {
    const r = parse("tonight");
    assert.equal(iso(r.start), "2026-10-16T22:00:00.000Z");
    assert.equal(iso(r.end), "2026-10-17T10:00:00.000Z");
  });

  test("last night = yesterday 22:00 -> today 05:00", () => {
    const r = parse("last night");
    assert.equal(iso(r.start), "2026-10-16T03:00:00.000Z"); // Oct 15 22:00 wall
    assert.equal(iso(r.end), "2026-10-16T10:00:00.000Z"); // Oct 16 05:00 wall
  });
});

describe("parseTimePhrase: clock times and absolute dates", () => {
  test("around 3pm = +/-30 min window", () => {
    const r = parse("around 3pm");
    assert.equal(iso(r.start), "2026-10-16T19:30:00.000Z");
    assert.equal(iso(r.end), "2026-10-16T20:30:00.000Z");
  });

  test("3pm yesterday anchors to yesterday", () => {
    const r = parse("3pm yesterday");
    assert.equal(iso(r.start), "2026-10-15T19:30:00.000Z");
    assert.equal(iso(r.end), "2026-10-15T20:30:00.000Z");
  });

  test("at 14:30 (24h) = +/-30 min window", () => {
    const r = parse("at 14:30");
    assert.equal(iso(r.start), "2026-10-16T19:00:00.000Z"); // 14:00 wall
    assert.equal(iso(r.end), "2026-10-16T20:00:00.000Z"); // 15:00 wall
  });

  test("2026-10-14 (ISO date)", () => {
    const r = parse("2026-10-14");
    assert.equal(iso(r.start), "2026-10-14T05:00:00.000Z");
    assert.equal(iso(r.end), "2026-10-15T05:00:00.000Z");
  });

  test("Oct 14 -> current year, most recent past occurrence", () => {
    const r = parse("Oct 14");
    assert.equal(iso(r.start), "2026-10-14T05:00:00.000Z");
    assert.equal(iso(r.end), "2026-10-15T05:00:00.000Z");
  });

  test("Dec 25 (future this year) -> previous year", () => {
    const r = parse("Dec 25");
    assert.equal(iso(r.start), "2025-12-25T06:00:00.000Z");
    assert.equal(iso(r.end), "2025-12-26T06:00:00.000Z");
  });

  test("10/14/2026 (MM/DD/YYYY)", () => {
    const r = parse("10/14/2026");
    assert.equal(iso(r.start), "2026-10-14T05:00:00.000Z");
    assert.equal(iso(r.end), "2026-10-15T05:00:00.000Z");
  });

  test("October 14 2025 (month name + year)", () => {
    const r = parse("October 14 2025");
    assert.equal(iso(r.start), "2025-10-14T05:00:00.000Z");
    assert.equal(iso(r.end), "2025-10-15T05:00:00.000Z");
  });
});

describe("parseTimePhrase: robustness", () => {
  test("garbage returns null, never throws", () => {
    for (const g of ["about the budget", "", "   ", "xyzzy plugh", "!!", "12345"]) {
      assert.equal(parseTimePhrase(g, { now: NOW, timeZone: TZ }), null, `input: ${g}`);
    }
  });

  test("non-string / nullish input returns null", () => {
    assert.equal(parseTimePhrase(null as unknown as string), null);
    assert.equal(parseTimePhrase(undefined as unknown as string), null);
  });

  test("time phrase embedded in a longer query still parses", () => {
    const r = parseTimePhrase("yesterday about the budget", { now: NOW, timeZone: TZ });
    assert.ok(r);
    assert.equal(iso(r.start), "2026-10-15T05:00:00.000Z");
    assert.equal(iso(r.end), "2026-10-16T05:00:00.000Z");
  });

  test("invalid timezone falls back to UTC, no throw", () => {
    const r = parseTimePhrase("today", { now: NOW, timeZone: "Mars/Olympus_Mons" });
    assert.ok(r);
    assert.equal(iso(r.start), "2026-10-16T00:00:00.000Z");
    assert.equal(iso(r.end), "2026-10-17T00:00:00.000Z");
  });

  test("resolveTimeZone validates IANA names", () => {
    assert.equal(resolveTimeZone("America/Winnipeg"), "America/Winnipeg");
    assert.equal(resolveTimeZone("Not/AZone"), "UTC");
    // v1.1: unset ONEMEMORY_TIMEZONE means the host's timezone, not UTC.
    assert.equal(
      resolveTimeZone(undefined),
      process.env.ONEMEMORY_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone
    );
  });

  test("start is inclusive, end is exclusive", () => {
    const r = parse("today");
    assert.ok(r.start.getTime() < r.end.getTime());
    assert.ok(r.label.length > 0);
  });
});

describe("filterByTimeRange", () => {
  const notes = [
    { created_at: "2026-10-15T06:00:00.000Z" }, // inside yesterday (Winnipeg)
    { created_at: "2026-10-15T04:59:59.999Z" }, // just before start -> out
    { created_at: "2026-10-16T05:00:00.000Z" }, // exactly end -> out (exclusive)
    { created_at: "2026-10-15T05:00:00.000Z" }, // exactly start -> in (inclusive)
    { created_at: "not-a-date" }, // unparseable -> out
  ];
  test("keeps [start, end), drops the rest", () => {
    const r = parse("yesterday");
    const kept = filterByTimeRange(notes, r);
    assert.deepEqual(
      kept.map((n) => n.created_at),
      ["2026-10-15T06:00:00.000Z", "2026-10-15T05:00:00.000Z"]
    );
  });
});

describe("runSearch with timeRange", () => {
  test("keyword mode passes the range into store.searchRanked", async () => {
    const seen: Array<[string, Record<string, unknown>]> = [];
    const stub = {
      searchRanked: (q: string, o: Record<string, unknown>) => {
        seen.push([q, o]);
        return [];
      },
      touch: (_id: number) => {},
      touchMany: (_ids: number[]) => {},
    };
    const r = parse("yesterday");
    await runSearch(stub as unknown as Store, "budget", {
      mode: "keyword",
      timeRange: { start: r.start, end: r.end },
    });
    assert.equal(seen.length, 1);
    assert.equal(seen[0][0], "budget");
    assert.equal(seen[0][1].startISO, "2026-10-15T05:00:00.000Z");
    assert.equal(seen[0][1].endISO, "2026-10-16T05:00:00.000Z");
  });

  test("blank query + timeRange lists the range newest-first", async () => {
    const canned = [{ id: 2 }, { id: 1 }];
    let gotOpts: Record<string, unknown> | null = null;
    const stub = {
      list: (o: Record<string, unknown>) => {
        gotOpts = o;
        return { notes: canned, total: 2 };
      },
      touch: (_id: number) => {},
      touchMany: (_ids: number[]) => {},
    };
    const r = parse("today");
    const out = await runSearch(stub as unknown as Store, "   ", {
      timeRange: { start: r.start, end: r.end },
    });
    assert.deepEqual(out, canned);
    assert.equal(gotOpts!.startISO, "2026-10-16T05:00:00.000Z");
    assert.equal(gotOpts!.endISO, "2026-10-17T05:00:00.000Z");
  });

  test("no timeRange behaves as before (no range opts sent)", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const stub = {
      searchRanked: (_q: string, o: Record<string, unknown>) => {
        seen.push(o);
        return [];
      },
      touch: (_id: number) => {},
      touchMany: (_ids: number[]) => {},
    };
    await runSearch(stub as unknown as Store, "budget", { mode: "keyword" });
    assert.ok(!("startISO" in seen[0]) && !("endISO" in seen[0]));
  });
});

describe("store range scoping (real DB)", () => {
  test("search() startISO/endISO filters on created_at", () => {
    const store = new Store(":memory:");
    const note = store.create({ title: "budget review notes", body: "quarterly budget" });
    const ts = note.created_at;
    const before = new Date(Date.parse(ts) - 60_000).toISOString();
    const after = new Date(Date.parse(ts) + 60_000).toISOString();

    const hit = store.search("budget", { startISO: before, endISO: after });
    assert.equal(hit.length, 1);
    assert.equal(hit[0].id, note.id);

    const miss = store.search("budget", { startISO: after });
    assert.equal(miss.length, 0);
  });

  test("list() startISO/endISO scopes and counts consistently", () => {
    const store = new Store(":memory:");
    const note = store.create({ title: "scoped list check" });
    const ts = note.created_at;
    const before = new Date(Date.parse(ts) - 60_000).toISOString();
    const after = new Date(Date.parse(ts) + 60_000).toISOString();

    const inRange = store.list({ startISO: before, endISO: after });
    assert.equal(inRange.total, 1);
    assert.equal(inRange.notes[0].id, note.id);

    const outRange = store.list({ startISO: after });
    assert.equal(outRange.total, 0);
    assert.deepEqual(outRange.notes, []);
  });
});
