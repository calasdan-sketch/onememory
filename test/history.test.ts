// Note history, restore, confidence, export/import and the schema v15 migration (1.6.0).
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Store, SCHEMA_VERSION, ValidationError, StaleWriteError, historyLimits, validateConfidence, type NoteRecord } from "../src/store.js";
import { ensureKey } from "../src/crypto.js";
import { actorStore } from "../src/actor.js";
import { SupersedeError, noteHistory, restoreVersion, purgeNoteHistory, supersedePreview, supersedeConfirm, type Caller } from "../src/supersede.js";
import { runSearch } from "../src/search-service.js";
import { downgradeTo } from "./legacy-db.js";

const as = <T>(label: string, fn: () => T): T => actorStore.run({ label, authed: true }, fn);
const admin = (label: string): Caller => ({ scope: "admin", writer: label });
const write = (label: string): Caller => ({ scope: "write", writer: label });

let store: Store;
beforeEach(() => {
  store = new Store(":memory:");
});
afterEach(() => {
  for (const k of ["ONEMEMORY_HISTORY_VERSIONS", "ONEMEMORY_HISTORY_MAX_BYTES"]) delete process.env[k];
});

const edit = (who: string, id: number, body: string): NoteRecord => as(who, () => store.update(id, { body }))!;
const make = (who: string, title: string, body: string, extra: Record<string, unknown> = {}): NoteRecord => as(who, () => store.create({ title, body, ...extra }));

describe("history is kept on every edit", () => {
  test("an edit keeps the text it replaces, with the writer and the time", () => {
    const n = make("alice", "t", "v1");
    edit("bob", n.id, "v2");
    edit("bob", n.id, "v3");
    const h = store.historyOf(n.id);
    assert.deepEqual(h.map((e) => [e.version, e.body, e.written_by]), [[2, "v2", "bob"], [1, "v1", "alice"]]);
    assert.equal(h[0].saved_by, "bob");
    assert.equal(h[0].reason, "update");
    assert.ok(h[0].saved_at.startsWith("20"));
  });

  test("a tag-only edit or a no-op edit does not add a version", () => {
    const n = make("alice", "t", "v1");
    as("alice", () => store.update(n.id, { tags: ["x"] }));
    as("alice", () => store.update(n.id, { body: "v1" }));
    assert.equal(store.historyCount(n.id), 0);
  });

  test("a stale edit that is refused keeps nothing", () => {
    const n = make("alice", "t", "v1");
    edit("bob", n.id, "v2");
    assert.throws(() => as("alice", () => store.update(n.id, { body: "late" }, { ifRev: 1 })), StaleWriteError);
    assert.equal(store.historyCount(n.id), 1);
    assert.equal(store.read(n.id)!.body, "v2");
  });

  test("history is bounded by the number of versions, and the original is never dropped", () => {
    process.env.ONEMEMORY_HISTORY_VERSIONS = "4";
    const n = make("alice", "t", "original");
    for (let i = 0; i < 30; i++) edit(i % 2 ? "bob" : "carol", n.id, `edit ${i}`);
    const h = store.historyOf(n.id);
    assert.ok(h.length <= 4, String(h.length));
    assert.equal(h[h.length - 1].body, "original", "the original text is still there");
    assert.equal(h[h.length - 1].written_by, "alice");
  });

  test("one writer flooding edits cannot push another writer's version out", () => {
    process.env.ONEMEMORY_HISTORY_VERSIONS = "5";
    const n = make("alice", "t", "alice's text");
    edit("bob", n.id, "bob's text");
    for (let i = 0; i < 40; i++) edit("mallory", n.id, `spam ${i}`);
    const bodies = store.historyOf(n.id).map((e) => e.body);
    assert.ok(bodies.includes("alice's text"));
    assert.ok(bodies.includes("bob's text"), bodies.join(" | "));
    assert.ok(bodies.length <= 5);
  });

  test("history is bounded by size too: huge bodies cannot grow the file without end", () => {
    process.env.ONEMEMORY_HISTORY_MAX_BYTES = "20000";
    const n = make("alice", "t", "x".repeat(9000));
    for (let i = 0; i < 12; i++) edit("bob", n.id, String(i).repeat(9000));
    const total = store.historyOf(n.id).reduce((a, e) => a + e.bytes, 0);
    assert.ok(total <= 20000 + 9100, String(total));
    assert.equal(store.historyOf(n.id).at(-1)!.body, "x".repeat(9000));
  });

  test("turning history off (0) keeps nothing new", () => {
    process.env.ONEMEMORY_HISTORY_VERSIONS = "0";
    const n = make("alice", "t", "v1");
    edit("bob", n.id, "v2");
    assert.equal(store.historyCount(n.id), 0);
  });

  test("the settings are bounded and fall back to the defaults", () => {
    assert.deepEqual(historyLimits(), { versions: 20, bytes: 2_000_000 });
    process.env.ONEMEMORY_HISTORY_VERSIONS = "99999";
    process.env.ONEMEMORY_HISTORY_MAX_BYTES = "1";
    assert.deepEqual(historyLimits(), { versions: 500, bytes: 10_000 });
    process.env.ONEMEMORY_HISTORY_VERSIONS = "nonsense";
    assert.equal(historyLimits().versions, 20);
  });

  test("a hard delete takes the note's history with it, and purge forgets it on request", () => {
    const n = make("alice", "t", "v1");
    edit("bob", n.id, "v2");
    const m = make("alice", "t2", "w1");
    edit("bob", m.id, "w2");
    assert.equal(purgeNoteHistory(store, admin("boss"), m.id).removed, 1);
    assert.equal(store.historyCount(m.id), 0);
    assert.equal(store.read(m.id)!.body, "w2", "the note itself is untouched");
    store.delete(n.id);
    assert.equal(store.historyCount(n.id), 0);
  });
});

