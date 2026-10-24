// 1.2.1 core fixes: retention data safety (janitor, export/import, restore),
// archived-note leaks, change feed for archive/restore, schema migration,
// import idempotency, input validation.
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Store, SCHEMA_VERSION, ValidationError, type ImportReport } from "../src/store.js";
import { autoConsolidate, consolidateNotes } from "../src/consolidate.js";

const raw = (s: Store): DatabaseSync => (s as unknown as { db: DatabaseSync }).db;
const DAY = 86_400_000;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "om-core121d-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("2: janitor never touches archived notes", () => {
  test("two identical notes, one archived: no merge, archive intact", () => {
    const s = new Store(":memory:");
    const a = s.create({ title: "dup note", body: "exactly the same text about gardening tomatoes" });
    const b = s.create({ title: "dup note", body: "exactly the same text about gardening tomatoes" });
    s.archive(a.id);
    const r = autoConsolidate(s);
    assert.equal(r.merged.length, 0);
    assert.ok(s.read(a.id)!.archived_at, "archived original still there and archived");
    assert.ok(s.read(b.id));
    assert.equal(s.list({ archivedOnly: true }).total, 1);
    s.close();
  });

  test("manual consolidation refuses archived ids", () => {
    const s = new Store(":memory:");
    const a = s.create({ title: "x", body: "alpha beta gamma" });
    const b = s.create({ title: "x", body: "alpha beta gamma" });
    s.archive(b.id);
    assert.throws(() => consolidateNotes(s, [a.id, b.id]), /archived/);
    s.close();
  });

  test("a merge keeps a TTL only when every source had one (the latest)", () => {
    const s = new Store(":memory:");
    const a = s.create({ title: "t", body: "same body words here", forget_after: 10 });
    const b = s.create({ title: "t", body: "same body words here", forget_after: 30 });
    assert.ok(b.expires_at && a.expires_at && b.expires_at > a.expires_at);
    const m = consolidateNotes(s, [a.id, b.id]);
    assert.equal(m.expires_at, b.expires_at);
    const c = s.create({ title: "u", body: "other body text words", forget_after: 10 });
    const d = s.create({ title: "u", body: "other body text words" });
    const m2 = consolidateNotes(s, [c.id, d.id]);
    assert.equal(m2.expires_at, undefined, "a source without TTL keeps the merge forever");
    s.close();
  });
});

describe("3: export/import keeps archived_at and expires_at", () => {
  test("round trip through exportAll -> importNotes", async () => {
    const a = new Store(":memory:");
    const arch = a.create({ title: "forgotten", body: "gone", forget_after: 5 });
    a.archive(arch.id);
    const ttl = a.create({ title: "ttl", body: "expires", forget_after: 7 });
    const dump = a.exportAll();
    const b = new Store(":memory:");
    await b.importNotes(dump);
    const got = b.exportAll();
    const g1 = got.find((n) => n.title === "forgotten")!;
    const g2 = got.find((n) => n.title === "ttl")!;
    assert.ok(g1.archived_at, "archived stays archived");
    assert.equal(g1.expires_at, arch.expires_at);
    assert.equal(g2.expires_at, ttl.expires_at);
    assert.equal(b.list({}).total, 1, "archived note is hidden from default list");
    assert.equal(b.list({ archivedOnly: true }).total, 1);
    a.close();
    b.close();
  });

  test("garbage archived_at / expires_at are rejected, not silently dropped", async () => {
    const s = new Store(":memory:");
    const report: ImportReport = { quarantined: [], rejected: [] };
    const out = await s.importNotes(
      [
        { title: "bad archive", body: "b", archived_at: "not-a-date" },
        { title: "bad ttl", body: "b", expires_at: "tomorrow-ish" },
        { title: "fine", body: "b" },
      ],
      { report }
    );
    assert.equal(out.length, 1);
    assert.equal(report.rejected.length, 2);
    s.close();
  });
});

describe("import idempotency (opt-in dedupe)", () => {
  test("default import repeats; dedupe:true skips identical notes", async () => {
    const a = new Store(":memory:");
    for (let i = 0; i < 3; i++) a.create({ title: `n${i}`, body: `body ${i}` });
    const dump = a.exportAll();
    const b = new Store(":memory:");
    await b.importNotes(dump);
    await b.importNotes(dump);
    assert.equal(b.countAll(), 6, "default behaviour unchanged");
    const c = new Store(":memory:");
    const report: ImportReport = { quarantined: [], rejected: [] };
    await c.importNotes(dump, { dedupe: true, report });
    await c.importNotes(dump, { dedupe: true, report });
    assert.equal(c.countAll(), 3);
    assert.equal(report.skipped, 3);
    a.close();
    b.close();
    c.close();
  });
});

describe("restore of an expired note", () => {
  test("restore clears the old TTL so the next sweep does not re-archive it", () => {
    const s = new Store(":memory:");
    const n = s.create({ title: "t", body: "b", forget_after: 1 });
    assert.equal(s.sweepExpired(Date.now() + 2 * DAY), 1);
    const back = s.restore(n.id)!;
    assert.equal(back.archived_at, undefined);
    assert.equal(back.expires_at, undefined);
    assert.equal(s.sweepExpired(Date.now() + 2 * DAY), 0);
    s.close();
  });

  test("restore can take a fresh TTL", () => {
    const s = new Store(":memory:");
    const n = s.create({ title: "t", body: "b", forget_after: 1 });
    s.sweepExpired(Date.now() + 2 * DAY);
    const back = s.restore(n.id, { forget_after: 30 })!;
    assert.ok(back.expires_at && Date.parse(back.expires_at) > Date.now() + 29 * DAY);
    s.close();
  });
});

