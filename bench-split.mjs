// Where does restore time actually go: inserting notes, or linking the
// similarity graph? This decides whether the fix is "insert faster" or
// "defer the graph".
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./dist/src/store.js";

const TOPICS = [
  "kubernetes rolling update with readiness probes and pod disruption budgets",
  "postgres connection pooling through pgbouncer in transaction mode",
  "terraform state locking and remote backend configuration for staging",
  "the espresso grinder needs a finer setting for the new light roast",
  "soccer practice moves to field two on tuesdays for the rest of fall",
  "subaru outback synthetic oil change interval and tire pressure specs",
  "wireguard vpn endpoint rotation and peer key management for the office",
  "react server components data fetching patterns and cache invalidation",
];
const body = (i) =>
  `${TOPICS[i % 8]}. Related: ${TOPICS[(i * 7 + 3) % 8]}. Entry ${i}.`;

async function measure(n) {
  const srcDir = mkdtempSync(join(tmpdir(), `om-sp-src-${n}-`));
  const src = new Store(join(srcDir, "state.db"));
  src.transaction(() => {
    for (let i = 0; i < n; i++) {
      src.create({ title: `entry ${i}`, body: body(i) }, { skipEdges: true });
    }
  });
  const notes = src.exportAll();
  src.close();

  // (a) inserts only, no graph
  const aDir = mkdtempSync(join(tmpdir(), `om-sp-a-${n}-`));
  const a = new Store(join(aDir, "state.db"));
  const t0 = process.hrtime.bigint();
  a.transaction(() => {
    for (const x of notes) {
      a.create(
        { namespace: x.namespace, title: x.title, body: x.body, tags: x.tags, source: x.source, created_at: x.created_at },
        { skipEdges: true, updatedAt: x.updated_at }
      );
    }
  });
  const insertMs = Number(process.hrtime.bigint() - t0) / 1e6;

  // (b) full importNotes (inserts + linkNotes)
  const bDir = mkdtempSync(join(tmpdir(), `om-sp-b-${n}-`));
  const b = new Store(join(bDir, "state.db"));
  const t1 = process.hrtime.bigint();
  await b.importNotes(notes.map((x) => ({ ...x })));
  const fullMs = Number(process.hrtime.bigint() - t1) / 1e6;

  console.log(
    `  ${n} notes: inserts-only ${(insertMs / 1000).toFixed(1)}s | ` +
      `full import ${(fullMs / 1000).toFixed(1)}s | ` +
      `graph linking = ${((fullMs - insertMs) / 1000).toFixed(1)}s (${(100 * (fullMs - insertMs) / fullMs).toFixed(0)}% of total)`
  );
  a.close();
  b.close();
  rmSync(srcDir, { recursive: true, force: true });
  rmSync(aDir, { recursive: true, force: true });
  rmSync(bDir, { recursive: true, force: true });
}

console.log("\n=== Restore cost split: inserts vs similarity graph ===");
for (const n of [500, 2000, 8000]) await measure(n);
