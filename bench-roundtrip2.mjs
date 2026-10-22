// Re-measure restore with DIVERSE note bodies (the first benchmark used one
// identical body for every note, which is the pathological worst case for an
// inverted index: every note shares every token with every other).
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
  "grocery list for the chili cookoff including cornbread ingredients",
  "docker multi-stage builds to keep the final image under two hundred megabytes",
  "the guest bathroom faucet drips and needs a new cartridge washer",
  "redis cluster failover behavior and client retry strategies compared",
];
const TAGSETS = [
  ["infra", "k8s"], ["db", "postgres"], ["infra", "terraform"], ["home", "kitchen"],
  ["family"], ["home", "car"], ["infra", "vpn"], ["work", "frontend"],
  ["home", "errands"], ["infra", "docker"], ["home", "repair"], ["infra", "cache"],
];

function body(i) {
  const a = TOPICS[i % TOPICS.length];
  const b = TOPICS[(i * 7 + 3) % TOPICS.length];
  const c = TOPICS[(i * 13 + 5) % TOPICS.length];
  return `${a}. Related: ${b}. Also noted: ${c}. Entry ${i}.`;
}

async function roundtrip(n) {
  const srcDir = mkdtempSync(join(tmpdir(), `om-rt2-src-${n}-`));
  const src = new Store(join(srcDir, "state.db"));
  src.transaction(() => {
    for (let i = 0; i < n; i++) {
      src.create(
        { title: `entry ${i}`, body: body(i), tags: TAGSETS[i % TAGSETS.length] },
        { skipEdges: true }
      );
    }
  });
  const notes = src.exportAll();
  src.close();

  const dstDir = mkdtempSync(join(tmpdir(), `om-rt2-dst-${n}-`));
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

console.log("\n=== Restore with DIVERSE bodies (realistic) ===");
for (const n of [500, 2000, 8000]) await roundtrip(n);
