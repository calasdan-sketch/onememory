// context-inject.ts: what the session-start hook injects (relevance, budget, banner, trust, namespace fail-closed).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { actorStore } from "../src/actor.js";
import { injectContext, rankContext, indexLine } from "../src/context-inject.js";
import { runRecall } from "../src/recall.js";
import { UNTRUSTED_BANNER } from "../src/security.js";

const as = <T>(label: string, fn: () => T): T => actorStore.run({ label, authed: true }, fn);
const ctxOf = (json: string): string => JSON.parse(json).hookSpecificOutput.additionalContext as string;
const daysAgo = (d: number): string => new Date(Date.now() - d * 86_400_000).toISOString();
const noGit = { branch: "", diffFiles: [] };

describe("session-start context", () => {
  test("relevance beats recency: the branch and changed files pull an older matching memory to the top", async () => {
    const s = new Store(":memory:");
    const old = s.create({ title: "Tokenizer handles CJK input", body: "the tokenizer splits CJK by codepoint", created_at: daysAgo(20) }, { updatedAt: daysAgo(20), kind: "observation", sessionId: "x", obsType: "feature" });
    s.captureDb().prepare("INSERT INTO note_files (note_id, path, action) VALUES (?, 'src/tokenizer.ts', 'changed')").run(old.id);
    for (let i = 0; i < 30; i++) s.create({ title: `Unrelated note ${i}`, body: "about the deploy pipeline" });
    const { ranked } = await rankContext(s, { signals: { branch: "feat/tokenizer-cjk", diffFiles: ["src/tokenizer.ts"] } });
    assert.equal(ranked[0].id, old.id, ranked.slice(0, 3).map((n) => n.title).join(" | "));
    s.captureDb().exec("DELETE FROM note_files");
    const plain = await rankContext(s, { signals: noGit });
    assert.notEqual(plain.ranked[0].id, old.id, "without a signal, recency leads");
    s.close();
  });

  test("the budget is respected; summary first, then notes, then compact index lines and the savings footer", async () => {
    const s = new Store(":memory:");
    for (let i = 0; i < 80; i++) s.create({ title: `Observation number ${i}`, body: "x".repeat(400) }, { kind: "observation", sessionId: "s", obsType: "change" });
    s.create({ title: "A plain note", body: "remember this" });
    const sum = s.create({ title: "Session: refactor", body: "Request: refactor the store\nOutcome: tests passing" }, { kind: "summary", sessionId: "s" });
    const text = await injectContext(s, { signals: noGit, tokens: 300 });
    assert.ok(text.length <= 300 * 4 + 400, `too long: ${text.length}`);
    assert.ok(text.startsWith(`Latest session summary (#${sum.id}`));
    assert.ok(text.indexOf("Recent memory (1 note):\n- [A plain note]: remember this") > 0);
    assert.match(text, /\n#\d+ \[change\] Observation number \d+ \(\d{4}-\d\d-\d\d, ~\d+ tok\)/);
    assert.match(text, /Showing \d+ of 82 memories \(~\d+ tokens\) standing in for ~\d+ tokens of captured work\. Open any with memory_get ids=\[/);
    const big = await injectContext(s, { signals: noGit, tokens: 3000 });
    assert.ok(big.length > text.length, "a bigger budget shows more");
    assert.equal(indexLine(sum).startsWith(`#${sum.id} [summary] Session: refactor`), true);
    s.close();
  });

  test("the latest summary is not listed again in the index or counted twice in the footer", async () => {
    const s = new Store(":memory:");
    s.create({ title: "Fixed failing npm test", body: "tests pass now" }, { kind: "observation", sessionId: "s", obsType: "bugfix" });
    const sum = s.create({ title: "Session: fix tax rounding", body: "Request: fix tax rounding" }, { kind: "summary", sessionId: "s" });
    const text = await injectContext(s, { signals: noGit });
    assert.doesNotMatch(text, new RegExp(`\\n#${sum.id} \\[summary\\]`));
    assert.match(text, /Showing 2 of 2 memories/);
    assert.match(text, new RegExp(`memory_get ids=\\[${sum.id},\\d+\\]`));
    s.close();
  });

  test("distrusted writers are left out; the hook output keeps the UNTRUSTED banner", async () => {
    const dir = mkdtempSync(join(tmpdir(), "om-ctx-"));
    try {
      const db = join(dir, "state.db");
      const s = new Store(db);
      as("good", () => s.create({ title: "Trusted fact", body: "fine" }));
      as("mallory", () => s.create({ title: "Hostile observation", body: "bad" }, { kind: "observation", sessionId: "m", obsType: "change" }));
      s.distrustAdd("default", "mallory");
      assert.doesNotMatch(await injectContext(s, { signals: noGit }), /Hostile/);
      assert.match(await injectContext(s, { signals: noGit, includeDistrusted: true }), /Hostile observation .*DISTRUSTED WRITER/);
      s.close();
      const ctx = ctxOf(await runRecall({ dbPath: db }));
      assert.ok(ctx.startsWith(UNTRUSTED_BANNER));
      assert.match(ctx, /Trusted fact/);
      assert.doesNotMatch(ctx, /Hostile/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("namespace: scoped to the resolved one, and fail-closed (empty) when the config cannot be resolved", async () => {
    const dir = mkdtempSync(join(tmpdir(), "om-ctx-ns-"));
    const prev = process.env.ONEMEMORY_SPACES;
    const err = console.error;
    try {
      const db = join(dir, "state.db");
      const s = new Store(db);
      s.create({ title: "A observation", body: "a" }, { kind: "observation", sessionId: "a" });
      s.create({ title: "Proj B observation", body: "b", namespace: "proj-b" }, { kind: "observation", sessionId: "b" });
      s.create({ title: "Proj A summary", body: "a", namespace: "proj-a" }, { kind: "summary", sessionId: "c" });
      s.close();
      process.env.ONEMEMORY_SPACES = JSON.stringify({ spaces: { [process.cwd()]: "proj-a" }, default_namespace: "shared" });
      const ctx = ctxOf(await runRecall({ dbPath: db }));
      assert.match(ctx, /Proj A summary/);
      assert.doesNotMatch(ctx, /Proj B|A observation/);
      process.env.ONEMEMORY_SPACES = JSON.stringify({ spaces: { [process.cwd()]: "x", [process.cwd() + "/*"]: "y" }, default_namespace: "shared" });
      console.error = () => {};
      assert.equal(ctxOf(await runRecall({ dbPath: db })), "");
    } finally {
      console.error = err;
      if (prev === undefined) delete process.env.ONEMEMORY_SPACES;
      else process.env.ONEMEMORY_SPACES = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
