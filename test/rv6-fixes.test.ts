import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../src/store.js";
import { actorStore, cleanWriter } from "../src/actor.js";
import { createApiServer } from "../src/api.js";
import { putTask, claimTask } from "../src/tasks.js";
import { downgradeTo } from "./legacy-db.js";

const as = <T>(label: string, fn: () => T): T => actorStore.run({ label, authed: true }, fn);
const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "src", "cli.js");
const tmp = (p: string): string => mkdtempSync(join(tmpdir(), p));
function cli(home: string, args: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [CLI, ...args], { env: { ...process.env, ONEMEMORY_HOME: home, ONEMEMORY_TOKEN: "t".repeat(40), ...env }, encoding: "utf8" });
}
function quietly<T>(fn: () => T): { out: T; logged: string } {
  const orig = console.error;
  let logged = "";
  console.error = (...a: unknown[]) => {
    logged += a.join(" ") + "\n";
  };
  try {
    return { out: fn(), logged };
  } finally {
    console.error = orig;
  }
}
const rawCount = (db: string, sql = "SELECT COUNT(*) AS c FROM notes"): number => {
  const d = new DatabaseSync(db, { readOnly: true });
  try {
    return Number((d.prepare(sql).get() as { c: number }).c);
  } finally {
    d.close();
  }
};

