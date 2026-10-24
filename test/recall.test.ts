import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSummary, buildHookOutput, runRecall } from "../src/recall.js";
import { UNTRUSTED_BANNER } from "../src/security.js";
import { Store } from "../src/store.js";
import type { NoteRecord } from "../src/store.js";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, "..", "src", "cli.js"); // dist/src/cli.js

function fakeNote(over: Partial<NoteRecord> = {}): NoteRecord {
  return {
    id: 1,
    namespace: "default",
    title: "Title",
    body: "Body",
    tags: [],
    rev: 1,
    source: "",
    written_by: "",
    created_by: "",
    created_at: "2026-10-16T00:00:00.000Z",
    updated_at: "2026-10-16T00:00:00.000Z",
    access_count: 0,
    last_accessed: null,
    ...over,
  };
}

describe("recall: buildSummary (pure)", () => {
  test("empty notes -> empty string", () => {
    assert.equal(buildSummary([]), "");
  });

  test("one note -> header + title + body snippet", () => {
    const out = buildSummary([fakeNote({ title: "Ship date", body: "We ship on Thursdays." })]);
    assert.equal(out, "Recent memory (1 note):\n- [Ship date]: We ship on Thursdays.");
  });

  test("multiple notes -> plural header, one line each", () => {
    const out = buildSummary([
      fakeNote({ title: "A", body: "alpha" }),
      fakeNote({ title: "B", body: "beta" }),
    ]);
    assert.equal(out, "Recent memory (2 notes):\n- [A]: alpha\n- [B]: beta");
  });

  test("body is truncated to ~200 chars", () => {
    const out = buildSummary([fakeNote({ title: "Long", body: "x".repeat(500) })]);
    const line = out.split("\n")[1];
    assert.ok(line.length <= "- [Long]: ".length + 200);
    assert.ok(line.includes("x".repeat(200)));
  });

  test("whitespace is collapsed, missing body has no dangling colon", () => {
    const out = buildSummary([
      fakeNote({ title: "  Spaced\nTitle ", body: "  line1\n\nline2  " }),
      fakeNote({ title: "Bare", body: "" }),
    ]);
    assert.ok(out.includes("- [Spaced Title]: line1 line2"));
    assert.ok(out.includes("- [Bare]") && !out.includes("[Bare]:"));
  });

  test("output is capped well under 8000 chars", () => {
    const notes = Array.from({ length: 100 }, (_, i) =>
      fakeNote({ title: `Note ${i}`, body: "y".repeat(500) })
    );
    const out = buildSummary(notes);
    assert.ok(out.length <= 8000, `length was ${out.length}`);
  });
});

