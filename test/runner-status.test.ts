// "Runner offline, N commands waiting": the read-only status, its MCP/REST
// surfaces, the catch_up / recall notice, and that it never leaks other
// namespaces or command text.
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Store } from "../src/store.js";
import { putTask, approveTask, catchUp, buildBoardSummary } from "../src/tasks.js";
import { runnerStatus, runnerNotice, staleAfterSeconds } from "../src/runner-status.js";
import { createMcpServer } from "../src/mcp-server-core.js";
import { createApiServer } from "../src/api.js";

const SECRET_WORD = "zq-topsecret-param-9431";

function parseTool(r: any): any {
  const t: string = r.content[0].text;
  return JSON.parse(t.slice(t.indexOf("{")));
}

function heartbeat(store: Store, ageSec: number, now = Date.now()): void {
  const body = JSON.stringify({ kind: "heartbeat", alive_at: new Date(now - ageSec * 1000).toISOString(), host: "SECRET-HOST", pid: 4242 });
  const existing = store.list({ namespace: "runner", limit: 10 }).notes.find((n) => n.title === "runner heartbeat");
  if (existing) store.update(existing.id, { body });
  else store.create({ namespace: "runner", title: "runner heartbeat", body, tags: ["heartbeat"] });
}

function approvedTask(store: Store, ns: string, title = "t"): number {
  const t = putTask(store, { title, namespace: ns, command: { action: "hello", params: { p: SECRET_WORD } }, target: "pc-1" }).task;
  approveTask(store, { id: t.id, if_rev: store.read(t.id)!.rev });
  return t.id;
}

describe("runner status", () => {
  let store: Store;
  const prevTtl = process.env.ONEMEMORY_APPROVAL_TTL_SECONDS;
  const prevStale = process.env.ONEMEMORY_RUNNER_STALE_SECONDS;
  beforeEach(() => {
    store = new Store(":memory:");
    delete process.env.ONEMEMORY_RUNNER_STALE_SECONDS;
  });
  afterEach(() => {
    store.close();
    if (prevTtl === undefined) delete process.env.ONEMEMORY_APPROVAL_TTL_SECONDS;
    else process.env.ONEMEMORY_APPROVAL_TTL_SECONDS = prevTtl;
    if (prevStale === undefined) delete process.env.ONEMEMORY_RUNNER_STALE_SECONDS;
    else process.env.ONEMEMORY_RUNNER_STALE_SECONDS = prevStale;
  });

  test("online vs stale vs never seen", () => {
    assert.equal(runnerStatus(store).runner.state, "never_seen");
    heartbeat(store, 30);
    const on = runnerStatus(store);
    assert.equal(on.runner.state, "online");
    assert.ok(on.runner.age_seconds! >= 29 && on.runner.age_seconds! < 60);
    heartbeat(store, 3 * 3600);
    const off = runnerStatus(store);
    assert.equal(off.runner.state, "stale");
    assert.equal(off.runner.stale_after_seconds, 600);
    process.env.ONEMEMORY_RUNNER_STALE_SECONDS = "86400";
    assert.equal(runnerStatus(store).runner.state, "online", "threshold is configurable");
    assert.equal(staleAfterSeconds(), 86400);
  });

  test("zero waiting: no notice, even when the runner is offline", () => {
    heartbeat(store, 99999);
    const s = runnerStatus(store);
    assert.equal(s.waiting_total, 0);
    assert.deepEqual(s.namespaces, []);
    assert.equal(s.notice, undefined);
    assert.equal(runnerNotice(store), null);
    assert.equal(catchUp(store, { changes: false }).runner_notice, undefined);
  });

  test("waiting commands + stale runner: counts, oldest, notice; unapproved are not counted", () => {
    heartbeat(store, 2 * 3600);
    const a = approvedTask(store, "tasks");
    approvedTask(store, "tasks", "second");
    putTask(store, { title: "never approved", namespace: "tasks", command: { action: "hello" }, target: "pc-1" });
    const s = runnerStatus(store, undefined, Date.now() + 5000);
    assert.equal(s.waiting_total, 2);
    assert.equal(s.expired_total, 0);
    assert.equal(s.expiring_soon_total, 0, "24 h approvals are not expiring within the hour");
    assert.equal(s.namespaces.length, 1);
    assert.equal(s.namespaces[0].namespace, "tasks");
    assert.equal(s.namespaces[0].oldest_waiting_task_id, a);
    assert.ok(s.namespaces[0].oldest_waiting_seconds! >= 5);
    assert.match(s.notice!, /Runner offline \(last seen 2 h ago\): 2 approved commands waiting\./);
    assert.equal(catchUp(store, { changes: false }).runner_notice, runnerNotice(store));
    // online runner: counts stay, notice goes
    heartbeat(store, 10);
    const on = runnerStatus(store);
    assert.equal(on.waiting_total, 2);
    assert.equal(on.notice, undefined);
  });

  test("approvals expiring within the hour, and already expired, are counted", () => {
    process.env.ONEMEMORY_APPROVAL_TTL_SECONDS = "1800"; // 30 min
    heartbeat(store, 5 * 3600);
    approvedTask(store, "tasks");
    const soon = runnerStatus(store);
    assert.equal(soon.waiting_total, 1);
    assert.equal(soon.expiring_soon_total, 1);
    assert.match(soon.notice!, /1 expiring within 1 h/);
    const later = runnerStatus(store, undefined, Date.now() + 2 * 3600_000);
    assert.equal(later.waiting_total, 0);
    assert.equal(later.expired_total, 1);
    assert.equal(later.namespaces[0].expired, 1);
    assert.equal(later.notice, undefined, "nothing runnable is waiting, so no offline notice");
  });

  test("an approval voided by an edit is not counted", () => {
    heartbeat(store, 5 * 3600);
    const id = approvedTask(store, "tasks");
    putTask(store, { id, command: { action: "hello", params: { p: "other" } } });
    assert.equal(runnerStatus(store).waiting_total, 0);
  });

  test("namespace isolation: only the asked-for / readable namespaces are counted", () => {
    heartbeat(store, 5 * 3600);
    approvedTask(store, "alpha");
    approvedTask(store, "beta");
    approvedTask(store, "beta", "b2");
    const a = runnerStatus(store, ["alpha"]);
    assert.equal(a.waiting_total, 1);
    assert.deepEqual(a.namespaces.map((n) => n.namespace), ["alpha"]);
    assert.deepEqual(runnerStatus(store, []).namespaces, []);
    assert.equal(runnerStatus(store, ["gamma"]).waiting_total, 0);
    assert.equal(runnerStatus(store).waiting_total, 3);
  });

  test("the status never contains command text, params, target or heartbeat host", () => {
    heartbeat(store, 5 * 3600);
    approvedTask(store, "tasks");
    const all = JSON.stringify(runnerStatus(store)) + runnerNotice(store);
    for (const leak of [SECRET_WORD, "hello", "pc-1", "SECRET-HOST", "4242"]) assert.ok(!all.includes(leak), `leaked ${leak}`);
  });

  test("recall board line and backward compatible catch_up shape", () => {
    heartbeat(store, 5 * 3600);
    approvedTask(store, "tasks");
    const c = catchUp(store, { changes: false });
    assert.ok(Array.isArray(c.handoffs) && c.tasks.total >= 1, "existing fields intact");
    assert.match(c.runner_notice!, /1 approved command waiting/);
    assert.equal(buildBoardSummary([], null), "", "buildBoardSummary unchanged");
  });
});

