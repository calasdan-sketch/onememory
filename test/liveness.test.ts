// "Runner offline, N commands waiting": the read-only status, its MCP/REST
// surfaces, the catch_up / recall notice, and that it never leaks other
// namespaces or command text.
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Store } from "../src/store.js";
import { putTask, approveTask, catchUp, buildBoardSummary, classifyQueuedCommand, scanWaitingCommands } from "../src/tasks.js";
import { runRecall } from "../src/recall.js";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { runnerStatus, runnerNotice, staleAfterSeconds, clearRunnerStatusCache } from "../src/liveness.js";
import { createMcpServer } from "../src/mcp-server-core.js";
import { createApiServer } from "../src/api.js";

const SECRET_WORD = "zq-topsecret-param-9431";

function parseTool(r: any): any {
  const t: string = r.content[0].text;
  return JSON.parse(t.slice(t.indexOf("{")));
}

/** Move a note's server-side updated_at (what liveness trusts) `sec` into the past. */
function backdate(store: Store, id: number, sec: number): void {
  (store as any).db.prepare("UPDATE notes SET updated_at = ? WHERE id = ?").run(new Date(Date.now() - sec * 1000).toISOString(), id);
}

/**
 * A runner heartbeat as the real runner writes it: stamped written_by "runner"
 * by the server, with the machine name and task namespace it serves.
 */
function heartbeat(store: Store, ageSec: number, o: { ns?: string; runner?: string; writer?: string; body?: Record<string, unknown> } = {}): number {
  clearRunnerStatusCache(store);
  const writer = o.writer ?? "runner";
  const body = JSON.stringify({
    kind: "heartbeat",
    alive_at: new Date(Date.now() - ageSec * 1000).toISOString(),
    host: "SECRET-HOST",
    pid: 4242,
    runner: o.runner ?? "pc-1",
    task_namespace: o.ns ?? "tasks",
    heartbeat_ms: 180_000,
    ...(o.body ?? {}),
  });
  const existing = store.list({ namespace: "runner", limit: 10, writtenBy: writer }).notes.find((n) => n.title === "runner heartbeat");
  const rec = existing
    ? store.update(existing.id, { body }, { writtenBy: writer })!
    : store.create({ namespace: "runner", title: "runner heartbeat", body, tags: ["heartbeat"] }, { writtenBy: writer });
  backdate(store, rec.id, ageSec);
  return rec.id;
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
    assert.match(later.notice!, /^1 command approval expired before the runner took it \(re-approve\)\.$/, "expired shows, without an offline line");
    assert.doesNotMatch(later.notice!, /Runner offline/);
  });

  test("an approval voided by an edit is not counted", () => {
    heartbeat(store, 5 * 3600);
    const id = approvedTask(store, "tasks");
    putTask(store, { id, command: { action: "hello", params: { p: "other" } } });
    assert.equal(runnerStatus(store).waiting_total, 0);
  });

  test("namespace isolation: only the readable part of the runner's namespace is counted", () => {
    heartbeat(store, 5 * 3600, { ns: "beta" });
    approvedTask(store, "alpha");
    approvedTask(store, "beta");
    approvedTask(store, "beta", "b2");
    // alpha is not the namespace this runner serves: it can never run there
    assert.equal(runnerStatus(store).waiting_total, 2);
    assert.deepEqual(runnerStatus(store, ["beta"]).namespaces.map((n) => n.namespace), ["beta"]);
    assert.equal(runnerStatus(store, ["alpha"]).waiting_total, 0, "a reader of alpha only sees nothing of beta");
    assert.deepEqual(runnerStatus(store, []).namespaces, []);
    assert.equal(runnerStatus(store, ["gamma"]).waiting_total, 0);
  });

  test("the status never contains command text, params or heartbeat host (a runner's NAME is shown, per target, since 1.4.0)", () => {
    heartbeat(store, 5 * 3600);
    approvedTask(store, "tasks");
    const st = runnerStatus(store);
    const all = JSON.stringify(st) + runnerNotice(store);
    for (const leak of [SECRET_WORD, "hello", "SECRET-HOST", "4242", "runner_serves"]) assert.ok(!all.includes(leak), `leaked ${leak}`);
    assert.deepEqual(st.targets.map((t) => t.target), ["pc-1"], "the runner's name is the one thing the per-target view adds");
  });

  test("catch_up: backward compatible shape and the notice", () => {
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
    heartbeat(store, 5 * 3600, { ns: "mine" });
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
    heartbeat(store, 5 * 3600, { ns: "beta" });
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
    assert.equal(all.waiting_total, 1, "only the namespace the runner serves counts");
    assert.equal(all.runner.state, "stale");
    const one: any = await (await get("/runner/status?namespace=beta", "rd")).json();
    assert.deepEqual(one.namespaces.map((n: any) => n.namespace), ["beta"]);
    const pinned: any = await (await get("/runner/status?namespace=beta", "pinned")).json();
    assert.deepEqual(pinned.namespaces, [], "a pinned token cannot look at another namespace");
    assert.equal(pinned.waiting_total, 0);
    assert.ok(!JSON.stringify(all).includes(SECRET_WORD));
    // read-only: POST is not a thing
    assert.notEqual((await fetch(base + "/runner/status", { method: "POST", headers: { Authorization: "Bearer rd" } })).status, 200);
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
  });
});

