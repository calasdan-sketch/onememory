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

/** Every `store.read(` / `exportAll(` / `exportBatch(` call outside store.ts, with the reason it is not a leak. */
const RAW_READS: Record<string, { read?: number; exportAll?: number; exportBatch?: number; why: string }> = {
  "api.ts": {
    read: 4,
    exportBatch: 1,
    why: "read: access probes and write-path lookups that run AFTER readVisible/denyUnreadable has decided (GET /notes/:id, PUT, archive, restore use readVisible); exportBatch: GET /export is admin-only and takes a ?include/no-attest choice",
  },
  "cli.ts": { read: 1, exportAll: 1, exportBatch: 1, why: "local shell commands (reindex, export, show): whoever runs them already has the database file" },
  "consolidate.ts": { read: 2, exportAll: 1, why: "janitorPool filters through store.filterVisible; read: re-reads of ids the pool already admitted" },
  "mcp-server-core.ts": { read: 4, exportAll: 1, why: "read: probes behind readVisible/canRead; exportAll: consolidation candidates, filtered with filterVisible" },
  "sync.ts": { read: 2, exportAll: 1, why: "the vault export skips hidden notes itself (hiddenIds) unless --include-distrusted; read: merge-base lookups on import" },
  "tasks.ts": { read: 6, why: "internal task flows: getTask uses readVisible; the others are update paths that first check visibility (ckeyHit, TaskNotFoundError)" },
};

function count(text: string, re: RegExp): number {
  return [...text.matchAll(re)].length;
}