describe("runner status surfaces", () => {
  async function mcp(store: Store, scope: "read" | "write" | "admin", opts: any = {}) {
    const server = createMcpServer(store, scope, opts);
    const [c, s] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "1.0.0" });
    await Promise.all([client.connect(c), server.connect(s)]);
    return client;
  }

  test("MCP: read scope can call it; first block is banner + JSON; no leaks", async () => {
    const store = new Store(":memory:");
    heartbeat(store, 5 * 3600);
    approvedTask(store, "tasks");
    const c = await mcp(store, "read");
    const r: any = await c.callTool({ name: "runner_status", arguments: {} });
    assert.ok(!r.isError);
    const j = parseTool(r);
    assert.equal(j.waiting_total, 1);
    assert.equal(j.runner.state, "stale");
    assert.ok(!r.content[0].text.includes(SECRET_WORD));
    const cu = parseTool(await c.callTool({ name: "catch_up", arguments: { include_changes: false } }));
    assert.match(cu.runner_notice, /Runner offline/);
    await c.close();
    store.close();
  });

  test("MCP: a namespace-resolved server only counts its readable namespaces", async () => {
    const store = new Store(":memory:");
    heartbeat(store, 5 * 3600);
    approvedTask(store, "mine");
    approvedTask(store, "theirs");
    approvedTask(store, "theirs", "t2");
    const c = await mcp(store, "read", { namespace: "mine", readsFrom: {} });
    const j = parseTool(await c.callTool({ name: "runner_status", arguments: { namespace: "theirs" } }));
    assert.equal(j.waiting_total, 1, "the namespace hint cannot widen the scope");
    assert.deepEqual(j.namespaces.map((n: any) => n.namespace), ["mine"]);
    await c.close();
    store.close();
  });

  test("REST: GET /runner/status needs a token, honours namespace, and is read-scope", async () => {
    const store = new Store(":memory:");
    heartbeat(store, 5 * 3600);
    approvedTask(store, "alpha");
    approvedTask(store, "beta");
    const server = createApiServer(store, [
      { token: "rd", scope: "read", label: "rd" },
      { token: "pinned", scope: "read", label: "pinned", namespace: "alpha" },
    ] as any);
    await new Promise<void>((r) => server.listen(0, r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const get = (p: string, tok?: string) => fetch(base + p, { headers: tok ? { Authorization: `Bearer ${tok}` } : {} });
    assert.equal((await get("/runner/status")).status, 401);
    assert.equal((await get("/runner/status", "wrong")).status, 401);
    const all: any = await (await get("/runner/status", "rd")).json();
    assert.equal(all.waiting_total, 2);
    assert.equal(all.runner.state, "stale");
    const one: any = await (await get("/runner/status?namespace=beta", "rd")).json();
    assert.deepEqual(one.namespaces.map((n: any) => n.namespace), ["beta"]);
    const pinned: any = await (await get("/runner/status?namespace=beta", "pinned")).json();
    assert.deepEqual(pinned.namespaces.map((n: any) => n.namespace), ["alpha"], "a pinned token cannot look at another namespace");
    assert.ok(!JSON.stringify(all).includes(SECRET_WORD));
    // read-only: POST is not a thing
    assert.notEqual((await fetch(base + "/runner/status", { method: "POST", headers: { Authorization: "Bearer rd" } })).status, 200);
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
  });
});
