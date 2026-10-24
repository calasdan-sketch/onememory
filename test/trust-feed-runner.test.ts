// 1.4.0 feed filters (event vs note writer, indexed), per-target runner status,
// the early return in the catch_up / recall notice, the module split that
// removed the tasks <-> liveness import cycle, and the delete / merge rules.
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Store } from "../src/store.js";
import { actorStore } from "../src/actor.js";
import { putTask, approveTask, catchUp } from "../src/tasks.js";
import { runnerStatus, runnerNotice, clearRunnerStatusCache, heartbeatTitle } from "../src/liveness.js";
import { consolidateNotes } from "../src/consolidate.js";
import { runChanges } from "../src/changes.js";
import { beat as runnerBeat, resetHeartbeat } from "../src/runner.js";
import { setProcessWriter } from "../src/actor.js";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { exportMarkdown, importMarkdown, parseNoteFile } from "../src/sync.js";

const as = <T>(label: string, fn: () => T): T => actorStore.run({ label, authed: true }, fn);
const HOUR_AGO = (): string => new Date(Date.now() - 3600_000).toISOString();
const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src");

describe("change feed: event writer vs note writer", () => {
  let s: Store;
  beforeEach(() => {
    s = new Store(":memory:");
  });
  afterEach(() => s.close());

  test("written_by is the EVENT writer, note_written_by the note's CURRENT writer", () => {
    const n = as("alice", () => s.create({ title: "doc", body: "v1" }));
    as("bob", () => s.update(n.id, { body: "v2" }));
    // one entry (the last event of the note): written by bob, note is bob's
    const e = s.changes({ since: HOUR_AGO() }).changes[0];
    assert.equal(e.written_by, "bob");
    assert.equal(e.note_written_by, "bob");
    // EVENT semantics: alice's create event is in the window, so written_by=alice finds the note
    // (its last matching event is alice's), although bob holds the note now.
    const ev = s.changes({ since: HOUR_AGO(), writtenBy: "alice" }).changes;
    assert.equal(ev.length, 1);
    assert.equal(ev[0].written_by, "alice");
    assert.equal(ev[0].note_written_by, "bob", "the entry shows who holds the note now");
    // NOTE semantics: only the note's CURRENT writer counts
    assert.equal(s.changes({ since: HOUR_AGO(), noteWrittenBy: "alice" }).changes.length, 0);
    assert.equal(s.changes({ since: HOUR_AGO(), noteWrittenBy: "bob" }).changes.length, 1);
    assert.equal(s.changes({ since: HOUR_AGO(), notNoteWrittenBy: "bob" }).changes.length, 0);
    // "not" is the exclusion form: alice's content was rewritten by bob, so alice still touched the note (1.4.1)
    assert.equal(s.changes({ since: HOUR_AGO(), notNoteWrittenBy: "alice" }).changes.length, 0);
    assert.equal(s.changes({ since: HOUR_AGO(), notNoteWrittenBy: "dave" }).changes.length, 1);
    // a tag-only touch by carol does not make her the note's writer
    as("carol", () => s.update(n.id, { tags: ["t"] }));
    assert.equal(s.changes({ since: HOUR_AGO(), noteWrittenBy: "carol" }).changes.length, 0);
    assert.equal(s.changes({ since: HOUR_AGO(), noteWrittenBy: "bob" }).changes.length, 1);
  });

  test("not_written_by on the feed also drops notes the writer touched in other ways (merge)", () => {
    const a = as("evil", () => s.create({ title: "tip one", body: "alpha tips" }));
    const b = as("good", () => s.create({ title: "tip two", body: "beta tips" }));
    const merged = as("admin", () => consolidateNotes(s, [a.id, b.id]));
    // the merge was made by admin, but the text came partly from evil
    const feed = s.changes({ since: HOUR_AGO(), notWrittenBy: "evil" }).changes;
    assert.ok(!feed.some((c) => c.id === merged.id), "the merged note counts as touched by evil");
    assert.equal(s.changes({ since: HOUR_AGO(), notWrittenBy: "somebody-else" }).changes.some((c) => c.id === merged.id), true);
    assert.equal(s.list({ notWrittenBy: "evil" }).notes.some((n) => n.id === merged.id), false);
    assert.equal(s.list({ notWrittenBy: "good" }).notes.some((n) => n.id === merged.id), false);
    assert.equal(s.list({ notWrittenBy: "admin" }).notes.some((n) => n.id === merged.id), false, "the merger wrote it too");
    assert.equal(s.list({ notWrittenBy: "nobody" }).notes.some((n) => n.id === merged.id), true);
    assert.equal(s.list({ writtenBy: "evil" }).notes.some((n) => n.id === merged.id), false, "written_by is still the LAST writer only");
    assert.deepEqual(s.read(merged.id)!.merged_from_writers, ["evil", "good"]);
  });

  test("merged_from_writers is stored for good and survives later edits and a restart of the feed query", () => {
    const a = as("evil", () => s.create({ title: "x one", body: "alpha" }));
    const b = as("good", () => s.create({ title: "x two", body: "beta" }));
    const merged = as("admin", () => consolidateNotes(s, [a.id, b.id]));
    as("someone", () => s.update(merged.id, { body: "rewritten" }));
    // the merger (admin) is replaced as the content writer, so it joins the set; the taint only ever grows
    assert.deepEqual(s.read(merged.id)!.merged_from_writers, ["admin", "evil", "good"]);
    assert.equal(s.list({ notWrittenBy: "evil" }).notes.some((n) => n.id === merged.id), false);
  });

  test("a delete records the note's author next to the deleter", () => {
    const n = as("alice", () => s.create({ title: "doc", body: "v1" }));
    as("bob", () => s.update(n.id, { body: "v2" }));
    as("carol", () => s.delete(n.id));
    const del = s.changes({ since: HOUR_AGO() }).changes[0];
    assert.equal(del.kind, "deleted");
    assert.equal(del.written_by, "carol", "the deleter");
    assert.equal(del.note_written_by, "bob", "the author at deletion time");
    assert.equal(del.note_writer_id, `${s.serverId()}/bob`);
    // filters work on a note that is gone
    assert.equal(s.changes({ since: HOUR_AGO(), noteWrittenBy: "bob" }).changes.length, 1);
    assert.equal(s.changes({ since: HOUR_AGO(), notNoteWrittenBy: "bob" }).changes.length, 0);
    assert.equal(s.changes({ since: HOUR_AGO(), writtenBy: "carol" }).changes.length, 1);
    assert.equal(s.changes({ since: HOUR_AGO(), writtenBy: "dave" }).changes.length, 0, "event semantics: dave did nothing");
  });

  test("runChanges / the catch-up path carry both filter kinds", () => {
    const n = as("alice", () => s.create({ title: "doc", body: "v1" }));
    as("bob", () => s.update(n.id, { tags: ["x"] }));
    const cu = catchUp(s, { consumer: "c", noteWrittenBy: "alice" });
    assert.equal(cu.changes!.counts.total, 1);
    const cu2 = catchUp(s, { consumer: "c2", notNoteWrittenBy: "alice" });
    assert.equal(cu2.changes!.counts.total, 0);
    assert.equal(runChanges(s, { since: HOUR_AGO(), notNoteWrittenBy: "zed" }).changes.length, 1);
  });

  test("a manual ack token is bound to the filters it was issued for", () => {
    as("alice", () => s.create({ title: "doc", body: "v1" }));
    const page = runChanges(s, { since: "last", consumer: "k", ackMode: "manual", noteWrittenBy: "alice" });
    assert.ok(page.ack_token);
    assert.throws(() => runChanges(s, { since: "last", consumer: "k", ackToken: page.ack_token!, noteWrittenBy: "bob" }), /different/);
    const ok = runChanges(s, { since: "last", consumer: "k", ackToken: page.ack_token!, noteWrittenBy: "alice" });
    assert.equal(ok.acked, true);
  });

  test("an index serves written_by on the change log (EXPLAIN QUERY PLAN)", () => {
    const rows = (s as any).db
      .prepare("EXPLAIN QUERY PLAN SELECT seq, note_id, kind FROM change_log WHERE seq > 0 AND seq <= 100 AND written_by = ?")
      .all("bob") as Array<{ detail: string }>;
    assert.ok(rows.some((r) => /idx_change_log_writer/.test(r.detail)), rows.map((r) => r.detail).join(" | "));
    const names = (s as any).db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map((r: any) => r.name);
    assert.ok(names.includes("idx_change_log_writer"));
  });
});