describe("4: archived notes do not leak", () => {
  test("neighbors, stats, stale count and the edge index skip archived notes", () => {
    const s = new Store(":memory:");
    const a = s.create({ title: "sourdough starter feeding", body: "feed the sourdough starter daily with flour and water" });
    const b = s.create({ title: "sourdough starter hydration", body: "sourdough starter hydration flour water ratio daily" });
    assert.ok(s.read(a.id, { withNeighbors: true })!.neighbors!.some((n) => n.id === b.id), "precondition: linked");
    s.archive(b.id);
    assert.equal(s.read(a.id, { withNeighbors: true })!.neighbors!.length, 0);
    assert.equal(s.listNeighbors(a.id).length, 0);
    const st = s.accessStats();
    assert.equal(st.totalNotes, 1);
    assert.ok(!st.mostAccessed.some((m) => m.id === b.id));
    assert.deepEqual(s.noteIdsMissingVectors(), [a.id]);
    // a new note must not be linked to the archived one via the edge index
    const c = s.create({ title: "sourdough starter troubleshooting", body: "sourdough starter flour water daily trouble" });
    assert.ok(!s.listNeighbors(c.id).some((n) => n.id === b.id));
    assert.ok(!raw(s).prepare("SELECT 1 FROM note_edges WHERE (note_id = ? AND neighbor_id = ?) OR (note_id = ? AND neighbor_id = ?)").get(c.id, b.id, b.id, c.id));
    s.close();
  });

  test("staleCount ignores archived notes", () => {
    const s = new Store(":memory:");
    const n = s.create({ title: "old", body: "b" });
    raw(s).prepare("UPDATE notes SET updated_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(n.id);
    assert.equal(s.staleCount(), 1);
    s.archive(n.id);
    assert.equal(s.staleCount(), 0);
    s.close();
  });
});

describe("5: archive/restore appear in the change feed", () => {
  test("archive and restore each add a feed event", () => {
    const s = new Store(":memory:");
    const n = s.create({ title: "t", body: "b" });
    const seq = () => (raw(s).prepare("SELECT MAX(seq) m FROM change_log").get() as { m: number }).m;
    const s0 = seq();
    s.archive(n.id);
    const s1 = seq();
    assert.ok(s1 > s0, "archive logged");
    s.restore(n.id);
    assert.ok(seq() > s1, "restore logged");
    const page = s.changes({ since: new Date(Date.now() - 60_000).toISOString() });
    assert.equal(page.changes.length, 1);
    s.close();
  });
});

describe("schema migration to v11 from 1.1.0 and 1.2.0 databases", () => {
  function downgrade(dbp: string, to: 9 | 10): void {
    const d = new DatabaseSync(dbp);
    d.exec(`
      DROP TRIGGER IF EXISTS notes_log_au;
      CREATE TRIGGER notes_log_au AFTER UPDATE ON notes
      WHEN (old.rev IS NOT new.rev OR old.title IS NOT new.title OR old.body IS NOT new.body
            OR old.tags IS NOT new.tags OR old.namespace IS NOT new.namespace
            OR old.source IS NOT new.source)
      BEGIN
        INSERT INTO change_log (note_id, kind, namespace, title, source, rev, changed_at)
        VALUES (new.id, 'updated', new.namespace, new.title, new.source, new.rev, strftime('%Y-%m-%dT%H:%M:%fZ','now'));
      END;
      ALTER TABLE quarantine DROP COLUMN sealed;
    `);
    if (to === 9) {
      d.exec("DROP INDEX idx_notes_archived; ALTER TABLE notes DROP COLUMN body_enc; ALTER TABLE notes DROP COLUMN expires_at; ALTER TABLE notes DROP COLUMN archived_at;");
    }
    d.exec(`PRAGMA user_version = ${to}`);
    d.close();
  }

  for (const from of [9, 10] as const) {
    test(`upgrades a v${from} database in place and keeps every note`, () => {
      const dbp = join(dir, `v${from}.db`);
      const s = new Store(dbp);
      for (let i = 0; i < 25; i++) s.create({ title: `note ${i}`, body: `body number ${i}` });
      s.close();
      downgrade(dbp, from);
      const t = new Store(dbp);
      assert.equal(raw(t).prepare("PRAGMA user_version").get()!.user_version, SCHEMA_VERSION);
      assert.equal(t.countAll(), 25);
      assert.equal(t.search("body number 7").length >= 1, true);
      const cols = (raw(t).prepare("PRAGMA table_info(quarantine)").all() as Array<{ name: string }>).map((c) => c.name);
      assert.ok(cols.includes("sealed"));
      // the new trigger is active
      const id = t.list({}).notes[0].id;
      t.archive(id);
      const last = raw(t).prepare("SELECT kind FROM change_log ORDER BY seq DESC LIMIT 1").get() as { kind: string };
      assert.equal(last.kind, "updated");
      assert.equal((raw(t).prepare("PRAGMA integrity_check").get() as Record<string, string>).integrity_check, "ok");
      t.close();
    });
  }
});

describe("forget_after validation", () => {
  test("negative, NaN, Infinity and strings are rejected at the store", () => {
    const s = new Store(":memory:");
    for (const bad of [-3, Number.NaN, Infinity, "x" as unknown as number]) {
      assert.throws(() => s.create({ title: "t", body: "b", forget_after: bad }), ValidationError, String(bad));
    }
    assert.doesNotThrow(() => s.create({ title: "t", body: "b", forget_after: 0 }));
    s.close();
  });
});
