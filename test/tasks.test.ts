// Task board, session handoffs and catch-up: the tasks.ts service, the
// task_put / task_list / session_handoff / catch_up MCP tools, the REST
// routes, the exact-tag list filter, and the SessionStart recall section.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Store, ValidationError } from "../src/store.js";
import { ensureKey } from "../src/crypto.js";
import {
  putTask,
  listTasks,
  writeHandoff,
  listHandoffs,
  catchUp,
  taskFromNote,
  handoffFromNote,
  buildBoardSummary,
  TaskNotFoundError,
  TASK_LIMITS,
} from "../src/tasks.js";
import { runRecall, RECALL_MAX_CHARS } from "../src/recall.js";
import { createMcpServer } from "../src/mcp-server-core.js";
import { createApiServer } from "../src/api.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function parseTool(r: any): any {
  const t: string = r.content[0].text;
  return JSON.parse(t.slice(t.indexOf("{")));
}

describe("Store.list exact-tag filters", () => {
  test("withTags / withoutTags match whole tags only, with correct totals", () => {
    const s = new Store(":memory:");
    s.create({ title: "a", tags: ["task", "status:running"] });
    s.create({ title: "b", tags: ["task-force"] });
    s.create({ title: "c", tags: ["task", "status:done"] });
    s.create({ title: "d", tags: ['x"task"'] });
    s.create({ title: "e", tags: ["100%_sure\\"] });
    const t = s.list({ withTags: ["task"] });
    assert.deepEqual(t.notes.map((n) => n.title).sort(), ["a", "c"]);
    assert.equal(t.total, 2);
    assert.deepEqual(s.list({ withTags: ["task"], withoutTags: ["status:done"] }).notes.map((n) => n.title), ["a"]);
    assert.deepEqual(s.list({ withTags: ["100%_sure\\"] }).notes.map((n) => n.title), ["e"]);
    assert.equal(s.list({ withTags: ["100%"] }).notes.length, 0);
    s.close();
  });
});

