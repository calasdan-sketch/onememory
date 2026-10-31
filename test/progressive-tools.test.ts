// Progressive disclosure: memory_index / memory_timeline / memory_get / session_list over MCP, and the same answers over
// REST (GET /index, GET /timeline, POST /get, GET /sessions, GET /sessions/:id, GET /files/timeline, POST /capture).
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Store } from "../src/store.js";
import { createMcpServer } from "../src/mcp-server-core.js";
import { createApiServer } from "../src/api.js";
import { normalizeHookInput, recordEvent } from "../src/capture.js";
import { distillSession } from "../src/extract.js";

const ADMIN = "admin-token-progressive-0000000000";
const READ = "read-token-progressive-00000000000";
const WRITE = "write-token-progressive-0000000000";

function parse(result: any): any {
  const text = result.content[0].text as string;
  return JSON.parse(text.slice(text.indexOf("{")));
}

describe("progressive disclosure tools (MCP and REST parity)", () => {
  let store: Store;
  let client: Client;
  let server: ReturnType<typeof createApiServer>;
  let base: string;
  let fixId: number;
  const call = async (name: string, args: Record<string, unknown>) => parse(await client.callTool({ name, arguments: args }));
  const rest = async (path: string, init: RequestInit = {}, token = READ) => {
    const r = await fetch(base + path, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers ?? {}) } });
    return { status: r.status, body: (await r.json()) as any };
  };

  before(async () => {
    store = new Store(":memory:");
    store.create({ title: "Plain note about deploys", body: "we deploy on fridays" });
    const steps: Array<[any, Record<string, unknown>]> = [
      ["user-prompt", { prompt: "fix the date parser" }],
      ["post-tool", { tool_name: "Bash", tool_input: { command: "npm test" }, tool_response: { stdout: "ℹ fail 1" } }],
      ["post-tool", { tool_name: "Edit", tool_input: { file_path: "/w/src/date.ts" }, tool_response: {} }],
      ["post-tool", { tool_name: "Bash", tool_input: { command: "npm test" }, tool_response: { stdout: "ℹ fail 0" } }],
      ["post-tool", { tool_name: "Bash", tool_input: { command: 'git commit -m "feat: parse ISO weeks"' }, tool_response: { stdout: "ok" } }],
      ["stop", {}],
    ];
    steps.forEach(([ev, raw], i) => recordEvent(store, normalizeHookInput(ev, { session_id: "sess-a", cwd: "/w", ...raw }, new Date(Date.now() - 60_000 + i * 1000)), "default"));
    distillSession(store, "sess-a");
    fixId = store.list({ kinds: ["observation"], obsTypes: ["bugfix"] }).notes[0].id;
    const mcp = createMcpServer(store);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "t", version: "1" });
    await Promise.all([client.connect(ct), mcp.connect(st)]);
    server = createApiServer(store, [
      { token: ADMIN, scope: "admin", label: "op" },
      { token: READ, scope: "read", label: "reader" },
      { token: WRITE, scope: "write", label: "hook" },
    ]);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    await client.close();
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
  });

  test("memory_index: compact rows across kinds, filterable; GET /index answers the same", async () => {
    const all = await call("memory_index", {});
    const kinds = new Set(all.rows.map((r: any) => r.kind));
    assert.deepEqual([...kinds].sort(), ["note", "observation", "summary"]);
    const row = all.rows.find((r: any) => r.id === fixId);
    assert.deepEqual(Object.keys(row).sort(), ["date", "files", "id", "kind", "namespace", "title", "tokens", "type"]);
    assert.deepEqual(row.files, ["src/date.ts"]);
    assert.equal((await rest("/index")).body.rows.length, all.rows.length);
    const bug = await call("memory_index", { obs_type: "bugfix" });
    assert.deepEqual(bug.rows.map((r: any) => r.id), [fixId]);
    assert.deepEqual((await rest("/index?obs_type=bugfix")).body, bug);
    const byFile = await call("memory_index", { file: "src/date.ts" });
    assert.ok(byFile.rows.length >= 2 && byFile.rows.every((r: any) => r.files.includes("src/date.ts")));
    assert.deepEqual((await rest("/index?file=src/date.ts")).body, byFile);
    const q = await call("memory_index", { query: "deploys" });
    assert.equal(q.rows[0].kind, "note");
    assert.deepEqual((await rest("/index?q=deploys")).body, q);
    assert.equal((await call("memory_index", { kind: "summary" })).rows.length, 1);
    assert.match((await client.callTool({ name: "memory_index", arguments: { kind: "bogus" } }) as any).content[0].text, /error|Invalid/i);
  });

  test("memory_timeline: rows around an anchor, oldest first; GET /timeline answers the same", async () => {
    const t = await call("memory_timeline", { anchor: fixId, before: 2, after: 2 });
    assert.equal(t.anchor, fixId);
    assert.ok(t.rows.some((r: any) => r.id === fixId));
    const dates = t.rows.map((r: any) => r.date);
    assert.deepEqual(dates, [...dates].sort());
    assert.deepEqual((await rest(`/timeline?anchor=${fixId}&before=2&after=2`)).body, t);
    const bySession = await call("memory_timeline", { session: "sess-a" });
    assert.ok(bySession.rows.length >= 2);
    assert.deepEqual((await rest("/timeline?session=sess-a")).body, bySession);
  });

  test("memory_get: full notes with files, session and citation; at most 20 ids; POST /get with a read token", async () => {
    const g = await call("memory_get", { ids: [fixId, 999999] });
    assert.equal(g.notes.length, 1);
    assert.deepEqual(g.missing, [999999]);
    const n = g.notes[0];
    assert.equal(n.citation, `om:#${fixId}`);
    assert.equal(n.session.id, "sess-a");
    assert.deepEqual(n.files, [{ path: "src/date.ts", action: "changed" }]);
    const r = await rest("/get", { method: "POST", body: JSON.stringify({ ids: [fixId, 999999] }) });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.missing, [999999]);
    assert.equal(r.body.notes[0].citation, `om:#${fixId}`);
    assert.equal((await rest("/get", { method: "POST", body: JSON.stringify({ ids: Array.from({ length: 21 }, (_, i) => i + 1) }) })).status, 400);
    assert.equal((await client.callTool({ name: "memory_get", arguments: { ids: Array.from({ length: 21 }, (_, i) => i + 1) } }) as any).isError, true);
  });

  test("session_list and GET /sessions, /sessions/:id, /files/timeline", async () => {
    const l = await call("session_list", {});
    assert.equal(l.sessions.length, 1);
    assert.equal(l.sessions[0].id, "sess-a");
    assert.match(l.sessions[0].summary, /^Session: fix the date parser/);
    assert.deepEqual((await rest("/sessions")).body, l);
    const one = await call("session_list", { session: "sess-a" });
    assert.ok(one.rows.length >= 2 && one.summary.kind === "summary");
    assert.equal((await rest("/sessions/sess-a")).body.rows.length, one.rows.length);
    assert.deepEqual(one.prompts.map((p: any) => p.text), ["fix the date parser"], "the session's prompts come with its timeline");
    assert.deepEqual((await rest("/sessions/sess-a")).body.prompts, one.prompts);
    assert.equal((await rest("/sessions/nope")).status, 404);
    const ft = await rest("/files/timeline?path=src/date.ts");
    assert.deepEqual(ft.body.rows.map((r: any) => r.id), byIds(byFileRows(await call("memory_index", { file: "src/date.ts" }))));
    assert.equal((await rest("/files/timeline")).status, 400);
  });

  test("POST /capture: write scope, redacted again, distilled on stop, cannot join another namespace's session", async () => {
    const ev = (o: Record<string, unknown>) => ({ method: "POST", body: JSON.stringify({ session_id: "remote-1", cwd: "/r", ...o }) });
    assert.equal((await rest("/capture", ev({ event: "user-prompt", input: "x" }), READ)).status, 403);
    assert.equal((await rest("/capture", ev({ event: "nope" }), WRITE)).status, 400);
    assert.equal((await rest("/capture", ev({ event: "user-prompt", input: "let's go with tabs, key AKIAIOSFODNN7EXAMPLE" }), WRITE)).status, 202);
    assert.equal((await rest("/capture", ev({ event: "stop" }), WRITE)).status, 202);
    const raw = store.captureDb().prepare("SELECT input FROM capture_events WHERE session_id = 'remote-1'").all() as Array<{ input: string }>;
    assert.ok(raw.every((r) => !r.input.includes("AKIAIOSFODNN7EXAMPLE")));
    const dec = await call("memory_index", { session: "remote-1", obs_type: "decision" });
    assert.equal(dec.rows.length, 1);
    store.captureDb().prepare("UPDATE sessions SET namespace = 'other' WHERE id = 'remote-1'").run();
    assert.equal((await rest("/capture", ev({ event: "user-prompt", input: "y" }), WRITE)).status, 409);
  });
});

const byFileRows = (r: any): any[] => [...r.rows].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id - b.id));
const byIds = (rows: any[]): number[] => rows.map((r) => r.id);
