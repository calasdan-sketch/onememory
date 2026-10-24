import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";

describe("Store CRUD + search", () => {
  let store: Store;

  beforeEach(() => {
    store = new Store(":memory:");
  });

  test("create requires a title", () => {
    assert.throws(() => store.create({ title: "" } as any), /title is required/);
  });

  test("create + read round-trip", () => {
    const note = store.create({ title: "Hello", body: "World", tags: ["a", "b"] });
    assert.equal(note.title, "Hello");
    assert.equal(note.body, "World");
    assert.deepEqual(note.tags, ["a", "b"]);
    assert.equal(note.namespace, "default");
    assert.ok(note.id > 0);

    const fetched = store.read(note.id);
    assert.deepEqual(fetched, note);
  });

  test("read returns null for missing id", () => {
    assert.equal(store.read(99999), null);
  });

  test("create defaults namespace and body", () => {
    const note = store.create({ title: "Bare" });
    assert.equal(note.namespace, "default");
    assert.equal(note.body, "");
    assert.deepEqual(note.tags, []);
  });

  test("namespace is respected", () => {
    const note = store.create({ title: "Scoped", namespace: "jarvis" });
    assert.equal(note.namespace, "jarvis");
  });

  test("update patches only given fields", () => {
    const note = store.create({ title: "Original", body: "Body1", tags: ["x"] });
    const updated = store.update(note.id, { body: "Body2" });
    assert.ok(updated);
    assert.equal(updated!.title, "Original");
    assert.equal(updated!.body, "Body2");
    assert.deepEqual(updated!.tags, ["x"]);
  });

  test("update returns null for missing id", () => {
    assert.equal(store.update(99999, { body: "x" }), null);
  });

  test("update rejects blowing away the title with empty string", () => {
    const note = store.create({ title: "Keep me" });
    assert.throws(() => store.update(note.id, { title: "  " }), /title cannot be empty/);
  });

  test("update bumps updated_at but not created_at", async () => {
    const note = store.create({ title: "Time test" });
    await new Promise((r) => setTimeout(r, 5));
    const updated = store.update(note.id, { body: "changed" });
    assert.equal(updated!.created_at, note.created_at);
    assert.notEqual(updated!.updated_at, note.created_at);
  });

  test("list returns notes newest-updated first with total count", () => {
    store.create({ title: "One" });
    store.create({ title: "Two" });
    store.create({ title: "Three" });
    const { notes, total } = store.list();
    assert.equal(total, 3);
    assert.equal(notes.length, 3);
    assert.equal(notes[0].title, "Three");
  });

  test("list filters by namespace", () => {
    store.create({ title: "A", namespace: "ns1" });
    store.create({ title: "B", namespace: "ns2" });
    const { notes, total } = store.list({ namespace: "ns1" });
    assert.equal(total, 1);
    assert.equal(notes[0].title, "A");
  });

  test("list respects limit/offset and clamps limit", () => {
    for (let i = 0; i < 5; i++) store.create({ title: `Item ${i}` });
    const page1 = store.list({ limit: 2, offset: 0 });
    const page2 = store.list({ limit: 2, offset: 2 });
    assert.equal(page1.notes.length, 2);
    assert.equal(page2.notes.length, 2);
    assert.notDeepEqual(page1.notes, page2.notes);

    const clamped = store.list({ limit: 100000 });
    assert.ok(clamped.notes.length <= 500);
  });

  test("search finds notes by title/body/tags", () => {
    store.create({ title: "Rocket Launch", body: "Countdown begins", tags: ["space"] });
    store.create({ title: "Grocery list", body: "milk eggs bread", tags: ["home"] });

    assert.equal(store.search("rocket").length, 1);
    assert.equal(store.search("countdown").length, 1);
    assert.equal(store.search("space").length, 1);
    assert.equal(store.search("milk").length, 1);
    assert.equal(store.search("nonexistentword").length, 0);
  });

  test("search is empty for empty query", () => {
    store.create({ title: "Anything" });
    assert.deepEqual(store.search(""), []);
    assert.deepEqual(store.search("   "), []);
  });

  test("search reflects updates immediately (no stale index)", () => {
    const note = store.create({ title: "Alpha", body: "original content" });
    assert.equal(store.search("original").length, 1);
    assert.equal(store.search("revised").length, 0);

    store.update(note.id, { body: "revised content" });

    assert.equal(store.search("original").length, 0, "stale match after update");
    assert.equal(store.search("revised").length, 1, "new content not indexed after update");
  });

  test("search excludes deleted notes", () => {
    const note = store.create({ title: "Ephemeral", body: "will vanish" });
    assert.equal(store.search("vanish").length, 1);
    store.delete(note.id);
    assert.equal(store.search("vanish").length, 0);
  });

  test("search respects namespace filter", () => {
    store.create({ title: "Match", body: "needle", namespace: "ns1" });
    store.create({ title: "Match2", body: "needle", namespace: "ns2" });
    assert.equal(store.search("needle").length, 2);
    assert.equal(store.search("needle", { namespace: "ns1" }).length, 1);
  });

  test("search handles special characters without throwing", () => {
    store.create({ title: 'Quote "test"', body: "a-b/c:d" });
    assert.doesNotThrow(() => store.search('"weird" query/with:chars'));
  });

  test("delete removes the note", () => {
    const note = store.create({ title: "Temp" });
    assert.equal(store.delete(note.id), true);
    assert.equal(store.read(note.id), null);
    assert.equal(store.delete(note.id), false);
  });
});