describe("putTask / listTasks", () => {
  test("create then partial update; defaults and shape", () => {
    const s = new Store(":memory:");
    const { task } = putTask(s, { title: "  Ship the logo  ", next_step: "pick\ncolors", owner: "phone" });
    assert.equal(task.title, "Ship the logo");
    assert.equal(task.status, "idea");
    assert.equal(task.next_step, "pick colors");
    assert.equal(task.owner, "phone");
    assert.equal(task.rev, 1);
    const u = putTask(s, { id: task.id, status: "running", notes: "started on the PC" }).task;
    assert.equal(u.status, "running");
    assert.equal(u.next_step, "pick colors", "untouched fields are kept");
    assert.equal(u.owner, "phone");
    assert.equal(u.notes, "started on the PC");
    assert.equal(u.rev, 2);
    const cleared = putTask(s, { id: task.id, owner: "", next_step: "" }).task;
    assert.equal(cleared.owner, "");
    assert.equal(cleared.next_step, "");
    assert.equal(cleared.notes, "started on the PC");
    s.close();
  });

  test("tasks are plain notes: tagged, searchable, in the change feed, extra tags survive", () => {
    const s = new Store(":memory:");
    const { note } = putTask(s, { title: "Quarterly zebra review", status: "planned", owner: "pc" });
    s.update(note.id, { tags: [...note.tags, "q4"] });
    const upd = putTask(s, { id: note.id, status: "blocked" });
    assert.deepEqual([...upd.note.tags].sort(), ["owner:pc", "q4", "status:blocked", "task"]);
    assert.equal(s.search("zebra").length, 1);
    const feed = s.changes({ since: new Date(Date.now() - 60_000).toISOString() });
    assert.equal(feed.changes.length, 1);
    assert.equal(feed.changes[0].title, "Quarterly zebra review");
    assert.equal(feed.changes[0].source, "pc");
    s.close();
  });

  test("validation: clear errors, nothing stored", () => {
    const s = new Store(":memory:");
    const bad: Array<[object, RegExp]> = [
      [{}, /title is required/],
      [{ title: "  " }, /title is required/],
      [{ title: "x", status: "finished" }, /status must be one of/],
      [{ title: "x", owner: "a/b" }, /owner must be/],
      [{ title: "x", owner: "o".repeat(65) }, /owner must be/],
      [{ title: "x".repeat(TASK_LIMITS.title + 1) }, /title exceeds/],
      [{ title: "x", next_step: "n".repeat(TASK_LIMITS.nextStep + 1) }, /next_step exceeds/],
      [{ title: "x", notes: "n".repeat(TASK_LIMITS.notes + 1) }, /notes exceeds/],
      [{ title: 5 }, /title must be a string/],
      [{ title: "x", if_rev: 0 }, /if_rev/],
      [{ id: 0, title: "x" }, /id must be/],
    ];
    for (const [input, re] of bad) assert.throws(() => putTask(s, input as any), re, JSON.stringify(input));
    assert.equal(s.list().total, 0);
    const t = putTask(s, { title: "ok" }).task;
    assert.throws(() => putTask(s, { id: t.id }), /nothing to update/);
    assert.throws(() => putTask(s, { id: t.id, title: " " }), /title cannot be empty/);
    s.close();
  });

  test("update only reaches live tasks: not plain notes, not archived, not other namespaces", () => {
    const s = new Store(":memory:");
    const plain = s.create({ title: "just a note" });
    assert.throws(() => putTask(s, { id: plain.id, status: "done" }), TaskNotFoundError);
    assert.throws(() => putTask(s, { id: 9999, status: "done" }), TaskNotFoundError);
    const mine = putTask(s, { title: "mine", namespace: "work" }).task;
    const other = putTask(s, { title: "theirs", namespace: "home" }).task;
    assert.throws(() => putTask(s, { id: other.id, status: "done" }, { namespace: "work" }), TaskNotFoundError);
    assert.equal(putTask(s, { id: mine.id, status: "done" }, { namespace: "work" }).task.status, "done");
    // a pinned scope forces creates into its namespace whatever the caller asks
    const forced = putTask(s, { title: "forced", namespace: "home" }, { namespace: "work" }).task;
    assert.equal(forced.namespace, "work");
    s.archive(mine.id);
    assert.throws(() => putTask(s, { id: mine.id, status: "running" }), TaskNotFoundError);
    // the plain note is untouched
    assert.equal(s.read(plain.id)!.rev, 1);
    s.close();
  });

  test("if_rev is compare-and-swap", () => {
    const s = new Store(":memory:");
    const t = putTask(s, { title: "race" }).task;
    putTask(s, { id: t.id, status: "running", if_rev: t.rev }); // phone wins
    assert.throws(() => putTask(s, { id: t.id, status: "blocked", if_rev: t.rev }), /stale write/); // pc is stale
    assert.equal(listTasks(s).tasks[0].status, "running");
    s.close();
  });

  test("listTasks: hides done by default, filters, orders by recency, respects namespaces", async () => {
    const s = new Store(":memory:");
    const a = putTask(s, { title: "a", status: "running", owner: "pc", namespace: "work" }).task;
    await sleep(5);
    const b = putTask(s, { title: "b", status: "done", namespace: "work" }).task;
    await sleep(5);
    const c = putTask(s, { title: "c", status: "planned", owner: "phone", namespace: "work" }).task;
    putTask(s, { title: "secret", status: "running", namespace: "home" });
    s.create({ title: "not a task", tags: ["status:running"] });
    assert.deepEqual(listTasks(s, { namespaces: ["work"] }).tasks.map((t) => t.title), ["c", "a"]);
    assert.deepEqual(listTasks(s, { namespaces: ["work"], status: "all" }).tasks.map((t) => t.title), ["c", "b", "a"]);
    assert.deepEqual(listTasks(s, { namespaces: ["work"], status: "done" }).tasks.map((t) => t.id), [b.id]);
    assert.deepEqual(listTasks(s, { namespaces: ["work"], owner: "pc" }).tasks.map((t) => t.id), [a.id]);
    assert.deepEqual(listTasks(s, { namespaces: ["work", "home"], status: "running" }).tasks.map((t) => t.title).sort(), ["a", "secret"]);
    assert.equal(listTasks(s, { namespaces: [] }).tasks.length, 0);
    putTask(s, { id: a.id, status: "blocked" });
    assert.equal(listTasks(s, { namespaces: ["work"] }).tasks[0].id, a.id, "recently changed comes first");
    assert.throws(() => listTasks(s, { status: "nope" }), ValidationError);
    assert.equal(c.status, "planned");
    s.close();
  });

  test("task body and title are encrypted like other notes", () => {
    const dir = mkdtempSync(join(tmpdir(), "om-task-enc-"));
    try {
      ensureKey(dir);
      const s = new Store(join(dir, "state.db"));
      const { task } = putTask(s, { title: "enc task", next_step: "call Marlene about the contract", notes: "launch-code-4411" });
      assert.equal(listTasks(s).tasks[0].next_step, "call Marlene about the contract");
      s.close();
      const raw = new DatabaseSync(join(dir, "state.db"));
      const row = raw.prepare("SELECT body, body_enc FROM notes WHERE id = ?").get(task.id) as { body: string; body_enc: string };
      assert.equal(row.body, "");
      assert.ok(row.body_enc && !row.body_enc.includes("Marlene") && !row.body_enc.includes("4411"));
      raw.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("taskFromNote tolerates a hand-edited note", () => {
    const s = new Store(":memory:");
    const { note } = putTask(s, { title: "t", status: "running" });
    const edited = s.update(note.id, { body: "I rewrote the body by hand", tags: ["task"] })!;
    const t = taskFromNote(edited);
    assert.equal(t.status, "idea");
    assert.equal(t.notes, "I rewrote the body by hand");
    assert.equal(t.next_step, "");
    s.close();
  });
});

describe("handoffs", () => {
  test("write, parse back, latest first", async () => {
    const s = new Store(":memory:");
    writeHandoff(s, { surface: "phone", summary: "first", next_step: "n1" });
    await sleep(5);
    const { handoff, note } = writeHandoff(s, {
      surface: "claude-code on pc",
      summary: "Built the wait endpoint.",
      done: ["wait=", "tests"],
      pending: ["docs", "release"],
      decisions: ["cap waits at 55s"],
      next_step: "write CHANGELOG",
    });
    assert.deepEqual(note.tags, ["handoff", "surface:claude-code on pc"]);
    assert.equal(note.source, "claude-code on pc");
    assert.match(note.title, /^Handoff from claude-code on pc \(\d{4}-\d\d-\d\d \d\d:\d\dZ\)$/);
    assert.deepEqual(handoffFromNote(note), handoff);
    assert.deepEqual(handoff.done, ["wait=", "tests"]);
    assert.deepEqual(handoff.decisions, ["cap waits at 55s"]);
    assert.equal(handoff.next_step, "write CHANGELOG");
    const list = listHandoffs(s, { limit: 5 });
    assert.deepEqual(list.map((h) => h.summary), ["Built the wait endpoint.", "first"]);
    assert.deepEqual(listHandoffs(s, { surface: "phone" }).map((h) => h.summary), ["first"]);
    s.close();
  });

  test("validation", () => {
    const s = new Store(":memory:");
    const bad: Array<[object, RegExp]> = [
      [{}, /surface is required/],
      [{ surface: "pc" }, /needs something in it/],
      [{ surface: "pc", done: [] }, /needs something in it/],
      [{ surface: "p/c", summary: "x" }, /surface must be/],
      [{ surface: "pc", done: "x" }, /must be a list of strings/],
      [{ surface: "pc", done: [1] }, /must be a list of strings/],
      [{ surface: "pc", done: Array(TASK_LIMITS.listItems + 1).fill("x") }, /too many items/],
      [{ surface: "pc", pending: ["x".repeat(TASK_LIMITS.listItem + 1)] }, /exceeds/],
      [{ surface: "pc", summary: "x".repeat(TASK_LIMITS.summary + 1) }, /summary exceeds/],
    ];
    for (const [input, re] of bad) assert.throws(() => writeHandoff(s, input as any), re, JSON.stringify(input));
    assert.equal(s.list().total, 0);
    s.close();
  });

  test("a pinned scope forces the namespace; reads honour the readable set", () => {
    const s = new Store(":memory:");
    writeHandoff(s, { surface: "a", summary: "x", namespace: "home" }, { namespace: "work" });
    writeHandoff(s, { surface: "b", summary: "y", namespace: "home" });
    assert.deepEqual(listHandoffs(s, { namespaces: ["work"] }).map((h) => h.surface), ["a"]);
    assert.equal(listHandoffs(s, { namespaces: [] }).length, 0);
    s.close();
  });
});

describe("catchUp", () => {
  test("changes since this consumer last looked + open tasks + latest handoff; marker advances", () => {
    const s = new Store(":memory:");
    putTask(s, { title: "open one", status: "running" });
    putTask(s, { title: "finished", status: "done" });
    writeHandoff(s, { surface: "pc", summary: "left off here", next_step: "go on" });
    const first = catchUp(s, { consumer: "phone" });
    assert.equal(first.changes!.markerReset, true);
    assert.equal(first.changes!.counts.total, 3);
    assert.equal(first.changes!.recent.length, 3);
    assert.deepEqual(first.tasks.open.map((t) => t.title), ["open one"]);
    assert.equal(first.handoffs[0].summary, "left off here");
    const second = catchUp(s, { consumer: "phone" });
    assert.equal(second.changes!.counts.total, 0);
    assert.equal(second.changes!.markerReset, undefined);
    putTask(s, { title: "new idea" });
    const third = catchUp(s, { consumer: "phone" });
    assert.deepEqual(third.changes!.recent.map((c) => c.title), ["new idea"]);
    // another consumer has its own marker
    assert.equal(catchUp(s, { consumer: "pc" }).changes!.counts.total, 4);
    // opting out of changes leaves the marker alone
    putTask(s, { title: "later" });
    assert.equal(catchUp(s, { consumer: "phone", changes: false }).changes, undefined);
    assert.equal(catchUp(s, { consumer: "phone" }).changes!.counts.total, 1);
    s.close();
  });

  test("a big gap is bounded: whole-window counts, newest 30 shown, marker still advances", () => {
    const s = new Store(":memory:");
    for (let i = 0; i < 70; i++) s.create({ title: `n${i}` });
    const c = catchUp(s, { consumer: "x" });
    assert.equal(c.changes!.counts.total, 70);
    assert.equal(c.changes!.recent.length, 30);
    assert.equal(c.changes!.omitted, 40);
    assert.equal(c.changes!.recent.at(-1)!.title, "n69");
    assert.equal(catchUp(s, { consumer: "x" }).changes!.counts.total, 0);
    s.close();
  });

  test("scope: nothing outside the namespaces leaks; bad consumer is a ValidationError", () => {
    const s = new Store(":memory:");
    putTask(s, { title: "mine", namespace: "work" });
    putTask(s, { title: "secret", namespace: "home" });
    writeHandoff(s, { surface: "h", summary: "secret handoff", namespace: "home" });
    const c = catchUp(s, { namespaces: ["work"], consumer: "z" });
    assert.deepEqual(c.tasks.open.map((t) => t.title), ["mine"]);
    assert.equal(c.handoffs.length, 0);
    assert.ok(c.changes!.recent.every((x) => x.namespace === "work"));
    assert.ok(!JSON.stringify(c).includes("secret"));
    assert.throws(() => catchUp(s, { consumer: "bad label!" }), ValidationError);
    s.close();
  });
});

describe("MCP tools", () => {
  async function connect(store: Store, scope: "read" | "write" | "admin", opts = {}) {
    const server = createMcpServer(store, scope, opts);
    const [c, s] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "1.0.0" });
    await Promise.all([client.connect(c), server.connect(s)]);
    return client;
  }

  test("tools are listed", async () => {
    const store = new Store(":memory:");
    const client = await connect(store, "admin");
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const n of ["task_put", "task_list", "session_handoff", "catch_up"]) assert.ok(names.includes(n), n);
    await client.close();
    store.close();
  });

  test("round trip: phone adds an idea, PC sees it in catch_up; output is untrusted-bannered", async () => {
    const store = new Store(":memory:");
    const phone = await connect(store, "write");
    const pc = await connect(store, "read");
    const put: any = await phone.callTool({
      name: "task_put",
      arguments: { title: "Try a hoodie line", status: "idea", owner: "phone", next_step: "sketch 3 logos" },
    });
    assert.ok(!put.isError);
    assert.match(put.content[0].text, /UNTRUSTED DATA/);
    const id = parseTool(put).task.id;
    await phone.callTool({
      name: "session_handoff",
      arguments: { surface: "phone", summary: "Added the hoodie idea", next_step: "PC: check the print vendor" },
    });
    const cu = parseTool(await pc.callTool({ name: "catch_up", arguments: { consumer: "pc" } }));
    assert.deepEqual(cu.tasks.open.map((t: any) => t.title), ["Try a hoodie line"]);
    assert.equal(cu.handoffs[0].next_step, "PC: check the print vendor");
    assert.ok(cu.changes.recent.some((c: any) => c.title === "Try a hoodie line"));
    const upd = parseTool(
      await phone.callTool({ name: "task_put", arguments: { id, status: "running", if_rev: 1 } })
    );
    assert.equal(upd.task.rev, 2);
    const stale: any = await phone.callTool({ name: "task_put", arguments: { id, status: "done", if_rev: 1 } });
    assert.equal(stale.isError, true);
    assert.match(stale.content[0].text, /stale write/);
    const listed = parseTool(await pc.callTool({ name: "task_list", arguments: { owner: "phone" } }));
    assert.equal(listed.tasks[0].status, "running");
    await phone.close();
    await pc.close();
    store.close();
  });

  test("scopes: read cannot write tasks or handoffs; write/read tools work for their scopes", async () => {
    const store = new Store(":memory:");
    const read = await connect(store, "read");
    for (const [name, args] of [
      ["task_put", { title: "x" }],
      ["session_handoff", { surface: "s", summary: "x" }],
    ] as const) {
      const r: any = await read.callTool({ name, arguments: args });
      assert.equal(r.isError, true, name);
      assert.match(r.content[0].text, /lacks the required 'write' scope/);
    }
    assert.equal(store.list().total, 0);
    for (const name of ["task_list", "catch_up"]) {
      const r: any = await read.callTool({ name, arguments: {} });
      assert.ok(!r.isError, name);
    }
    await read.close();
    store.close();
  });

  test("namespace resolution: writes land in the server's namespace, reads are confined, foreign ids are 'no task'", async () => {
    const store = new Store(":memory:");
    const foreign = putTask(store, { title: "foreign", namespace: "home" }).task;
    putTask(store, { title: "granted", namespace: "shared" });
    const client = await connect(store, "write", { namespace: "work", readsFrom: { work: ["shared"] } });
    const made = parseTool(
      await client.callTool({ name: "task_put", arguments: { title: "mine", namespace: "home" } })
    );
    assert.equal(made.task.namespace, "work", "model-supplied namespace must be ignored");
    const bad: any = await client.callTool({ name: "task_put", arguments: { id: foreign.id, status: "done" } });
    assert.equal(bad.isError, true);
    assert.match(bad.content[0].text, /no task with id/);
    assert.equal(listTasks(store, { namespaces: ["home"] }).tasks[0].status, "idea");
    // reading a granted namespace works but never writing to it
    const granted = listTasks(store, { namespaces: ["shared"] }).tasks[0];
    const nope: any = await client.callTool({ name: "task_put", arguments: { id: granted.id, status: "done" } });
    assert.equal(nope.isError, true);
    const listed = parseTool(await client.callTool({ name: "task_list", arguments: { namespace: "home" } }));
    assert.deepEqual(listed.tasks.map((t: any) => t.title).sort(), ["granted", "mine"]);
    const cu = parseTool(await client.callTool({ name: "catch_up", arguments: { namespace: "home", consumer: "c" } }));
    assert.ok(!JSON.stringify(cu).includes("foreign"));
    const h = parseTool(await client.callTool({ name: "session_handoff", arguments: { surface: "s", summary: "y" } }));
    assert.equal(h.handoff.namespace, "work");
    await client.close();
    store.close();
  });

  test("linter still guards task text (secrets are refused)", async () => {
    const store = new Store(":memory:");
    const client = await connect(store, "write");
    const r: any = await client.callTool({
      name: "task_put",
      arguments: { title: "deploy", notes: "key is AKIAIOSFODNN7EXAMPLE and sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789" },
    });
    assert.ok(r.isError || parseTool(r).quarantined || parseTool(r).warnings, "secret-looking text must not pass silently");
    await client.close();
    store.close();
  });
});