describe("who may read and restore history", () => {
  test("administrators only", () => {
    const n = make("alice", "t", "v1");
    edit("bob", n.id, "v2");
    assert.throws(() => noteHistory(store, write("alice"), n.id), (e: unknown) => e instanceof SupersedeError && e.status === 403);
    assert.throws(() => restoreVersion(store, write("alice"), n.id, 1), (e: unknown) => e instanceof SupersedeError && e.status === 403);
    assert.throws(() => purgeNoteHistory(store, write("alice"), n.id), (e: unknown) => e instanceof SupersedeError && e.status === 403);
    assert.equal(noteHistory(store, admin("boss"), n.id).versions.length, 1);
  });

  test("another tenant's note looks exactly like a missing note", () => {
    const n = as("alice", () => store.create({ title: "t", body: "SECRETV1", namespace: "tenantA" }));
    as("alice", () => store.update(n.id, { body: "v2" }));
    const gone = as("alice", () => store.create({ title: "g", body: "g", namespace: "tenantB" }));
    store.delete(gone.id);
    const pinned: Caller = { scope: "admin", writer: "adminB", ownNamespace: "tenantB" };
    const catchIt = (id: number): Error => {
      try {
        noteHistory(store, pinned, id);
      } catch (e) {
        return e as Error;
      }
      throw new Error("expected an error");
    };
    const a = catchIt(n.id);
    const b = catchIt(gone.id);
    assert.equal(a.message, b.message);
    assert.ok(!a.message.includes("SECRETV1"));
    assert.throws(() => restoreVersion(store, pinned, n.id, 1), /no note/);
    assert.throws(() => purgeNoteHistory(store, pinned, n.id), /no note/);
  });

  test("versions by a distrusted writer are hidden unless asked for, and counted", () => {
    const n = make("boss", "t", "trusted v1");
    edit("mallory", n.id, "mallory v2");
    edit("boss", n.id, "boss v3");
    store.distrustAdd("default", "mallory");
    const h = noteHistory(store, admin("boss"), n.id);
    assert.deepEqual(h.versions.map((v) => v.body), ["trusted v1"]);
    assert.equal(h.hidden_by_trust_policy, 1);
    assert.equal(noteHistory(store, admin("boss"), n.id, { includeDistrusted: true }).versions.length, 2);
  });
});

