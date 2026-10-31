// The distrust list is enforced by ONE gate (Store.readVisible for a note by id, Store.filterVisible /
// the SQL predicate for sets). This file fails when a new read route or a new raw store read appears
// that nobody has classified, so a future route cannot quietly bypass the gate (the 1.4.0 review found
// four such routes: tags-only update echo, task replay, the janitor and the vault export).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Store } from "../src/store.js";
import { actorStore } from "../src/actor.js";
import { createApiServer } from "../src/api.js";
import { createMcpServer } from "../src/mcp-server-core.js";
import { putTask, writeHandoff } from "../src/tasks.js";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src");
const as = <T>(label: string, fn: () => T): T => actorStore.run({ label, authed: true }, fn);
const read = (f: string): string => readFileSync(join(SRC, f), "utf8");

/**
 * Every raw read of notes outside store.ts: `.read(` / `.exportAll(` / `.exportBatch(` on ANY receiver (an alias,
 * `this.s.read(`, `deps.store.read(` all match), each carrying a `// gate-ok: <reason>` comment on the same line.
 * The reasons are listed here per file, so the check is keyed on the call site and not on a count: adding a read, or
 * swapping one safe read for an unsafe one in the same file, changes the list and fails.
 */
const RAW_SITE_RE = /\.(read|exportAll|exportBatch)\(/;
const GATE_OK = "// gate-ok: ";
const EXPECTED_SITES: Record<string, string[]> = {
  "api.ts": [
    "access probe: denyUnreadable/readVisible decide before anything is returned",
    "PUT: namespace check, then a hidden note reads as 404",
    "tag-guard lookup only (no content returned)",
    "archive/restore: denyUnwritable probe, hidden note is 404",
    "GET /export is admin-only (a full backup)",
  ],
  "cli.ts": [
    "local shell command (reindex): the operator owns the database file",
    "local shell command (show): the operator owns the database file",
    "local shell command (lint scan): the operator owns the database file",
    "local shell command (export): the operator owns the database file",
  ],
  "consolidate.ts": [
    "admin consolidation by ids: mixed trusted/distrusted sources are refused below",
    "candidate scan is filtered with store.filterVisible before use",
    "re-read of an id the pool already admitted",
  ],
  "mcp-server-core.ts": [
    "tag-guard lookup only (no content returned)",
    "access probe: readVisible decides before anything is returned",
    "admin delete: namespace check only",
    "consolidation candidates (admin): filtered with filterVisible",
    "consolidation candidates (admin): filtered with filterVisible",
    "admin consolidate: namespace check only",
  ],
  "setup.ts": ["setup reads back the test note it wrote a moment ago"],
  "sync.ts": [
    "the vault export skips hidden notes itself (hiddenIds) unless --include-distrusted",
    "existence check only (deleted here?)",
    "import merge-base lookup: compares hashes, returns nothing to a caller",
  ],
  "extract.ts": ["the capture writer re-reads its own summary note"],
  "llm.ts": ["the capture writer re-reads its own summary note"],
  "progressive.ts": ["access probe: readVisible decides before anything is returned"],
  "tasks.ts": [
    "requireTaskRef: a distrusted task reads as absent",
    "cycle check walks parent ids only",
    "putTask update: visibility is checked on the next lines (distrusted is TaskNotFoundError)",
    "claimTask: distrusted tasks are refused on the next line",
    "approveTask: distrusted tasks are refused on the next line",
    "finishCommandTask: runner-internal, writes a result, returns nothing",
  ],
};

/** The raw-read call sites in a source text: [line number, text of the line]. Comment-only lines are ignored. */
export function rawSites(text: string): Array<[number, string]> {
  const out: Array<[number, string]> = [];
  text.split("\n").forEach((line, i) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
    if (RAW_SITE_RE.test(line.split(GATE_OK)[0])) out.push([i + 1, line]);
  });
  return out;
}

/** Unconditional `includeDistrusted: true` (not behind a `? { includeDistrusted: true } : {}` pass-through of an admin-gated flag), per file. */
const INTERNAL_OPT_IN: Record<string, number> = { "api.ts": 1, "liveness.ts": 2, "mcp-server-core.ts": 1, "runner.ts": 2, "tasks.ts": 2 };

