// `onememory hook <event>` is fail-open: whatever goes wrong it exits 0, prints nothing or one valid hook JSON object,
// and keeps the (redacted) event in the spool instead of losing it or blocking the agent.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { Store, SCHEMA_VERSION } from "../src/store.js";
import { SPOOL_FILE } from "../src/capture.js";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.js");
const SECRET = "AKIAIOSFODNN7EXAMPLE";

function hook(home: string, event: string, stdin: string, env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [CLI, "hook", event], { input: stdin, env: { ...process.env, ONEMEMORY_HOME: home, ...env }, encoding: "utf8", timeout: 20_000 });
}
const payload = (o: Record<string, unknown> = {}): string =>
  JSON.stringify({ session_id: "sess-1", cwd: "C:/work/app", tool_name: "Bash", tool_input: { command: `echo ${SECRET}` }, tool_response: { stdout: "ok" }, ...o });

/** stdout is empty or exactly one JSON object. */
function validOut(stdout: string): void {
  const t = stdout.trim();
  if (!t) return;
  const v = JSON.parse(t) as unknown;
  assert.ok(v && typeof v === "object" && !Array.isArray(v), t);
}
function spooled(home: string): string[] {
  const p = join(home, SPOOL_FILE);
  return existsSync(p) ? readFileSync(p, "utf8").split("\n").filter(Boolean) : [];
}

describe("hook fail-open", () => {
  test("garbage stdin: exit 0, valid output, for every event", () => {
    const home = mkdtempSync(join(tmpdir(), "om-hook-g-"));
    try {
      for (const ev of ["session-start", "user-prompt", "post-tool", "post-tool-failure", "stop", "subagent-stop", "session-end", "file-context", "no-such-event"]) {
        for (const stdin of ["", "{not json", "[1,2]", "null", "\u0000\u0001"]) {
          const r = hook(home, ev, stdin);
          assert.equal(r.status, 0, `${ev} ${JSON.stringify(stdin)}: ${r.stderr}`);
          validOut(r.stdout);
          if (ev === "session-start") assert.match(r.stdout, /"hookEventName":"SessionStart"/);
          else assert.equal(r.stdout.trim(), "");
        }
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("no database yet: exit 0, the event is spooled (redacted), no database is created", () => {
    const home = mkdtempSync(join(tmpdir(), "om-hook-m-"));
    try {
      const r = hook(home, "post-tool", payload());
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout.trim(), "");
      assert.ok(!existsSync(join(home, "state.db")), "the hook never creates the database");
      const lines = spooled(home);
      assert.equal(lines.length, 1);
      assert.ok(!lines[0].includes(SECRET), "the spool holds only redacted text");
      assert.match(lines[0], /\[REDACTED:AWS access key\]/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a database at a newer (or older) schema is never opened for writing: spooled, file untouched", () => {
    const home = mkdtempSync(join(tmpdir(), "om-hook-n-"));
    try {
      const db = join(home, "state.db");
      new Store(db).close();
      const raw = new DatabaseSync(db);
      raw.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
      raw.close();
      const r = hook(home, "post-tool", payload());
      assert.equal(r.status, 0, r.stderr);
      assert.equal(Store.peekSchemaVersion(db), SCHEMA_VERSION + 1);
      assert.equal(spooled(home).length, 1);
      const s = hook(home, "session-start", payload());
      assert.equal(s.status, 0);
      validOut(s.stdout);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a locked database: spooled within the short lock wait; the next hook drains the spool", () => {
    const home = mkdtempSync(join(tmpdir(), "om-hook-l-"));
    try {
      const db = join(home, "state.db");
      new Store(db).close();
      const lock = new DatabaseSync(db);
      lock.exec("BEGIN IMMEDIATE");
      const t0 = Date.now();
      const r = hook(home, "post-tool", payload());
      const took = Date.now() - t0;
      lock.exec("ROLLBACK");
      lock.close();
      assert.equal(r.status, 0, r.stderr);
      assert.equal(spooled(home).length, 1);
      assert.ok(took < 10_000, `took ${took}ms`);
      // A new session drains the spool.
      const n = hook(home, "user-prompt", JSON.stringify({ session_id: "sess-2", cwd: "C:/work/app", prompt: "next" }));
      assert.equal(n.status, 0, n.stderr);
      assert.equal(spooled(home).length, 0);
      const raw = new DatabaseSync(db, { readOnly: true });
      const rows = raw.prepare("SELECT session_id, event, input FROM capture_events ORDER BY seq").all() as Array<{ session_id: string; event: string; input: string }>;
      raw.close();
      assert.deepEqual(rows.map((x) => x.session_id).sort(), ["sess-1", "sess-2"]);
      assert.ok(rows.every((x) => !x.input.includes(SECRET)));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("ONEMEMORY_CAPTURE=off records nothing; session-start still answers", () => {
    const home = mkdtempSync(join(tmpdir(), "om-hook-o-"));
    try {
      new Store(join(home, "state.db")).close();
      assert.equal(hook(home, "post-tool", payload(), { ONEMEMORY_CAPTURE: "off" }).status, 0);
      writeFileSync(join(home, "capture.json"), JSON.stringify({ capture: "off" }));
      assert.equal(hook(home, "post-tool", payload()).status, 0);
      const s = hook(home, "session-start", payload(), { ONEMEMORY_CAPTURE: "off" });
      assert.match(s.stdout, /SessionStart/);
      const raw = new DatabaseSync(join(home, "state.db"), { readOnly: true });
      assert.equal((raw.prepare("SELECT COUNT(*) AS n FROM capture_events").get() as { n: number }).n, 0);
      raw.close();
      assert.equal(spooled(home).length, 0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
