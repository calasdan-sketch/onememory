// Benchmark: how does backup export behave with months of notes piled up?
// Measures export wall time + peak memory at several scales, and checks
// whether a full backup can actually round-trip through POST /import.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./dist/src/store.js";

const SCALES = [500, 2000, 8000];

function peakMemMB() {
  const m = process.memoryUsage();
  return { rss: m.rss / 1048576, heap: m.heapUsed / 1048576 };
}

function seed(store, n) {
  // Realistic personal/work note: ~600 char body, a few tags.
  const body =
    "Working notes for the deploy pipeline. The staging environment needs the " +
    "migration run before the app boots, and the healthcheck should retry for " +
    "at least 30 seconds before giving up. Owner: dan. Ticket: INFRA-4471. ".repeat(2);
  const before = peakMemMB();
  const t0 = process.hrtime.bigint();
  // One transaction for the whole seed -- mirrors a bulk import path.
  store.transaction(() => {
    for (let i = 0; i < n; i++) {
      store.create(
        {
          title: `note ${i} — deploy runbook step`,
          body,
          tags: ["infra", i % 2 ? "staging" : "prod"],
        },
        { skipEdges: true }
      );
    }
  });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const after = peakMemMB();
  console.log(
    `  seeded ${n} notes in ${ms.toFixed(0)}ms (rss +${(after.rss - before.rss).toFixed(0)}MB)`
  );
}

async function measureExport(dir, label) {
  const store = new Store(join(dir, "state.db"));
  try {
    global.gc?.();
    const base = peakMemMB();
    const t0 = process.hrtime.bigint();
    const notes = store.exportAll();
    const rowsMs = Number(process.hrtime.bigint() - t0) / 1e6;
    const mid = peakMemMB();

    const t1 = process.hrtime.bigint();
    const json = JSON.stringify({ notes });
    const stringifyMs = Number(process.hrtime.bigint() - t1) / 1e6;
    const end = peakMemMB();

    const sizeMB = Buffer.byteLength(json) / 1048576;
    console.log(
      `  ${label}: ${notes.length} notes | ${sizeMB.toFixed(1)}MB JSON | ` +
        `exportAll ${rowsMs.toFixed(0)}ms (peak heap +${(mid.heap - base.heap).toFixed(0)}MB) | ` +
        `stringify ${stringifyMs.toFixed(0)}ms (peak heap +${(end.heap - base.heap).toFixed(0)}MB)`
    );
    return { count: notes.length, sizeMB, json };
  } finally {
    store.close();
  }
}

console.log("\n=== Export at scale (current code) ===");
for (const n of SCALES) {
  const dir = mkdtempSync(join(tmpdir(), `om-bench-${n}-`));
  const store = new Store(join(dir, "state.db"));
  seed(store, n);
  store.close();
  await measureExport(dir, `${n} notes`);
  rmSync(dir, { recursive: true, force: true });
}

// --- The round-trip question: can a multi-month backup be restored over HTTP?
console.log("\n=== HTTP import cap check ===");
const { MAX_BODY_BYTES } = await import("./dist/src/http-common.js");
console.log(`  MAX_BODY_BYTES = ${MAX_BODY_BYTES} (${(MAX_BODY_BYTES / 1048576).toFixed(1)}MB)`);
const dir = mkdtempSync(join(tmpdir(), "om-bench-rt-"));
const store = new Store(join(dir, "state.db"));
seed(store, 2000);
store.close();
const { json } = await measureExport(dir, "round-trip store");
const bytes = Buffer.byteLength(json);
console.log(
  bytes > MAX_BODY_BYTES
    ? `  ✖ BACKUP IS ${(bytes / MAX_BODY_BYTES).toFixed(1)}x THE IMPORT CAP — POST /import would 413.`
    : `  ✔ backup fits within the import cap.`
);
rmSync(dir, { recursive: true, force: true });
