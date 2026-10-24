// Retention: per-note TTL (forget_after -> expires_at), the expiry sweep,
// soft-archive/restore, and the guarantee that archived notes drop out of
// list/search/recall but stay on disk and are restorable.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, retentionDeadline } from "../src/store.js";
import { runSearch } from "../src/search-service.js";

const DAY_MS = 86_400_000;

/** Fresh temp store per test; encryption key deliberately absent (plaintext). */
function freshStore(): { store: Store; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "om-retention-"));
  const saved = process.env.ONEMEMORY_KEY_FILE;
  process.env.ONEMEMORY_KEY_FILE = join(dir, "no-such-key");
  const store = new Store(join(dir, "state.db"));
  // Restore env immediately; the Store already captured its key state.
  if (saved === undefined) delete process.env.ONEMEMORY_KEY_FILE;
  else process.env.ONEMEMORY_KEY_FILE = saved;
  return { store, dir };
}

function cleanup(dir: string, store: Store): void {
  store.close();
  rmSync(dir, { recursive: true, force: true });
}

describe("retention: retentionDeadline()", () => {
  test("computes an absolute deadline N days out", () => {
    const from = "2026-01-01T00:00:00.000Z";
    const d = retentionDeadline(7, from);
    assert.equal(d, "2026-01-08T00:00:00.000Z");
  });

  test("0 / negative / NaN / undefined mean no TTL", () => {
    assert.equal(retentionDeadline(0), null);
    assert.equal(retentionDeadline(-1), null);
    assert.equal(retentionDeadline(Number.NaN), null);
    assert.equal(retentionDeadline(undefined), null);
  });

  test("absurdly large values are capped, never producing Invalid Date", () => {
    const d = retentionDeadline(1e15, "2026-01-01T00:00:00.000Z");
    assert.ok(d, "must still produce a deadline");
    assert.ok(Number.isFinite(Date.parse(d!)), "deadline must parse as a date");
  });
});

describe("retention: TTL on write + sweep", () => {
  test("forget_after sets expires_at; sweep archives it once past due", () => {
    const { store, dir } = freshStore();
    try {
      const note = store.create({ title: "temp", body: "b", forget_after: 1 });
      assert.ok(note.expires_at, "expires_at is set");
      assert.equal(note.archived_at, undefined, "fresh note is not archived");

      // Not yet due: sweep archives nothing.
      assert.equal(store.sweepExpired(Date.now()), 0);
      assert.equal(store.read(note.id)!.archived_at, undefined);

      // Past due: sweep archives it (relative to a future clock).
      const n = store.sweepExpired(Date.now() + 2 * DAY_MS);
      assert.equal(n, 1);
      const after = store.read(note.id)!;
      assert.ok(after.archived_at, "archived_at set by sweep");
    } finally {
      cleanup(dir, store);
    }
  });

  test("sweep is idempotent (does not re-archive or double-count)", () => {
    const { store, dir } = freshStore();
    try {
      const note = store.create({ title: "t", body: "b", forget_after: 1 });
      const future = Date.now() + 3 * DAY_MS;
      assert.equal(store.sweepExpired(future), 1);
      assert.equal(store.sweepExpired(future), 0, "second sweep finds nothing new");
    } finally {
      cleanup(dir, store);
    }
  });

  test("a note with no TTL is never swept", () => {
    const { store, dir } = freshStore();
    try {
      const note = store.create({ title: "keep", body: "b" });
      assert.equal(note.expires_at, undefined);
      assert.equal(store.sweepExpired(Date.now() + 3650 * DAY_MS), 0);
      assert.equal(store.read(note.id)!.archived_at, undefined);
    } finally {
      cleanup(dir, store);
    }
  });

  test("update can set, reset and clear the TTL", () => {
    const { store, dir } = freshStore();
    try {
      const note = store.create({ title: "t", body: "b" });
      assert.equal(note.expires_at, undefined, "no TTL initially");

      const withTtl = store.update(note.id, { forget_after: 5 })!;
      assert.ok(withTtl.expires_at, "update can add a TTL");

      // Omitting forget_after preserves the existing deadline.
      const preserved = store.update(note.id, { tags: ["x"] })!;
      assert.equal(preserved.expires_at, withTtl.expires_at, "deadline preserved when forget_after omitted");

      // forget_after: 0 clears it. The record then matches the "no TTL"
      // shape exactly (expires_at omitted, not null) -- a cleared TTL and a
      // never-set TTL are indistinguishable to callers, by design.
      const cleared = store.update(note.id, { forget_after: 0 })!;
      assert.equal(cleared.expires_at, undefined, "forget_after: 0 clears the TTL");
    } finally {
      cleanup(dir, store);
    }
  });
});

describe("retention: archive / restore", () => {
  test("archive hides a note from list and search; restore brings it back", async () => {
    const { store, dir } = freshStore();
    try {
      const note = store.create({ title: "findme distinctive", body: " searchable body" });

      // Visible before archive.
      assert.equal(store.list({}).notes.some((n) => n.id === note.id), true);
      assert.equal((await runSearch(store, "distinctive")).some((n) => n.id === note.id), true);

      store.archive(note.id);
      assert.ok(store.read(note.id)!.archived_at, "archived_at set");
      assert.equal(store.list({}).notes.some((n) => n.id === note.id), false, "hidden from list");
      assert.equal((await runSearch(store, "distinctive")).some((n) => n.id === note.id), false, "hidden from search");

      // Still on disk (reversible).
      assert.ok(store.read(note.id), "note still readable directly");

      store.restore(note.id);
      assert.equal(store.read(note.id)!.archived_at, undefined, "archived_at cleared");
      assert.equal(store.list({}).notes.some((n) => n.id === note.id), true, "back in list");
      assert.equal((await runSearch(store, "distinctive")).some((n) => n.id === note.id), true, "back in search");
    } finally {
      cleanup(dir, store);
    }
  });

  test("list surfaces archived notes only when asked", () => {
    const { store, dir } = freshStore();
    try {
      const live = store.create({ title: "live", body: "b" });
      const gone = store.create({ title: "gone", body: "b" });
      store.archive(gone.id);

      const def = store.list({});
      assert.deepEqual(
        def.notes.map((n) => n.id).sort(),
        [live.id],
        "default list excludes archived"
      );

      const all = store.list({ includeArchived: true });
      assert.equal(all.notes.length, 2, "includeArchived shows both");

      const only = store.list({ archivedOnly: true });
      assert.deepEqual(only.notes.map((n) => n.id), [gone.id], "archivedOnly shows just the archive");
    } finally {
      cleanup(dir, store);
    }
  });

  test("archived note is excluded from semantic/vector search too", () => {
    const { store, dir } = freshStore();
    try {
      const note = store.create({ title: "vec", body: "b" });
      const vec = new Float32Array([1, 0, 0]);
      store.setVector(note.id, vec, "test-model");

      const before = store.semanticSearch(vec, {});
      assert.equal(before.some((h) => h.note.id === note.id), true);

      store.archive(note.id);
      const after = store.semanticSearch(vec, {});
      assert.equal(
        after.some((h) => h.note.id === note.id),
        false,
        "archived note must not resurface via vector search"
      );
    } finally {
      cleanup(dir, store);
    }
  });
});
