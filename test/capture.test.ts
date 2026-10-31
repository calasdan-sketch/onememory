// capture.ts: hook payload -> redacted, truncated capture event; settings; spool.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { ensureKey } from "../src/crypto.js";
import {
  captureSettings,
  globMatch,
  normalizeHookInput,
  shouldCapture,
  recordEvent,
  spoolEvent,
  drainSpool,
  captureBacklog,
  SPOOL_MAX_TRIES,
  spoolSize,
  FIELD_MAX,
  SPOOL_FILE,
} from "../src/capture.js";

const SECRET = "AKIAIOSFODNN7EXAMPLE";

describe("normalizeHookInput", () => {
  test("a Bash post-tool payload: command in, stdout+stderr out, redacted", () => {
    const ev = normalizeHookInput("post-tool", {
      session_id: "s",
      cwd: "/w",
      tool_name: "Bash",
      tool_input: { command: `curl -H ${SECRET}` },
      tool_response: { stdout: "out", stderr: "err" },
    });
    assert.equal(ev.tool, "Bash");
    assert.ok(!ev.input.includes(SECRET));
    assert.match(ev.input, /REDACTED:AWS access key/);
    assert.equal(ev.output, "out\nerr");
    assert.equal(ev.ok, true);
  });
  test("a failure carries the error and ok=false; huge fields are cut to 4 KB; <private> is gone", () => {
    const f = normalizeHookInput("post-tool-failure", { session_id: "s", tool_name: "Bash", tool_input: { command: "x" }, error: "boom" });
    assert.equal(f.ok, false);
    assert.equal(f.output, "boom");
    const big = normalizeHookInput("user-prompt", { session_id: "s", prompt: "a".repeat(100_000) });
    assert.equal(big.input.length, FIELD_MAX);
    assert.equal(big.bytes, 100_000);
    const p = normalizeHookInput("user-prompt", { session_id: "s", prompt: "keep <private>my password plan</private> this" });
    assert.equal(p.input, "keep  this");
  });
  test("garbage payloads become an empty event that is not captured", () => {
    for (const raw of [null, 3, "x", [1], {}]) {
      const ev = normalizeHookInput("post-tool", raw);
      assert.equal(shouldCapture(ev, { enabled: true, exclude: [], skipTools: [] }), false);
    }
  });
});

