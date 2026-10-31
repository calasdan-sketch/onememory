// `encrypt enable` / `disable` reseal what the capture hooks stored: capture_events outputs and the notes they became.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { ensureKey } from "../src/crypto.js";
import { normalizeHookInput, recordEvent } from "../src/capture.js";
import { distillSession } from "../src/extract.js";

const MARK = "zebra-quokka-output";

describe("encryption toggle and captured data", () => {
  test("enable seals plaintext capture outputs and capture notes; disable opens them again; the distiller reads both", () => {
    const dir = mkdtempSync(join(tmpdir(), "om-capenc-"));
    try {
      const db = join(dir, "state.db");
      let s = new Store(db);
      const steps: Array<[any, Record<string, unknown>]> = [
        ["user-prompt", { prompt: "fix the test" }],
        ["post-tool", { tool_name: "Bash", tool_input: { command: "npm test" }, tool_response: { stdout: `ℹ fail 1 ${MARK}` } }],
        ["post-tool", { tool_name: "Edit", tool_input: { file_path: "/w/a.ts" }, tool_response: {} }],
        ["post-tool", { tool_name: "Bash", tool_input: { command: "npm test" }, tool_response: { stdout: "ℹ fail 0" } }],
        ["stop", {}],
      ];
      steps.forEach(([ev, raw], i) => recordEvent(s, normalizeHookInput(ev, { session_id: "s1", cwd: "/w", ...raw }, new Date(Date.now() - 60_000 + i * 1000)), "default"));
      distillSession(s, "s1");
      const outputs = (st: Store) => st.captureDb().prepare("SELECT output, output_enc FROM capture_events WHERE output <> '' OR output_enc IS NOT NULL").all() as Array<{ output: string; output_enc: string | null }>;
      const captured = (st: Store) => st.list({ kinds: ["observation", "summary"], limit: 50 }).notes;
      assert.ok(outputs(s).length >= 2 && outputs(s).every((r) => r.output_enc === null));
      const before = captured(s).map((n) => [n.id, n.body]);
      assert.ok(before.length >= 2);
      s.close();

      const key = ensureKey(dir);
      s = new Store(db);
      s.encryptAll(key);
      assert.ok(outputs(s).every((r) => r.output === "" && r.output_enc && !r.output_enc.includes(MARK)), "every output sealed");
      assert.ok(captured(s).every((n) => n.encrypted === true), "capture notes sealed like any note");
      assert.deepEqual(captured(s).map((n) => [n.id, n.body]), before, "and still read back");
      assert.equal(s.encryptAll(key), 0, "idempotent");
      // The distiller reads the sealed outputs (a re-distill rebuilds the same summary).
      const sum = captured(s).find((n) => n.kind === "summary")!;
      distillSession(s, "s1");
      assert.equal(s.read(sum.id)!.body, sum.body);
      s.close();
      assert.ok(!readFileSync(db).includes(MARK), "no plaintext output left in the file");

      s = new Store(db);
      s.decryptAll(key);
      s.close();
      rmSync(join(dir, ".key"));
      s = new Store(db);
      assert.ok(outputs(s).every((r) => r.output_enc === null && r.output !== ""), "every output open again");
      assert.ok(outputs(s).some((r) => r.output.includes(MARK)));
      assert.deepEqual(captured(s).map((n) => [n.id, n.body]), before);
      s.close();
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});