describe("restoring a version", () => {
  test("makes a NEW version; the text it replaces goes into the history", () => {
    const n = make("boss", "t", "good");
    edit("mallory", n.id, "bad");
    const r = as("boss", () => restoreVersion(store, admin("boss"), n.id, 1));
    assert.equal(r.note.body, "good");
    assert.equal(r.note.rev, 3);
    assert.equal(r.note.written_by, "boss");
    assert.deepEqual(store.historyOf(n.id).map((e) => [e.version, e.body, e.reason]), [[2, "bad", "restore"], [1, "good", "update"]]);
  });

  test("refuses when the note moved on (if_rev), a missing version, and a bad version number", () => {
    const n = make("boss", "t", "v1");
    edit("bob", n.id, "v2");
    edit("bob", n.id, "v3");
    assert.throws(() => as("boss", () => restoreVersion(store, admin("boss"), n.id, 1, { ifRev: 2 })), StaleWriteError);
    assert.throws(() => restoreVersion(store, admin("boss"), n.id, 77), /no saved version/);
    assert.throws(() => restoreVersion(store, admin("boss"), n.id, "x"), /version number/);
    assert.equal(store.read(n.id)!.body, "v3");
  });

  test("will not put back a version written by a distrusted writer", () => {
    const n = make("boss", "t", "v1");
    edit("mallory", n.id, "v2");
    edit("boss", n.id, "v3");
    store.distrustAdd("default", "mallory");
    assert.throws(() => restoreVersion(store, admin("boss"), n.id, 2), (e: unknown) => e instanceof SupersedeError && e.status === 403);
    assert.equal(store.read(n.id)!.body, "v3");
  });

  test("after distrusting the overwriter, restoring the trusted text makes it visible to agents again", async () => {
    const n = make("boss", "oncall phone zebra", "On-call phone is 111.");
    edit("mallory", n.id, "On-call phone is 999.");
    store.distrustAdd("default", "mallory");
    assert.equal((await runSearch(store, "oncall phone zebra")).length, 0, "the overwritten note is hidden from agents");
    as("boss", () => restoreVersion(store, admin("boss"), n.id, 1));
    const seen = await runSearch(store, "oncall phone zebra");
    assert.equal(seen.length, 1);
    assert.equal(seen[0].body, "On-call phone is 111.");
  });

  test("the taint of a restored version follows the TEXT, and never adds trust", () => {
    const n = make("alice", "t", "v1");
    edit("mallory", n.id, "v2");
    edit("bob", n.id, "v3 mixes");
    // v3 was written over mallory's text, so it carries her name; restoring v2 (hers) is refused once she is distrusted,
    // and restoring v1 (alice's own text) does not carry mallory forward.
    const r = as("boss", () => restoreVersion(store, admin("boss"), n.id, 1));
    assert.ok(!(r.note.merged_from_writers ?? []).includes("mallory"));
    store.distrustAdd("default", "mallory");
    assert.equal(store.isDistrusted(store.read(n.id)!), false);
  });

  test("an imported (claimed) version only ever adds names; it never clears any", async () => {
    const n = make("alice", "t", "v1");
    edit("mallory", n.id, "v2");
    const exp = store.exportBatch(0, 10, { history: true })[0];
    const other = new Store(":memory:");
    try {
      await other.importNotes([exp as never]);
      const imported = other.list({ includeArchived: true }).notes[0];
      const h = other.historyOf(imported.id);
      assert.equal(h.length, 1);
      assert.equal(h[0].imported, true);
      assert.equal(h[0].written_by, "", "an imported entry's writer is only a claim");
      assert.equal(h[0].claimed_writer, "alice");
      const r = restoreVersion(other, admin("boss"), imported.id, h[0].version);
      assert.ok((r.note.merged_from_writers ?? []).includes("alice"));
    } finally {
      other.close();
    }
  });

  test("a replaced note cannot have a version restored until it is brought back", () => {
    const n = make("boss", "t", "v1");
    edit("bob", n.id, "v2");
    const nw = make("boss", "u", "other");
    const p = as("boss", () => supersedePreview(store, admin("boss"), { old_ids: [n.id], new_id: nw.id }));
    as("boss", () => supersedeConfirm(store, admin("boss"), { token: p.token }));
    assert.throws(() => restoreVersion(store, admin("boss"), n.id, 1), /replaced by note/);
  });
});