describe("REST /tasks, /handoffs, /catch-up", () => {
  let store: Store;
  let base: string;
  let server: ReturnType<typeof createApiServer>;
  const ADMIN = "admin-token-tasks";
  const WRITE = "write-token-tasks";
  const READ = "read-token-tasks";
  const WORK = "work-token-tasks";
  before(async () => {
    store = new Store(":memory:");
    server = createApiServer(store, [
      { token: ADMIN, scope: "admin", label: "admin" },
      { token: WRITE, scope: "write", label: "write" },
      { token: READ, scope: "read", label: "read" },
      { token: WORK, scope: "write", label: "work", namespace: "work" },
    ]);
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
  });
  const call = (method: string, path: string, token?: string, body?: unknown) =>
    fetch(`${base}${path}`, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });

  test("auth and scopes", async () => {
    for (const [m, p] of [["GET", "/tasks"], ["POST", "/tasks"], ["PUT", "/tasks/1"], ["POST", "/handoffs"], ["GET", "/catch-up"]]) {
      assert.equal((await call(m, p)).status, 401, `${m} ${p}`);
    }
    assert.equal((await call("POST", "/tasks", READ, { title: "x" })).status, 403);
    assert.equal((await call("PUT", "/tasks/1", READ, { status: "done" })).status, 403);
    assert.equal((await call("POST", "/handoffs", READ, { surface: "s", summary: "x" })).status, 403);
    assert.equal((await call("GET", "/tasks", READ)).status, 200);
    assert.equal((await call("GET", "/catch-up", READ)).status, 200);
    assert.equal(store.list().total, 0);
  });

  test("create, update, list, 404, 409, 400s", async () => {
    const created = await call("POST", "/tasks", WRITE, { title: "REST task", owner: "curl", next_step: "do it" });
    assert.equal(created.status, 201);
    const { task } = await created.json();
    assert.equal(task.status, "idea");
    const upd = await call("PUT", `/tasks/${task.id}`, WRITE, { status: "running", if_rev: 1 });
    assert.equal(upd.status, 200);
    assert.equal((await upd.json()).task.rev, 2);
    assert.equal((await call("PUT", `/tasks/${task.id}`, WRITE, { status: "done", if_rev: 1 })).status, 409);
    assert.equal((await call("PUT", "/tasks/99999", WRITE, { status: "done" })).status, 404);
    const plain = store.create({ title: "plain note" });
    assert.equal((await call("PUT", `/tasks/${plain.id}`, WRITE, { status: "done" })).status, 404);
    assert.equal((await call("POST", "/tasks", WRITE, { status: "idea" })).status, 400);
    assert.equal((await call("POST", "/tasks", WRITE, { title: "x", status: "weird" })).status, 400);
    assert.equal((await call("POST", "/tasks", WRITE, { id: task.id, title: "x" })).status, 400);
    assert.equal((await call("POST", "/tasks", WRITE, "{not json")).status, 400);
    assert.equal((await call("POST", "/tasks", WRITE, "[1]")).status, 400);
    assert.equal((await call("GET", "/tasks?limit=abc", READ)).status, 400);
    assert.equal((await call("GET", "/tasks?status=nope", READ)).status, 400);
    const list = await (await call("GET", "/tasks?owner=curl", READ)).json();
    assert.deepEqual(list.tasks.map((t: any) => t.status), ["running"]);
    await call("PUT", `/tasks/${task.id}`, WRITE, { status: "done" });
    assert.equal((await (await call("GET", "/tasks", READ)).json()).tasks.length, 0);
    assert.equal((await (await call("GET", "/tasks?status=done", READ)).json()).tasks.length, 1);
    assert.equal((await call("DELETE", `/tasks/${task.id}`, WRITE)).status, 403);
  });

  test("handoff -> catch-up round trip", async () => {
    const h = await call("POST", "/handoffs", WRITE, { surface: "laptop", done: ["a"], pending: ["b"], next_step: "c" });
    assert.equal(h.status, 201);
    assert.equal((await call("POST", "/handoffs", WRITE, { surface: "laptop" })).status, 400);
    const cu = await (await call("GET", "/catch-up?consumer=rest-pc", READ)).json();
    assert.equal(cu.handoffs[0].surface, "laptop");
    assert.deepEqual(cu.handoffs[0].pending, ["b"]);
    assert.ok(cu.changes.counts.total >= 1);
    const again = await (await call("GET", "/catch-up?consumer=rest-pc&changes=0", READ)).json();
    assert.equal(again.changes, undefined);
    assert.equal((await call("GET", "/catch-up?consumer=bad%20label", READ)).status, 400);
    const hs = await (await call("GET", "/handoffs?surface=laptop&limit=1", READ)).json();
    assert.equal(hs.handoffs.length, 1);
  });

  test("a namespace-pinned token cannot see or touch another namespace", async () => {
    const other = putTask(store, { title: "home only", namespace: "home" }).task;
    const mine = await (await call("POST", "/tasks", WORK, { title: "work thing", namespace: "home" })).json();
    assert.equal(mine.task.namespace, "work");
    const list = await (await call("GET", "/tasks?namespace=home", WORK)).json();
    assert.deepEqual(list.tasks.map((t: any) => t.title), ["work thing"]);
    assert.equal((await call("PUT", `/tasks/${other.id}`, WORK, { status: "done" })).status, 404);
    assert.equal(store.read(other.id)!.rev, 1);
    const cu = await (await call("GET", "/catch-up?namespace=home", WORK)).json();
    assert.ok(!JSON.stringify(cu).includes("home only"));
    const hs = await (await call("POST", "/handoffs", WORK, { surface: "s", summary: "w", namespace: "home" })).json();
    assert.equal(hs.handoff.namespace, "work");
  });
});