describe("Store security guards", () => {
  let store: Store;
  beforeEach(() => {
    store = new Store(":memory:");
  });

  test("refuses to store an obvious secret (AWS key)", () => {
    assert.throws(
      () => store.create({ title: "creds", body: "aws key AKIAIOSFODNN7EXAMPLE here" }),
      /looks like a/
    );
  });

  test("refuses an oversized body", () => {
    const big = "x".repeat(300_000);
    assert.throws(() => store.create({ title: "big", body: big }), /body exceeds/);
  });

  test("a normal note with no secrets is stored fine", () => {
    const n = store.create({ title: "ok", body: "nothing sensitive here" });
    assert.ok(n.id > 0);
    assert.equal(store.read(n.id)?.body, "nothing sensitive here");
  });
});

describe("Store export/import", () => {
  let store: Store;
  beforeEach(() => {
    store = new Store(":memory:");
  });

  test("export then import round-trips notes into a fresh store", async () => {
    store.create({ title: "one", body: "first", tags: ["a"] });
    store.create({ namespace: "proj", title: "two", body: "second" });
    const dump = store.exportAll();
    assert.equal(dump.length, 2);

    const fresh = new Store(":memory:");
    const imported = await fresh.importNotes(dump);
    assert.equal(imported.length, 2);
    assert.equal(imported[0].title, "one");
    assert.equal(fresh.exportAll().length, 2);
    assert.equal(fresh.list({ namespace: "proj" }).notes[0].title, "two");
  });
});

describe("Store panel-fix regressions", () => {
  let store: Store;
  beforeEach(() => {
    store = new Store(":memory:");
  });

  test("tags with commas and spaces round-trip intact", () => {
    const n = store.create({ title: "t", tags: ["winnipeg, mb", "a b", "x"] });
    assert.deepEqual(n.tags, ["winnipeg, mb", "a b", "x"]);
    assert.deepEqual(store.read(n.id)!.tags, ["winnipeg, mb", "a b", "x"]);
  });

  test("tags are deduped and trimmed", () => {
    const n = store.create({ title: "t", tags: [" x ", "x", "", "y"] });
    assert.deepEqual(n.tags, ["x", "y"]);
  });

  test("punctuation-only search returns [] instead of throwing", () => {
    store.create({ title: "hello world" });
    assert.deepEqual(store.search("***"), []);
    assert.deepEqual(store.search("---"), []);
    assert.equal(store.search("hello").length, 1);
  });

  test("non-finite limit does not crash list", () => {
    store.create({ title: "a" });
    const r = store.list({ limit: NaN as unknown as number });
    assert.ok(r.notes.length >= 1);
  });

  test("update with a blank namespace keeps the existing one", () => {
    const n = store.create({ namespace: "proj", title: "a" });
    const u = store.update(n.id, { namespace: "   ", body: "b" });
    assert.equal(u!.namespace, "proj");
  });
});

describe("Store revisions + compare-and-swap", () => {
  let store: Store;
  beforeEach(() => {
    store = new Store(":memory:");
  });

  test("rev starts at 1 and increments on each update", () => {
    const n = store.create({ title: "a" });
    assert.equal(n.rev, 1);
    const u = store.update(n.id, { body: "b" });
    assert.equal(u!.rev, 2);
  });

  test("compare-and-swap rejects a stale write and accepts the current rev", () => {
    const n = store.create({ title: "a" }); // rev 1
    store.update(n.id, { body: "x" }); // now rev 2
    assert.throws(
      () => store.update(n.id, { body: "y" }, { ifRev: 1 }),
      /stale write/
    );
    const ok = store.update(n.id, { body: "z" }, { ifRev: 2 });
    assert.equal(ok!.rev, 3);
  });

  test("provenance source is stored and returned", () => {
    const n = store.create({ title: "a", source: "claude-code" });
    assert.equal(n.source, "claude-code");
    assert.equal(store.read(n.id)!.source, "claude-code");
  });
});

describe("Store import (best-effort) + secret scanning", () => {
  // Assemble secret-shaped fixtures from fragments so no credential literal
  // appears verbatim in source (secret scanners match raw text).
  const j = (...p: string[]): string => p.join("");

  test("importNotes skips notes that fail validation and imports the rest", async () => {
    const s = new Store(":memory:");
    const created = await s.importNotes([
      { title: "good one", body: "fine" },
      { title: "bad one", body: j("AKIA", "1234567890ABCD12") }, // secret -> rejected
      { title: "good two", body: "also fine" },
      { title: "   ", body: "no title" }, // empty title -> skipped
    ]);
    assert.equal(created.length, 2);
    assert.deepEqual(created.map((n) => n.title), ["good one", "good two"]);
    assert.equal(s.exportAll().length, 2); // the bad note was never committed
    s.close();
  });

  test("a secret in the source field is rejected", () => {
    const s = new Store(":memory:");
    const secret = j("ghp", "_", "0123456789abcdefghijklmnopqrstuvwxyz");
    assert.throws(() => s.create({ title: "ok", source: secret }), /refusing to store/);
    s.close();
  });
});
