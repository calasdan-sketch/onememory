// Does a multi-month backup actually RESTORE in reasonable time?
// Times importNotes (inserts + linkNotes graph rebuild) at several scales.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./dist/src/store.js";

const body =
  "Working notes for the deploy pipeline. The staging environment needs the " +
  "migration run before the app boots, and the healthcheck should retry for " +
  "at least 30 seconds before giving up. Owner: dan. Ticket: INFRA-4471. ".repeat(2);

async function roundtrip(n) {
  const srcDir = mkdtempSync(join(tmpdir(), `om-rt-src-${n}-`));
  const src = new Store(join(srcDir, "state.db"));
  src.transaction(() => {
    for (let i = 0; i < n; i++) {
      src.create(
        { title: `note ${i} — deploy runbook step`, body, tags: ["infra", i % 2 ? "staging" : "prod"] },
        { skipEdges: true }
      );
    }
  });
  const notes = src.exportAll();
  src.close();

  const dstDir = mkdtempSync(join(tmpdir(), `om-rt-dst-${n}-`));
  const dst = new Store(join(dstDir, "state.db"));
  const t0 = process.hrtime.bigint();
  const created = await dst.importNotes(notes.map((x) => ({ ...x })));
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log(
    `  ${n} notes: restored ${created.length} in ${(ms / 1000).toFixed(1)}s ` +
      `(${(ms / n).toFixed(2)}ms/note)`
  );
  dst.close();
  rmSync(srcDir, { recursive: true, force: true });
  rmSync(dstDir, { recursive: true, force: true });
}

console.log("\n=== Full restore round-trip (current code) ===");
for (const n of [500, 2000, 8000]) await roundtrip(n);
