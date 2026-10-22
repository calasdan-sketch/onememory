// "A few months of revisions piled up" — the exact case a Redditor asked about.
//
// OneMemory stores only the LATEST version of a note (rev is a counter, not a
// snapshot); edit history lives in change_log as metadata-only rows pruned at
// 90 days, and is NOT part of the backup. This benchmark proves two things:
//   1. Export cost tracks note count, NOT edit count (revision-heavy store
//      exports about as fast as a fresh store with the same notes).
//   2. A full round-trip (export -> import) of the revision-heavy store
//      restores current state correctly and fast.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./dist/src/store.js";

const N_NOTES = 500;
const UPDATES_PER_NOTE = 24; // ~6 months of weekly edits

// --- 1. Build the revision-heavy store (500 notes x 24 edits = 12,500 writes)
const heavyDir = mkdtempSync(join(tmpdir(), `om-rev-heavy-`));
const heavy = new Store(join(heavyDir, "state.db"));
const bodies = (i, r) =>
  `entry ${i} revision ${r}. kubernetes rolling update notes for pod ${i} ` +
  `with readiness probe config revision ${r} and postgres pgbouncer pool size hints.`;

const t0 = process.hrtime.bigint();
const ids = [];
for (let i = 0; i < N_NOTES; i++) {
  ids.push(heavy.create({ title: `entry ${i}`, body: bodies(i, 0), tags: ["bench"] }, { skipEdges: true }).id);
}
for (let r = 1; r <= UPDATES_PER_NOTE; r++) {
  for (const id of ids) heavy.update(id, { body: bodies(id, r) });
}
const seedMs = Number(process.hrtime.bigint() - t0) / 1e6;

// How much history piled up (the thing the Redditor imagines bloating the backup)
const changeRows = (() => {
  // change_log isn't exposed on Store; count via a second connection-free path:
  // the changes() feed reports totals over a window. Use a wide window.
  const page = heavy.changes({ since: "2000-01-01T00:00:00.000Z", limit: 1 });
  return page.counts.total;
})();
const maxRev = Math.max(...ids.map((id) => heavy.read(id).rev));

console.log(`\n=== "A few months of revisions piled up" ===`);
console.log(
  `  seeded: ${N_NOTES} notes x ${UPDATES_PER_NOTE} edits = ${(N_NOTES * (UPDATES_PER_NOTE + 1)).toLocaleString()} writes ` +
    `(${(seedMs / 1000).toFixed(1)}s), max rev = ${maxRev}, change-feed rows = ${changeRows.toLocaleString()}`
);

// --- 2. A fresh store with the SAME current notes, no edit history
const freshDir = mkdtempSync(join(tmpdir(), `om-rev-fresh-`));
const fresh = new Store(join(freshDir, "state.db"));
fresh.transaction(() => {
  for (const id of ids) {
    const n = heavy.read(id);
    fresh.create({ title: n.title, body: n.body, tags: n.tags }, { skipEdges: true });
  }
});

// --- 3. Streamed export of BOTH (same loop the API /export uses)
function streamedExport(store) {
  let bytes = 0;
  let notes = 0;
  let afterId = 0;
  for (;;) {
    const page = store.exportBatch(afterId, 500);
    if (page.length === 0) break;
    afterId = page[page.length - 1].id;
    for (const n of page) bytes += Buffer.byteLength(JSON.stringify(n));
    notes += page.length;
    if (page.length < 500) break;
  }
  return { bytes, notes };
}

global.gc?.();
const heapBefore = process.memoryUsage().heapUsed;
const t1 = process.hrtime.bigint();
const heavyExport = streamedExport(heavy);
const heavyMs = Number(process.hrtime.bigint() - t1) / 1e6;

global.gc?.();
const t2 = process.hrtime.bigint();
const freshExport = streamedExport(fresh);
const freshMs = Number(process.hrtime.bigint() - t2) / 1e6;
const heapAfter = process.memoryUsage().heapUsed;

console.log(`  export revision-heavy store: ${heavyMs.toFixed(0)}ms, ${heavyExport.notes} notes, ${(heavyExport.bytes / 1048576).toFixed(1)}MB JSON`);
console.log(`  export fresh same-size store: ${freshMs.toFixed(0)}ms, ${freshExport.notes} notes  <- history adds ~${(heavyMs - freshMs).toFixed(0)}ms`);
console.log(`  heap delta across both exports: +${((heapAfter - heapBefore) / 1048576).toFixed(0)}MB (streamed, one page at a time)`);

// --- 4. Correctness: the backup holds CURRENT state only, latest body wins
const dump = heavy.exportAll();
const wrongBody = dump.filter((n) => !n.body.includes(`revision ${UPDATES_PER_NOTE}`)).length;
const wrongRev = dump.filter((n) => n.rev !== UPDATES_PER_NOTE + 1).length;
console.log(`  backup content: ${dump.length} entries (one per note, not per revision), latest body: ${dump.length - wrongBody}/${dump.length}, rev=${UPDATES_PER_NOTE + 1}: ${dump.length - wrongRev}/${dump.length}`);

// --- 5. Round-trip: restore the revision-heavy backup into a fresh store
const restoreDir = mkdtempSync(join(tmpdir(), `om-rev-restore-`));
const restored = new Store(join(restoreDir, "state.db"));
const t3 = process.hrtime.bigint();
await restored.importNotes(dump.map((d) => ({ ...d })), { deferEdges: true });
const restoreMs = Number(process.hrtime.bigint() - t3) / 1e6;
const rt = restored.exportAll();
const rtOk =
  rt.length === N_NOTES &&
  rt.every((n) => n.body.includes(`revision ${UPDATES_PER_NOTE}`)) &&
  rt.every((n) => n.created_at && n.updated_at);
console.log(`  restore ${N_NOTES} notes: ${(restoreMs / 1000).toFixed(1)}s, current state intact: ${rtOk ? "yes" : "NO"}`);

heavy.close();
fresh.close();
restored.close();
rmSync(heavyDir, { recursive: true, force: true });
rmSync(freshDir, { recursive: true, force: true });
rmSync(restoreDir, { recursive: true, force: true });
