// v16 captured rows survive export -> import and vault sync: kind, session_id, obs_type, their files and their session.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, type ImportNote } from "../src/store.js";
import { normalizeHookInput, recordEvent } from "../src/capture.js";
import { distillSession } from "../src/extract.js";
import { exportMarkdown, importMarkdown } from "../src/sync.js";
import { sessionList, sessionGet } from "../src/progressive.js";

function captured(): Store {
  const s = new Store(":memory:");
  s.create({ title: "Plain note", body: "stays a note" });
  const steps: Array<[any, Record<string, unknown>]> = [
    ["user-prompt", { prompt: "fix the date parser" }],
    ["post-tool", { tool_name: "Bash", tool_input: { command: "npm test" }, tool_response: { stdout: "ℹ fail 1" } }],
    ["post-tool", { tool_name: "Edit", tool_input: { file_path: "/w/src/date.ts" }, tool_response: {} }],
    ["post-tool", { tool_name: "Bash", tool_input: { command: "npm test" }, tool_response: { stdout: "ℹ fail 0" } }],
    ["stop", {}],
  ];
  steps.forEach(([ev, raw], i) => recordEvent(s, normalizeHookInput(ev, { session_id: "sess-a", cwd: "/w", ...raw }, new Date(Date.now() - 60_000 + i * 1000)), "default"));
  distillSession(s, "sess-a");
  return s;
}
/** What must survive, per row, keyed by title. */
function shape(s: Store): Record<string, unknown> {
  const notes = s.list({ kinds: ["note", "observation", "summary"], limit: 100 }).notes;
  const files = s.noteFiles(notes.map((n) => n.id));
  return Object.fromEntries(notes.map((n) => [n.title, { kind: n.kind ?? "note", session_id: n.session_id ?? "", obs_type: n.obs_type ?? "", files: files.get(n.id) ?? [] }]));
}

describe("captured rows round-trip", () => {
  test("JSON export -> import keeps kind, session, type, files; the session and its summary come back", async () => {
    const a = captured();
    const want = shape(a);
    assert.ok(Object.values(want).some((v: any) => v.kind === "observation" && v.obs_type === "bugfix" && v.files.length), JSON.stringify(want));
    const dump = a.exportBatch(0, 500);
    assert.ok(dump.some((n: any) => n.kind === "observation" && Array.isArray(n.files) && n.files.length));
    assert.ok(dump.filter((n) => !n.kind).every((n: any) => n.files === undefined), "an ordinary note's export shape is unchanged");
    const b = new Store(":memory:");
    await b.importNotes(JSON.parse(JSON.stringify(dump)) as ImportNote[]);
    assert.deepEqual(shape(b), want);
    const l = sessionList(b, {}).sessions;
    assert.equal(l.length, 1);
    assert.equal(l[0].id, "sess-a");
    assert.match(l[0].summary ?? "", /^Session: fix the date parser/);
    assert.ok(sessionGet(b, {}, "sess-a")!.rows.length >= 2);
    a.close();
    b.close();
  });

  test("an import payload cannot invent a kind or malformed files: those become an ordinary note / are dropped", async () => {
    const b = new Store(":memory:");
    await b.importNotes([
      { title: "Odd kind", body: "x", kind: "admin", session_id: "s", obs_type: "bugfix" },
      { title: "Odd files", body: "y", kind: "observation", session_id: "s2", obs_type: "Bad Type!", files: [{ path: "ok.ts", action: "read" }, { path: 5, action: "read" }, { path: "x", action: "rm" }, null, "str"] },
    ] as ImportNote[]);
    const got = shape(b);
    assert.deepEqual(got["Odd kind"], { kind: "note", session_id: "", obs_type: "", files: [] });
    assert.deepEqual(got["Odd files"], { kind: "observation", session_id: "s2", obs_type: "", files: [{ path: "ok.ts", action: "read" }] });
    b.close();
  });

  test("vault sync: export to Markdown and import into another store keeps the captured fields", async () => {
    const dir = mkdtempSync(join(tmpdir(), "om-caprt-"));
    try {
      const a = captured();
      const want = shape(a);
      exportMarkdown(a, dir);
      const files = readdirSync(join(dir, "default")).map((f) => readFileSync(join(dir, "default", f), "utf8"));
      const plain = files.find((t) => t.includes('title: "Plain note"'))!;
      assert.doesNotMatch(plain, /^kind:/m, "an ordinary note's file is unchanged");
      assert.ok(files.some((t) => /^kind: "observation"$/m.test(t) && /^files: \[/m.test(t)));
      const b = new Store(":memory:");
      await importMarkdown(b, dir);
      assert.deepEqual(shape(b), want);
      assert.equal(sessionList(b, {}).sessions[0]?.id, "sess-a");
      a.close();
      b.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
