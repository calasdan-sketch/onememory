// Trust policy (1.4.0): stable writer ids and the per-namespace distrust list.
// Every read path that can show a note to an agent must leave out a distrusted
// writer's notes by default and show them, marked, only on request.
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Store } from "../src/store.js";
import { actorStore } from "../src/actor.js";
import { createApiServer } from "../src/api.js";
import { createMcpServer } from "../src/mcp-server-core.js";
import { runSearch, runSearchExplained, runRelevantSearch } from "../src/search-service.js";
import { runChanges } from "../src/changes.js";
import { putTask, approveTask, claimTask, getTask, listTasks, listHandoffs, writeHandoff, catchUp, queuedCommandTasks, classifyQueuedCommand } from "../src/tasks.js";
import { buildSummary } from "../src/recall.js";
import { provenanceBanner } from "../src/security.js";
import { consolidateNotes } from "../src/consolidate.js";
import { makeWriterId, parseWriterRef, distrustSql, matchesDistrust, type DistrustRule } from "../src/trust.js";

const as = <T>(label: string, fn: () => T): T => actorStore.run({ label, authed: true }, fn);
const HOUR_AGO = (): string => new Date(Date.now() - 3600_000).toISOString();

function parseTool(r: any): any {
  const t: string = r.content[0].text;
  return JSON.parse(t.slice(t.indexOf("{")));
}

async function mcp(store: Store, scope: "read" | "write" | "admin", opts: any = {}, conn: any = {}) {
  const server = createMcpServer(store, scope, opts, conn);
  const [c, s] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1.0.0" });
  await Promise.all([client.connect(c), server.connect(s)]);
  return client;
}