describe("B: one gate for reading a note", () => {
  test("the scanner itself: it matches aliased receivers and ignores comments (positive control)", () => {
    const sample = [
      "const a = store.read(1);",
      "const b = s.read(2); // gate-ok: x",
      "const c = this.s.read(3);",
      "const d = deps.store.exportAll({ live: true });",
      "const e = self.store.exportBatch(0, 10);",
      "// store.read(99) in a comment",
      " * store.read(98) in a doc block",
      "const f = readFileSync(p);",
    ].join("\n");
    assert.deepEqual(rawSites(sample).map(([n]) => n), [1, 2, 3, 4, 5]);
  });

  test("no module reads notes raw without a reviewed, reasoned call site", () => {
    const files = readdirSync(SRC).filter((f) => f.endsWith(".ts") && f !== "store.ts");
    const seen: Record<string, string[]> = {};
    const unmarked: string[] = [];
    for (const f of files) {
      for (const [n, line] of rawSites(read(f))) {
        const i = line.indexOf(GATE_OK);
        if (i < 0) unmarked.push(`${f}:${n}  ${line.trim().slice(0, 100)}`);
        else (seen[f] ??= []).push(line.slice(i + GATE_OK.length).trim());
      }
    }
    assert.deepEqual(unmarked, [], "raw read without a `// gate-ok: <reason>` marker: route it through store.readVisible / filterVisible (or the SQL predicate), or mark it and list it in EXPECTED_SITES");
    for (const f of Object.keys(seen)) seen[f].sort();
    const expected = Object.fromEntries(Object.entries(EXPECTED_SITES).map(([f, v]) => [f, [...v].sort()]));
    assert.deepEqual(seen, expected, "the set of reviewed raw reads changed: update EXPECTED_SITES in test/trust-gate-guard.test.ts with the reason it is safe");
  });

  test("no SQL on the notes table outside store.ts, and no new unconditional includeDistrusted opt-in", () => {
    const files = readdirSync(SRC).filter((f) => f.endsWith(".ts") && f !== "store.ts");
    const sql: string[] = [];
    const optIn: Record<string, number> = {};
    for (const f of files) {
      const t = read(f);
      if (/\b(?:FROM|JOIN|UPDATE|INTO)\s+notes\b/i.test(t)) sql.push(f);
      const n = t.split("\n").filter((l) => /includeDistrusted: ?true/.test(l) && !/\? \{ includeDistrusted: true \} : \{\}/.test(l) && !/^\s*\/\//.test(l)).length;
      if (n) optIn[f] = n;
    }
    // backup.ts only counts the notes of the COPY it just made.
    assert.deepEqual(sql.sort(), ["backup.ts"], "SQL on the notes table belongs in store.ts, behind the gate");
    assert.deepEqual(optIn, INTERNAL_OPT_IN, "an unconditional includeDistrusted: true was added or removed: review it, then update INTERNAL_OPT_IN");
  });

  test("every HTTP GET route and every MCP tool is classified", () => {
    const api = read("api.ts");
    const routes = new Set<string>();
    for (const m of api.matchAll(/req\.method === "GET" && \(?path === "([^"]+)"/g)) routes.add(m[1]);
    if (/req\.method === "GET" && idMatch/.test(api)) routes.add("/notes/:id");
    if (/req\.method === "GET" && getId/.test(api)) routes.add("/tasks/:id");
    if (/req\.method === "GET" && SIGN_PAGES\[path\]/.test(api)) routes.add("(sign pages)");
    if (/req\.method === "GET" && sessMatch/.test(api)) routes.add("/sessions/:id");
    const NOTE_ROUTES = ["/notes", "/notes/:id", "/search", "/stats", "/changes", "/tasks", "/tasks/:id", "/handoffs", "/catch-up", "/export", "/index", "/timeline", "/sessions", "/sessions/:id", "/files/timeline"];
    const NO_NOTE_CONTENT = ["/health", "/ready", "/", "/dashboard.js", "(sign pages)", "/runner/status", "/trust"];
    assert.deepEqual([...routes].sort(), [...NOTE_ROUTES, ...NO_NOTE_CONTENT].sort(), "a GET route was added: add it to NOTE_ROUTES (and to the canary test below) or NO_NOTE_CONTENT");

    const mcp = read("mcp-server-core.ts");
    const tools = new Set<string>([...mcp.matchAll(/server\.registerTool\(\s*"([a-z_]+)"/g)].map((m) => m[1]));
    const NOTE_TOOLS = ["state_read", "state_search", "state_relevant", "state_list", "memory_stats", "memory_consolidation_candidates", "memory_since", "task_get", "task_list", "catch_up", "memory_ack", "memory_history", "memory_index", "memory_timeline", "memory_get", "session_list"];
    const OTHER_TOOLS = ["state_write", "state_delete", "memory_consolidate", "memory_rebuild_edges", "task_put", "task_claim", "task_approve", "session_handoff", "memory_quarantine", "runner_status", "trust_policy", "memory_supersede_preview", "memory_supersede_confirm", "memory_supersede_undo", "memory_restore_version", "memory_history_purge"];
    assert.deepEqual([...tools].sort(), [...NOTE_TOOLS, ...OTHER_TOOLS].sort(), "an MCP tool was added: classify it here (and canary-test it below if it returns note content)");
  });
});

describe("B: the canary never reaches a non-admin reader through any classified read route", () => {
  /** Seed one namespace: the evil writer's notes/tasks/handoff (hidden) next to good, trusted ones (the positive controls). */
  function seed(): { s: Store; CANARY: string; evilNote: number; evilTask: number; goodNote: number; goodTask: number } {
    const s = new Store(":memory:");
    const CANARY = "CANARYQX7";
    const e = as("evil", () => s.create({ namespace: "work", title: `${CANARY} title`, body: `${CANARY} body zebra` }));
    as("evil", () => putTask(s, { title: `${CANARY} task`, namespace: "work" }));
    const et = as("evil", () => putTask(s, { title: `${CANARY} task two`, namespace: "work" })).task;
    as("evil", () => writeHandoff(s, { surface: "evil-box", summary: `${CANARY} summary`, namespace: "work" }));
    as("evil", () => s.create({ namespace: "work", title: `${CANARY} twin`, body: `${CANARY} body zebra` }));
    const g = as("good", () => s.create({ namespace: "work", title: "plain", body: "zebra but fine" }));
    const gt = as("good", () => putTask(s, { title: "plain task", namespace: "work" })).task;
    as("good", () => writeHandoff(s, { surface: "good-box", summary: "plain summary", namespace: "work" }));
    for (let i = 0; i < 3; i++) s.touch(e.id);
    s.distrustAdd("work", "evil");
    return { s, CANARY, evilNote: e.id, evilTask: et.id, goodNote: g.id, goodTask: gt.id };
  }

  test("HTTP: GET routes (a trusted marker must show up where the route lists things)", async () => {
    const { s, CANARY, evilNote, evilTask, goodNote, goodTask } = seed();
    const TOKEN = "r".repeat(32);
    const WTOKEN = "w".repeat(32);
    const server = createApiServer(s, [
      { token: TOKEN, scope: "read", label: "reader" },
      { token: WTOKEN, scope: "write", label: "writer" },
    ]);
    await new Promise<void>((r) => server.listen(0, r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      // [path, expected status, text that MUST be in the body (positive control; "" = none)]
      const routes: Array<[string, number, string]> = [
        ["/notes?namespace=work", 200, "plain"],
        [`/notes/${evilNote}`, 404, ""],
        [`/notes/${goodNote}`, 200, "zebra but fine"],
        ["/search?q=zebra&namespace=work", 200, "plain"],
        ["/stats?namespace=work", 200, "totalNotes"],
        ["/changes?since=1h&namespace=work", 200, "plain"],
        ["/tasks?namespace=work", 200, "plain task"],
        [`/tasks/${evilTask}`, 404, ""],
        [`/tasks/${goodTask}`, 200, "plain task"],
        ["/handoffs?namespace=work", 200, "good-box"],
        ["/catch-up?namespace=work&consumer=zz", 200, "plain"],
        ["/index?namespace=work", 200, "plain"],
        ["/index?q=zebra&namespace=work", 200, "plain"],
        [`/timeline?anchor=${goodNote}`, 200, "plain"],
        [`/timeline?anchor=${evilNote}`, 200, ""],
        ["/sessions?namespace=work", 200, "sessions"],
        ["/files/timeline?path=src/x.ts", 200, "rows"],
      ];
      for (const [p, status, must] of routes) {
        const r = await fetch(base + p, { headers: { Authorization: `Bearer ${TOKEN}` } });
        const text = await r.text();
        assert.equal(r.status, status, `${p} -> ${r.status}: ${text.slice(0, 120)}`);
        assert.ok(!text.includes(CANARY), `${p} leaked the canary: ${text.slice(0, 200)}`);
        if (must) assert.ok(text.includes(must), `${p} did not return the trusted marker ${JSON.stringify(must)} (a typo'd route or argument would pass the leak check by returning nothing): ${text.slice(0, 200)}`);
      }
      // /stats counts: the hidden notes are not counted for a non-admin
      const st = (await (await fetch(`${base}/stats?namespace=work`, { headers: { Authorization: `Bearer ${TOKEN}` } })).json()) as { totalNotes: number };
      assert.equal(st.totalNotes, 3 /* plain note + plain task + good handoff; the 5 evil ones are not counted */, "totalNotes excludes the hidden notes for a non-admin");
      const rel = await fetch(`${base}/relevant`, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify({ message: "zebra", namespace: "work" }) });
      const relText = await rel.text();
      assert.ok(!relText.includes(CANARY));
      assert.ok(relText.includes("plain"), "/relevant returns the trusted note");
      // write routes echo content too: a hidden id is a 404, never an echo
      const put = await fetch(`${base}/notes/${evilNote}`, { method: "PUT", headers: { Authorization: `Bearer ${WTOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify({ tags: ["x"] }) });
      assert.equal(put.status, 404);
      assert.ok(!(await put.text()).includes(CANARY));
      const post = await fetch(`${base}/notes`, { method: "POST", headers: { Authorization: `Bearer ${WTOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify({ title: "fresh", body: "zebra", namespace: "work" }) });
      assert.equal(post.status, 201);
      assert.ok(!(await post.text()).includes(CANARY));
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      s.close();
    }
  });

  test("MCP: note-returning tools, with an admin client for the admin-only ones", async () => {
    const { s, CANARY, evilNote, evilTask, goodNote, goodTask } = seed();
    const connect = async (scope: "write" | "admin") => {
      const server = createMcpServer(s, scope, {}, { label: scope === "admin" ? "boss" : "good", authed: true });
      const [c1, c2] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "t", version: "1" });
      await Promise.all([client.connect(c1), server.connect(c2)]);
      return client;
    };
    const writer = await connect("write");
    const admin = await connect("admin");
    try {
      // [client, tool, args, expect an error result, text that MUST be in the result]
      const calls: Array<[Client, string, Record<string, unknown>, boolean, string]> = [
        [writer, "state_read", { id: evilNote }, true, ""],
        [writer, "state_read", { id: goodNote }, false, "zebra but fine"],
        [writer, "state_search", { query: "zebra", namespace: "work" }, false, "plain"],
        [writer, "state_relevant", { message: "zebra", namespace: "work" }, false, "plain"],
        [writer, "state_list", { namespace: "work" }, false, "plain"],
        [writer, "memory_stats", { namespace: "work" }, false, "totalNotes"],
        [writer, "memory_consolidation_candidates", { namespace: "work", threshold: 0.5 }, true, "admin"],
        [admin, "memory_consolidation_candidates", { namespace: "work", threshold: 0.5 }, false, ""],
        [writer, "memory_since", { since: "1h", namespace: "work" }, false, "plain"],
        [writer, "task_get", { id: evilTask }, true, ""],
        [writer, "task_get", { id: goodTask }, false, "plain task"],
        [writer, "task_list", { namespace: "work" }, false, "plain task"],
        [writer, "catch_up", { namespace: "work", consumer: "zz" }, false, "plain"],
        [writer, "memory_ack", { consumer: "zz", namespace: "work", ack_token: "bogus" }, true, ""],
        [writer, "memory_index", { namespace: "work" }, false, "plain"],
        [writer, "memory_index", { query: "zebra", namespace: "work" }, false, "plain"],
        [writer, "memory_timeline", { anchor: goodNote }, false, "plain"],
        [writer, "memory_timeline", { anchor: evilNote }, false, ""],
        [writer, "memory_get", { ids: [evilNote, goodNote] }, false, "zebra but fine"],
        [writer, "session_list", { namespace: "work" }, false, "sessions"],
        [writer, "state_write", { id: evilNote, tags: ["x"] }, true, ""],
        [writer, "state_write", { title: "fresh", body: "zebra", namespace: "work" }, false, "fresh"],
      ];
      for (const [client, name, args, wantError, must] of calls) {
        const r: any = await client.callTool({ name, arguments: args });
        const text = JSON.stringify(r);
        assert.ok(!text.includes(CANARY), `${name} leaked the canary: ${text.slice(0, 200)}`);
        assert.equal(Boolean(r.isError), wantError, `${name} ${JSON.stringify(args)}: unexpected ${r.isError ? "error" : "success"}: ${text.slice(0, 160)}`);
        if (must) assert.ok(text.includes(must), `${name} did not return ${JSON.stringify(must)}: ${text.slice(0, 200)}`);
      }
    } finally {
      await writer.close();
      await admin.close();
      s.close();
    }
  });
});

describe("docs name every MCP tool", () => {
  test("SKILL.md frontmatter and docs/architecture.md list every registered tool", () => {
    const mcp = read("mcp-server-core.ts");
    const tools = [...mcp.matchAll(/server\.registerTool\(\s*"([a-z_]+)"/g)].map((m) => m[1]);
    assert.ok(tools.length >= 20);
    const root = join(SRC, "..");
    const skill = readFileSync(join(root, "SKILL.md"), "utf8");
    const front = skill.slice(0, skill.indexOf("\n---", 4));
    const arch = readFileSync(join(root, "docs", "architecture.md"), "utf8");
    for (const t of tools) {
      assert.ok(front.includes(t), `SKILL.md frontmatter does not list ${t}`);
      assert.ok(arch.includes(`| \`${t}\``), `docs/architecture.md has no table row for ${t}`);
    }
  });
});

