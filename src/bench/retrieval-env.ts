// Imported FIRST by retrieval.ts (before anything that loads config.js): point ONEMEMORY_HOME at a fresh temp folder
// so the retrieval benchmark can never open or write your real data. Every other ONEMEMORY_* variable is removed
// (lint policy, staleness, tokens...), except the embedding settings the hybrid run needs.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

for (const k of Object.keys(process.env)) {
  if (k.startsWith("ONEMEMORY_") && !k.startsWith("ONEMEMORY_EMBED")) delete process.env[k];
}
export const BENCH_HOME = mkdtempSync(join(tmpdir(), "onememory-retrieval-"));
process.env.ONEMEMORY_HOME = BENCH_HOME;
process.on("exit", () => rmSync(BENCH_HOME, { recursive: true, force: true }));
