// v16: captured observations and summaries do not feed the note housekeeping: memory_stats totals, the stale count and
// every duplicate/consolidation path leave them out.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Store, ValidationError } from "../src/store.js";
import { findCandidates, findCandidatesCooperative, resolveConsolidationNotes } from "../src/consolidate.js";

const longAgo = new Date(Date.now() - 3 * 365 * 86_400_000).toISOString();

describe("captured rows and note housekeeping", () => {
  test("accessStats and staleCount count ordinary notes only", () => {
    const s = new Store(":memory:");
    s.create({ title: "Old plain note", body: "a", created_at: longAgo }, { updatedAt: longAgo });
    for (let i = 0; i < 3; i++) s.create({ title: `Old observation ${i}`, body: "b", created_at: longAgo }, { updatedAt: longAgo, kind: "observation", sessionId: "s", obsType: "change" });
    s.create({ title: "Old summary", body: "c", created_at: longAgo }, { updatedAt: longAgo, kind: "summary", sessionId: "s" });
    const st = s.accessStats();
    assert.equal(st.totalNotes, 1);
    assert.equal(st.neverAccessed, 1);
    assert.deepEqual(st.mostAccessed.map((n) => n.title), ["Old plain note"]);
    assert.equal(st.staleCount, 1);
    assert.equal(s.staleCount(["default"]), 1);
    s.close();
  });

  test("duplicate scans skip captured rows; consolidating one by id is refused", async () => {
    const s = new Store(":memory:");
    const n1 = s.create({ title: "Deploy on fridays", body: "we deploy every friday afternoon" });
    const n2 = s.create({ title: "Deploy on fridays", body: "we deploy every friday afternoon" });
    const o1 = s.create({ title: "Edited src/a.ts", body: "changed src/a.ts" }, { kind: "observation", sessionId: "s1", obsType: "change" });
    const o2 = s.create({ title: "Edited src/a.ts", body: "changed src/a.ts" }, { kind: "observation", sessionId: "s2", obsType: "change" });
    const pool = s.exportAll({ live: true });
    const ids = (pairs: Array<{ idA: number; idB: number }>) => pairs.map((p) => [p.idA, p.idB].sort((x, y) => x - y));
    assert.deepEqual(ids(findCandidates(pool)), [[n1.id, n2.id]]);
    assert.deepEqual(ids(await findCandidatesCooperative(pool)), [[n1.id, n2.id]]);
    assert.throws(() => resolveConsolidationNotes(s, [o1.id, o2.id]), (e: unknown) => e instanceof ValidationError && /captured observation/.test((e as Error).message));
    assert.equal(resolveConsolidationNotes(s, [n1.id, n2.id]).length, 2);
    s.close();
  });
});
