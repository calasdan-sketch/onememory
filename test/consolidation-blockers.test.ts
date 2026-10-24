// Regression tests for the auto-consolidation panel blockers #4, #6, #7, #8.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Store, ValidationError } from "../src/store.js";
import {
  autoConsolidate,
  consolidateNotes,
  cosineSimilarity,
  isAutoMergeSafe,
} from "../src/consolidate.js";

describe("auto-consolidation panel blockers", () => {
  test("#4: janitor with nsActive only touches ownNs notes", () => {
    const s = new Store(":memory:");
    // Identical duplicate pairs in TWO namespaces -- without the pool
    // filter, findCandidates would find both pairs and the janitor would
    // restructure/delete the other server's notes on a timer.
    const a1 = s.create({ namespace: "server-a", title: "Dupe", body: "same content here" });
    const a2 = s.create({ namespace: "server-a", title: "Dupe", body: "same content here" });
    const b1 = s.create({ namespace: "server-b", title: "Dupe", body: "same content here" });
    const b2 = s.create({ namespace: "server-b", title: "Dupe", body: "same content here" });

    const res = autoConsolidate(s, { ownNamespace: "server-a" });

    // Only the ownNs pair is even a candidate...
    assert.equal(res.candidateCount, 1, "cross-namespace pool must be restricted");
    // ...and only it gets merged.
    assert.equal(res.merged.length, 1);
    assert.equal(res.merged[0].idA, a1.id);
    assert.equal(res.merged[0].idB, a2.id);
    const mergedNote = s.read(res.merged[0].mergedId);
    assert.ok(mergedNote);
    assert.equal(mergedNote.namespace, "server-a");
    // server-b's notes are untouched: no merge, no deletion.
    assert.ok(s.read(b1.id), "server-b note b1 must survive the janitor");
    assert.ok(s.read(b2.id), "server-b note b2 must survive the janitor");
    assert.equal(
      s.exportAll().filter((n) => n.namespace === "server-b").length,
      2,
      "server-b must still have exactly its two notes"
    );
    s.close();
  });

  test("#4: janitor without namespace resolution keeps legacy whole-store behavior", () => {
    const s = new Store(":memory:");
    s.create({ title: "Dupe", body: "same content here" });
    s.create({ title: "Dupe", body: "same content here" });
    const res = autoConsolidate(s, {});
    assert.equal(res.merged.length, 1, "legacy mode still merges duplicates");
    s.close();
  });

  test("#6: two terse notes differing only in single-char tokens are NOT auto-merged", () => {
    const s = new Store(":memory:");
    const n1 = s.create({ title: "release note", body: "ship the build with config a" });
    const n2 = s.create({ title: "release note", body: "ship the build with config b" });
    // tokenize() drops "a"/"b" (< 2 chars): both notes reduce to the same
    // token set, so the cosine lands on a perfect 1.0 (modulo FP noise --
    // findCandidates snaps scores within 1e-9 of 1) -- the old code would
    // auto-merge and delete both sources (silent data loss).
    assert.ok(
      cosineSimilarity(`${n1.title} ${n1.body}`, `${n2.title} ${n2.body}`) >= 0.999,
      "precondition: the token-collapse pair scores ~1.0 (auto-merge band)"
    );
    assert.equal(isAutoMergeSafe(n1, n2), false, "safety gate must reject the pair");

    const res = autoConsolidate(s, {});
    assert.equal(res.candidateCount, 1, "pair is still surfaced for human review");
    assert.equal(res.merged.length, 0, "token-collapse pair must never auto-merge");
    assert.ok(s.read(n1.id) && s.read(n2.id), "both source notes must survive");
    s.close();
  });

  test("#6: true duplicates still auto-merge", () => {
    const s = new Store(":memory:");
    const d1 = s.create({ title: "release note", body: "ship the build with config b" });
    const d2 = s.create({ title: "release note", body: "ship the build with config b" });
    assert.equal(isAutoMergeSafe(d1, d2), true);
    const res = autoConsolidate(s, {});
    assert.equal(res.merged.length, 1);
    assert.equal(res.merged[0].idA, d1.id);
    assert.equal(res.merged[0].idB, d2.id);
    s.close();
  });

  test("#7: Store.transaction rolls back everything when the callback throws", () => {
    const s = new Store(":memory:");
    s.create({ title: "keep me", body: "x" });
    assert.throws(
      () =>
        s.transaction(() => {
          s.create({ title: "doomed", body: "x" });
          throw new Error("boom");
        }),
      /boom/
    );
    assert.deepEqual(
      s.exportAll().map((n) => n.title),
      ["keep me"],
      "the in-transaction create must be rolled back"
    );
    s.close();
  });

  test("#7: consolidateNotes runs create + deletes inside a single transaction", () => {
    const s = new Store(":memory:");
    const a = s.create({ title: "T", body: "same body text here" });
    const b = s.create({ title: "T", body: "same body text here" });
    let calls = 0;
    const orig = s.transaction.bind(s);
    s.transaction = <T>(fn: () => T): T => {
      calls += 1;
      return orig(fn);
    };
    consolidateNotes(s, [a.id, b.id], { deleteSources: true });
    assert.equal(calls, 1, "merge must use exactly one transaction");
    s.close();
  });

  test("#7/#8: Store.deleteIfRev only deletes when the rev matches", () => {
    const s = new Store(":memory:");
    const n = s.create({ title: "t", body: "b" });
    assert.equal(s.deleteIfRev(n.id, n.rev + 99), false, "stale rev must not delete");
    assert.ok(s.read(n.id), "note must survive a stale guarded delete");
    assert.equal(s.deleteIfRev(n.id, n.rev), true, "matching rev deletes");
    assert.equal(s.read(n.id), null);
    s.close();
  });

  test("#8: merge aborts when a source note's rev changed between candidate-read and merge", () => {
    const s = new Store(":memory:");
    const a = s.create({ title: "Dup", body: "identical body text" });
    const b = s.create({ title: "Dup", body: "identical body text" });

    // Simulate the TOCTOU race: a concurrent writer lands AFTER the merge's
    // pre-transaction read but BEFORE the in-transaction re-read.
    const origTxn = s.transaction.bind(s);
    s.transaction = <T>(fn: () => T): T => {
      s.update(b.id, { body: "identical body text edited by another agent" });
      return origTxn(fn);
    };

    assert.throws(
      () => consolidateNotes(s, [a.id, b.id], { deleteSources: true }),
      (e) =>
        e instanceof ValidationError &&
        /changed while preparing the merge/.test(e.message),
      "merge must abort on a rev change, not destroy the concurrent write"
    );
    // No partial merge: the concurrent writer's content survives, note a
    // survives, and no merged note exists.
    assert.equal(s.exportAll().length, 2, "nothing may be merged or deleted");
    assert.equal(
      s.read(b.id)!.body,
      "identical body text edited by another agent",
      "the concurrent write must be preserved"
    );
    assert.ok(s.read(a.id));
    s.close();
  });

  test("#8: merge aborts when a source note vanished before the merge (no resurrection)", () => {
    const s = new Store(":memory:");
    const a = s.create({ title: "Dup", body: "identical body text" });
    const b = s.create({ title: "Dup", body: "identical body text" });

    const origTxn = s.transaction.bind(s);
    s.transaction = <T>(fn: () => T): T => {
      s.delete(b.id);
      return origTxn(fn);
    };

    assert.throws(
      () => consolidateNotes(s, [a.id, b.id], { deleteSources: true }),
      (e) =>
        e instanceof ValidationError &&
        /deleted while preparing the merge/.test(e.message),
      "merge must abort when a source vanished, not resurrect it in the merge"
    );
    assert.equal(s.exportAll().length, 1);
    assert.ok(s.read(a.id));
    s.close();
  });

  test("#8: normal merge still succeeds and deletes sources atomically", () => {
    const s = new Store(":memory:");
    const a = s.create({ title: "Dup", body: "identical body text" });
    const b = s.create({ title: "Dup", body: "identical body text" });
    const merged = consolidateNotes(s, [a.id, b.id], { deleteSources: true });
    assert.equal(merged.body, "identical body text");
    assert.equal(s.read(a.id), null);
    assert.equal(s.read(b.id), null);
    assert.equal(s.exportAll().length, 1);
    s.close();
  });
});