describe("F1: one resolved namespace feeds the include_distrusted gate and the search (query + body)", () => {
  const OPTS = { namespace: "work", readsFrom: { work: ["shared"] } };
  const PIN = "p".repeat(32);
  let s: Store;
  let server: ReturnType<typeof createApiServer>;
  let base: string;
  beforeEach(async () => {
    s = new Store(":memory:");
    as("evil", () => s.create({ namespace: "shared", title: "SHAREDEVIL", body: "zebra" }));
    as("evil", () => s.create({ namespace: "work", title: "WORKEVIL", body: "zebra" }));
    s.distrustAdd("shared", "evil");
    s.distrustAdd("work", "evil");
    server = createApiServer(s, [{ token: PIN, scope: "admin", label: "pinadm", namespace: "work" }], OPTS);
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    s.close();
  });
  const post = (path: string, body: object) =>
    fetch(base + path, { method: "POST", headers: { Authorization: `Bearer ${PIN}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });

  // [query string, body, expected status, must contain, must not contain]
  const table: Array<[string, Record<string, unknown>, number, RegExp | null, RegExp | null]> = [
    ["?namespace=work", { message: "zebra", include_distrusted: true }, 200, /WORKEVIL/, /SHAREDEVIL/],
    ["", { message: "zebra", include_distrusted: true }, 403, /own namespace/, null],
    ["", { message: "zebra", include_distrusted: true, namespace: "shared" }, 403, /own namespace/, null],
    ["?namespace=work", { message: "zebra", include_distrusted: true, namespace: "shared" }, 403, /own namespace/, null],
    ["?namespace=shared", { message: "zebra", include_distrusted: true, namespace: "work" }, 200, /WORKEVIL/, /SHAREDEVIL/],
    ["?namespace=shared", { message: "zebra", include_distrusted: true }, 403, /own namespace/, null],
    ["", { message: "zebra", include_distrusted: true, namespace: "work" }, 200, /WORKEVIL/, /SHAREDEVIL/],
    ["?namespace=work&include_distrusted=1", { message: "zebra" }, 200, /WORKEVIL/, /SHAREDEVIL/],
    ["?include_distrusted=1", { message: "zebra", namespace: "work" }, 403, /own namespace/, null],
  ];
  for (const [q, body, status, has, not] of table) {
    test(`POST /relevant${q} ${JSON.stringify(body)} -> ${status}`, async () => {
      const r = await post("/relevant" + q, body);
      const t = await r.text();
      assert.equal(r.status, status, t);
      if (has) assert.match(t, has);
      if (not) assert.doesNotMatch(t, not);
    });
  }
  test("without the opt-in nothing distrusted shows on any shape", async () => {
    for (const q of ["", "?namespace=work", "?namespace=shared"]) {
      const t = await (await post("/relevant" + q, { message: "zebra" })).text();
      assert.doesNotMatch(t, /EVIL/, q);
    }
  });
  test("/ack gates on the same (query) namespace it reads", async () => {
    assert.equal((await post("/ack?namespace=shared", { ack_token: "x", include_distrusted: true })).status, 403);
    assert.equal((await post("/ack", { ack_token: "x", include_distrusted: true })).status, 403);
  });
});

describe("F2/F4: label cleaning is idempotent and applies to rows stored by 1.4.1", () => {
  test("cleanWriter(cleanWriter(x)) === cleanWriter(x) on random strings built from tricky characters", () => {
    const pool = ["e", "a", "\u200b", "\u0301", "\u00e9", "\u2122", "\u200d", "\u{1F468}", "\u{1F4BB}", " ", "\u00ad", "\ufb01", "\ufeff", "\u0308", "\uff21", "\n"];
    let seed = 12345;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let i = 0; i < 30000; i++) {
      let x = "";
      for (let j = 0, n = 1 + Math.floor(rnd() * 8); j < n; j++) x += pool[Math.floor(rnd() * pool.length)];
      const once = cleanWriter(x);
      assert.equal(cleanWriter(once), once, JSON.stringify(x));
    }
  });

  test("a rule on 'e + zero-width + combining accent' matches the label however it is typed; emoji ZWJ and the trademark sign too", () => {
    const s = new Store(":memory:");
    for (const label of ["e\u200b\u0301vil", "\u{1F468}\u200d\u{1F4BB} dev", "Dan\u2122 bot"]) {
      as(label, () => s.create({ title: `by ${label}`, body: "x" }));
    }
    as("good", () => s.create({ title: "plain", body: "x" }));
    assert.equal(s.list().notes.length, 4);
    for (const rule of ["e\u200b\u0301vil", "\u00e9vil", "\u{1F468}\u200d\u{1F4BB} dev", "\u{1F468}\u{1F4BB} dev", "Dan\u2122 bot", "DanTM bot"]) s.distrustAdd("*", rule);
    assert.deepEqual(s.list().notes.map((n) => n.title), ["plain"]);
    s.close();
  });

  test("the one-time migration re-writes stored labels, taint sets and rules written by 1.4.1, then stays quiet", () => {
    const dir = tmp("om-rv6-lab-");
    try {
      const path = join(dir, "state.db");
      let s = new Store(path);
      as("good", () => s.create({ title: "fine", body: "x" }));
      const bad = as("seed", () => s.create({ title: "old evil", body: "x" }));
      s.close();
      const d = new DatabaseSync(path);
      const raw = "Dan\u2122 bot";
      d.prepare("UPDATE notes SET written_by = ?, created_by = ?, imported_written_by = ?, merged_from_writers = ? WHERE id = ?").run(raw, raw, "e\u200b\u0301vil", JSON.stringify([raw, "ok"]), bad.id);
      d.prepare("UPDATE change_log SET written_by = ?, note_written_by = ? WHERE note_id = ?").run(raw, raw, bad.id);
      for (const w of [raw, "DanTM bot"]) d.prepare("INSERT INTO trust_distrust (namespace, writer, added_at, added_by) VALUES ('*', ?, 'now', 'x')").run(w);
      d.exec("DELETE FROM _meta WHERE key = 'labels_clean_v1'");
      d.close();

      s = new Store(path);
      const hidden = s.list().notes.map((n) => n.title);
      assert.deepEqual(hidden, ["fine"], "the rule typed for the old label hides the old note again");
      s.close();
      const v = new DatabaseSync(path, { readOnly: true });
      const row = v.prepare("SELECT written_by, created_by, imported_written_by, merged_from_writers FROM notes WHERE id = ?").get(bad.id) as Record<string, string>;
      assert.equal(row.written_by, "DanTM bot");
      assert.equal(row.created_by, "DanTM bot");
      assert.equal(row.imported_written_by, "\u00e9vil");
      assert.deepEqual(JSON.parse(row.merged_from_writers), ["DanTM bot", "ok"]);
      assert.equal((v.prepare("SELECT written_by AS w FROM change_log WHERE note_id = ? AND written_by <> '' LIMIT 1").get(bad.id) as { w: string }).w, "DanTM bot");
      assert.equal(Number((v.prepare("SELECT COUNT(*) AS c FROM trust_distrust").get() as { c: number }).c), 1, "the two spellings of one rule became one");
      assert.equal((v.prepare("SELECT value AS c FROM _meta WHERE key = 'labels_clean_v1'").get() as { c: string }).c, "1");
      v.close();
      const again = quietly(() => new Store(path));
      again.out.close();
      assert.equal(again.logged, "");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("F3: import --file is all-or-nothing on a bad file and reports clearly on a later failure", () => {
  const noteJson = (i: number, extra: Record<string, unknown> = {}) => ({ title: `note ${i}`, body: `body ${i}`, tags: ["t"], created_at: new Date(1_700_000_000_000 + i * 1000).toISOString(), ...extra });
  function setup(): { home: string; db: string; file: string } {
    const home = tmp("om-rv6-imp-");
    return { home, db: join(home, "state.db"), file: join(home, "in.json") };
  }
  const count = (db: string): number => (existsSync(db) ? rawCount(db) : 0);

  test("a file cut in the middle imports NOTHING and says so", () => {
    const { home, db, file } = setup();
    try {
      const full = JSON.stringify({ notes: Array.from({ length: 1200 }, (_, i) => noteJson(i)) });
      writeFileSync(file, full.slice(0, Math.floor(full.length * 0.8)));
      const r = cli(home, ["import", "--file", file]);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /Nothing was imported/);
      assert.match(r.stderr, /truncated/);
      assert.equal(count(db), 0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("trailing garbage, a non-text title, nested tags, too many tags and absurd nesting all import nothing, with a readable error", () => {
    const { home, db, file } = setup();
    try {
      const good = Array.from({ length: 600 }, (_, i) => noteJson(i));
      let deep = "1";
      for (let i = 0; i < 100; i++) deep = `[${deep}]`;
      const cases: Array<[string, string, RegExp]> = [
        ["trailing garbage", JSON.stringify({ notes: good }) + "garbage{{{", /truncated|JSON/],
        ["numeric title", JSON.stringify({ notes: [...good, noteJson(601, { title: 42 })] }), /note #601: "title" must be text \(found number\)/],
        ["nested tags", JSON.stringify({ notes: [...good, noteJson(601, { tags: [["a"]] })] }), /note #601: tag 1 must be text \(found a nested list\)/],
        ["tags not a list", JSON.stringify({ notes: [noteJson(1, { tags: "x" })] }), /"tags" must be a list/],
        ["too many tags", JSON.stringify({ notes: [noteJson(1, { tags: Array.from({ length: 5000 }, (_, i) => `t${i}`) })] }), /"tags" has 5000 entries/],
        ["deep nesting", `{"notes":[{"title":"x","body":"y","extra":${deep}}]}`, /nested more than 64 levels/],
      ];
      for (const [name, text, re] of cases) {
        writeFileSync(file, text);
        const r = cli(home, ["import", "--file", file]);
        assert.equal(r.status, 1, name);
        assert.match(r.stderr, re, name);
        assert.match(r.stderr, /Nothing was imported/, name);
        assert.doesNotMatch(r.stderr, /at .*\.js:\d+/, `${name}: no stack trace`);
        assert.equal(count(db), 0, name);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a valid file imports; entries that are not notes are reported; a re-run with --dedupe adds nothing", () => {
    const { home, db, file } = setup();
    try {
      writeFileSync(file, JSON.stringify({ notes: [noteJson(1), "stray", noteJson(2), null] }));
      const r = cli(home, ["import", "--file", file]);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /Imported 2 note\(s\)/);
      assert.match(r.stdout, /2 entries in the file were not a note/);
      const again = cli(home, ["import", "--file", file, "--dedupe"]);
      assert.match(again.stdout, /Imported 0 note\(s\), skipped 2 already present/);
      assert.equal(count(db), 2);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a failure in a later batch reports N imported / M not, and a --dedupe re-run finishes the job without duplicates", () => {
    const { home, db, file } = setup();
    try {
      new Store(db).close();
      const d = new DatabaseSync(db);
      d.exec("CREATE TRIGGER boom BEFORE INSERT ON notes WHEN new.title = 'BOOM' BEGIN SELECT RAISE(ABORT, 'disk on fire'); END;");
      d.close();
      const list = Array.from({ length: 700 }, (_, i) => noteJson(i, i === 650 ? { title: "BOOM" } : {}));
      writeFileSync(file, JSON.stringify({ notes: list }));
      const r = cli(home, ["import", "--file", file]);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /disk on fire/);
      assert.match(r.stderr, /500 note\(s\) were imported before the error, 200 were not/);
      assert.match(r.stderr, /--dedupe/);
      assert.equal(count(db), 500);
      const d2 = new DatabaseSync(db);
      d2.exec("DROP TRIGGER boom");
      d2.close();
      const fin = cli(home, ["import", "--file", file, "--dedupe"]);
      assert.equal(fin.status, 0, fin.stderr);
      assert.match(fin.stdout, /Imported 200 note\(s\), skipped 500 already present/);
      assert.equal(count(db), 700);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("F5/F6/F7: rotation order, claim message, expiry wording", () => {
  let dir: string;
  let s: Store;
  beforeEach(() => {
    dir = tmp("om-rv6-key-");
    s = new Store(join(dir, "state.db"));
  });
  afterEach(() => {
    try {
      s.close();
    } catch {
      /* closed */
    }
    rmSync(dir, { recursive: true, force: true });
  });
  const retired = (id: string): number => rawCount(join(dir, "state.db"), `SELECT COUNT(*) AS c FROM trust_attesters WHERE key_id = '${id}'`);

  test("if the audit write fails AFTER the key file was swapped, the retired public key is still recorded and the rotation stands", () => {
    const old = s.identity();
    (s as any).logTrust = () => {
      throw new Error("disk full");
    };
    const r = quietly(() => s.rotateSigningKey());
    assert.match(r.logged, /WAS rotated/);
    assert.equal(r.out.old_key_id, old.key_id);
    assert.equal(retired(old.key_id), 1, "the old public key survived");
    assert.notEqual(s.identity().key_id, old.key_id, "the new key is live");
    assert.equal(r.out.old_public_key, old.public_key);
  });

  test("if the key file swap fails, the old key stays in use and no retired row is left behind", () => {
    const old = s.identity();
    writeFileSync(join(dir, `.attest-key.${old.key_id}.old`), "in the way");
    assert.throws(() => s.rotateSigningKey({ keepOldPrivate: true }));
    assert.equal(s.identity().key_id, old.key_id);
    assert.equal(retired(old.key_id), 0);
    assert.equal(readdirSync(dir).filter((f) => f.endsWith(".new")).length, 0, "no temp key left");
  });

  test("a rotation by another process is picked up (the stamp cached is the one read before the key)", () => {
    const first = s.identity();
    const other = new Store(join(dir, "state.db"));
    const r = other.rotateSigningKey();
    other.close();
    assert.equal(s.identity().key_id, r.new_key_id);
    assert.notEqual(r.new_key_id, first.key_id);
    assert.equal(s.identity().key_id, r.new_key_id, "and it stays");
  });

  test("a distrusted writer claiming a task is told it may not CLAIM it", () => {
    const t = as("alice", () => putTask(s, { title: "a task" })).task;
    s.distrustAdd("default", "evil");
    assert.throws(() => as("evil", () => claimTask(s, { id: t.id, owner: "evil" })), /may not claim task #\d+/);
    assert.doesNotThrow(() => as("alice", () => claimTask(s, { id: t.id, owner: "alice" })));
  });

  test("the not_after wording in docs and help says the key is believed for nothing afterwards", () => {
    const root = join(HERE, "..", "..");
    const trust = readFileSync(join(root, "docs", "trust.md"), "utf8");
    assert.doesNotMatch(trust, /trusts a key only for exports it signed up to that/);
    assert.match(trust, /not believed for anything, old exports included/);
    const help = cli(dir, ["trust", "help"]);
    assert.match(help.stdout + help.stderr, /believed for nothing, old exports too/);
  });
});

describe("RV6-b: the pre-upgrade copy is required, read-only directories get a readable error, bad copies are handled with care", () => {
  const savedFree = Store.freeBytes;
  const savedEnv = process.env.ONEMEMORY_SKIP_PREMIGRATION_BACKUP;
  afterEach(() => {
    Store.freeBytes = savedFree;
    if (savedEnv === undefined) delete process.env.ONEMEMORY_SKIP_PREMIGRATION_BACKUP;
    else process.env.ONEMEMORY_SKIP_PREMIGRATION_BACKUP = savedEnv;
  });
  function legacy(): { dir: string; path: string } {
    const dir = tmp("om-rv6-bak-");
    const path = join(dir, "state.db");
    const s = new Store(path);
    as("alice", () => s.create({ title: "old one", body: "from before" }));
    as("bob", () => s.create({ title: "old two", body: "also before" }));
    s.close();
    downgradeTo(path, 13);
    return { dir, path };
  }

  test("with no room for the copy the upgrade does NOT run; ONEMEMORY_SKIP_PREMIGRATION_BACKUP=1 upgrades without one", () => {
    const { dir, path } = legacy();
    try {
      Store.freeBytes = () => 0;
      assert.throws(() => quietly(() => new Store(path)), /was not upgraded.*not enough free disk space.*ONEMEMORY_SKIP_PREMIGRATION_BACKUP=1/s);
      assert.equal(Store.peekSchemaVersion(path), 13, "the database is untouched");
      assert.ok(!existsSync(path + ".pre-v14-backup"));
      process.env.ONEMEMORY_SKIP_PREMIGRATION_BACKUP = "1";
      const r = quietly(() => new Store(path));
      r.out.close();
      assert.match(r.logged, /WITHOUT a pre-upgrade copy/);
      assert.equal(Store.peekSchemaVersion(path), 14);
      assert.ok(!existsSync(path + ".pre-v14-backup"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an existing copy that cannot be opened is moved aside, never deleted; an empty or garbage one is replaced", () => {
    for (const kind of ["unreadable", "empty", "garbage"] as const) {
      const { dir, path } = legacy();
      try {
        const bak = path + ".pre-v14-backup";
        if (kind === "unreadable") {
          mkdirSync(bak); // stands in for a file this user may not open (running as root, permissions cannot be used)
          writeFileSync(join(bak, "precious"), "x");
        } else writeFileSync(bak, kind === "empty" ? "" : "this is not a database at all, just text".repeat(50));
        const r = quietly(() => new Store(path));
        r.out.close();
        assert.ok(Store.verifyBackupFile(bak).ok, `${kind}: a fresh valid copy is in place`);
        const kept = readdirSync(dir).filter((f) => /^state\.db\.pre-v14-backup-\d{8}-\d{6}/.test(f));
        if (kind === "unreadable") {
          assert.equal(kept.length, 1, "moved aside");
          assert.ok(existsSync(join(dir, kept[0], "precious")));
          assert.match(r.logged, /could not be checked/);
        } else {
          assert.equal(kept.length, 0, `${kind}: nothing worth keeping`);
          assert.match(r.logged, /not usable/);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  test("verifyBackupFile classifies what it cannot use", () => {
    const dir = tmp("om-rv6-vf-");
    try {
      writeFileSync(join(dir, "empty"), "");
      writeFileSync(join(dir, "junk"), "not a database ".repeat(100));
      mkdirSync(join(dir, "adir"));
      const kind = (n: string) => {
        const r = Store.verifyBackupFile(join(dir, n));
        return r.ok ? "ok" : r.kind;
      };
      assert.equal(kind("empty"), "empty");
      assert.equal(kind("junk"), "garbage");
      assert.equal(kind("adir"), "unreadable");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an existing database whose directory cannot take the WAL files gets the readable message", () => {
    const dir = tmp("om-rv6-ro-");
    try {
      const path = join(dir, "state.db");
      const s = new Store(path);
      as("a", () => s.create({ title: "n", body: "b" }));
      s.close();
      for (const f of ["state.db-wal", "state.db-shm"]) rmSync(join(dir, f), { force: true });
      mkdirSync(join(dir, "state.db-wal")); // SQLite cannot create its WAL file here: what a read-only mount does to an existing database
      assert.throws(() => new Store(path), /cannot write to its data directory/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("docs: no 'refuses to start' without the env override, no stale --prune, the dated copies are named", () => {
    const root = join(HERE, "..", "..");
    const up = readFileSync(join(root, "docs", "upgrading.md"), "utf8");
    assert.match(up, /ONEMEMORY_SKIP_PREMIGRATION_BACKUP/);
    assert.doesNotMatch(up, /refuses to start/);
    assert.doesNotMatch(readFileSync(join(root, "docs", "trust.md"), "utf8"), /refuses to start/);
    assert.doesNotMatch(readFileSync(join(root, "docs", "file-sync.md"), "utf8"), /with `--prune`/);
    const help = cli(tmp("om-rv6-h-"), ["help"]);
    assert.match(help.stdout, /dated copies/);
    void statSync;
  });
});