describe("runner status per target", () => {
  let s: Store;
  const keep = { ttl: process.env.ONEMEMORY_APPROVAL_TTL_SECONDS, stale: process.env.ONEMEMORY_RUNNER_STALE_SECONDS, legacy: process.env.ONEMEMORY_RUNNER_ACCEPT_LEGACY };
  beforeEach(() => {
    s = new Store(":memory:");
    delete process.env.ONEMEMORY_RUNNER_STALE_SECONDS;
    delete process.env.ONEMEMORY_RUNNER_ACCEPT_LEGACY;
    // the namespace the server believes runners serve when a runner has not said (so a runner never seen still counts)
    process.env.ONEMEMORY_RUNNER_TASK_NAMESPACE = "tasks";
  });
  afterEach(() => {
    s.close();
    delete process.env.ONEMEMORY_RUNNER_TASK_NAMESPACE;
    for (const [k, v] of [["ONEMEMORY_APPROVAL_TTL_SECONDS", keep.ttl], ["ONEMEMORY_RUNNER_STALE_SECONDS", keep.stale], ["ONEMEMORY_RUNNER_ACCEPT_LEGACY", keep.legacy]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  /** A heartbeat as runner.ts writes it now: one note per runner id, stamped "runner". */
  function beat(runner: string, ageSec: number, ns = "tasks", writer = "runner"): void {
    clearRunnerStatusCache(s);
    const title = heartbeatTitle(runner);
    const body = JSON.stringify({ kind: "heartbeat", alive_at: new Date().toISOString(), runner, task_namespace: ns, host: "SECRET-HOST", heartbeat_ms: 180_000 });
    const old = s.list({ namespace: "runner", limit: 50, includeDistrusted: true }).notes.find((n) => n.title === title);
    const rec = old ? s.update(old.id, { body }, { writtenBy: writer })! : s.create({ namespace: "runner", title, body, tags: ["heartbeat"] }, { writtenBy: writer });
    (s as any).db.prepare("UPDATE notes SET updated_at = ? WHERE id = ?").run(new Date(Date.now() - ageSec * 1000).toISOString(), rec.id);
  }
  function cmd(target: string, title: string, ns = "tasks"): number {
    const t = putTask(s, { title, namespace: ns, command: { action: "hello" }, target }).task;
    approveTask(s, { id: t.id, if_rev: s.read(t.id)!.rev });
    return t.id;
  }

  test("each runner has its own state and its own waiting commands; the totals still add up", () => {
    beat("pc-1", 20);
    beat("pc-2", 3 * 3600);
    cmd("pc-1", "for one");
    cmd("pc-2", "for two a");
    cmd("pc-2", "for two b");
    cmd("pc-3", "for a runner never seen");
    const st = runnerStatus(s);
    const by = Object.fromEntries(st.targets.map((t) => [t.target, t]));
    assert.deepEqual(Object.keys(by).sort(), ["pc-1", "pc-2", "pc-3"]);
    assert.equal(by["pc-1"].state, "online");
    assert.equal(by["pc-1"].waiting, 1);
    assert.equal(by["pc-1"].notice, undefined, "an online runner raises no offline notice");
    assert.equal(by["pc-2"].state, "stale");
    assert.equal(by["pc-2"].waiting, 2);
    assert.match(by["pc-2"].notice!, /Runner "pc-2" offline \(last seen 3 h ago\): 2 approved commands waiting/);
    assert.equal(by["pc-3"].state, "never_seen");
    assert.equal(by["pc-3"].waiting, 1);
    assert.match(by["pc-3"].notice!, /no heartbeat seen/);
    assert.equal(st.waiting_total, 4, "backward-compatible total");
    assert.equal(st.targets.reduce((n, t) => n + t.waiting, 0), 4);
    assert.equal(st.namespaces[0].waiting, 4);
    // the old single-runner view reports the worst runner that has work waiting
    assert.equal(st.runner.state, "never_seen");
    assert.equal(st.runner.target, "pc-3");
    assert.match(st.notice!, /pc-2.*pc-3|pc-3.*pc-2/);
  });

  test("a healthy runner no longer hides a dead one", () => {
    beat("pc-1", 5);
    beat("pc-2", 5 * 3600);
    cmd("pc-2", "stuck");
    const st = runnerStatus(s);
    assert.equal(st.runner.state, "stale", "the summary follows the runner that has the command");
    assert.ok(st.notice && /offline/.test(st.notice), "the notice appears although another runner is online");
    assert.equal(st.targets.find((t) => t.target === "pc-1")!.waiting, 0);
  });

  test("one runner, one note per runner id: a second runner does not overwrite the first's heartbeat", () => {
    beat("pc-1", 10);
    beat("pc-2", 3 * 3600);
    beat("pc-1", 5);
    const notes = s.list({ namespace: "runner", withTags: ["heartbeat"] }).notes;
    assert.deepEqual(notes.map((n) => n.title).sort(), [heartbeatTitle("pc-1"), heartbeatTitle("pc-2")]);
    assert.equal(runnerStatus(s).targets.find((t) => t.target === "pc-2")!.state, "stale");
  });

  test("a single runner keeps the exact old shape (no target field, same totals)", () => {
    beat("pc-1", 5 * 3600);
    cmd("pc-1", "only");
    const st = runnerStatus(s);
    assert.equal(st.targets.length, 1);
    assert.equal(st.runner.state, "stale");
    assert.equal(st.waiting_total, 1);
    assert.match(st.notice!, /^Runner offline \(last seen 5 h ago\): 1 approved command waiting\.$/);
  });

  test("forged heartbeats (a token that is merely named like a runner) are ignored; legacy ones need the switch", () => {
    beat("pc-1", 5, "tasks", "token:runner");
    beat("pc-9", 5, "tasks", "");
    cmd("pc-1", "x");
    let st = runnerStatus(s);
    assert.equal(st.targets.find((t) => t.target === "pc-1")!.state, "never_seen");
    assert.ok(!st.targets.some((t) => t.target === "pc-9"));
    process.env.ONEMEMORY_RUNNER_ACCEPT_LEGACY = "1";
    clearRunnerStatusCache(s);
    st = runnerStatus(s);
    assert.equal(st.targets.find((t) => t.target === "pc-9")!.state, "online", "the unsafe fallback is honoured only when asked for");
  });

  test("namespace isolation: a reader of one namespace sees only that namespace's commands per target", () => {
    beat("pc-1", 5 * 3600, "alpha");
    cmd("pc-1", "in alpha", "alpha");
    const hidden = runnerStatus(s, ["beta"]);
    assert.equal(hidden.waiting_total, 0);
    assert.equal(hidden.targets.reduce((n, t) => n + t.waiting, 0), 0);
    assert.equal(runnerStatus(s, ["alpha"]).targets.find((t) => t.target === "pc-1")!.waiting, 1);
  });

  test("the status never contains command text or the heartbeat's host", () => {
    beat("pc-1", 5 * 3600);
    cmd("pc-1", "secret title");
    const text = JSON.stringify(runnerStatus(s)) + runnerNotice(s);
    assert.ok(!text.includes("SECRET-HOST") && !text.includes("secret title") && !text.includes("hello"));
  });

  test("the notice returns at once when no approved command is queued (no heartbeat read, no classifier pass)", () => {
    beat("pc-1", 5 * 3600);
    const real = s.list.bind(s);
    let listCalls = 0;
    (s as any).list = (...a: unknown[]) => {
      listCalls++;
      return (real as any)(...a);
    };
    // a runner is stale but nothing is queued: nothing can be waiting
    assert.equal(runnerNotice(s), null);
    assert.equal(listCalls, 0, "runnerNotice never listed notes");
    // an online runner with nothing queued: the same early return
    beat("pc-1", 2);
    listCalls = 0;
    assert.equal(runnerNotice(s), null);
    assert.equal(catchUp(s, { changes: false }).runner_notice, undefined);
    // catch_up itself lists tasks and handoffs (2 calls); the notice adds none
    assert.equal(listCalls, 2);
    // with a command queued the full path runs
    listCalls = 0;
    beat("pc-1", 5 * 3600);
    cmd("pc-1", "now there is");
    const before = listCalls;
    assert.match(runnerNotice(s)!, /offline/);
    assert.ok(listCalls > before);
    s.list = real as any;
  });
});

describe("module structure", () => {
  const imports = (file: string): string[] =>
    [...readFileSync(join(SRC, file), "utf8").matchAll(/from\s+"(\.\/[^"]+)"/g)].map((m) => m[1]);

  test("liveness.ts and task-core.ts do not import tasks.ts (the cycle is gone)", () => {
    assert.ok(!imports("liveness.ts").includes("./tasks.js"));
    assert.ok(!imports("task-core.ts").includes("./tasks.js"));
    assert.ok(!imports("task-core.ts").includes("./liveness.js"));
    assert.ok(imports("tasks.ts").includes("./task-core.js"));
    assert.ok(imports("liveness.ts").includes("./task-core.js"));
  });

  test("no module that ships in the npm package imports a runner-* module (the package leaves those out)", () => {
    // package.json "files" excludes dist/src/runner*; a static import of one from a shipped module would
    // crash the published server at start-up. (Dynamic import() is checked too.)
    const shipped = readdirSync(SRC).filter((f) => f.endsWith(".ts") && !/^runner/.test(f));
    assert.ok(shipped.length > 20, "sanity: the source listing worked");
    for (const f of ["liveness.ts", "task-core.ts", "trust.ts", "attest.ts"]) assert.ok(shipped.includes(f), `${f} ships`);
    const offenders: string[] = [];
    for (const f of shipped) {
      const text = readFileSync(join(SRC, f), "utf8");
      if (/(?:from\s+|import\s*\(\s*)["']\.\/runner[^"']*["']/.test(text)) offenders.push(f);
    }
    assert.deepEqual(offenders, [], "shipped modules must not import ./runner*");
  });

  test("tasks.ts still re-exports the public classifier names", async () => {
    const t = await import("../src/tasks.js");
    for (const name of ["classifyQueuedCommand", "scanWaitingCommands", "queuedCommandTasks", "verifyApproval", "TASK_TAG", "commandHash", "approvalNonce"]) {
      assert.ok(name in t, `${name} is still exported from tasks.js`);
    }
  });
});

describe("the runner writes one heartbeat per runner id", () => {
  test("two runner ids make two notes, and the status shows both runners", () => {
    const s = new Store(":memory:");
    const keepId = process.env.ONEMEMORY_RUNNER_ID;
    try {
      // the real runner process is stamped "runner"; mimic it for the liveness trust rule
      setProcessWriter("runner");
      process.env.ONEMEMORY_RUNNER_ID = "pc-1";
      resetHeartbeat();
      runnerBeat(s, "secret", new Date().toISOString());
      runnerBeat(s, "secret", new Date().toISOString());
      process.env.ONEMEMORY_RUNNER_ID = "pc-2";
      resetHeartbeat();
      runnerBeat(s, "secret", new Date().toISOString());
      const notes = s.list({ namespace: "runner", withTags: ["heartbeat"] }).notes;
      assert.deepEqual(notes.map((n) => n.title).sort(), [heartbeatTitle("pc-1"), heartbeatTitle("pc-2")]);
      assert.ok(notes.every((n) => n.written_by === "runner"));
      const st = runnerStatus(s);
      assert.deepEqual(st.targets.map((t) => [t.target, t.state]), [["pc-1", "online"], ["pc-2", "online"]]);
    } finally {
      setProcessWriter("cli");
      if (keepId === undefined) delete process.env.ONEMEMORY_RUNNER_ID;
      else process.env.ONEMEMORY_RUNNER_ID = keepId;
      resetHeartbeat();
      s.close();
    }
  });
});

describe("file sync carries the writer only as an unverified claim", () => {
  test("origin_writer is written to the front matter; importing it elsewhere records it as imported_written_by, never as the writer", async () => {
    const a = new Store(":memory:");
    const b = new Store(":memory:");
    const dir = mkdtempSync(join(tmpdir(), "om-sync-writer-"));
    setProcessWriter("cli");
    try {
      const n = as("phone", () => a.create({ title: "from the phone", body: "hello" }));
      exportMarkdown(a, dir);
      const file = readdirSync(join(dir, "default"))[0];
      const text = readFileSync(join(dir, "default", file), "utf8");
      const fm = parseNoteFile(text).fm;
      assert.equal(fm.origin_writer, `${a.serverId()}/phone`);
      // the hash (the merge base) does not include it
      assert.equal(fm.hash, (await import("../src/sync.js")).contentHash(n));
      await importMarkdown(b, dir);
      const got = b.list().notes[0];
      assert.equal(got.title, "from the phone");
      assert.equal(got.written_by, "cli", "stamped with the importing process, not the file's claim");
      assert.equal(got.imported_written_by, `${a.serverId()}/phone`);
      // A claim can only ever ADD taint (never remove it): distrusting that name hides the note, so a file
      // cannot launder a distrusted writer's note by omitting or rewriting the claim, and a forged claim
      // can only hide the forger's own import.
      b.distrustAdd("default", "phone");
      assert.equal(b.list().notes.length, 0);
      assert.equal(b.list({ includeDistrusted: true }).notes.length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      a.close();
      b.close();
    }
  });
});