describe("stable writer identity", () => {
  test("server_id is a random uuid, minted once, and survives a REAL reopen of the file", () => {
    const dir = mkdtempSync(join(tmpdir(), "om-sid-"));
    try {
      const path = join(dir, "state.db");
      const a = new Store(path);
      const b = new Store(":memory:");
      const sid = a.serverId();
      assert.match(sid, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      assert.notEqual(sid, b.serverId(), "every database gets its own");
      assert.equal(a.serverId(), sid, "stable within a process");
      a.close();
      b.close();
      const again = new Store(path);
      assert.equal(again.serverId(), sid, "the same file keeps its id across a close and reopen");
      again.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("writer_id = <server_id>/<label> next to written_by on notes, feed entries, tasks and handoffs", () => {
    const s = new Store(":memory:");
    const n = as("phone", () => s.create({ title: "doc", body: "x" }));
    assert.equal(n.written_by, "phone");
    assert.equal(n.writer_id, `${s.serverId()}/phone`);
    assert.equal(s.read(n.id)!.writer_id, `${s.serverId()}/phone`);
    const ev = s.changes({ since: HOUR_AGO() }).changes[0];
    assert.equal(ev.writer_id, `${s.serverId()}/phone`);
    assert.equal(ev.note_writer_id, `${s.serverId()}/phone`);
    const t = as("phone", () => putTask(s, { title: "t" })).task;
    assert.equal(t.writer_id, `${s.serverId()}/phone`);
    const h = as("phone", () => writeHandoff(s, { surface: "phone", summary: "s" })).handoff;
    assert.equal(h.writer_id, `${s.serverId()}/phone`);
    // an unknown writer has no id
    assert.equal(makeWriterId(s.serverId(), ""), "");
    s.close();
  });

  test("the label is normalised the same way for ids", () => {
    assert.equal(makeWriterId("sid", "  Phone  "), makeWriterId("sid", "Phone"));
    const id = "0b9b0a4e-1111-4222-8333-444455556666";
    assert.deepEqual(parseWriterRef(`${id}/phone`), { serverId: id, label: "phone" });
    assert.deepEqual(parseWriterRef("phone"), { serverId: "", label: "phone" });
    assert.deepEqual(parseWriterRef("team/phone").serverId, "", "a slash alone does not make an id");
  });

  test("written_by and writer_id can both be used as filters", () => {
    const s = new Store(":memory:");
    as("alice", () => s.create({ title: "a note", body: "x" }));
    as("bob", () => s.create({ title: "b note", body: "x" }));
    assert.equal(s.list({ writtenBy: "alice" }).notes.length, 1);
    assert.equal(s.list({ writtenBy: `${s.serverId()}/alice` }).notes.length, 1);
    assert.equal(s.list({ writtenBy: "11111111-1111-4111-8111-111111111111/alice" }).notes.length, 0, "a foreign id never matches a local writer");
    assert.equal(s.list({ notWrittenBy: `${s.serverId()}/alice` }).notes.map((n) => n.title).join(), "b note");
    s.close();
  });
});

describe("distrust list: store level", () => {
  let s: Store;
  beforeEach(() => {
    s = new Store(":memory:");
  });
  afterEach(() => s.close());

  test("an empty policy changes nothing (default behaviour)", () => {
    as("evil", () => s.create({ title: "hello world", body: "alpha" }));
    assert.deepEqual(s.distrustRules(), []);
    assert.equal(s.list().notes.length, 1);
    assert.equal(s.list().notes[0].distrusted, undefined);
    assert.equal(distrustSql([], s.serverId()).sql, "");
  });

  test("distrusted notes are left out of list, search and read-neighbors; include_distrusted shows them marked", () => {
    const bad = as("evil", () => s.create({ title: "shared topic one", body: "alpha beta gamma delta" }));
    const good = as("good", () => s.create({ title: "shared topic two", body: "alpha beta gamma delta" }));
    s.distrustAdd("default", "evil");
    assert.deepEqual(s.list().notes.map((n) => n.id), [good.id]);
    assert.equal(s.list().total, 1, "the total agrees with the page");
    assert.deepEqual(s.search("alpha").map((n) => n.id), [good.id]);
    assert.deepEqual(s.searchRanked("alpha").map((h) => h.note.id), [good.id]);
    const shown = s.list({ includeDistrusted: true }).notes;
    assert.equal(shown.length, 2);
    assert.equal(shown.find((n) => n.id === bad.id)!.distrusted, true);
    assert.equal(shown.find((n) => n.id === good.id)!.distrusted, undefined);
    // neighbours of the trusted note do not name the distrusted one
    const nb = s.read(good.id, { withNeighbors: true })!.neighbors ?? [];
    assert.ok(!nb.some((x) => x.id === bad.id));
    const nb2 = s.read(good.id, { withNeighbors: true, includeDistrusted: true })!.neighbors ?? [];
    assert.ok(nb2.length === 0 || nb2.some((x) => x.id === bad.id));
  });

  test("a rule is per namespace; '*' covers all; a writer_id rule matches the local label", () => {
    as("evil", () => s.create({ namespace: "a", title: "in a", body: "x" }));
    as("evil", () => s.create({ namespace: "b", title: "in b", body: "x" }));
    s.distrustAdd("a", "evil");
    assert.deepEqual(s.list().notes.map((n) => n.title), ["in b"]);
    s.distrustAdd("*", `${s.serverId()}/evil`);
    assert.equal(s.list().notes.length, 0);
    assert.equal(s.distrustRemove("a", "evil"), true);
    assert.equal(s.list().notes.length, 0, "the wildcard rule still applies");
    assert.equal(s.distrustRemove("*", `${s.serverId()}/evil`), true);
    assert.equal(s.list().notes.length, 2);
    assert.equal(s.distrustRemove("a", "evil"), false, "removing twice reports false");
  });

  test("a distrusted writer's content stays hidden after a trusted rewrite (no laundering); removing the rule restores it", () => {
    const n = as("good", () => s.create({ title: "doc", body: "v1" }));
    s.distrustAdd("default", "evil");
    assert.equal(s.list().notes.length, 1);
    as("evil", () => s.update(n.id, { body: "v2 poisoned" }));
    assert.equal(s.list().notes.length, 0);
    // a trusted writer editing the note does not clean it: it may still contain the poisoned text
    as("good", () => s.update(n.id, { body: "v3 reviewed" }));
    assert.equal(s.list().notes.length, 0, "the taint is monotonic");
    assert.deepEqual(s.read(n.id)!.merged_from_writers, ["evil", "good"], "both earlier hands are on record");
    // a tags-only touch changes nothing either
    as("good", () => s.update(n.id, { tags: ["x"] }));
    assert.equal(s.list().notes.length, 0);
    // the human way to un-hide it is to lift the rule
    s.distrustRemove("default", "evil");
    assert.equal(s.list().notes.length, 1);
  });

  test("validation: namespace and writer are required; the list is bounded per namespace and overall", () => {
    assert.throws(() => s.distrustAdd("", "x"), /namespace is required/);
    assert.throws(() => s.distrustAdd("default", ""), /writer is required/);
    for (let i = 0; i < 50; i++) s.distrustAdd("default", `w${i}`);
    assert.throws(() => s.distrustAdd("default", "one-too-many"), /full \(50 entries\)/);
    s.distrustAdd("default", "w3"); // re-adding an existing rule is not "one more"
    for (let n = 0; n < 9; n++) for (let i = 0; i < 50; i++) s.distrustAdd(`ns${n}`, `w${i}`);
    assert.throws(() => s.distrustAdd("ns9", "one-too-many"), /too many|at most|500/i);
  });

  test("changes are audit-logged in the database with who made them", () => {
    as("admin-console", () => s.distrustAdd("default", "evil"));
    as("admin-console", () => s.distrustRemove("default", "evil"));
    const log = s.trustLog(10);
    assert.deepEqual(log.map((l) => l.action), ["undistrust", "distrust"]);
    assert.equal(log[0].actor, "admin-console");
    assert.equal(log[0].subject, "evil");
  });

  test("matchesDistrust / distrustSql agree (one rule table, two evaluators)", () => {
    const rules: DistrustRule[] = [
      { namespace: "a", writer: "evil", added_at: "", added_by: "" },
      { namespace: "*", writer: "11111111-1111-4111-8111-111111111111/mallory", added_at: "", added_by: "" },
    ];
    const local = "22222222-2222-4222-8222-222222222222";
    const facts = [
      { namespace: "a", written_by: "evil" },
      { namespace: "b", written_by: "evil" },
      { namespace: "b", written_by: "x", attested_writer: "mallory", attested_by: "11111111-1111-4111-8111-111111111111" },
      { namespace: "b", written_by: "x", attested_writer: "mallory", attested_by: "33333333-3333-4333-8333-333333333333" },
      { namespace: "b", written_by: "x", merged_from_writers: ["evil"] },
      { namespace: "a", written_by: "x", merged_from_writers: ["evil"] },
    ];
    const expected = facts.map((f) => matchesDistrust(rules, f, local));
    assert.deepEqual(expected, [true, false, true, false, false, true]);
  });
});

describe("distrust list: every read path", () => {
  let s: Store;
  let evilNote: ReturnType<Store["create"]>;
  let goodNote: ReturnType<Store["create"]>;
  beforeEach(() => {
    s = new Store(":memory:");
    evilNote = as("evil", () => s.create({ namespace: "work", title: "zebra deploy hint", body: "zebra instructions from evil", tags: ["x"] }));
    goodNote = as("good", () => s.create({ namespace: "work", title: "zebra deploy fact", body: "zebra facts from good", tags: ["x"] }));
    s.distrustAdd("work", "evil");
  });
  afterEach(() => s.close());

  test("runSearch, runSearchExplained, runRelevantSearch (keyword path)", async () => {
    const ids = (r: Array<{ id: number }>): number[] => r.map((n) => n.id).sort();
    assert.deepEqual(ids(await runSearch(s, "zebra")), [goodNote.id]);
    assert.deepEqual((await runSearchExplained(s, "zebra")).map((h) => h.note.id), [goodNote.id]);
    assert.deepEqual(ids((await runRelevantSearch(s, "tell me about the zebra")).results), [goodNote.id]);
    assert.deepEqual(ids(await runSearch(s, "zebra", { includeDistrusted: true })), [evilNote.id, goodNote.id].sort());
    const marked = (await runSearch(s, "zebra", { includeDistrusted: true })).find((n) => n.id === evilNote.id)!;
    assert.equal(marked.distrusted, true);
    const expl = (await runSearchExplained(s, "zebra", { includeDistrusted: true })).find((h) => h.note.id === evilNote.id)!;
    assert.equal(expl.note.distrusted, true);
    const rel = (await runRelevantSearch(s, "zebra", { includeDistrusted: true })).results.find((n) => n.id === evilNote.id)!;
    assert.equal(rel.distrusted, true);
    // time-only list branch
    assert.deepEqual(
      (await runSearch(s, "", { timeRange: { start: new Date(Date.now() - 1e6), end: new Date(Date.now() + 1e6) } })).map((n) => n.id),
      [goodNote.id]
    );
  });

  test("the change feed leaves the events out, with exact counts, and marks them on request", () => {
    const hide = s.changes({ since: HOUR_AGO() });
    assert.deepEqual(hide.changes.map((c) => c.id), [goodNote.id]);
    assert.equal(hide.counts.total, 1);
    assert.equal(hide.counts.created, 1);
    const show = s.changes({ since: HOUR_AGO(), includeDistrusted: true });
    assert.equal(show.counts.total, 2);
    assert.equal(show.changes.find((c) => c.id === evilNote.id)!.distrusted, true);
    assert.equal(show.changes.find((c) => c.id === goodNote.id)!.distrusted, undefined);
    // the same through runChanges
    assert.equal(runChanges(s, { since: HOUR_AGO() }).changes.length, 1);
  });

  test("a distrusted note's DELETE stays hidden too (its writer is remembered on the delete row)", () => {
    as("admin", () => s.delete(evilNote.id));
    const feed = s.changes({ since: HOUR_AGO() });
    assert.deepEqual(feed.changes.map((c) => c.id), [goodNote.id], "no 'deleted' entry for the distrusted note");
    const all = s.changes({ since: HOUR_AGO(), includeDistrusted: true });
    const del = all.changes.find((c) => c.id === evilNote.id)!;
    assert.equal(del.kind, "deleted");
    assert.equal(del.note_written_by, "evil");
    assert.equal(del.distrusted, true);
  });

  test("a feed cursor stays valid across pages and the ack token is scoped to the filter", () => {
    for (let i = 0; i < 5; i++) as("good", () => s.create({ namespace: "work", title: `g${i}`, body: "x" }));
    const p1 = s.changes({ since: HOUR_AGO(), limit: 2 });
    assert.ok(p1.nextCursor);
    const p2 = s.changes({ cursor: p1.nextCursor!, limit: 2 });
    assert.equal(p2.changes.length, 2);
    // a cursor from the include_distrusted view is not valid for the default view
    const inc = s.changes({ since: HOUR_AGO(), limit: 2, includeDistrusted: true });
    assert.throws(() => s.changes({ cursor: inc.nextCursor! }), /different/);
  });

  test("catch_up: changes, tasks and handoffs", () => {
    const evilTask = as("evil", () => putTask(s, { namespace: "work", title: "evil task" })).task;
    const goodTask = as("good", () => putTask(s, { namespace: "work", title: "good task" })).task;
    as("evil", () => writeHandoff(s, { namespace: "work", surface: "evil-box", summary: "evil handoff" }));
    as("good", () => writeHandoff(s, { namespace: "work", surface: "good-box", summary: "good handoff" }));
    const cu = catchUp(s, { namespaces: ["work"], consumer: "c1" });
    assert.deepEqual(cu.tasks.open.map((t) => t.id), [goodTask.id]);
    assert.deepEqual(cu.handoffs.map((h) => h.surface), ["good-box"]);
    assert.ok(cu.changes!.recent.every((c) => c.id !== evilNote.id && c.id !== evilTask.id));
    const inc = catchUp(s, { namespaces: ["work"], consumer: "c2", includeDistrusted: true });
    assert.equal(inc.tasks.open.length, 2);
    assert.equal(inc.handoffs.length, 2);
    assert.equal((inc.tasks.open.find((t) => t.id === evilTask.id) as any).distrusted, true);
    assert.equal(inc.handoffs.find((h) => h.surface === "evil-box")!.distrusted, true);
    // writer filters work on catch_up too
    const only = catchUp(s, { namespaces: ["work"], consumer: "c3", includeDistrusted: true, notWrittenBy: "evil" });
    assert.deepEqual(only.tasks.open.map((t) => t.id), [goodTask.id]);
    assert.deepEqual(only.handoffs.map((h) => h.surface), ["good-box"]);
  });

  test("tasks: list, get, claim and approve", () => {
    const evilTask = as("evil", () => putTask(s, { namespace: "work", title: "evil task" })).task;
    const goodTask = as("good", () => putTask(s, { namespace: "work", title: "good task" })).task;
    assert.deepEqual(listTasks(s, { namespaces: ["work"] }).tasks.map((t) => t.id), [goodTask.id]);
    assert.equal(listTasks(s, { namespaces: ["work"] }).total, 1);
    assert.equal(listTasks(s, { namespaces: ["work"], includeDistrusted: true }).total, 2);
    assert.throws(() => getTask(s, evilTask.id, ["work"]), /no task/);
    assert.equal(getTask(s, evilTask.id, ["work"], { includeDistrusted: true }).distrusted, true);
    assert.throws(() => claimTask(s, { id: evilTask.id, owner: "me" }), /distrust list/);
    assert.equal(claimTask(s, { id: goodTask.id, owner: "me" }).task.id, goodTask.id);
    // releasing is still allowed (it only gives something up)
    s.distrustAdd("work", "good");
    assert.equal(claimTask(s, { id: goodTask.id, owner: "me", release: true }).released, true);
  });

  test("a distrusted command task is never run, even if it was approved before the writer was distrusted", () => {
    s.distrustRemove("work", "evil");
    const cmd = as("evil", () => putTask(s, { namespace: "work", title: "run it", command: { action: "hello" }, target: "pc-1" })).task;
    as("admin", () => approveTask(s, { id: cmd.id, if_rev: s.read(cmd.id)!.rev }));
    const note = s.read(cmd.id)!;
    const now = Date.now();
    assert.equal(classifyQueuedCommand(s, note, { me: "pc-1", namespace: "work" }, now).kind, "runnable", "control: runnable before");
    assert.equal(queuedCommandTasks(s, "work").length, 1);
    s.distrustAdd("work", "evil");
    assert.equal(queuedCommandTasks(s, "work").length, 0, "the runner's queue no longer returns it");
    const v = classifyQueuedCommand(s, note, { me: "pc-1", namespace: "work" }, now);
    assert.deepEqual(v, { kind: "skip", why: "distrusted" }, "and the classifier refuses it independently");
    assert.throws(() => approveTask(s, { id: cmd.id, if_rev: s.read(cmd.id)!.rev }), /distrust list/);
  });

  test("recall summary marks a distrusted note when it is asked to show one", () => {
    const text = buildSummary(s.markDistrusted([s.read(evilNote.id)!]));
    assert.match(text, /DISTRUSTED WRITER/);
    assert.doesNotMatch(buildSummary([s.read(goodNote.id)!]), /DISTRUSTED/);
  });

  test("memory_stats and the consolidation candidate list do not show a distrusted note's title", async () => {
    for (let i = 0; i < 3; i++) s.touch(evilNote.id);
    const stats = s.accessStats(["work"]);
    assert.equal(stats.totalNotes, 2, "counts include every note");
    assert.ok(!stats.mostAccessed.some((m) => m.id === evilNote.id), "titles do not");
    const twin = as("evil", () => s.create({ namespace: "work", title: "zebra deploy hint", body: "zebra instructions from evil" }));
    const c = await mcp(s, "admin");
    const r = parseTool(await c.callTool({ name: "memory_consolidation_candidates", arguments: { namespace: "work", threshold: 0.5 } }));
    assert.ok(!JSON.stringify(r).includes("zebra deploy hint"), `leaked: ${JSON.stringify(r)}`);
    void twin;
  });

  test("consolidation keeps the taint: a merge of a distrusted note stays hidden and counts as touched by that writer", () => {
    s.distrustRemove("work", "evil");
    const a = as("evil", () => s.create({ namespace: "work", title: "tip one", body: "alpha tips" }));
    const b = as("good", () => s.create({ namespace: "work", title: "tip two", body: "beta tips" }));
    const merged = as("admin", () => consolidateNotes(s, [a.id, b.id]));
    assert.deepEqual(merged.merged_from_writers, ["evil", "good"]);
    s.distrustAdd("work", "evil");
    assert.ok(!s.list({ namespace: "work" }).notes.some((n) => n.id === merged.id), "the merged note is hidden");
    // even after a trusted editor rewrites the merged note: the taint is permanent by design
    as("good", () => s.update(merged.id, { body: "reviewed by good" }));
    assert.ok(!s.list({ namespace: "work" }).notes.some((n) => n.id === merged.id));
    assert.deepEqual(s.read(merged.id)!.merged_from_writers, ["admin", "evil", "good"], "the set only grows");
  });
});

describe("distrust list: the banner", () => {
  test("a distrusted note is named first and called DISTRUSTED in the WHO WROTE THIS block", () => {
    const text = provenanceBanner({
      notes: [
        { id: 1, written_by: "good", created_by: "good" },
        { id: 2, written_by: "evil", created_by: "evil", distrusted: true },
      ],
    });
    const lines = text.split("\n");
    assert.match(lines[1], /^- #2: DISTRUSTED WRITER/);
    assert.match(lines[2], /^- #1: written by good/);
  });

  test("the warning survives the line cap", () => {
    const notes = Array.from({ length: 40 }, (_, i) => ({ id: i + 1, written_by: "w", created_by: "w", distrusted: i === 39 }));
    const text = provenanceBanner({ notes }, 5);
    assert.match(text, /#40: DISTRUSTED WRITER/);
  });
});

describe("distrust list: HTTP API", () => {
  let store: Store;
  let server: ReturnType<typeof createApiServer>;
  let base: string;
  const ADMIN = "adm-tok";
  const WRITE = "wr-tok";
  const READ = "rd-tok";
  const EVIL = "evil-tok";
  const PIN = "pin-admin-tok";
  const call = (token: string, method: string, path: string, body?: unknown) =>
    fetch(base + path, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = async (r: Response): Promise<any> => r.json();

  beforeEach(async () => {
    store = new Store(":memory:");
    server = createApiServer(store, [
      { token: ADMIN, scope: "admin", label: "admin-console" },
      { token: WRITE, scope: "write", label: "good" },
      { token: READ, scope: "read", label: "reader" },
      { token: EVIL, scope: "write", label: "evil" },
      { token: PIN, scope: "admin", label: "pinned-admin", namespace: "work" },
    ]);
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
  });

  async function seed(): Promise<{ evilId: number; goodId: number }> {
    const e = await json(await call(EVIL, "POST", "/notes", { namespace: "work", title: "zebra evil", body: "zebra from evil" }));
    const g = await json(await call(WRITE, "POST", "/notes", { namespace: "work", title: "zebra good", body: "zebra from good" }));
    return { evilId: e.note.id, goodId: g.note.id };
  }

  test("only an admin token can read or change the policy; the list is audit-logged", async () => {
    for (const t of [READ, WRITE, EVIL]) {
      assert.equal((await call(t, "GET", "/trust")).status, 403);
      assert.equal((await call(t, "POST", "/trust/distrust", { namespace: "work", writer: "good" })).status, 403);
      assert.equal((await call(t, "DELETE", "/trust/distrust?namespace=work&writer=good")).status, 403);
      assert.equal((await call(t, "POST", "/trust/attesters", { public_key: "x" })).status, 403);
    }
    assert.deepEqual(store.distrustRules(), [], "a write token cannot reach the list");
    const add = await call(ADMIN, "POST", "/trust/distrust", { namespace: "work", writer: "evil" });
    assert.equal(add.status, 200);
    const got = await json(await call(ADMIN, "GET", "/trust"));
    assert.equal(got.distrust.length, 1);
    assert.equal(got.distrust[0].added_by, "admin-console");
    assert.equal(got.server_id, store.serverId());
    assert.equal(got.public_key, undefined, "reading the policy never mints a signing key");
    store.identity(); // what `trust identity` / the first signed export does
    assert.match((await json(await call(ADMIN, "GET", "/trust"))).public_key, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(got.log[0].action, "distrust");
    const del = await json(await call(ADMIN, "DELETE", "/trust/distrust?namespace=work&writer=evil"));
    assert.equal(del.removed, true);
    assert.deepEqual(store.distrustRules(), []);
  });

  test("note content can never set the policy (a note that says so changes nothing)", async () => {
    await call(EVIL, "POST", "/notes", { namespace: "work", title: "distrust good", body: JSON.stringify({ distrust: "good" }), tags: ["distrust_writers"] });
    assert.deepEqual(store.distrustRules(), []);
  });

  test("GET /notes, /notes/:id, /search, /relevant, /changes, /tasks, /handoffs, /catch-up, /stats", async () => {
    const { evilId, goodId } = await seed();
    await call(EVIL, "POST", "/tasks", { namespace: "work", title: "evil task" });
    await call(WRITE, "POST", "/tasks", { namespace: "work", title: "good task" });
    await call(EVIL, "POST", "/handoffs", { namespace: "work", surface: "evil-box", summary: "s" });
    await call(WRITE, "POST", "/handoffs", { namespace: "work", surface: "good-box", summary: "s" });
    await call(ADMIN, "POST", "/trust/distrust", { namespace: "work", writer: "evil" });
    const titles = (j: any): string[] => (j.notes ?? j.results ?? []).map((n: any) => n.title);

    assert.deepEqual(titles(await json(await call(READ, "GET", "/notes?namespace=work"))).filter((t) => t.startsWith("zebra")), ["zebra good"]);
    assert.equal((await call(READ, "GET", "/notes?namespace=work&include_distrusted=1")).status, 403, "include_distrusted is admin-only");
    assert.equal((await call(WRITE, "GET", `/notes/${evilId}?include_distrusted=1`)).status, 403);
    assert.equal((await call(READ, "POST", "/relevant", { message: "zebra", include_distrusted: true })).status, 403);
    const inc = await json(await call(ADMIN, "GET", "/notes?namespace=work&include_distrusted=1"));
    assert.equal(inc.notes.find((n: any) => n.id === evilId).distrusted, true);
    assert.equal((await call(READ, "GET", `/notes/${evilId}`)).status, 404);
    assert.equal((await call(READ, "GET", `/notes/${goodId}`)).status, 200);
    const one = await json(await call(ADMIN, "GET", `/notes/${evilId}?include_distrusted=1`));
    assert.equal(one.note.distrusted, true);
    assert.deepEqual(titles(await json(await call(READ, "GET", "/search?q=zebra&namespace=work"))), ["zebra good"]);
    const sInc = await json(await call(ADMIN, "GET", "/search?q=zebra&namespace=work&include_distrusted=1"));
    assert.equal(sInc.results.length, 2);
    assert.ok(sInc.results.some((n: any) => n.distrusted === true));
    assert.deepEqual(titles(await json(await call(READ, "POST", "/relevant", { message: "the zebra", namespace: "work" }))), ["zebra good"]);
    const rInc = await json(await call(ADMIN, "POST", "/relevant", { message: "the zebra", namespace: "work", include_distrusted: true }));
    assert.equal(rInc.results.length, 2);
    const ch = await json(await call(READ, "GET", "/changes?since=1h&namespace=work"));
    assert.ok(ch.changes.every((c: any) => c.written_by !== "evil"));
    const chInc = await json(await call(ADMIN, "GET", "/changes?since=1h&namespace=work&include_distrusted=1"));
    assert.ok(chInc.changes.some((c: any) => c.written_by === "evil" && c.distrusted === true));
    const tasks = await json(await call(READ, "GET", "/tasks?namespace=work"));
    assert.deepEqual(tasks.tasks.map((t: any) => t.title), ["good task"]);
    assert.equal((await json(await call(ADMIN, "GET", "/tasks?namespace=work&include_distrusted=1"))).tasks.length, 2);
    const hand = await json(await call(READ, "GET", "/handoffs?namespace=work"));
    assert.deepEqual(hand.handoffs.map((h: any) => h.surface), ["good-box"]);
    const cu = await json(await call(READ, "GET", "/catch-up?namespace=work&consumer=zz"));
    assert.deepEqual(cu.tasks.open.map((t: any) => t.title), ["good task"]);
    assert.deepEqual(cu.handoffs.map((h: any) => h.surface), ["good-box"]);
    // writer filters on every route, plus the note-level one on the feed
    const nb = await json(await call(ADMIN, "GET", "/changes?since=1h&namespace=work&include_distrusted=1&not_note_written_by=evil"));
    assert.ok(nb.changes.every((c: any) => c.note_written_by !== "evil"));
    const wb = await json(await call(ADMIN, "GET", "/changes?since=1h&namespace=work&include_distrusted=1&note_written_by=evil"));
    assert.ok(wb.changes.length > 0 && wb.changes.every((c: any) => c.note_written_by === "evil"));
    const stats = await json(await call(READ, "GET", "/stats?namespace=work"));
    assert.ok(!JSON.stringify(stats).includes("zebra evil"));
  });

  test("namespace isolation still holds with the policy on: a pinned token never sees another namespace's rules or notes", async () => {
    await call(ADMIN, "POST", "/trust/distrust", { namespace: "other", writer: "someone" });
    await call(ADMIN, "POST", "/trust/distrust", { namespace: "work", writer: "evil" });
    const seen = await json(await call(PIN, "GET", "/trust"));
    assert.deepEqual(seen.distrust.map((r: any) => r.namespace), ["work"]);
    assert.equal((await call(PIN, "POST", "/trust/distrust", { namespace: "other", writer: "x" })).status, 403);
    assert.equal((await call(PIN, "POST", "/trust/distrust", { namespace: "*", writer: "x" })).status, 403);
    assert.equal((await call(PIN, "POST", "/trust/distrust", { writer: "pal" })).status, 200, "its own namespace is implied");
    assert.ok(store.distrustRules().some((r) => r.namespace === "work" && r.writer === "pal"));
    assert.equal((await call(PIN, "POST", "/trust/attesters", { public_key: "A".repeat(43) })).status, 403, "the attester list is server-wide");
  });
});

describe("distrust list: MCP", () => {
  test("state_read / state_list / state_search / state_relevant / memory_since / catch_up / task_list / task_get", async () => {
    const s = new Store(":memory:");
    const e = as("evil", () => s.create({ title: "zebra evil", body: "zebra from evil" }));
    as("good", () => s.create({ title: "zebra good", body: "zebra from good" }));
    const et = as("evil", () => putTask(s, { title: "evil task" })).task;
    as("good", () => putTask(s, { title: "good task" }));
    s.distrustAdd("default", "evil");
    const c = await mcp(s, "read");
    const ca = await mcp(s, "admin");
    // include_distrusted is an ADMIN option: a read connection is refused loudly, not silently served
    const refused: any = await c.callTool({ name: "state_list", arguments: { include_distrusted: true } });
    assert.equal(refused.isError, true);
    assert.match(refused.content[0].text, /admin/i);
    const titles = (j: any, k = "results"): string[] => (j[k] ?? []).map((n: any) => n.title);
    assert.equal((await c.callTool({ name: "state_read", arguments: { id: e.id } }) as any).isError, true);
    const rd = parseTool(await ca.callTool({ name: "state_read", arguments: { id: e.id, include_distrusted: true } }));
    assert.equal(rd.note.distrusted, true);
    const rdText = (await ca.callTool({ name: "state_read", arguments: { id: e.id, include_distrusted: true } }) as any).content;
    assert.match(rdText[1].text, /DISTRUSTED WRITER/, "the WHO WROTE THIS block says so");
    assert.deepEqual(titles(parseTool(await c.callTool({ name: "state_list", arguments: {} })), "notes").filter((t) => t.startsWith("zebra")), ["zebra good"]);
    assert.equal(parseTool(await ca.callTool({ name: "state_list", arguments: { include_distrusted: true } })).notes.length >= 2, true);
    assert.deepEqual(titles(parseTool(await c.callTool({ name: "state_search", arguments: { query: "zebra" } }))), ["zebra good"]);
    assert.equal(parseTool(await ca.callTool({ name: "state_search", arguments: { query: "zebra", include_distrusted: true } })).results.length, 2);
    assert.deepEqual(titles(parseTool(await c.callTool({ name: "state_relevant", arguments: { message: "the zebra" } }))), ["zebra good"]);
    assert.equal(parseTool(await ca.callTool({ name: "state_relevant", arguments: { message: "the zebra", include_distrusted: true } })).results.length, 2);
    const since = parseTool(await c.callTool({ name: "memory_since", arguments: { since: "1h" } }));
    assert.ok(since.changes.every((x: any) => x.written_by !== "evil"));
    const sinceInc = parseTool(await ca.callTool({ name: "memory_since", arguments: { since: "1h", include_distrusted: true } }));
    assert.ok(sinceInc.changes.some((x: any) => x.distrusted === true));
    const cu = parseTool(await c.callTool({ name: "catch_up", arguments: { consumer: "m1" } }));
    assert.deepEqual(cu.tasks.open.map((t: any) => t.title), ["good task"]);
    const cuInc = parseTool(await ca.callTool({ name: "catch_up", arguments: { consumer: "m2", include_distrusted: true } }));
    assert.equal(cuInc.tasks.open.length, 2);
    assert.equal(parseTool(await c.callTool({ name: "task_list", arguments: {} })).tasks.length, 1);
    assert.equal((await c.callTool({ name: "task_get", arguments: { id: et.id } }) as any).isError, true);
    assert.equal(parseTool(await ca.callTool({ name: "task_get", arguments: { id: et.id, include_distrusted: true } })).task.distrusted, true);
    await c.close();
    s.close();
  });

  test("trust_policy is admin only and does what the REST routes do", async () => {
    const s = new Store(":memory:");
    for (const scope of ["read", "write"] as const) {
      const c = await mcp(s, scope);
      const r: any = await c.callTool({ name: "trust_policy", arguments: { action: "list" } });
      assert.equal(r.isError, true, `${scope} is refused`);
      await c.close();
    }
    const c = await mcp(s, "admin", {}, { label: "boss", authed: true });
    const add = await c.callTool({ name: "trust_policy", arguments: { action: "distrust", namespace: "default", writer: "evil" } }) as any;
    assert.ok(!add.isError);
    const list = parseTool(await c.callTool({ name: "trust_policy", arguments: { action: "list" } }));
    assert.equal(list.distrust[0].writer, "evil");
    assert.equal(list.distrust[0].added_by, "boss");
    assert.equal(list.server_id, s.serverId());
    const bad = await c.callTool({ name: "trust_policy", arguments: { action: "distrust", writer: "x" } }) as any;
    assert.equal(bad.isError, true, "a namespace is required");
    assert.equal(parseTool(await c.callTool({ name: "trust_policy", arguments: { action: "undistrust", namespace: "default", writer: "evil" } })).removed, true);
    await c.close();
    // a pinned server manages only its own namespace and cannot touch the attester list
    const pinned = await mcp(s, "admin", { namespace: "work" }, { label: "boss", authed: true });
    await pinned.callTool({ name: "trust_policy", arguments: { action: "distrust", writer: "evil" } });
    assert.deepEqual(s.distrustRules().map((r) => r.namespace), ["work"]);
    const att = await pinned.callTool({ name: "trust_policy", arguments: { action: "add_attester", public_key: "A".repeat(43) } }) as any;
    assert.equal(att.isError, true);
    await pinned.close();
    s.close();
  });
});
