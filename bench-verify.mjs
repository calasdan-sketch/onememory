// Verify the three fixes against a realistic store.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./dist/src/store.js";
import { createApiServer } from "./dist/src/api.js";
import { IMPORT_BODY_BYTES } from "./dist/src/http-common.js";

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
const body = (i) => `${TOPICS[i % 8]}. Related: ${TOPICS[(i * 7 + 3) % 8]}. Entry ${i}.`;

const store = new Store(":memory:");
const N = 8000;
store.transaction(() => {
  for (let i = 0; i < N; i++) {
    store.create({ title: `entry ${i}`, body: body(i), tags: ["bench"] }, { skipEdges: true });
  }
});

console.log(`\n=== Verified against a ${N}-note store ===`);

// 1. Restore: deferEdges vs inline
for (const defer of [false, true]) {
  const d = mkdtempSync(join(tmpdir(), `om-ver-${defer}-`));
  const s2 = new Store(join(d, "state.db"));
  const notes = store.exportAll();
  const t0 = process.hrtime.bigint();
  await s2.importNotes(notes.map((x) => ({ ...x })), { deferEdges: defer });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log(
    `  restore ${N} notes ${defer ? "WITH deferEdges " : "inline (old way)"}: ${(ms / 1000).toFixed(1)}s`
  );
  s2.close();
  rmSync(d, { recursive: true, force: true });
}

// 2. Export: peak memory, streamed vs materialized
const peak = () => process.memoryUsage().heapUsed / 1048576;

global.gc?.();
const before = peak();
const exported = store.exportAll();
const materialized = JSON.stringify({ notes: exported });
const afterMat = peak();
console.log(
  `  materialized export: ${((Buffer.byteLength(materialized)) / 1048576).toFixed(1)}MB JSON, ` +
    `heap +${(afterMat - before).toFixed(0)}MB`
);
// free the materialized form before measuring streamed
exported.length = 0;
global.gc?.();

// 3. The import cap accepts this backup
const bytes = Buffer.byteLength(materialized);
console.log(
  `  import cap: ${IMPORT_BODY_BYTES / 1048576}MB; backup is ${(bytes / 1048576).toFixed(1)}MB -> ` +
    (bytes <= IMPORT_BODY_BYTES ? "ACCEPTED ✔" : "STILL BLOCKED ✖")
);

// 4. Streamed export over real HTTP: verify shape + time
const server = createApiServer(store, [{ token: "t", scope: "admin", label: "x" }]);
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;
global.gc?.();
const pre = peak();
const t1 = process.hrtime.bigint();
const res = await fetch(`${base}/export`, { headers: { Authorization: "Bearer t" } });
const text = await res.text();
const streamMs = Number(process.hrtime.bigint() - t1) / 1e6;
const post = peak();
const parsed = JSON.parse(text);
console.log(
  `  streamed /export over HTTP: ${streamMs.toFixed(0)}ms, heap +${(post - pre).toFixed(0)}MB, ` +
    `${parsed.notes.length} notes, valid JSON: ${parsed.notes.length === N ? "yes ✔" : "NO ✖"}`
);
server.close();
store.close();