describe("runner status: trust and correctness", () => {
  let store: Store;
  const saved = {
    ttl: process.env.ONEMEMORY_APPROVAL_TTL_SECONDS,
    stale: process.env.ONEMEMORY_RUNNER_STALE_SECONDS,
    hb: process.env.ONEMEMORY_RUNNER_HEARTBEAT_MS,
    id: process.env.ONEMEMORY_RUNNER_ID,
    ns: process.env.ONEMEMORY_RUNNER_TASK_NAMESPACE,
  };
  const restore = (k: string, v: string | undefined) => (v === undefined ? delete process.env[k] : (process.env[k] = v));
  beforeEach(() => {
    store = new Store(":memory:");
    for (const k of ["ONEMEMORY_RUNNER_STALE_SECONDS", "ONEMEMORY_RUNNER_HEARTBEAT_MS", "ONEMEMORY_RUNNER_ID", "ONEMEMORY_RUNNER_TASK_NAMESPACE"]) delete process.env[k];
  });
  afterEach(() => {
    store.close();
    restore("ONEMEMORY_APPROVAL_TTL_SECONDS", saved.ttl);
    restore("ONEMEMORY_RUNNER_STALE_SECONDS", saved.stale);
    restore("ONEMEMORY_RUNNER_HEARTBEAT_MS", saved.hb);
    restore("ONEMEMORY_RUNNER_ID", saved.id);
    restore("ONEMEMORY_RUNNER_TASK_NAMESPACE", saved.ns);
  });

  test("a heartbeat forged by a token (future alive_at, any writer) is ignored", () => {
    // what a write-scope token holder can post: a note that looks exactly like the heartbeat
    heartbeat(store, 0, { writer: "evil-token", body: { alive_at: new Date(Date.now() + 10 * 86_400_000).toISOString() } });
    assert.equal(runnerStatus(store).runner.state, "never_seen");
    approvedTask(store, "tasks");
    // an old real beat is stale even though a forged fresh one exists next to it
    const real = heartbeat(store, 3 * 3600);
    const s = runnerStatus(store);
    assert.equal(s.runner.state, "stale");
    assert.ok(real > 0);
    assert.match(s.notice!, /Runner offline \(last seen 3 h ago\)/);
  });

  test("the body's alive_at can only make a heartbeat OLDER than the server stamp, never newer", () => {
    heartbeat(store, 3 * 3600, { body: { alive_at: new Date(Date.now() + 86_400_000).toISOString() } });
    const s = runnerStatus(store);
    assert.equal(s.runner.state, "stale", "a future alive_at in the body does not make it online");
    assert.ok(s.runner.age_seconds! >= 3 * 3600 - 5);
    // a lagging alive_at (beyond the skew allowance) is believed: it is how a tag-only touch is told apart
    heartbeat(store, 5, { body: { alive_at: "1999-01-01T00:00:00Z" } });
    assert.notEqual(runnerStatus(store).runner.state, "online", "the runner itself said it was alive in 1999");
    // within the allowance the server stamp wins
    heartbeat(store, 5, { body: { alive_at: new Date(Date.now() - 60_000).toISOString() } });
    assert.equal(runnerStatus(store).runner.state, "online");
  });

  test("a tag-only edit (or any non-heartbeat write) by the runner label does not refresh liveness", () => {
    const id = heartbeat(store, 3 * 3600);
    assert.equal(runnerStatus(store).runner.state, "stale");
    // the runner label (or anyone holding it) touches ONLY the tags: updated_at moves to now, alive_at does not
    store.update(id, { tags: ["heartbeat", "x"] }, { writtenBy: "runner" });
    clearRunnerStatusCache(store);
    const s = runnerStatus(store);
    assert.equal(s.runner.state, "stale", "a tag-only touch is not a heartbeat");
    assert.ok(s.runner.age_seconds! >= 3 * 3600 - 5);
    // a body-less heartbeat note is not believed at all
    store.create({ namespace: "runner", title: "runner heartbeat", body: "not json", tags: ["heartbeat"] }, { writtenBy: "runner" });
    store.create({ namespace: "runner", title: "runner heartbeat", body: "{}", tags: ["heartbeat"] }, { writtenBy: "runner" });
    clearRunnerStatusCache(store);
    assert.equal(runnerStatus(store).runner.state, "stale");
  });

  test("a heartbeat stamped in the future (server clock) is not believed; a small skew is clamped", () => {
    const id = heartbeat(store, 0);
    (store as any).db.prepare("UPDATE notes SET updated_at = ? WHERE id = ?").run(new Date(Date.now() + 3600_000).toISOString(), id);
    clearRunnerStatusCache(store);
    assert.equal(runnerStatus(store).runner.state, "never_seen");
    (store as any).db.prepare("UPDATE notes SET updated_at = ? WHERE id = ?").run(new Date(Date.now() + 30_000).toISOString(), id);
    clearRunnerStatusCache(store);
    const s = runnerStatus(store);
    assert.equal(s.runner.state, "online");
    assert.equal(s.runner.age_seconds, 0);
  });

  test("a flood of forged heartbeat notes cannot push the real one out of view", () => {
    heartbeat(store, 20);
    for (let i = 0; i < 60; i++) store.create({ namespace: "runner", title: "runner heartbeat", body: "{}", tags: ["heartbeat"] }, { writtenBy: `tok-${i}` });
    clearRunnerStatusCache(store);
    assert.equal(runnerStatus(store).runner.state, "online");
  });

  test("a legacy heartbeat (written_by empty, from a runner before 1.3.4) is NOT believed by default (1.4.0)", () => {
    heartbeat(store, 20, { writer: "" });
    assert.equal(runnerStatus(store).runner.state, "never_seen");
  });

  test("ONEMEMORY_RUNNER_ACCEPT_LEGACY=1 lets a pre-1.3.4 heartbeat count again", () => {
    process.env.ONEMEMORY_RUNNER_ACCEPT_LEGACY = "1";
    try {
      heartbeat(store, 20, { writer: "" });
      assert.equal(runnerStatus(store).runner.state, "online");
    } finally {
      delete process.env.ONEMEMORY_RUNNER_ACCEPT_LEGACY;
      clearRunnerStatusCache(store);
    }
    assert.equal(runnerStatus(store).runner.state, "never_seen", "off again");
  });

  test("tasks for another namespace are not 'waiting'; a never-seen target is shown as unconfirmed, not hidden", () => {
    heartbeat(store, 5 * 3600, { runner: "pc-1", ns: "tasks" });
    approvedTask(store, "elsewhere");
    const s0 = runnerStatus(store);
    assert.equal(s0.waiting_total, 0, "pc-1 serves 'tasks' only");
    assert.equal(s0.notice, undefined);
    // a command for a runner that never sent a heartbeat cannot be placed in a namespace: it is surfaced
    // in the command's own namespace and flagged, rather than silently dropped (1.4.1)
    const other = putTask(store, { title: "other pc", namespace: "tasks", command: { action: "hello" }, target: "laptop-2" }).task;
    approveTask(store, { id: other.id, if_rev: store.read(other.id)!.rev });
    const s1 = runnerStatus(store);
    assert.equal(s1.waiting_total, 1);
    const t = s1.targets.find((x: any) => x.target === "laptop-2");
    assert.ok(t, "the never-seen target is listed");
    assert.equal(t.namespace_unconfirmed, true);
    approvedTask(store, "tasks");
    assert.equal(runnerStatus(store).waiting_total, 2, "plus the task addressed to pc-1 in its namespace");
  });

  test("the classifier the runner polls with is the one the status uses", () => {
    const id = approvedTask(store, "tasks");
    const n = store.read(id)!;
    const now = Date.now();
    const v = classifyQueuedCommand(store, n, { me: "pc-1", namespace: "tasks" }, now);
    assert.equal(v.kind, "runnable");
    assert.deepEqual(classifyQueuedCommand(store, n, { me: "pc-9", namespace: "tasks" }, now), { kind: "skip", why: "other_target" });
    assert.deepEqual(classifyQueuedCommand(store, n, { me: "pc-1", namespace: "x" }, now), { kind: "skip", why: "other_namespace" });
    assert.deepEqual(classifyQueuedCommand(store, n, { me: "pc-1", namespace: "" }, now), { kind: "skip", why: "other_namespace" });
    // a live lease on an approved task: the runner skips it, so it is not waiting
    store.update(id, { tags: [...n.tags, `task.lease:${now + 600_000}:alice`] });
    const leased = store.read(id)!;
    assert.deepEqual(classifyQueuedCommand(store, leased, { me: "pc-1", namespace: "tasks" }, now), { kind: "skip", why: "leased" });
  });

  test("a forged expired approval tag does not count as expired; a real one does", () => {
    heartbeat(store, 10);
    const id = approvedTask(store, "tasks");
    const n = store.read(id)!;
    const past = Date.now() - 3600_000;
    const forged = n.tags.map((t) => (t.startsWith("task.approval:") ? `task.approval:${"a".repeat(16)}.${past}.${"b".repeat(32)}` : t));
    assert.notDeepEqual(forged, n.tags, "the approval tag was replaced");
    store.update(id, { tags: forged });
    const s = runnerStatus(store);
    assert.equal(s.expired_total, 0, "an unverifiable tag cannot inflate the count");
    assert.equal(s.waiting_total, 0);
    // the real thing, expired
    const real = approvedTask(store, "tasks", "real");
    const later = runnerStatus(store, undefined, Date.now() + 2 * 86_400_000);
    assert.equal(later.expired_total, 1);
    assert.ok(real > 0);
  });

  test("expired approvals show in the notice even while the runner is online", () => {
    process.env.ONEMEMORY_APPROVAL_TTL_SECONDS = "60";
    heartbeat(store, 5);
    approvedTask(store, "tasks");
    const s = runnerStatus(store, undefined, Date.now() + 120_000);
    assert.equal(s.runner.state, "online");
    assert.equal(s.expired_total, 1);
    assert.match(s.notice!, /1 command approval expired/);
    assert.match(catchUp(store, { changes: false }).runner_notice ?? "", /^$|expired|waiting/);
  });

  test("more matches than the scan limit are reported as 'at least'", () => {
    const ids = [approvedTask(store, "tasks", "a"), approvedTask(store, "tasks", "b"), approvedTask(store, "tasks", "c")];
    const r = scanWaitingCommands(store, { me: "pc-1", namespace: "tasks" }, undefined, Date.now(), 2);
    assert.equal(r.truncated, true);
    assert.ok(r.items.length >= 2 && r.items.length <= 3);
    assert.equal(scanWaitingCommands(store, { me: "pc-1", namespace: "tasks" }).truncated, false);
    assert.equal(ids.length, 3);
    heartbeat(store, 5 * 3600);
    // the notice wording
    const s = runnerStatus(store);
    assert.equal(s.truncated, undefined);
  });

  test("stale threshold: default, clamp, and never below three beats", () => {
    assert.equal(staleAfterSeconds(), 600);
    process.env.ONEMEMORY_RUNNER_STALE_SECONDS = "5";
    assert.equal(staleAfterSeconds(), 30, "floor 30 s");
    process.env.ONEMEMORY_RUNNER_STALE_SECONDS = "99999999";
    assert.equal(staleAfterSeconds(), 7 * 86_400, "cap 7 d");
    process.env.ONEMEMORY_RUNNER_STALE_SECONDS = "garbage";
    assert.equal(staleAfterSeconds(), 600);
    delete process.env.ONEMEMORY_RUNNER_STALE_SECONDS;
    assert.equal(staleAfterSeconds(900_000), 2700, "a 15 min beat needs 45 min before 'offline'");
    process.env.ONEMEMORY_RUNNER_HEARTBEAT_MS = "1200000";
    assert.equal(staleAfterSeconds(), 3600, "falls back to the configured beat interval");
  });

  test("a slow heartbeat does not read as permanently offline", () => {
    heartbeat(store, 1500, { body: { heartbeat_ms: 600_000 } }); // beats every 10 min, last one 25 min ago
    const s = runnerStatus(store);
    assert.equal(s.runner.stale_after_seconds, 1800);
    assert.equal(s.runner.state, "online");
  });

  test("results are cached for a few seconds and refreshed when anything changes", () => {
    heartbeat(store, 5 * 3600);
    const a = runnerStatus(store);
    assert.equal(runnerStatus(store), a, "same object while nothing changed");
    approvedTask(store, "tasks");
    const b = runnerStatus(store);
    assert.notEqual(b, a);
    assert.equal(b.waiting_total, 1);
  });

  test("the status shape stays additive (old fields intact)", () => {
    heartbeat(store, 5 * 3600);
    const s = runnerStatus(store);
    for (const k of ["runner", "waiting_total", "expiring_soon_total", "expired_total", "namespaces"]) assert.ok(k in s, k);
    for (const k of ["state", "last_seen", "age_seconds", "stale_after_seconds"]) assert.ok(k in s.runner, k);
  });
});