describe("history and encryption at rest", () => {
  test("old text is sealed in the file when encryption is on, and still restorable", () => {
    const dir = mkdtempSync(join(tmpdir(), "om-hist-enc-"));
    try {
      ensureKey(dir);
      const path = join(dir, "state.db");
      const s = new Store(path);
      const n = as("alice", () => s.create({ title: "t", body: "PLAINTEXT-ONE" }));
      as("bob", () => s.update(n.id, { body: "PLAINTEXT-TWO" }));
      assert.equal(s.historyOf(n.id)[0].body, "PLAINTEXT-ONE");
      s.close();
      const raw = new DatabaseSync(path, { readOnly: true });
      const row = raw.prepare("SELECT body, body_enc FROM note_history").get() as { body: string; body_enc: string };
      raw.close();
      assert.equal(row.body, "");
      assert.ok(row.body_enc.length > 10);
      assert.ok(!row.body_enc.includes("PLAINTEXT"));
      const again = new Store(path);
      const r = as("boss", () => restoreVersion(again, admin("boss"), n.id, 1));
      assert.equal(r.note.body, "PLAINTEXT-ONE");
      again.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("turning encryption on later seals the history that was already kept, and turning it off opens it again", () => {
    const dir = mkdtempSync(join(tmpdir(), "om-hist-later-"));
    try {
      const path = join(dir, "state.db");
      const s = new Store(path);
      const n = as("alice", () => s.create({ title: "t", body: "OLD-SECRET-TEXT" }));
      as("bob", () => s.update(n.id, { body: "newer" }));
      const key = ensureKey(dir);
      assert.ok(s.encryptAll(key) >= 1);
      const read = (): { body: string; body_enc: string | null } => {
        const raw = new DatabaseSync(path, { readOnly: true });
        try {
          return raw.prepare("SELECT body, body_enc FROM note_history").get() as { body: string; body_enc: string | null };
        } finally {
          raw.close();
        }
      };
      assert.equal(read().body, "");
      assert.ok(read().body_enc && !read().body_enc!.includes("OLD-SECRET"));
      assert.equal(s.historyOf(n.id)[0].body, "OLD-SECRET-TEXT");
      s.decryptAll(key);
      assert.equal(read().body, "OLD-SECRET-TEXT");
      assert.equal(read().body_enc, null);
      s.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a history body cannot be moved to another row (it is bound to its own row)", () => {
    const dir = mkdtempSync(join(tmpdir(), "om-hist-aad-"));
    try {
      ensureKey(dir);
      const path = join(dir, "state.db");
      const s = new Store(path);
      const n = as("alice", () => s.create({ title: "t", body: "ONE" }));
      as("bob", () => s.update(n.id, { body: "TWO" }));
      as("bob", () => s.update(n.id, { body: "THREE" }));
      s.close();
      const raw = new DatabaseSync(path);
      const rows = raw.prepare("SELECT hid, body_enc FROM note_history ORDER BY hid").all() as Array<{ hid: number; body_enc: string }>;
      raw.prepare("UPDATE note_history SET body_enc = ? WHERE hid = ?").run(rows[0].body_enc, rows[1].hid);
      raw.close();
      const again = new Store(path);
      assert.throws(() => again.historyOf(n.id), /unreadable|cannot|decrypt|authenticat/i);
      again.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("confidence (a claim, not a check)", () => {
  test("is validated: a number from 0 to 1, nothing else", () => {
    for (const bad of [1.01, -0.01, Number.NaN, Infinity, "0.5", true, {}]) assert.throws(() => validateConfidence(bad as never), ValidationError, String(bad));
    for (const ok of [0, 0.5, 1, undefined, null]) assert.doesNotThrow(() => validateConfidence(ok as never));
    assert.throws(() => as("a", () => store.create({ title: "t", body: "b", confidence: 2 })), ValidationError);
  });

  test("is stored with the writer who claimed it, and kept through a text edit", () => {
    const n = make("alice", "t", "b", { confidence: 0.4 });
    assert.equal(n.confidence, 0.4);
    assert.equal(n.confidence_claimed_by, "alice");
    const e = edit("bob", n.id, "b2");
    assert.equal(e.confidence, 0.4);
    assert.equal(e.confidence_claimed_by, "alice", "the claim is still alice's, not bob's");
  });

  test("can be changed, and cleared with null; the new claimant is the one who changed it", () => {
    const n = make("alice", "t", "b", { confidence: 0.4 });
    const c = as("bob", () => store.update(n.id, { confidence: 0.9 }))!;
    assert.equal(c.confidence, 0.9);
    assert.equal(c.confidence_claimed_by, "bob");
    const z = as("bob", () => store.update(n.id, { confidence: null }))!;
    assert.equal(z.confidence, undefined);
  });

  test("a note without one has none (no default is invented)", () => {
    const n = make("alice", "t", "b");
    assert.equal(n.confidence, undefined);
  });

  test("survives export and import together with its claimant and the history", async () => {
    const n = make("alice", "t", "b1", { confidence: 0.35 });
    edit("bob", n.id, "b2");
    const exp = store.exportBatch(0, 10, { history: true });
    assert.equal(exp[0].confidence, 0.35);
    assert.equal(exp[0].history?.length, 1);
    const other = new Store(":memory:");
    try {
      await other.importNotes(exp as never);
      const got = other.list({}).notes[0];
      assert.equal(got.confidence, 0.35);
      assert.equal(other.historyOf(got.id)[0].body, "b1");
      assert.equal(other.historyOf(got.id)[0].confidence, 0.35);
    } finally {
      other.close();
    }
  });

  test("an export without history carries none", () => {
    const n = make("alice", "t", "b1");
    edit("bob", n.id, "b2");
    assert.equal(store.exportBatch(0, 10, {})[0].history, undefined);
  });

  test("a replaced note stays linked to its replacement through export and import", async () => {
    const old = make("alice", "old", "alpha");
    const nw = make("alice", "new", "beta");
    const p = as("alice", () => supersedePreview(store, write("alice"), { old_ids: [old.id], new_id: nw.id }));
    as("alice", () => supersedeConfirm(store, write("alice"), { token: p.token }));
    const exp = store.exportBatch(0, 10, { history: true });
    const other = new Store(":memory:");
    try {
      await other.importNotes(exp as never);
      const all = other.list({ includeSuperseded: true }).notes;
      const o = all.find((n) => n.title === "old")!;
      const nn = all.find((n) => n.title === "new")!;
      assert.equal(o.status, "superseded");
      assert.equal(o.superseded_by, nn.id, "the link points at the new copy, not the old id");
      assert.equal(other.list({}).notes.some((n) => n.title === "old"), false);
    } finally {
      other.close();
    }
  });

  test("an import with a replacement that is not in the file drops the link instead of pointing at a stranger", async () => {
    const old = make("alice", "old", "alpha");
    const nw = make("alice", "new", "beta");
    const p = as("alice", () => supersedePreview(store, write("alice"), { old_ids: [old.id], new_id: nw.id }));
    as("alice", () => supersedeConfirm(store, write("alice"), { token: p.token }));
    const only = store.exportBatch(0, 10, {}).filter((n) => n.title === "old");
    const other = new Store(":memory:");
    try {
      const stranger = as("z", () => other.create({ title: "stranger", body: "s" }));
      await other.importNotes(only as never);
      const o = other.list({ includeSuperseded: true, includeArchived: true }).notes.find((n) => n.title === "old")!;
      assert.notEqual(o.superseded_by, stranger.id);
      assert.equal(o.superseded_by, undefined);
      assert.ok(o.archived_at, "it stays out of sight (archived), and can be restored like any archived note");
    } finally {
      other.close();
    }
  });
});

describe("schema v15 migration", () => {
  function v14Db(encrypted = false): { dir: string; path: string } {
    const dir = mkdtempSync(join(tmpdir(), "om-mig15-"));
    if (encrypted) ensureKey(dir);
    const path = join(dir, "state.db");
    const s = new Store(path);
    as("alice", () => s.create({ title: "one", body: "first note", tags: ["a"] }));
    as("bob", () => s.create({ title: "two", body: "second note" }));
    s.close();
    downgradeTo(path, 14);
    return { dir, path };
  }
  const cols = (path: string, table: string): string[] => {
    const raw = new DatabaseSync(path, { readOnly: true });
    try {
      return (raw.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((r) => r.name);
    } finally {
      raw.close();
    }
  };
  const version = (path: string): number => {
    const raw = new DatabaseSync(path, { readOnly: true });
    try {
      return Number((raw.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
    } finally {
      raw.close();
    }
  };

  for (const encrypted of [false, true]) {
    test(`a v14 database${encrypted ? " (encrypted)" : ""} upgrades, keeps every note, takes one verified backup at v14`, () => {
      const { dir, path } = v14Db(encrypted);
      try {
        assert.equal(version(path), 14);
        assert.ok(!cols(path, "notes").includes("confidence"));
        const quiet = console.error;
        console.error = () => undefined;
        let s: Store;
        try {
          s = new Store(path);
        } finally {
          console.error = quiet;
        }
        assert.equal(SCHEMA_VERSION, 16);
        assert.equal(version(path), 16);
        assert.deepEqual(s.list({}).notes.map((n) => n.title).sort(), ["one", "two"]);
        assert.equal(s.list({}).notes.find((n) => n.title === "one")!.body, "first note");
        for (const c of ["confidence", "confidence_by", "superseded_by", "superseded_at", "superseded_by_writer"]) assert.ok(cols(path, "notes").includes(c), c);
        for (const t of ["note_history", "supersede_used", "supersede_log"]) assert.ok(cols(path, t).length > 0, t);
        const bak = path + ".pre-v16-backup";
        assert.ok(existsSync(bak), "the pre-upgrade copy exists");
        assert.ok(Store.verifyBackupFile(bak).ok);
        assert.equal(version(bak), 14, "the copy is still at the old version, so an older release can open it");
        // The new features work on the upgraded file.
        const one = s.list({}).notes.find((n) => n.title === "one")!;
        as("bob", () => s.update(one.id, { body: "changed", confidence: 0.6 }));
        assert.equal(s.historyOf(one.id)[0].body, "first note");
        assert.equal(s.read(one.id)!.confidence, 0.6);
        s.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  test("is idempotent: reopening changes nothing and never replaces the backup", () => {
    const { dir, path } = v14Db();
    try {
      const quiet = console.error;
      console.error = () => undefined;
      try {
        new Store(path).close();
        const bak = path + ".pre-v16-backup";
        const before = readdirSync(dir).sort();
        const s = new Store(path);
        const one = s.list({}).notes[0];
        as("x", () => s.update(one.id, { body: "edit" }));
        s.close();
        new Store(path).close();
        assert.deepEqual(readdirSync(dir).sort(), before);
        assert.equal(version(bak), 14);
      } finally {
        console.error = quiet;
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("running the v15 step twice on a half-upgraded file loses nothing", () => {
    const { dir, path } = v14Db();
    try {
      const quiet = console.error;
      console.error = () => undefined;
      try {
        new Store(path).close();
        const raw = new DatabaseSync(path);
        raw.exec("PRAGMA user_version = 14");
        raw.close();
        const s = new Store(path);
        assert.equal(s.list({}).notes.length, 2);
        s.close();
        assert.equal(version(path), 16);
      } finally {
        console.error = quiet;
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("ranking: the newer of two near-identical notes comes first", () => {
  test("a stale older twin stays behind its newer twin even when it matches the words better", async () => {
    const old = await store.importNotes([
      {
        title: "Primary contact for orchid",
        body: "The primary contact for orchid is Ada. primary contact orchid primary contact.",
        created_at: new Date(Date.now() - 200 * 86_400_000).toISOString(),
        updated_at: new Date(Date.now() - 200 * 86_400_000).toISOString(),
      } as never,
    ]);
    void old;
    const nw = make("alice", "orchid main contact moved", "orchid primary contact changed: it is now Grace.");
    const hits = await runSearch(store, "orchid primary contact");
    assert.equal(hits[0].id, nw.id, hits.map((h) => `${h.id}:${h.title}`).join(" | "));
    assert.equal(hits.length, 2, "the older note is still returned (and flagged), not hidden");
  });
});
