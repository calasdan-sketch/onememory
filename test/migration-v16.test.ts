// Schema v16 (2.0.0): automatic memory. Upgrade from the real v15 shape (plain and encrypted), one pre-upgrade backup,
// idempotent reopen, ordinary reads still see notes only, the no-migrate open used by the hooks, and the raw-event TTL.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Store, SCHEMA_VERSION, SchemaMismatchError } from "../src/store.js";
import { ensureKey } from "../src/crypto.js";
import { downgradeTo } from "./legacy-db.js";

function quietly<T>(fn: () => T): T {
  const real = console.error;
  console.error = () => {};
  try {
    return fn();
  } finally {
    console.error = real;
  }
}

const cols = (path: string, table: string): string[] => {
  const raw = new DatabaseSync(path, { readOnly: true });
  try {
    return (raw.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((r) => r.name);
  } finally {
    raw.close();
  }
};

for (const encrypted of [false, true]) {
  describe(`schema v15 -> v16${encrypted ? " (encrypted store)" : ""}`, () => {
    function legacy(): { dir: string; path: string } {
      const dir = mkdtempSync(join(tmpdir(), "om-mig16-"));
      if (encrypted) ensureKey(dir);
      const path = join(dir, "state.db");
      const s = new Store(path);
      s.create({ title: "old one", body: "from before" });
      s.create({ title: "old two", body: "also before", tags: ["x"] });
      s.close();
      downgradeTo(path, 15);
      return { dir, path };
    }

    test("migrates, keeps every note as kind 'note', adds the tables, backs up once", () => {
      const { dir, path } = legacy();
      try {
        assert.equal(Store.peekSchemaVersion(path), 15);
        assert.ok(!cols(path, "notes").includes("kind"));
        const s = quietly(() => new Store(path));
        assert.equal(SCHEMA_VERSION, 16);
        assert.equal(Store.peekSchemaVersion(path), 16);
        assert.ok(existsSync(path + ".pre-v16-backup"));
        assert.equal(Store.peekSchemaVersion(path + ".pre-v16-backup"), 15);
        for (const c of ["kind", "session_id", "obs_type"]) assert.ok(cols(path, "notes").includes(c), c);
        assert.ok(cols(path, "capture_events").includes("output_enc"));
        assert.ok(cols(path, "sessions").includes("distilled_seq"));
        assert.ok(cols(path, "note_files").includes("action"));
        assert.ok(cols(path, "file_context_seen").includes("path"));
        const notes = s.list().notes;
        assert.deepEqual(notes.map((n) => n.title).sort(), ["old one", "old two"]);
        assert.ok(notes.every((n) => n.kind === undefined), "an ordinary note keeps its exact old shape");
        assert.equal(s.read(notes.find((n) => n.title === "old one")!.id)!.body, "from before");
        s.close();
        // Reopen: nothing to do, no second backup.
        const again = new Store(path);
        assert.equal(again.list().total, 2);
        again.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("captured rows stay out of every ordinary read unless asked for by kind", () => {
      const dir = mkdtempSync(join(tmpdir(), "om-mig16-k-"));
      try {
        if (encrypted) ensureKey(dir);
        const s = new Store(join(dir, "state.db"));
        s.create({ title: "plain note about parsers", body: "parsers" });
        const obs = s.create({ title: "Fixed the parsers bug", body: "parsers fixed" }, { kind: "observation", sessionId: "s1", obsType: "bugfix" });
        assert.equal(obs.kind, "observation");
        assert.equal(obs.session_id, "s1");
        assert.equal(obs.obs_type, "bugfix");
        assert.equal(s.list().total, 1);
        assert.equal(s.search("parsers").length, 1);
        assert.equal(s.list({ kinds: ["observation"] }).total, 1);
        assert.equal(s.list({ kinds: ["note", "observation"], sessionId: "s1" }).total, 1);
        assert.equal(s.list({ kinds: ["observation"], obsTypes: ["feature"] }).total, 0);
        assert.equal(s.searchRanked("parsers", { kinds: ["note", "observation"] }).length, 2);
        s.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
}

describe("no-migrate open (the capture hooks)", () => {
  test("refuses an older and a newer schema, opens the current one", () => {
    const dir = mkdtempSync(join(tmpdir(), "om-mig16-nm-"));
    try {
      const path = join(dir, "state.db");
      new Store(path).close();
      downgradeTo(path, 15);
      assert.throws(() => new Store(path, { noMigrate: true }), (e: unknown) => e instanceof SchemaMismatchError && e.found === 15);
      assert.equal(Store.peekSchemaVersion(path), 15, "a refused open did not migrate");
      quietly(() => new Store(path)).close();
      const raw = new DatabaseSync(path);
      raw.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
      raw.close();
      assert.throws(() => new Store(path, { noMigrate: true }), SchemaMismatchError);
      const raw2 = new DatabaseSync(path);
      raw2.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      raw2.close();
      new Store(path, { noMigrate: true }).close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("capture event retention", () => {
  test("sweepExpired deletes raw events older than ONEMEMORY_CAPTURE_RETENTION_DAYS", () => {
    const s = new Store(":memory:");
    const db = s.captureDb();
    const ins = db.prepare("INSERT INTO capture_events (session_id, at, event) VALUES (?, ?, 'post-tool')");
    ins.run("s", new Date(Date.now() - 10 * 86_400_000).toISOString());
    ins.run("s", new Date(Date.now() - 3 * 86_400_000).toISOString());
    ins.run("s", new Date().toISOString());
    s.sweepExpired();
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM capture_events").get() as { n: number }).n, 2);
    process.env.ONEMEMORY_CAPTURE_RETENTION_DAYS = "1";
    try {
      s.sweepExpired();
    } finally {
      delete process.env.ONEMEMORY_CAPTURE_RETENTION_DAYS;
    }
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM capture_events").get() as { n: number }).n, 1);
    s.close();
  });
});
