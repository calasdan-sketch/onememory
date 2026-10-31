// The project profile, "why was this shown?" tags with never-show, and the token / footprint meter.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import type { AddressInfo } from "node:net";
import { Store } from "../src/store.js";
import { injectContext, projectProfile, setNeverShow, profileTokens, WHY_LEGEND } from "../src/context-inject.js";
import { meterAdd, meterStats, meterLine } from "../src/meter.js";
import { llmSummarize } from "../src/llm.js";
import { createApiServer } from "../src/api.js";
import { DASHBOARD_HTML, DASHBOARD_JS } from "../src/dashboard.js";
import { NEVER_SHOW_TAG } from "../src/reserved-tags.js";
import { putTask } from "../src/tasks.js";

const noGit = { branch: "", diffFiles: [] };
const daysAgo = (d: number): string => new Date(Date.now() - d * 86_400_000).toISOString();

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const prev = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) if (v === undefined) delete process.env[k];
  else process.env[k] = v;
  return fn().finally(() => {
    for (const [k, v] of Object.entries(prev)) if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  });
}

function seed(): Store {
  const s = new Store(":memory:");
  const d = s.create({ title: "Decision: use node:sqlite, no native deps", body: "decided" }, { kind: "observation", sessionId: "s", obsType: "decision" });
  s.create({ title: "Two-space indent, double quotes", body: "style", tags: ["convention"] });
  const o = s.create({ title: "Edited the store", body: "x" }, { kind: "observation", sessionId: "s", obsType: "change" });
  for (const id of [d.id, o.id]) s.captureDb().prepare("INSERT INTO note_files (note_id, path, action) VALUES (?, 'src/store.ts', 'changed')").run(id);
  s.create({ title: "Session: refactor the store", body: "Request: refactor" }, { kind: "summary", sessionId: "s" });
  putTask(s, { title: "Write the migration" });
  return s;
}

describe("project profile", () => {
  test("decisions, conventions, key files, last session and open tasks, deterministic, first in the pack", async () => {
    const s = seed();
    const p = projectProfile(s, {}, s.list({ kinds: ["summary"], limit: 1 }).notes[0], 1200);
    assert.match(p, /^What I know about this project:\n/);
    assert.match(p, /Decisions: use node:sqlite, no native deps/);
    assert.match(p, /Conventions: Two-space indent, double quotes/);
    assert.match(p, /Key files: src\/store\.ts \(2\)/);
    assert.match(p, /Last session: Session: refactor the store/);
    assert.match(p, /Open tasks: 1 \(on the board\)/);
    assert.equal(projectProfile(s, {}, null, 1200), projectProfile(s, {}, null, 1200), "deterministic");
    const text = await injectContext(s, { signals: noGit });
    assert.ok(text.startsWith("What I know about this project:"), text.slice(0, 80));
    s.close();
  });

  test("hard cap, the off switch, and never-show rows stay out of it", async () => {
    const s = seed();
    const small = projectProfile(s, {}, null, 90);
    assert.ok(small.length <= 90, small);
    assert.match(small, /Decisions:/);
    assert.equal(profileTokens({}), 300);
    assert.equal(profileTokens({ ONEMEMORY_PROFILE_TOKENS: "50" }), 50);
    assert.equal(profileTokens({ ONEMEMORY_PROFILE: "off" }), 0);
    await withEnv({ ONEMEMORY_PROFILE: "off" }, async () => assert.doesNotMatch(await injectContext(s, { signals: noGit }), /What I know/));
    const dec = s.list({ kinds: ["observation"], obsTypes: ["decision"] }).notes[0];
    setNeverShow(s, dec.id, true);
    assert.doesNotMatch(projectProfile(s, {}, null, 1200), /Decisions/);
    s.close();
  });
});

describe("why was this shown? / never show again", () => {
  test("each line carries a compact reason tag, explained once by a legend", async () => {
    const s = new Store(":memory:");
    const old = s.create({ title: "Tokenizer handles CJK input", body: "codepoints", created_at: daysAgo(20) }, { updatedAt: daysAgo(20), kind: "observation", sessionId: "x", obsType: "feature" });
    s.captureDb().prepare("INSERT INTO note_files (note_id, path, action) VALUES (?, 'src/tokenizer.ts', 'changed')").run(old.id);
    s.create({ title: "A plain note", body: "remember this" });
    const text = await injectContext(s, { signals: { branch: "feat/tokenizer", diffFiles: ["src/tokenizer.ts"] } });
    assert.match(text, new RegExp(`#${old.id} \\[feature\\] Tokenizer handles CJK input \\([^)]*\\) \\{kw,files(,recent)? 20d\\}`));
    assert.match(text, /- \[A plain note\] \{recent 0d\}: remember this/);
    assert.equal(text.split(WHY_LEGEND).length, 2, "one legend");
    s.close();
  });

  test("a never-show note is skipped by injection (all signals), stays readable, and can be shown again", async () => {
    const s = new Store(":memory:");
    const n = s.create({ title: "Tokenizer noise", body: "unhelpful" }, { kind: "observation", sessionId: "x", obsType: "change" });
    s.captureDb().prepare("INSERT INTO note_files (note_id, path, action) VALUES (?, 'src/tokenizer.ts', 'changed')").run(n.id);
    s.create({ title: "Keep me", body: "useful" });
    const signals = { branch: "feat/tokenizer", diffFiles: ["src/tokenizer.ts"] };
    assert.match(await injectContext(s, { signals }), /Tokenizer noise/);
    assert.ok(setNeverShow(s, n.id, true)!.tags.includes(NEVER_SHOW_TAG));
    const text = await injectContext(s, { signals });
    assert.doesNotMatch(text, /Tokenizer noise/);
    assert.match(text, /Keep me/);
    assert.ok(s.read(n.id), "still stored");
    setNeverShow(s, n.id, false);
    assert.match(await injectContext(s, { signals }), /Tokenizer noise/);
    assert.equal(setNeverShow(s, 9999, true), null);
    s.close();
  });

  test("dashboard: a never-show button on each note PUTs the tag", async () => {
    assert.match(DASHBOARD_HTML, /onclick="loadMeter\(\)"[^>]*>Meter</);
    const puts: Array<{ path: string; body: string }> = [];
    const els = new Map<string, any>();
    const el = (id: string): any => {
      if (!els.has(id)) els.set(id, { value: "", style: {}, textContent: "", innerHTML: "", checked: false, addEventListener() {}, focus() {}, appendChild() {} });
      return els.get(id);
    };
    const ctx: any = {
      document: { getElementById: el, createElement: () => ({ style: {} }) },
      sessionStorage: { getItem: () => "", setItem() {}, removeItem() {} },
      alert() {},
      confirm: () => true,
      setTimeout,
      clearTimeout,
      encodeURIComponent,
      fetch: async (path: string, opts: any) => {
        if (opts?.method === "PUT") puts.push({ path, body: opts.body });
        const json = path.startsWith("/notes/7") ? { note: { id: 7, rev: 3, tags: ["a"] } } : { notes: [] };
        return { ok: true, status: 200, json: async () => json };
      },
    };
    vm.createContext(ctx);
    vm.runInContext(DASHBOARD_JS, ctx);
    ctx.render([{ id: 7, title: "t", namespace: "default", tags: ["a"], body: "" }]);
    assert.match(el("list").innerHTML, /onclick='neverShow\(7,true\)'>never show</);
    ctx.neverShow(7, true);
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(puts, [{ path: "/notes/7", body: JSON.stringify({ tags: ["a", NEVER_SHOW_TAG], if_rev: 3 }) }]);
  });
});

