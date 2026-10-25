// Preloaded by `npm test` (node --test --import ./dist/test/setup-env.js): the suite must not depend on, or touch,
// the developer's own configuration. Every ONEMEMORY_* variable is removed (a stray ONEMEMORY_RUNNER_STALE_SECONDS,
// ONEMEMORY_TRUSTED_ATTESTERS or ONEMEMORY_ATTEST_KEY_FILE made tests fail, and the last one could point a test at a real
// signing key), and the data directory is a throwaway one. Tests that need a variable set it themselves.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

for (const k of Object.keys(process.env)) if (k.startsWith("ONEMEMORY_") || k.startsWith("CLAUDE_BRIDGE_")) delete process.env[k];
const home = mkdtempSync(join(tmpdir(), "onememory-test-home-"));
process.env.ONEMEMORY_HOME = home;
process.on("exit", () => {
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});
