// Schema v14 (1.4.0): upgrade from the real v11, v12 and v13 shapes (plain and
// encrypted), the one pre-upgrade backup, idempotent reopen, rollback.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync, copyFileSync, readdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { Store, SCHEMA_VERSION } from "../src/store.js";
import { ensureKey } from "../src/crypto.js";
import { actorStore } from "../src/actor.js";
import { putTask } from "../src/tasks.js";
import { downgradeTo } from "./legacy-db.js";

const as = <T>(label: string, fn: () => T): T => actorStore.run({ label, authed: true }, fn);
const HOUR_AGO = (): string => new Date(Date.now() - 3600_000).toISOString();

function quietly<T>(fn: () => T): { out: T; logged: string[] } {
  const real = console.error;
  const logged: string[] = [];
  console.error = (...a: unknown[]) => void logged.push(a.join(" "));
  try {
    return { out: fn(), logged };
  } finally {
    console.error = real;
  }
}

const tables = (path: string): string[] => {
  const raw = new DatabaseSync(path, { readOnly: true });
  try {
    return (raw.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','index','trigger')").all() as Array<{ name: string }>).map((r) => r.name);
  } finally {
    raw.close();
  }
};
const cols = (path: string, table: string): string[] => {
  const raw = new DatabaseSync(path, { readOnly: true });
  try {
    return (raw.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((r) => r.name);
  } finally {
    raw.close();
  }
};

for (const encrypted of [false, true]) {
  for (const from of [11, 12, 13] as const) {
    describe(`schema v${from} -> v14${encrypted ? " (encrypted store)" : ""}`, () => {
      function legacy(): { dir: string; path: string } {
        const dir = mkdtempSync(join(tmpdir(), "om-mig14-"));
        if (encrypted) ensureKey(dir);
        const path = join(dir, "state.db");
        const s = new Store(path);
        as("alice", () => s.create({ title: "old one", body: "from before", source: "claude-code" }));
        as("bob", () => s.create({ title: "old two", body: "also before", tags: ["x"] }));
        as("alice", () => putTask(s, { title: "an old task" }));
        s.close();
        downgradeTo(path, from);
        return { dir, path };
      }

      test("opens, migrates to the current version, keeps every row and takes one backup at the old version", () => {
        const { dir, path } = legacy();
        try {
          assert.equal(Store.peekSchemaVersion(path), from);
          const { out: s, logged } = quietly(() => new Store(path));
          assert.equal(SCHEMA_VERSION, 15);
          assert.equal(Store.peekSchemaVersion(path), SCHEMA_VERSION);
          const bak = path + ".pre-v15-backup";
          assert.ok(existsSync(bak), "backup exists");
          assert.equal(Store.peekSchemaVersion(bak), from, "the backup is still at the OLD schema");
          assert.ok(logged.some((l) => l.includes(bak)), "the upgrade says where the copy is");
          const titles = s.list().notes.map((n) => n.title).sort();
          assert.deepEqual(titles, ["an old task", "old one", "old two"]);
          assert.equal(s.read(s.list().notes.find((n) => n.title === "old one")!.id)!.body, "from before", "bodies read back (decrypted when the store is encrypted)");
          const raw = new DatabaseSync(bak, { readOnly: true });
          assert.equal((raw.prepare("SELECT COUNT(*) AS n FROM notes").get() as any).n, 3);
          assert.equal((raw.prepare("PRAGMA integrity_check").get() as any).integrity_check, "ok");
          raw.close();
          s.close();
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      });

      test("the new columns, tables, index and triggers exist; old rows get empty trust facts", () => {
        const { dir, path } = legacy();
        try {
          quietly(() => new Store(path)).out.close();
          const names = tables(path);
          for (const t of ["trust_distrust", "trust_attesters", "trust_log", "idx_change_log_writer", "notes_log_ad", "notes_log_ai", "notes_log_au"]) {
            assert.ok(names.includes(t), `${t} exists`);
          }
          for (const c of ["imported_created_by", "attested_writer", "attested_by", "merged_from_writers", "written_by", "created_by", "imported_written_by"]) {
            assert.ok(cols(path, "notes").includes(c), `notes.${c}`);
          }
          for (const c of ["note_written_by", "note_attested_writer", "note_attested_by", "note_merged_from", "written_by", "actor"]) {
            assert.ok(cols(path, "change_log").includes(c), `change_log.${c}`);
          }
          const s = new Store(path);
          for (const n of s.list().notes) {
            assert.equal(n.attested_writer, undefined);
            assert.equal(n.merged_from_writers, undefined);
            if (from < 13) assert.equal(n.written_by, "", "pre-v13 rows keep an unknown writer; nothing is guessed from `source`");
          }
          s.close();
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      });

      test("server_id is minted once and never changes; a reopen is a no-op and never replaces the backup", () => {
        const { dir, path } = legacy();
        try {
          const a = quietly(() => new Store(path)).out;
          const id = a.serverId();
          assert.match(id, /^[0-9a-f-]{36}$/);
          a.close();
          const bak = path + ".pre-v15-backup";
          writeFileSync(bak, "SENTINEL");
          const b = new Store(path);
          assert.equal(b.serverId(), id, "same id after reopen");
          b.close();
          assert.equal(readFileSync(bak, "utf8"), "SENTINEL", "the original copy is never overwritten");
          assert.equal(Store.peekSchemaVersion(path), SCHEMA_VERSION);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      });

      test("after the upgrade the new features work on the old rows (delete log, filters, distrust, export)", () => {
        const { dir, path } = legacy();
        try {
          const s = quietly(() => new Store(path)).out;
          const victim = s.list().notes.find((n) => n.title === "old two")!;
          as("carol", () => s.update(victim.id, { body: "edited after the upgrade" }));
          as("dave", () => s.delete(victim.id));
          const del = s.changes({ since: HOUR_AGO() }).changes.find((c) => c.kind === "deleted" && c.id === victim.id)!;
          assert.ok(del, "the delete is in the feed");
          assert.equal(del.written_by, "dave");
          assert.equal(del.note_written_by, "carol", "the delete row remembers the author");
          s.distrustAdd("*", "carol");
          assert.ok(!s.changes({ since: HOUR_AGO() }).changes.some((c) => c.id === victim.id), "a distrusted author's delete stays hidden");
          assert.ok(s.exportBatch(0, 100, { attest: true }).every((n) => n.attestation), "every note can be attested");
          s.close();
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      });

      test("rollback: the backup opens as the old schema; putting it back and upgrading again works", () => {
        const { dir, path } = legacy();
        try {
          quietly(() => new Store(path)).out.close();
          const bak = path + ".pre-v15-backup";
          // what the docs say: stop everything, put the copy back as the database
          copyFileSync(bak, path);
          for (const ext of ["-wal", "-shm"]) if (existsSync(path + ext)) rmSync(path + ext);
          assert.equal(Store.peekSchemaVersion(path), from);
          const raw = new DatabaseSync(path, { readOnly: true });
          assert.equal((raw.prepare("SELECT COUNT(*) AS n FROM notes").get() as any).n, 3);
          raw.close();
          // (an older release reads this file: it is exactly the file it wrote.) Upgrading again is fine:
          rmSync(bak);
          const again = quietly(() => new Store(path)).out;
          assert.equal(again.list().notes.length, 3);
          assert.equal(Store.peekSchemaVersion(path), SCHEMA_VERSION);
          again.close();
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      });
    });
  }
}

describe("schema v14: other upgrade safety", () => {
  test("an empty or brand-new database gets no backup; a newer database is refused", () => {
    const dir = mkdtempSync(join(tmpdir(), "om-mig14-new-"));
    try {
      const p = join(dir, "fresh.db");
      new Store(p).close();
      assert.ok(!existsSync(p + ".pre-v15-backup"));
      const raw = new DatabaseSync(p);
      raw.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
      raw.close();
      assert.throws(() => new Store(p), /newer than this build supports/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a second open of an already-upgraded file finds nothing left to do (same process)", () => {
    const dir = mkdtempSync(join(tmpdir(), "om-mig14-reopen-"));
    try {
      const path = join(dir, "state.db");
      const s = new Store(path);
      s.create({ title: "n", body: "b" });
      s.close();
      downgradeTo(path, 13);
      const { out } = quietly(() => {
        const one = new Store(path);
        const two = new Store(path);
        return [one, two];
      });
      assert.equal(out[0].serverId(), out[1].serverId());
      out.forEach((x) => x.close());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("two REAL processes opening the same old file at the same moment end up with one consistent upgrade", async () => {
    const dir = mkdtempSync(join(tmpdir(), "om-mig14-race-"));
    try {
      const path = join(dir, "state.db");
      const s = new Store(path);
      s.create({ title: "n", body: "b" });
      s.close();
      downgradeTo(path, 13);
      const storeUrl = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "store.js")).href;
      const code = `const {Store}=await import(${JSON.stringify(storeUrl)});const s=new Store(process.argv[1]);process.stdout.write(s.serverId());s.close();`;
      const run = (): Promise<{ code: number | null; out: string; err: string }> =>
        new Promise((resolve) => {
          const c = spawn(process.execPath, ["--input-type=module", "-e", code, path], { stdio: ["ignore", "pipe", "pipe"] });
          let out = "";
          let err = "";
          c.stdout.on("data", (d) => (out += d));
          c.stderr.on("data", (d) => (err += d));
          c.on("close", (code) => resolve({ code, out, err }));
        });
      const [a, b] = await Promise.all([run(), run()]);
      assert.equal(a.code, 0, a.err);
      assert.equal(b.code, 0, b.err);
      assert.equal(a.out, b.out, "both processes see the same server id");
      assert.equal(Store.peekSchemaVersion(path), SCHEMA_VERSION);
      assert.ok(Store.verifyBackupFile(path + ".pre-v15-backup").ok, "exactly one valid pre-upgrade copy");
      assert.deepEqual(readdirSync(dir).filter((f) => f.includes(".partial")), [], "no partial file is left behind");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a failed upgrade rolls back whole (nothing half-migrated)", () => {
    const dir = mkdtempSync(join(tmpdir(), "om-mig14-fail-"));
    try {
      const path = join(dir, "state.db");
      const s = new Store(path);
      s.create({ title: "n", body: "b" });
      s.close();
      downgradeTo(path, 13);
      // make the LAST statements of the v14 step fail: a table already holds the index's name
      const raw = new DatabaseSync(path);
      raw.exec("CREATE TABLE idx_change_log_writer (x INTEGER)");
      raw.close();
      assert.throws(() => quietly(() => new Store(path)));
      assert.equal(Store.peekSchemaVersion(path), 13, "still the old version");
      assert.ok(!cols(path, "notes").includes("attested_writer"), "no column was added");
      assert.ok(!tables(path).includes("trust_log"), "no table was added");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