describe("runner status: recall hook, CLI, dashboard", () => {
  test("the SessionStart recall prints the offline line", async () => {
    const dir = mkdtempSync(join(tmpdir(), "om-live-recall-"));
    try {
      const db = join(dir, "s.db");
      const st = new Store(db);
      heartbeat(st, 4 * 3600);
      approvedTask(st, "tasks");
      st.close();
      const out = JSON.parse(await runRecall({ dbPath: db }));
      assert.match(out.hookSpecificOutput.additionalContext, /Runner offline \(last seen 4 h ago\): 1 approved command waiting/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("recall does not upgrade an older database (only a normal command does)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "om-live-recall-old-"));
    try {
      const db = join(dir, "s.db");
      const st = new Store(db);
      st.create({ title: "n", body: "b" });
      st.close();
      const raw = new DatabaseSync(db);
      raw.exec("PRAGMA user_version = 12");
      raw.close();
      const out = JSON.parse(await runRecall({ dbPath: db }));
      assert.equal(out.hookSpecificOutput.additionalContext, "");
      assert.equal(Store.peekSchemaVersion(db), 12, "still v12: the hook did not migrate it");
      assert.ok(!existsSync(db + ".pre-v14-backup"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("CLI runner-status: human durations and --json", () => {
    const dir = mkdtempSync(join(tmpdir(), "om-live-cli-"));
    try {
      const db = join(dir, "s.db");
      const st = new Store(db);
      heartbeat(st, 3 * 3600);
      approvedTask(st, "tasks");
      st.close();
      const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.js");
      const run = (...args: string[]) =>
        spawnSync(process.execPath, [cli, "runner-status", ...args], {
          env: { ...process.env, ONEMEMORY_DB_PATH: db, ONEMEMORY_HOME: dir },
          encoding: "utf8",
          timeout: 30000,
        });
      const human = run();
      assert.equal(human.status, 0, human.stderr);
      assert.match(human.stdout, /Runner: stale \(last heartbeat 3 h ago; counted offline after 10 min\)/);
      assert.match(human.stdout, /oldest waited/);
      assert.doesNotMatch(human.stdout, /\d{4,}s/, "no raw big second counts");
      const json = run("--json");
      assert.equal(json.status, 0, json.stderr);
      const j = JSON.parse(json.stdout);
      assert.equal(j.runner.state, "stale");
      assert.equal(j.waiting_total, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("dashboard: the banner is fed from /runner/status and written with textContent", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, "..", "src", "dashboard.js"), "utf8");
    assert.match(src, /\/runner\/status/);
    const i = src.indexOf("loadRunner");
    assert.ok(i >= 0, "loadRunner is present");
    const body = src.slice(i, src.indexOf("\n}", i));
    assert.match(body, /textContent/);
    assert.doesNotMatch(body, /innerHTML/);
  });
});