describe("capture settings", () => {
  test("env wins over capture.json; own tools, skipped tools and excluded folders are not captured", () => {
    const dir = mkdtempSync(join(tmpdir(), "om-cap-s-"));
    try {
      writeFileSync(join(dir, "capture.json"), JSON.stringify({ capture: "off", exclude: ["**/secret"], skip_tools: ["TodoWrite"] }));
      assert.equal(captureSettings(dir, {}).enabled, false);
      const s = captureSettings(dir, { ONEMEMORY_CAPTURE: "on" });
      assert.equal(s.enabled, true);
      assert.deepEqual(s.exclude, ["**/secret"]);
      assert.deepEqual(captureSettings(dir, { ONEMEMORY_CAPTURE_SKIP_TOOLS: "A, B" }).skipTools, ["A", "B"]);
      const base = { session_id: "s", cwd: "/home/me/app", event: "post-tool" as const, tool: "Read", input: "", output: "", ok: true, bytes: 0, at: "" };
      assert.equal(shouldCapture(base, s), true);
      assert.equal(shouldCapture({ ...base, tool: "mcp__onememory__state_read" }, s), false);
      assert.equal(shouldCapture({ ...base, tool: "TodoWrite" }, s), false);
      assert.equal(shouldCapture({ ...base, cwd: "/home/me/secret" }, s), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test("globMatch: * is one segment, ** any depth, Windows paths and case", () => {
    assert.ok(globMatch("/a/*/c", "/a/b/c"));
    assert.ok(!globMatch("/a/*/c", "/a/b/x/c"));
    assert.ok(globMatch("/a/**", "/a/b/x/c"));
    assert.ok(globMatch("C:/Clients/**", "c:\\clients\\acme", "win32"));
    assert.ok(!globMatch("C:/Clients/**", "c:\\clients\\acme", "linux"));
  });
});

describe("recordEvent and the spool", () => {
  test("stores the event, opens the session once, seals the output when encryption is on", () => {
    const dir = mkdtempSync(join(tmpdir(), "om-cap-r-"));
    try {
      ensureKey(dir);
      const s = new Store(join(dir, "state.db"));
      const ev = normalizeHookInput("post-tool", { session_id: "s1", cwd: "/w", tool_name: "Read", tool_input: { file_path: "/w/a.ts" }, tool_response: "secret file text" });
      assert.equal(recordEvent(s, ev, "ns").newSession, true);
      assert.equal(recordEvent(s, normalizeHookInput("user-prompt", { session_id: "s1", prompt: "hi" }), "ns").newSession, false);
      const db = s.captureDb();
      const row = db.prepare("SELECT output, output_enc FROM capture_events WHERE tool = 'Read'").get() as { output: string; output_enc: string | null };
      assert.equal(row.output, "");
      assert.ok(row.output_enc && !row.output_enc.includes("secret file text"));
      const sess = db.prepare("SELECT namespace, event_count, prompt_count FROM sessions WHERE id = 's1'").get() as Record<string, unknown>;
      assert.deepEqual({ ...sess }, { namespace: "ns", event_count: 2, prompt_count: 1 });
      s.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test("drainSpool stores every spooled event and removes the file; torn lines are dropped", () => {
    const dir = mkdtempSync(join(tmpdir(), "om-cap-d-"));
    try {
      const ev = normalizeHookInput("user-prompt", { session_id: "s9", cwd: "/w", prompt: "later" });
      assert.ok(spoolEvent(dir, { ...ev, namespace: "default" }));
      assert.ok(spoolEvent(dir, { ...ev, namespace: "default" }));
      writeFileSync(join(dir, SPOOL_FILE), '{"torn', { flag: "a" });
      assert.ok(spoolSize(dir) > 0);
      const s = new Store(join(dir, "state.db"));
      assert.equal(drainSpool(s, dir), 2);
      assert.ok(!existsSync(join(dir, SPOOL_FILE)));
      assert.equal((s.captureDb().prepare("SELECT COUNT(*) AS n FROM capture_events").get() as { n: number }).n, 2);
      assert.equal(captureBacklog(s), 2, "doctor's backlog: both events still wait to be distilled");
      s.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test("an event that never stores is dropped after SPOOL_MAX_TRIES drains; a killed drain's file is adopted", () => {
    const dir = mkdtempSync(join(tmpdir(), "om-cap-b-"));
    try {
      const ev = normalizeHookInput("user-prompt", { session_id: "s8", cwd: "/w", prompt: "x" });
      spoolEvent(dir, { ...ev, namespace: "default" });
      const broken = new Store(join(dir, "broken.db"));
      broken.close(); // every recordEvent now throws
      for (let i = 1; i < SPOOL_MAX_TRIES; i++) {
        assert.equal(drainSpool(broken, dir), 0);
        assert.equal(JSON.parse(readFileSync(join(dir, SPOOL_FILE), "utf8")).tries, i);
      }
      drainSpool(broken, dir);
      assert.ok(!existsSync(join(dir, SPOOL_FILE)), "dropped, not cycled forever");
      assert.equal(spoolSize(dir), 0);
      const orphan = join(dir, `${SPOOL_FILE}.999-0.draining`);
      writeFileSync(orphan, JSON.stringify({ ...ev, namespace: "default" }) + "\n");
      const s = new Store(join(dir, "state.db"));
      assert.equal(drainSpool(s, dir), 0, "a fresh .draining file belongs to a running drain");
      utimesSync(orphan, new Date(Date.now() - 3600_000), new Date(Date.now() - 3600_000));
      assert.equal(drainSpool(s, dir), 1);
      assert.ok(!existsSync(orphan));
      s.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