describe("token & footprint meter", () => {
  test("a metered session start records injected and saved tokens; no session id, no record; numbers only", async () => {
    const s = seed();
    await injectContext(s, { signals: noGit });
    assert.equal(meterStats(s).totals.sessions, 0, "not metered without a session id");
    const text = await injectContext(s, { signals: noGit, sessionId: "sess-1" });
    await injectContext(s, { signals: noGit, sessionId: "sess-1" });
    const m = meterStats(s);
    assert.equal(m.totals.sessions, 1);
    assert.equal(m.totals.injections, 2);
    assert.equal(m.totals.injected_tokens, 2 * Math.ceil(text.length / 4));
    assert.ok(m.totals.saved_tokens >= 0);
    assert.equal(m.totals.llm_tokens, 0);
    assert.equal(m.recent[0].session_id, "sess-1");
    assert.ok(m.db_bytes > 0);
    assert.deepEqual(Object.keys(m.recent[0]).sort(), ["injected_tokens", "injections", "llm_tokens", "namespace", "saved_tokens", "session_id", "updated_at"]);
    assert.match(meterLine(m), /footprint: 1 session\(s\), ~\d+ tokens injected \(2 time\(s\)\)/);
    s.close();
  });

  test("namespace scoping and capture events", () => {
    const s = new Store(":memory:");
    meterAdd(s, "a", "proj-a", { injected: 10, saved: 90 });
    meterAdd(s, "b", "proj-b", { injected: 5 });
    s.captureDb().prepare("INSERT INTO sessions (id, namespace, started_at) VALUES ('a', 'proj-a', '2026-10-31')").run();
    s.captureDb().prepare("INSERT INTO capture_events (session_id, at, event) VALUES ('a', '2026-10-31', 'user-prompt')").run();
    assert.equal(meterStats(s).totals.injected_tokens, 15);
    const a = meterStats(s, ["proj-a"]);
    assert.deepEqual([a.totals.injected_tokens, a.totals.saved_tokens, a.capture_events], [10, 90, 1]);
    assert.equal(meterStats(s, []).totals.sessions, 0);
    assert.equal(meterStats(s, ["proj-b"]).capture_events, 0);
    s.close();
  });

  test("the local model's tokens are counted; 0 when it is off", async () => {
    const s = new Store(":memory:");
    const sum = s.create({ title: "Session: x", body: "Request: x" }, { kind: "summary", sessionId: "llm-1" });
    s.captureDb().prepare("INSERT INTO sessions (id, namespace, started_at, summary_note_id) VALUES ('llm-1', 'default', '2026-10-31', ?)").run(sum.id);
    assert.equal(await llmSummarize(s, "llm-1", {}), false);
    assert.equal(meterStats(s).totals.llm_tokens, 0);
    const { createServer } = await import("node:http");
    const srv = createServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: "Tidy title\nDid the thing." } }] }));
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    try {
      const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
      assert.equal(await llmSummarize(s, "llm-1", { ONEMEMORY_LLM_URL: url, ONEMEMORY_LLM_MODEL: "m" }), true);
      assert.ok(meterStats(s).totals.llm_tokens > 0);
    } finally {
      srv.close();
      s.close();
    }
  });

  test("GET /stats carries the meter", async () => {
    const s = new Store(":memory:");
    meterAdd(s, "a", "default", { injected: 12, saved: 30 });
    const server = createApiServer(s, "tok-meter-test");
    await new Promise<void>((r) => server.listen(0, r));
    try {
      const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/stats`, { headers: { authorization: "Bearer tok-meter-test" } });
      const j: any = await res.json();
      assert.equal(res.status, 200);
      assert.equal(j.meter.totals.injected_tokens, 12);
      assert.equal(j.meter.totals.saved_tokens, 30);
      assert.equal(typeof j.meter.db_bytes, "number");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      s.close();
    }
  });
});