describe("recall: task board in the SessionStart hook", () => {
  const ctxOf = (out: string): string => JSON.parse(out).hookSpecificOutput.additionalContext;

  test("open tasks and the latest handoff come first; tasks are not repeated as recent notes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "om-recall-board-"));
    try {
      const db = join(dir, "state.db");
      const s = new Store(db);
      s.create({ title: "Pref", body: "Keep replies short." });
      putTask(s, { title: "Build the hoodie page", status: "running", owner: "pc", next_step: "pick fonts" });
      putTask(s, { title: "Already shipped", status: "done" });
      writeHandoff(s, { surface: "phone", summary: "Left the hoodie idea", pending: ["vendor quote"], next_step: "PC: check vendor" });
      s.close();
      const ctx = ctxOf(await runRecall({ dbPath: db }));
      assert.match(ctx, /Open tasks \(1\):/);
      assert.match(ctx, /#\d+ \[running\] Build the hoodie page \(pc\) -> next: pick fonts/);
      assert.match(ctx, /Latest handoff from phone/);
      assert.match(ctx, /next: PC: check vendor/);
      assert.ok(!ctx.includes("Already shipped"), "done tasks stay out");
      assert.ok(ctx.includes("Keep replies short."), "ordinary recall still works");
      assert.ok(ctx.indexOf("Open tasks") < ctx.indexOf("Recent memory"));
      assert.equal((ctx.match(/Build the hoodie page/g) ?? []).length, 1);
      assert.ok(ctx.includes("UNTRUSTED DATA"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a store with no tasks or handoffs recalls exactly as before", async () => {
    const dir = mkdtempSync(join(tmpdir(), "om-recall-plain-"));
    try {
      const db = join(dir, "state.db");
      const s = new Store(db);
      s.create({ title: "Only", body: "note" });
      s.close();
      const ctx = ctxOf(await runRecall({ dbPath: db }));
      assert.ok(ctx.includes("Recent memory (1 note):\n- [Only] {recent 0d}: note"));
      assert.ok(!ctx.includes("Open tasks") && !ctx.includes("handoff"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("stays inside the size budget with many long tasks", async () => {
    const dir = mkdtempSync(join(tmpdir(), "om-recall-big-"));
    try {
      const db = join(dir, "state.db");
      const s = new Store(db);
      for (let i = 0; i < 40; i++) {
        putTask(s, { title: "T".repeat(190) + i, next_step: "N".repeat(490), status: "running" });
        s.create({ title: `note ${i}`, body: "B".repeat(2000) });
      }
      writeHandoff(s, { surface: "pc", summary: "S".repeat(900), pending: Array(25).fill("P".repeat(480)) });
      s.close();
      const t0 = Date.now();
      const ctx = ctxOf(await runRecall({ dbPath: db }));
      assert.ok(ctx.length <= RECALL_MAX_CHARS + 600, `context too large: ${ctx.length}`); // + banner
      assert.ok(Date.now() - t0 < 2000);
      assert.match(ctx, /Open tasks \(40, showing \d+\):/, "header counts the total, not the shown rows");
      assert.match(ctx, /Latest handoff from pc/, "the handoff is never cut by a long task list");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("configured namespaces: the board is scoped like the notes (no cross-namespace leak)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "om-recall-ns-board-"));
    const prev = process.env.ONEMEMORY_SPACES;
    try {
      const db = join(dir, "state.db");
      const s = new Store(db);
      putTask(s, { title: "proj-a task", namespace: "proj-a" });
      putTask(s, { title: "other project task", namespace: "proj-b" });
      writeHandoff(s, { surface: "x", summary: "other project handoff", namespace: "proj-b" });
      s.close();
      process.env.ONEMEMORY_SPACES = JSON.stringify({ spaces: { [process.cwd()]: "proj-a" }, default_namespace: "shared" });
      const ctx = ctxOf(await runRecall({ dbPath: db }));
      assert.ok(ctx.includes("proj-a task"));
      assert.ok(!ctx.includes("other project"), `LEAK: ${ctx}`);
    } finally {
      if (prev === undefined) delete process.env.ONEMEMORY_SPACES;
      else process.env.ONEMEMORY_SPACES = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("buildBoardSummary: empty -> empty, and is capped", () => {
    assert.equal(buildBoardSummary([], null), "");
    const s = new Store(":memory:");
    const tasks = Array.from({ length: 30 }, (_, i) => putTask(s, { title: "t".repeat(190) + i, next_step: "n".repeat(400) }).task);
    assert.ok(buildBoardSummary(tasks, null).length <= 2500);
    s.close();
  });
});
