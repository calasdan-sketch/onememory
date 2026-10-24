// Command tasks: task_put({command, target}) -> admin approval -> the PC's
// runner executes it through the same gates as a signed command note.
// Mostly NEGATIVE tests: nothing may run unless every gate holds.
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Store } from "../src/store.js";
import { putTask, approveTask, getTask, claimTask } from "../src/tasks.js";
import { Ledger, RUNNER, type Allowlist, type RunnerDeps } from "../src/runner.js";
import { pollTasks } from "../src/runner-tasks.js";
import { createMcpServer } from "../src/mcp-server-core.js";
import { createApiServer } from "../src/api.js";

const SECRET = "very-secret-runner-key-123";
const NS = "tasks";

function parseTool(r: any): any {
  const t: string = r.content[0].text;
  return JSON.parse(t.slice(t.indexOf("{")));
}

describe("command tasks", () => {
  let store: Store;
  let dir: string;
  let marker: string;
  let deps: RunnerDeps;
  let allow: Allowlist;

  beforeEach(() => {
    store = new Store(":memory:");
    dir = mkdtempSync(join(tmpdir(), "om-cmdtask-"));
    marker = join(dir, "ran.txt");
    allow = {
      mark: {
        file: process.execPath,
        args: ["-e", "require('fs').writeFileSync(process.argv[1], 'ran')"],
        params: { p: "[A-Za-z0-9/_.-]{1,200}" },
        paramArgs: ["{p}"],
        description: "write a marker file",
      },
      hello: { file: process.execPath, args: ["-e", "console.log('hello from the runner')"] },
    };
    deps = { store, secret: SECRET, allow, ledger: new Ledger(join(dir, "seen.json")), runnerId: "pc-1", taskNamespace: NS };
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const queue = (extra: Record<string, unknown> = {}) =>
    putTask(store, { title: "do it", namespace: NS, command: { action: "mark", params: { p: marker } }, target: "pc-1", ...extra }).task;

  test("data model: queued, unapproved, shows the command; the secret is nowhere", () => {
    const t = queue();
    assert.equal(t.status, "queued");
    assert.equal(t.approval, "none");
    assert.deepEqual(t.command, { action: "mark", params: { p: marker }, target: "pc-1" });
    const everything = JSON.stringify(store.list({ limit: 100 }).notes);
    assert.ok(!everything.includes(SECRET));
  });

  test("a write-scope task cannot run: unapproved is ignored", async () => {
    const t = queue();
    assert.equal(await pollTasks(deps), 0);
    assert.equal(existsSync(marker), false);
    assert.equal(getTask(store, t.id).status, "queued");
  });

  test("approved + right target + right namespace + allowlisted: runs, result written back, approval consumed", async () => {
    const t = queue();
    const approved = approveTask(store, { id: t.id, if_rev: store.read(t.id)!.rev });
    assert.equal(approved.approval, "approved");
    assert.equal(await pollTasks(deps), 1);
    assert.equal(readFileSync(marker, "utf8"), "ran");
    const after = getTask(store, t.id);
    assert.equal(after.status, "done");
    assert.equal(after.approval, "none", "single-use");
    assert.equal(after.result!.exit_code, 0);
    assert.equal(after.result!.status, "ok");
    const signed = store.list({ namespace: RUNNER.resultsNamespace, limit: 10 }).notes;
    assert.ok(signed.some((n) => n.title.startsWith("result task-") && n.body.includes('"sig"')), "signed result note");
    assert.ok(!JSON.stringify(store.list({ limit: 100 }).notes).includes(SECRET));
    // nothing left to run
    rmSync(marker);
    assert.equal(await pollTasks(deps), 0);
    assert.equal(existsSync(marker), false);
  });

  test("output is recorded on the task", async () => {
    const t = putTask(store, { title: "hi", namespace: NS, command: { action: "hello" }, target: "pc-1" }).task;
    approveTask(store, { id: t.id, if_rev: store.read(t.id)!.rev });
    await pollTasks(deps);
    assert.match(String(getTask(store, t.id).result!.output), /hello from the runner/);
  });

  test("edited via task_put after approval: approval is gone, nothing runs", async () => {
    const t = queue();
    approveTask(store, { id: t.id, if_rev: store.read(t.id)!.rev });
    const edited = putTask(store, { id: t.id, command: { action: "mark", params: { p: join(dir, "other.txt") } } }).task;
    assert.equal(edited.approval, "none");
    assert.equal(edited.status, "queued");
    assert.equal(await pollTasks(deps), 0);
    assert.equal(existsSync(marker), false);
    assert.equal(existsSync(join(dir, "other.txt")), false);
  });

  test("edited behind the API's back (plain note write) after approval: MAC no longer matches", async () => {
    const t = queue();
    approveTask(store, { id: t.id, if_rev: store.read(t.id)!.rev });
    const n = store.read(t.id)!;
    const evil = join(dir, "evil.txt");
    store.update(t.id, { body: n.body.replace(JSON.stringify(marker), JSON.stringify(evil)) });
    assert.equal(getTask(store, t.id).approval, "stale");
    assert.equal(await pollTasks(deps), 0);
    assert.equal(existsSync(evil), false);
    assert.equal(existsSync(marker), false);
  });

  test("changing only the target after approval voids it too", async () => {
    const t = queue();
    approveTask(store, { id: t.id, if_rev: store.read(t.id)!.rev });
    assert.equal(putTask(store, { id: t.id, target: "pc-2" }).task.approval, "none");
    assert.equal(await pollTasks(deps), 0);
  });

  test("an approval tag copied from another task does not verify", async () => {
    const a = queue();
    approveTask(store, { id: a.id, if_rev: store.read(a.id)!.rev });
    const b = queue();
    const tagA = store.read(a.id)!.tags.find((x) => x.startsWith("task.approval:"))!;
    store.update(b.id, { tags: [...store.read(b.id)!.tags, tagA] });
    assert.equal(getTask(store, b.id).approval, "stale");
    // run only A's approval
    assert.equal(await pollTasks(deps), 1);
    assert.equal(getTask(store, b.id).status, "queued");
  });

  test("a made-up approval tag does not verify", async () => {
    const t = queue();
    store.update(t.id, { tags: [...store.read(t.id)!.tags, `task.approval:${"a".repeat(16)}.${"b".repeat(32)}`] });
    assert.equal(getTask(store, t.id).approval, "stale");
    assert.equal(await pollTasks(deps), 0);
    assert.equal(existsSync(marker), false);
  });

  test("wrong target: left untouched for the machine it is addressed to", async () => {
    const t = queue({ target: "pc-2" });
    approveTask(store, { id: t.id, if_rev: store.read(t.id)!.rev });
    assert.equal(await pollTasks(deps), 0);
    assert.equal(existsSync(marker), false);
    assert.equal(getTask(store, t.id).status, "queued");
    assert.equal(getTask(store, t.id).approval, "approved", "still valid for pc-2");
    // and pc-2 would run it
    assert.equal(await pollTasks({ ...deps, runnerId: "pc-2" }), 1);
    assert.equal(existsSync(marker), true);
  });

  test("wrong namespace / feature off: never looked at", async () => {
    const t = putTask(store, { title: "x", namespace: "default", command: { action: "mark", params: { p: marker } }, target: "pc-1" }).task;
    approveTask(store, { id: t.id, if_rev: store.read(t.id)!.rev });
    assert.equal(await pollTasks(deps), 0);
    assert.equal(existsSync(marker), false);
    const t2 = queue();
    approveTask(store, { id: t2.id, if_rev: store.read(t2.id)!.rev });
    assert.equal(await pollTasks({ ...deps, taskNamespace: "" }), 0, "no task namespace configured = off");
    assert.equal(existsSync(marker), false);
  });

  test("a task moved to another namespace after approval loses it (MAC binds the namespace)", async () => {
    const t = queue();
    approveTask(store, { id: t.id, if_rev: store.read(t.id)!.rev });
    store.update(t.id, { namespace: "elsewhere" });
    store.update(t.id, { namespace: NS });
    assert.equal(getTask(store, t.id).approval, "approved", "round trip unchanged is still the same namespace");
    store.update(t.id, { namespace: "elsewhere" });
    assert.equal(getTask(store, t.id, ["elsewhere"]).approval, "stale");
    assert.equal(await pollTasks({ ...deps, taskNamespace: "elsewhere" }), 0);
    assert.equal(existsSync(marker), false);
  });

  test("non-allowlisted action: approved but refused in writing, nothing spawned", async () => {
    const t = putTask(store, { title: "rm", namespace: NS, command: { action: "rm-rf", params: {} }, target: "pc-1" }).task;
    approveTask(store, { id: t.id, if_rev: store.read(t.id)!.rev });
    assert.equal(await pollTasks(deps), 1);
    const after = getTask(store, t.id);
    assert.equal(after.status, "failed");
    assert.equal(after.result!.status, "refused");
    assert.match(String(after.result!.reason), /not allowed/);
  });

  test("parameter outside its pattern is refused (no injection through params)", async () => {
    const t = putTask(store, { title: "inj", namespace: NS, command: { action: "mark", params: { p: "x; touch /tmp/pwned" } }, target: "pc-1" }).task;
    approveTask(store, { id: t.id, if_rev: store.read(t.id)!.rev });
    await pollTasks(deps);
    const after = getTask(store, t.id);
    assert.equal(after.status, "failed");
    assert.match(String(after.result!.reason), /pattern/);
    // an undeclared parameter is refused too
    const t2 = putTask(store, { title: "inj2", namespace: NS, command: { action: "hello", params: { extra: "1" } }, target: "pc-1" }).task;
    approveTask(store, { id: t2.id, if_rev: store.read(t2.id)!.rev });
    await pollTasks(deps);
    assert.equal(getTask(store, t2.id).status, "failed");
  });

  test("replay: an used approval can't run again; re-queue needs a fresh admin approval", async () => {
    const t = queue();
    approveTask(store, { id: t.id, if_rev: store.read(t.id)!.rev });
    await pollTasks(deps);
    rmSync(marker);
    // a write token re-queues it
    const again = putTask(store, { id: t.id, status: "queued" }).task;
    assert.equal(again.approval, "none");
    assert.equal(await pollTasks(deps), 0);
    assert.equal(existsSync(marker), false);
    // a fresh approval = a fresh nonce = runs once more
    approveTask(store, { id: t.id, if_rev: store.read(t.id)!.rev });
    assert.equal(await pollTasks(deps), 1);
    assert.equal(existsSync(marker), true);
  });

  test("replay against the ledger: a used cmd id is rejected even with a valid approval", async () => {
    const t = queue();
    const approved = approveTask(store, { id: t.id, if_rev: store.read(t.id)!.rev });
    const tag = store.read(approved.id)!.tags.find((x) => x.startsWith("task.approval:"))!;
    const nonce = tag.slice("task.approval:".length).split(".")[0];
    deps.ledger.add(`task-${t.id}-${nonce}`);
    assert.equal(await pollTasks(deps), 1);
    assert.equal(existsSync(marker), false);
    assert.match(String(getTask(store, t.id).result!.reason), /already used/);
  });

  test("a command task cannot be claimed, so a lease cannot starve the runner", async () => {
    const t = queue();
    approveTask(store, { id: t.id, if_rev: store.read(t.id)!.rev });
    assert.throws(() => claimTask(store, { id: t.id, owner: "human" }), /command task/);
    assert.equal(await pollTasks(deps), 1);
  });

  test("approval rules: needs a command, needs queued", () => {
    const plain = putTask(store, { title: "plain", namespace: NS }).task;
    assert.throws(() => approveTask(store, { id: plain.id, if_rev: store.read(plain.id)!.rev }), /no command/);
    const t = queue();
    putTask(store, { id: t.id, status: "blocked" });
    assert.throws(() => approveTask(store, { id: t.id, if_rev: store.read(t.id)!.rev }), /only a queued/);
  });

  test("validation: target required, status must be queued, params shape", () => {
    assert.throws(() => putTask(store, { title: "x", command: { action: "mark" } }), /target/);
    assert.throws(() => putTask(store, { title: "x", command: { action: "mark" }, target: "pc-1", status: "done" }), /queued/);
    assert.throws(() => putTask(store, { title: "x", command: { action: "bad action!" }, target: "pc-1" }), /action/);
    assert.throws(() => putTask(store, { title: "x", command: { action: "a", params: { p: "a\nb" } }, target: "pc-1" }), /control/);
    assert.throws(() => putTask(store, { title: "x", command: { action: "a", params: { p: 1 as any } }, target: "pc-1" }), /string/);
    assert.throws(() => putTask(store, { title: "x", target: "pc-1" }), /command/);
  });

  test("flood ceiling applies to command tasks", async () => {
    for (let i = 0; i < 3; i++) {
      const t = putTask(store, { title: `t${i}`, namespace: NS, command: { action: "hello" }, target: "pc-1" }).task;
      approveTask(store, { id: t.id, if_rev: store.read(t.id)!.rev });
    }
    const prev = RUNNER.maxPerPoll;
    (RUNNER as any).maxPerPoll = 2;
    try {
      assert.equal(await pollTasks(deps), 2);
      assert.equal(await pollTasks(deps), 1, "overflow is deferred, not lost");
    } finally {
      (RUNNER as any).maxPerPoll = prev;
    }
  });
});

describe("who may approve", () => {
  test("MCP: write scope cannot approve or self-approve; admin can", async () => {
    const store = new Store(":memory:");
    async function connect(scope: "write" | "admin") {
      const server = createMcpServer(store, scope);
      const [c, s] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "t", version: "1.0.0" });
      await Promise.all([client.connect(c), server.connect(s)]);
      return client;
    }
    const w = await connect("write");
    const made = parseTool(await w.callTool({ name: "task_put", arguments: { title: "c", command: { action: "hello" }, target: "pc-1" } }));
    assert.equal(made.task.status, "queued");
    assert.equal(made.task.approval, "none");
    const r1: any = await w.callTool({ name: "task_approve", arguments: { id: made.task.id } });
    assert.equal(r1.isError, true);
    assert.match(r1.content[0].text, /admin/);
    const r2: any = await w.callTool({ name: "task_put", arguments: { title: "c2", command: { action: "hello" }, target: "pc-1", approve: true } });
    assert.equal(r2.isError, true);
    assert.equal(store.list({ withTags: ["task"] }).total, 1, "the refused self-approve created nothing");
    const a = await connect("admin");
    const ok = parseTool(await a.callTool({ name: "task_approve", arguments: { id: made.task.id, command_hash: made.task.command_hash } }));
    assert.equal(ok.task.approval, "approved");
    const direct = parseTool(await a.callTool({ name: "task_put", arguments: { title: "c3", command: { action: "hello" }, target: "pc-1", approve: true } }));
    assert.equal(direct.task.approval, "approved");
    const revoked = parseTool(await a.callTool({ name: "task_approve", arguments: { id: made.task.id, revoke: true } }));
    assert.equal(revoked.task.approval, "none");
    await w.close();
    await a.close();
    store.close();
  });

  test("REST: only admin tokens reach /tasks/:id/approve; reads can't see a way around it", async () => {
    const store = new Store(":memory:");
    const server = createApiServer(store, [
      { token: "adm", scope: "admin", label: "adm" },
      { token: "wr", scope: "write", label: "wr" },
      { token: "rd", scope: "read", label: "rd" },
    ]);
    await new Promise<void>((r) => server.listen(0, r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const call = (m: string, p: string, tok: string, b?: unknown) =>
      fetch(base + p, { method: m, headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" }, body: b ? JSON.stringify(b) : undefined });
    const made: any = await (await call("POST", "/tasks", "wr", { title: "c", command: { action: "hello" }, target: "pc-1" })).json();
    assert.equal(made.task.status, "queued");
    assert.equal((await call("POST", `/tasks/${made.task.id}/approve`, "wr")).status, 403);
    assert.equal((await call("POST", `/tasks/${made.task.id}/approve`, "rd")).status, 403);
    assert.equal((await call("POST", "/tasks", "wr", { title: "c2", command: { action: "hello" }, target: "pc-1", approve: true })).status, 403);
    // forging the approval through plain notes is refused
    assert.equal((await call("PUT", `/notes/${made.task.id}`, "wr", { tags: ["task", "status:queued", `task.approval:${"a".repeat(16)}.${"b".repeat(32)}`] })).status, 400);
    const ok: any = await (await call("POST", `/tasks/${made.task.id}/approve`, "adm", { command_hash: made.task.command_hash })).json();
    assert.equal(ok.task.approval, "approved");
    const got: any = await (await call("GET", `/tasks/${made.task.id}`, "rd")).json();
    assert.equal(got.task.approval, "approved");
    assert.equal((await call("GET", "/tasks/99999", "rd")).status, 404);
    // a write token editing the command voids the approval
    const edited: any = await (await call("PUT", `/tasks/${made.task.id}`, "wr", { command: { action: "hello", params: {} }, target: "pc-9" })).json();
    assert.equal(edited.task.approval, "none");
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
  });
});