describe("B: one gate for reading a note", () => {
  test("no module reads notes raw without being on the reviewed list", () => {
    const files = readdirSync(SRC).filter((f) => f.endsWith(".ts") && f !== "store.ts" && !/^runner/.test(f));
    const seen: Record<string, { read: number; exportAll: number; exportBatch: number }> = {};
    for (const f of files) {
      const t = read(f);
      const c = {
        read: count(t, /\b(?:store|this\.store)\.read\(/g),
        exportAll: count(t, /\bstore\.exportAll\(/g),
        exportBatch: count(t, /\bstore\.exportBatch\(/g),
      };
      if (c.read || c.exportAll || c.exportBatch) seen[f] = c;
    }
    const expected = Object.fromEntries(Object.entries(RAW_READS).map(([f, e]) => [f, { read: e.read ?? 0, exportAll: e.exportAll ?? 0, exportBatch: e.exportBatch ?? 0 }]));
    assert.deepEqual(
      seen,
      expected,
      "a raw store read was added or removed. Route it through store.readVisible / filterVisible (or the SQL predicate), " +
        "then update RAW_READS in test/trust-gate-guard.test.ts with the reason it is safe."
    );
  });

  test("every HTTP GET route and every MCP tool is classified", () => {
    const api = read("api.ts");
    const routes = new Set<string>();
    for (const m of api.matchAll(/req\.method === "GET" && \(?path === "([^"]+)"/g)) routes.add(m[1]);
    if (/req\.method === "GET" && idMatch/.test(api)) routes.add("/notes/:id");
    if (/req\.method === "GET" && getId/.test(api)) routes.add("/tasks/:id");
    if (/req\.method === "GET" && SIGN_PAGES\[path\]/.test(api)) routes.add("(sign pages)");
    const NOTE_ROUTES = ["/notes", "/notes/:id", "/search", "/stats", "/changes", "/tasks", "/tasks/:id", "/handoffs", "/catch-up", "/export"];
    const NO_NOTE_CONTENT = ["/health", "/ready", "/", "/dashboard.js", "(sign pages)", "/runner/status", "/trust"];
    assert.deepEqual([...routes].sort(), [...NOTE_ROUTES, ...NO_NOTE_CONTENT].sort(), "a GET route was added: add it to NOTE_ROUTES (and to the canary test below) or NO_NOTE_CONTENT");

    const mcp = read("mcp-server-core.ts");
    const tools = new Set<string>([...mcp.matchAll(/server\.registerTool\(\s*"([a-z_]+)"/g)].map((m) => m[1]));
    const NOTE_TOOLS = ["state_read", "state_search", "state_relevant", "state_list", "memory_stats", "memory_consolidation_candidates", "memory_since", "task_get", "task_list", "catch_up", "memory_ack"];
    const OTHER_TOOLS = ["state_write", "state_delete", "memory_consolidate", "memory_rebuild_edges", "task_put", "task_claim", "task_approve", "session_handoff", "memory_quarantine", "runner_status", "trust_policy"];
    assert.deepEqual([...tools].sort(), [...NOTE_TOOLS, ...OTHER_TOOLS].sort(), "an MCP tool was added: classify it here (and canary-test it below if it returns note content)");
  });
});

describe("B: the canary never reaches a non-admin reader through any classified read route", () => {
  test("HTTP: GET routes", async () => {
    const s = new Store(":memory:");
    const CANARY = "CANARYQX7";
    const e = as("evil", () => s.create({ namespace: "work", title: `${CANARY} title`, body: `${CANARY} body zebra` }));
    as("evil", () => putTask(s, { title: `${CANARY} task`, namespace: "work" }));
    const et = as("evil", () => putTask(s, { title: `${CANARY} task two`, namespace: "work" })).task;
    as("evil", () => writeHandoff(s, { surface: "evil-box", summary: `${CANARY} summary`, namespace: "work" }));
    as("good", () => s.create({ namespace: "work", title: "plain", body: "zebra but fine" }));
    for (let i = 0; i < 3; i++) s.touch(e.id);
    s.distrustAdd("work", "evil");
    const TOKEN = "r".repeat(32);
    const server = createApiServer(s, [{ token: TOKEN, scope: "read", label: "reader" }]);
    await new Promise<void>((r) => server.listen(0, r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const paths = [
        "/notes?namespace=work",
        `/notes/${e.id}`,
        "/search?q=zebra&namespace=work",
        "/stats?namespace=work",
        "/changes?since=1h&namespace=work",
        "/tasks?namespace=work",
        `/tasks/${et.id}`,
        "/handoffs?namespace=work",
        "/catch-up?namespace=work&consumer=zz",
      ];
      for (const p of paths) {
        const r = await fetch(base + p, { headers: { Authorization: `Bearer ${TOKEN}` } });
        const text = await r.text();
        assert.ok(!text.includes(CANARY), `${p} leaked the canary: ${text.slice(0, 200)}`);
      }
      const rel = await fetch(`${base}/relevant`, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify({ message: "zebra", namespace: "work" }) });
      assert.ok(!(await rel.text()).includes(CANARY));
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      s.close();
    }
  });

  test("MCP: note-returning tools", async () => {
    const s = new Store(":memory:");
    const CANARY = "CANARYQX7";
    const e = as("evil", () => s.create({ namespace: "work", title: `${CANARY} title`, body: `${CANARY} body zebra` }));
    const et = as("evil", () => putTask(s, { title: `${CANARY} task`, namespace: "work" })).task;
    as("evil", () => writeHandoff(s, { surface: "evil-box", summary: `${CANARY} summary`, namespace: "work" }));
    as("evil", () => s.create({ namespace: "work", title: `${CANARY} twin`, body: `${CANARY} body zebra` }));
    as("good", () => s.create({ namespace: "work", title: "plain", body: "zebra but fine" }));
    for (let i = 0; i < 3; i++) s.touch(e.id);
    s.distrustAdd("work", "evil");
    const server = createMcpServer(s, "write", {}, { label: "good", authed: true });
    const [c1, c2] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "1" });
    await Promise.all([client.connect(c1), server.connect(c2)]);
    try {
      const calls: Array<[string, Record<string, unknown>]> = [
        ["state_read", { id: e.id }],
        ["state_search", { query: "zebra", namespace: "work" }],
        ["state_relevant", { message: "zebra", namespace: "work" }],
        ["state_list", { namespace: "work" }],
        ["memory_stats", { namespace: "work" }],
        ["memory_consolidation_candidates", { namespace: "work", threshold: 0.5 }],
        ["memory_since", { since: "1h", namespace: "work" }],
        ["task_get", { id: et.id }],
        ["task_list", { namespace: "work" }],
        ["catch_up", { namespace: "work", consumer: "zz" }],
        ["memory_ack", { consumer: "zz", namespace: "work", ack_token: "bogus" }],
        ["state_write", { id: e.id, tags: ["x"] }],
      ];
      for (const [name, args] of calls) {
        const r: any = await client.callTool({ name, arguments: args });
        const text = JSON.stringify(r);
        assert.ok(!text.includes(CANARY), `${name} leaked the canary: ${text.slice(0, 200)}`);
      }
    } finally {
      await client.close();
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