describe("recall: hook JSON shape", () => {
  test("buildHookOutput has the exact nested Claude Code form", () => {
    const parsed = JSON.parse(buildHookOutput("hello"));
    assert.deepEqual(parsed, {
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "hello" },
    });
  });

  test("runRecall resolves valid JSON with hookEventName SessionStart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "onememory-recall-"));
    try {
      const store = new Store(join(dir, "state.db"));
      store.create({ title: "Pref", body: "Keep replies short." });
      store.close();
      const out = await runRecall({ dbPath: join(dir, "state.db") });
      const parsed = JSON.parse(out);
      assert.equal(parsed.hookSpecificOutput.hookEventName, "SessionStart");
      assert.ok(parsed.hookSpecificOutput.additionalContext.includes("Pref"));
      assert.ok(parsed.hookSpecificOutput.additionalContext.includes("Keep replies short."));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("recall: fail-silent", () => {
  test("runRecall never throws on a bogus DB path, returns empty context JSON", async () => {    const out = await runRecall({ dbPath: "/nonexistent-dir-xyz/db.sqlite" });
    const parsed = JSON.parse(out);
    assert.equal(parsed.hookSpecificOutput.hookEventName, "SessionStart");
    assert.equal(parsed.hookSpecificOutput.additionalContext, "");
  });

  test("CLI: bogus ONEMEMORY_DB_PATH -> exit 0, valid JSON on stdout", () => {
    const r = spawnSync(process.execPath, [CLI, "recall"], {
      env: { ...process.env, ONEMEMORY_DB_PATH: "/nonexistent-dir-xyz/db.sqlite" },
      encoding: "utf8",
      timeout: 15000,
    });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.hookSpecificOutput.hookEventName, "SessionStart");
    assert.equal(parsed.hookSpecificOutput.additionalContext, "");
  });

  test("CLI: --budget-ms 1 against a real DB still exits 0 fast with valid JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "onememory-recall-"));
    try {
      const store = new Store(join(dir, "state.db"));
      for (let i = 0; i < 20; i++) store.create({ title: `N${i}`, body: `body ${i}` });
      store.close();
      const started = Date.now();
      const r = spawnSync(process.execPath, [CLI, "recall", "--budget-ms", "1"], {
        env: { ...process.env, ONEMEMORY_DB_PATH: join(dir, "state.db") },
        encoding: "utf8",
        timeout: 15000,
      });
      const elapsed = Date.now() - started;
      assert.equal(r.status, 0, `stderr: ${r.stderr}`);
      const parsed = JSON.parse(r.stdout);
      assert.equal(parsed.hookSpecificOutput.hookEventName, "SessionStart");
      assert.ok(typeof parsed.hookSpecificOutput.additionalContext === "string");
      assert.ok(elapsed < 10000, `took ${elapsed}ms`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("CLI: garbage flag values fall back to defaults, exit 0", () => {
    const r = spawnSync(process.execPath, [CLI, "recall", "--budget-ms", "abc", "--limit", "0"], {
      env: { ...process.env, ONEMEMORY_DB_PATH: "/nonexistent-dir-xyz/db.sqlite" },
      encoding: "utf8",
      timeout: 15000,
    });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    JSON.parse(r.stdout); // must still be valid JSON
  });
});

describe("recall: namespace isolation (regression)", () => {
  const SPACES_KEY = "ONEMEMORY_SPACES";

  function setSpaces(value: string | undefined): string | undefined {
    const prev = process.env[SPACES_KEY];
    if (value === undefined) delete process.env[SPACES_KEY];
    else process.env[SPACES_KEY] = value;
    return prev;
  }

  function restoreSpaces(prev: string | undefined): void {
    if (prev === undefined) delete process.env[SPACES_KEY];
    else process.env[SPACES_KEY] = prev;
  }

  /** Seeds a temp DB with notes in two namespaces; returns the DB path. */
  function seedTwoNamespaces(): string {
    const dir = mkdtempSync(join(tmpdir(), "onememory-recall-ns-"));
    const dbFile = join(dir, "state.db");
    const store = new Store(dbFile);
    store.create({ title: "ProjA note", body: "alpha secret", namespace: "proj-a" });
    store.create({ title: "Shared note", body: "beta public", namespace: "shared" });
    store.close();
    return dbFile;
  }

  function contextOf(hookJson: string): string {
    return (JSON.parse(hookJson).hookSpecificOutput.additionalContext) as string;
  }

  test("configured namespaces -> recall scoped to the resolved namespace (no leak)", async () => {
    const dbFile = seedTwoNamespaces();
    const prev = setSpaces(
      JSON.stringify({
        spaces: { [process.cwd()]: "proj-a" },
        default_namespace: "shared",
      })
    );
    try {
      const ctx = contextOf(await runRecall({ dbPath: dbFile }));
      assert.ok(ctx.includes("ProjA note"), `resolved note missing: ${ctx}`);
      assert.ok(
        !ctx.includes("Shared note"),
        `cross-namespace LEAK — unscoped note present: ${ctx}`
      );
    } finally {
      restoreSpaces(prev);
      rmSync(dirname(dbFile), { recursive: true, force: true });
    }
  });

  test("unresolvable config (ambiguous overlap) -> loud stderr + empty context, NOT unscoped", async () => {
    const dbFile = seedTwoNamespaces();
    const cwd = process.cwd();
    // Two equal-depth patterns matching the cwd but mapping to different
    // namespaces -> resolveNamespace() throws (ambiguous overlap).
    const prev = setSpaces(
      JSON.stringify({
        spaces: { [cwd]: "ns-a", [cwd + "/*"]: "ns-b" },
        default_namespace: "shared",
      })
    );
    const errors: string[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map((a) => String(a)).join(" "));
    };
    try {
      const ctx = contextOf(await runRecall({ dbPath: dbFile }));
      assert.equal(
        ctx,
        "",
        `must not leak unscoped notes when resolution fails, got: ${ctx}`
      );
      assert.ok(
        errors.some((m) => m.includes("NAMESPACE RESOLUTION FAILED")),
        `expected loud stderr warning, got: ${JSON.stringify(errors)}`
      );
    } finally {
      console.error = origError;
      restoreSpaces(prev);
      rmSync(dirname(dbFile), { recursive: true, force: true });
    }
  });

  test("invalid configured namespaces -> loud stderr + empty context, NOT unscoped", async () => {
    const dbFile = seedTwoNamespaces();
    const prev = setSpaces(JSON.stringify({ spaces: { "/x": "ns" } })); // missing default_namespace
    const errors: string[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map((a) => String(a)).join(" "));
    };
    try {
      const ctx = contextOf(await runRecall({ dbPath: dbFile }));
      assert.equal(
        ctx,
        "",
        `must not leak unscoped notes on invalid config, got: ${ctx}`
      );
      assert.ok(
        errors.some((m) => m.includes("NAMESPACE RESOLUTION FAILED")),
        `expected loud stderr warning, got: ${JSON.stringify(errors)}`
      );
    } finally {
      console.error = origError;
      restoreSpaces(prev);
      rmSync(dirname(dbFile), { recursive: true, force: true });
    }
  });

  test("hook output wraps injected notes with the untrusted-data banner", async () => {
    const dir = mkdtempSync(join(tmpdir(), "onememory-recall-banner-"));
    const dbFile = join(dir, "state.db");
    try {
      const store = new Store(dbFile);
      store.create({ title: "Inject", body: "try to ignore me", namespace: "proj-a" });
      store.close();
      // Feature off (legacy unscoped recall) — the banner must still be
      // present: the injection risk is in the notes, not the scoping.
      const prev = setSpaces(undefined);
      try {
        const ctx = contextOf(await runRecall({ dbPath: dbFile }));
        assert.ok(
          ctx.startsWith(UNTRUSTED_BANNER),
          `banner missing from hook output: ${ctx.slice(0, 120)}`
        );
        assert.ok(ctx.includes("Inject"));
      } finally {
        restoreSpaces(prev);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("empty recall still yields empty context (no banner noise)", async () => {
    const prev = setSpaces(undefined);
    try {
      const ctx = contextOf(await runRecall({ dbPath: "/nonexistent-dir-xyz/db.sqlite" }));
      assert.equal(ctx, "");
    } finally {
      restoreSpaces(prev);
    }
  });
});
