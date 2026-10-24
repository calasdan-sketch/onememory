// Compare-and-swap on Store.update, including across two Store instances on the
// SAME on-disk database (the phone + desktop scenario this feature exists for).
//
// Honesty note: node:sqlite is synchronous and update() has no await between
// BEGIN and COMMIT, so two writers CANNOT truly interleave within one process --
// these tests can't reproduce a real wall-clock race. What they DO verify is
// that once one connection commits, a second connection's stale `ifRev` is
// rejected (and the committed write is visible to it via WAL). The atomicity of
// the guard itself is structural: it lives in the UPDATE's WHERE clause
// (`rev = ?`), not a separate read-then-check, so the DB enforces it rather than
// application timing -- that's design/code-review territory, not an in-process
// test.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, ValidationError } from "../src/store.js";

describe("Store.update compare-and-swap", () => {
  let dir: string;
  let dbPath: string;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "onememory-cas-"));
    dbPath = join(dir, "state.db");
  });
  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("a correct ifRev succeeds and bumps the revision", () => {
    const s = new Store(dbPath);
    const note = s.create({ title: "doc", body: "v1" });
    assert.equal(note.rev, 1);
    const updated = s.update(note.id, { body: "v2" }, { ifRev: 1 });
    assert.equal(updated?.rev, 2);
    assert.equal(updated?.body, "v2");
    s.close();
  });

  test("a stale ifRev is rejected", () => {
    const s = new Store(dbPath);
    const note = s.create({ title: "doc2", body: "v1" });
    s.update(note.id, { body: "v2" }, { ifRev: note.rev }); // now rev 2
    assert.throws(
      () => s.update(note.id, { body: "v3" }, { ifRev: note.rev }), // still passing rev 1
      ValidationError
    );
    // The rejected write did not apply.
    assert.equal(s.read(note.id)?.body, "v2");
    s.close();
  });

  test("omitting ifRev forces the update (no CAS)", () => {
    const s = new Store(dbPath);
    const note = s.create({ title: "doc3", body: "v1" });
    const updated = s.update(note.id, { body: "forced" }); // no ifRev
    assert.equal(updated?.body, "forced");
    s.close();
  });

  test("across two connections: once A commits, B's stale ifRev is rejected (A's write stands)", () => {
    const a = new Store(dbPath);
    const b = new Store(dbPath);
    const note = a.create({ title: "shared", body: "base" });

    // Both sides have read rev=1. A commits first with ifRev=1.
    const aRev = note.rev;
    const bRev = note.rev;
    const aw = a.update(note.id, { body: "from A" }, { ifRev: aRev });
    assert.equal(aw?.body, "from A");
    assert.equal(aw?.rev, 2);

    // B, on a SEPARATE connection, still holds rev=1 -> rejected, not allowed to
    // overwrite A. This also confirms the commit is visible across connections.
    assert.throws(() => b.update(note.id, { body: "from B" }, { ifRev: bRev }), ValidationError);

    // A's write stands.
    assert.equal(b.read(note.id)?.body, "from A");
    a.close();
    b.close();
  });

  test("updating a concurrently-deleted note returns null (not found), not a crash", () => {
    const a = new Store(dbPath);
    const b = new Store(dbPath);
    const note = a.create({ title: "doomed", body: "x" });
    b.delete(note.id);
    assert.equal(a.update(note.id, { body: "y" }, { ifRev: note.rev }), null);
    a.close();
    b.close();
  });
});
