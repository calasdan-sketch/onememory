// Round 3 review fixes: approval binding / expiry / consumption, queue
// starvation and quota, lease rules, approval key in backups, the real writer
// in the change feed (v12), markdown restore of reserved tags, purge-aware
// markers, audit rotation under concurrency, watch signals, claim/due checks.
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { Store, SCHEMA_VERSION } from "../src/store.js";
import {
  putTask,
  approveTask,
  getTask,
  claimTask,
  markCommandRunning,
  queuedCommandTasks,
  verifyApproval,
} from "../src/tasks.js";
import { Ledger, RUNNER, type Allowlist, type RunnerDeps } from "../src/runner.js";
import { pollTasks } from "../src/runner-tasks.js";
import { backupStore } from "../src/backup.js";
import { runChanges } from "../src/changes.js";
import { exportMarkdown, importMarkdown } from "../src/sync.js";
import { actorStore } from "../src/actor.js";
import { watchLoop } from "../src/watch.js";

const NS = "tasks";
const CLI = join(process.cwd(), "dist/src/cli.js");
const mk = (p: string): string => mkdtempSync(join(tmpdir(), p));
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("command approval: binding, expiry, consumption, starvation, leases", () => {
  let store: Store;
  let dir: string;
  let marker: string;
  let deps: RunnerDeps;
  let allow: Allowlist;

  beforeEach(() => {
    store = new Store(":memory:");
    dir = mk("om-r3-");
    marker = join(dir, "ran.txt");
    allow = {
      mark: {
        file: process.execPath,
        args: ["-e", "require('fs').appendFileSync(process.argv[1], 'x')"],
        params: { p: "[A-Za-z0-9/_.:~ \\\\-]{1,200}" },
        paramArgs: ["{p}"],
        description: "write a marker file",
      },
    };
    deps = { store, secret: "round3-runner-secret-123", allow, ledger: new Ledger(join(dir, "seen.json")), runnerId: "pc-1", taskNamespace: NS };
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
    delete process.env.ONEMEMORY_APPROVAL_TTL_SECONDS;
    delete process.env.ONEMEMORY_TASK_COMMAND_QUOTA;
  });

  const queue = (p = marker, extra: Record<string, unknown> = {}) =>
    putTask(store, { title: "do it", namespace: NS, command: { action: "mark", params: { p } }, target: "pc-1", ...extra }).task;

  test("approve must name what the admin saw: no hash/rev is refused", () => {
    const t = queue();
    assert.throws(() => approveTask(store, { id: t.id }), /command_hash/);
    assert.equal(getTask(store, t.id).approval, "none");
  });

  test("swap after the admin read: the stale command_hash is refused, the new command never runs", async () => {
    const evil = join(dir, "evil.txt");
    const t = queue();
    const seen = getTask(store, t.id); // what the admin read
    assert.match(seen.command_hash!, /^[0-9a-f]{64}$/);
    putTask(store, { id: t.id, command: { action: "mark", params: { p: evil } } });
    assert.throws(() => approveTask(store, { id: t.id, command_hash: seen.command_hash! }), /command_hash mismatch/);
    assert.throws(() => approveTask(store, { id: t.id, if_rev: seen.rev }), /stale approval/);
    assert.equal(await pollTasks(deps), 0);
    assert.equal(existsSync(evil), false);
    // approving the current text with its own hash works
    const now = getTask(store, t.id);
    assert.equal(approveTask(store, { id: t.id, command_hash: now.command_hash! }).approval, "approved");
  });

  test("an unchanged command keeps its hash; a different command changes it", () => {
    const t = queue();
    const h = getTask(store, t.id).command_hash;
    putTask(store, { id: t.id, notes: "only notes changed" });
    assert.equal(getTask(store, t.id).command_hash, h);
    putTask(store, { id: t.id, command: { action: "mark", params: { p: join(dir, "other") } } });
    assert.notEqual(getTask(store, t.id).command_hash, h);
  });

  test("starvation: 60 newer unapproved command tasks cannot hide an older approved one", async () => {
    const c = queue();
    approveTask(store, { id: c.id, if_rev: store.read(c.id)!.rev });
    for (let i = 0; i < 60; i++) queue(join(dir, `junk${i}`));
    assert.equal(queuedCommandTasks(store, NS).length, 1, "SQL filters on the approval tag");
    assert.equal(await pollTasks(deps), 1);
    assert.equal(existsSync(marker), true);
  });

  test("starvation: approved tasks beyond one page are all reached", async () => {
    process.env.ONEMEMORY_TASK_COMMAND_QUOTA = "1000";
    for (let i = 0; i < 205; i++) {
      const t = queue(join(dir, `m${i}`));
      approveTask(store, { id: t.id, if_rev: store.read(t.id)!.rev });
    }
    assert.equal(queuedCommandTasks(store, NS).length, 205);
  });

  test("quota: a namespace cannot hold more queued command tasks than the limit", () => {
    process.env.ONEMEMORY_TASK_COMMAND_QUOTA = "3";
    for (let i = 0; i < 3; i++) queue(join(dir, `q${i}`));
    assert.throws(() => queue(join(dir, "q3")), /too many queued command tasks/);
    // other namespaces and plain tasks are unaffected
    putTask(store, { title: "plain", namespace: NS });
    putTask(store, { title: "other ns", namespace: "elsewhere", command: { action: "mark", params: { p: marker } }, target: "pc-1" });
  });

  test("the approval is consumed in the same write that marks the task running", () => {
    const t = queue();
    approveTask(store, { id: t.id, if_rev: store.read(t.id)!.rev });
    const note = store.read(t.id)!;
    const running = markCommandRunning(store, note)!;
    assert.ok(!running.tags.some((x) => x.startsWith("task.approval:")), "no approval tag once running");
    // a write token flipping it back to queued has nothing to replay
    const back = putTask(store, { id: t.id, status: "queued" }).task;
    assert.equal(back.approval, "none");
    assert.equal(verifyApproval(store, store.read(t.id)!), "none");
  });

  test("crash replay: runner dies after marking running, ledger lost, status forced back to queued: nothing runs", async () => {
    const t = queue();
    approveTask(store, { id: t.id, if_rev: store.read(t.id)!.rev });
    assert.ok(markCommandRunning(store, store.read(t.id)!), "runner got as far as running, then crashed");
    rmSync(join(dir, "seen.json"), { force: true });
    deps.ledger = new Ledger(join(dir, "seen.json"));
    // a write token re-queues it with an ordinary task_put
    assert.equal(putTask(store, { id: t.id, status: "queued" }).task.status, "queued");
    assert.equal(await pollTasks(deps), 0);
    assert.equal(existsSync(marker), false);
  });

  test("approvals expire inside the MAC", async () => {
    process.env.ONEMEMORY_APPROVAL_TTL_SECONDS = "60";
    const t = queue();
    const a = approveTask(store, { id: t.id, if_rev: store.read(t.id)!.rev });
    assert.equal(a.approval, "approved");
    const exp = Date.parse(a.approval_expires_at!);
    assert.ok(exp > Date.now() && exp <= Date.now() + 61_000);
    assert.equal(await pollTasks({ ...deps, now: () => exp + 1000 }), 0, "expired approval never runs");
    assert.equal(existsSync(marker), false);
    assert.equal(verifyApproval(store, store.read(t.id)!, exp + 1000), "stale");
    // pushing the expiry later in the tag breaks the MAC
    const note = store.read(t.id)!;
    const tag = note.tags.find((x) => x.startsWith("task.approval:"))!;
    const [nonce, , mac] = tag.slice("task.approval:".length).split(".");
    store.update(t.id, { tags: note.tags.map((x) => (x === tag ? `task.approval:${nonce}.${exp + 86_400_000}.${mac}` : x)) });
    assert.equal(getTask(store, t.id).approval, "stale");
    // re-approving restores it
    assert.equal(approveTask(store, { id: t.id, if_rev: store.read(t.id)!.rev }).approval, "approved");
  });

  test("leases: command tasks cannot be claimed; approve and revoke clear an existing lease", () => {
    const plain = putTask(store, { title: "x", namespace: NS }).task;
    claimTask(store, { id: plain.id, owner: "squatter", ttl_seconds: 86_400 });
    putTask(store, { id: plain.id, command: { action: "mark", params: { p: marker } }, target: "pc-1" });
    assert.ok(getTask(store, plain.id).lease, "lease survived the edit");
    assert.throws(() => claimTask(store, { id: plain.id, owner: "other" }), /command task/);
    const a = approveTask(store, { id: plain.id, if_rev: store.read(plain.id)!.rev });
    assert.equal(a.lease, null, "approve cleared the lease");
    const t2 = putTask(store, { title: "y", namespace: NS }).task;
    claimTask(store, { id: t2.id, owner: "squatter", ttl_seconds: 86_400 });
    putTask(store, { id: t2.id, command: { action: "mark", params: { p: marker } }, target: "pc-1" });
    const r = approveTask(store, { id: t2.id, revoke: true });
    assert.equal(r.lease, null, "revoke cleared the lease");
  });

  test("claim rejects a done task; due must be a real calendar date", () => {
    const t = putTask(store, { title: "d", status: "done" }).task;
    assert.throws(() => claimTask(store, { id: t.id, owner: "me" }), /already done/);
    assert.equal(getTask(store, t.id).status, "done");
    assert.throws(() => putTask(store, { title: "bad", due: "2026-02-31" }), /real calendar date/);
    assert.throws(() => putTask(store, { title: "bad", due: "2026-13-01" }), /due/);
    assert.throws(() => putTask(store, { title: "bad", due: "2026-04-31T10:00:00Z" }), /real calendar date/);
    assert.equal(putTask(store, { title: "ok", due: "2028-02-29" }).task.due, "2028-02-29");
  });
});

describe("backup and the approval key", () => {
  test("the approval key is not copied by default; --include-approval-key keeps it", () => {
    const dir = mk("om-r3-bk-");
    try {
      const db = join(dir, "state.db");
      const s = new Store(db);
      const t = putTask(s, { title: "c", namespace: NS, command: { action: "mark", params: { p: "x" } }, target: "pc-1" }).task;
      approveTask(s, { id: t.id, if_rev: s.read(t.id)!.rev });
      assert.ok((s as any).getMeta("approval_key"));
      const plain = backupStore(s, db, join(dir, "b1"));
      const full = backupStore(s, db, join(dir, "b2"), { includeApprovalKey: true });
      assert.equal(plain.approvalKey, false);
      assert.equal(full.approvalKey, true);
      s.close();
      const r1 = new Store(plain.db);
      assert.equal((r1 as any).getMeta("approval_key"), null);
      assert.equal(getTask(r1, t.id).approval, "stale", "approvals fail closed in a restore without the key");
      r1.close();
      const r2 = new Store(full.db);
      assert.equal(getTask(r2, t.id).approval, "approved");
      r2.close();
      assert.match(readFileSync(join(dir, "b1", "README.txt"), "utf8"), /approval key NOT included/);
      // CLI flag
      const env = { ...process.env, ONEMEMORY_HOME: dir, ONEMEMORY_DB_PATH: db };
      const c1 = spawnSync(process.execPath, [CLI, "backup", "--out", join(dir, "b3")], { env, encoding: "utf8" });
      assert.equal(c1.status, 0, c1.stderr);
      assert.match(c1.stdout, /NOT copied/);
      const c2 = spawnSync(process.execPath, [CLI, "backup", "--out", join(dir, "b4"), "--include-approval-key"], { env, encoding: "utf8" });
      assert.equal(c2.status, 0, c2.stderr);
      assert.match(c2.stdout, /Included the command-task approval key/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("change feed: real writer, purge-aware markers, v11 upgrade", () => {
  test("exclude_self hides only the consumer's own writes, even when `source` says otherwise", () => {
    const s = new Store(":memory:");
    const since = new Date(Date.now() - 60_000).toISOString();
    // PC creates a task owned by "pc"; the phone marks it done (owner/source stays "pc")
    const id = actorStore.run({ label: "pc" }, () => putTask(s, { title: "t", owner: "pc" }).task.id);
    // consumer pc: its own create is hidden
    const first = runChanges(s, { since: "last", consumer: "pc", excludeSelf: true });
    assert.equal(first.changes.length, 0);
    actorStore.run({ label: "phone" }, () => putTask(s, { id, status: "done" }));
    assert.equal(s.read(id)!.source, "pc", "the note's provenance is still pc");
    const r = runChanges(s, { since: "last", consumer: "pc", excludeSelf: true });
    assert.equal(r.changes.length, 1, "the phone's edit is visible to pc");
    const again = runChanges(s, { since, consumer: "x", excludeSelf: true });
    assert.equal(again.changes.length, 1, "other consumer sees the note");
    // a writer with no recorded actor falls back to source
    const n = s.create({ title: "cli note", source: "pc" });
    assert.ok(n.id);
    const r2 = runChanges(s, { since: "last", consumer: "pc", excludeSelf: true });
    assert.equal(r2.changes.length, 0);
    s.close();
  });

  test("v11 database upgrades to v12: actor column, old rows keep working, new rows are stamped", () => {
    const dir = mk("om-r3-mig-");
    try {
      const dbp = join(dir, "v11.db");
      const s = new Store(dbp);
      s.create({ title: "before", source: "pc" });
      s.close();
      const d = new DatabaseSync(dbp);
      d.exec("ALTER TABLE change_log DROP COLUMN actor; PRAGMA user_version = 11;");
      // a foreign writer (no om_actor function, no stamping) still works
      d.exec("INSERT INTO notes (namespace, title, body, tags, source, rev, created_at, updated_at) VALUES ('default','raw','b','[]','x',1,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')");
      d.close();
      const t = new Store(dbp);
      const cols = (t as unknown as { db: DatabaseSync }).db.prepare("PRAGMA table_info(change_log)").all() as Array<{ name: string }>;
      assert.ok(cols.some((c) => c.name === "actor"));
      assert.equal(((t as unknown as { db: DatabaseSync }).db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, SCHEMA_VERSION);
      actorStore.run({ label: "phone" }, () => t.create({ title: "after", source: "x" }));
      t.create({ title: "no actor" });
      const rows = (t as unknown as { db: DatabaseSync }).db.prepare("SELECT title, actor FROM change_log ORDER BY seq").all() as Array<{ title: string; actor: string }>;
      assert.equal(rows.find((r) => r.title === "after")!.actor, "phone");
      assert.equal(rows.find((r) => r.title === "before")?.actor ?? "", "");
      assert.equal(rows.find((r) => r.title === "raw")?.actor ?? "", "", "foreign writes carry no actor");
      t.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("purge past a consumer's marker sets markerReset (and keeps returning what is left)", () => {
    const s = new Store(":memory:");
    const db = (s as unknown as { db: DatabaseSync }).db;
    s.create({ title: "e0" });
    s.create({ title: "e1" });
    const first = runChanges(s, { since: "last", consumer: "idle" });
    assert.equal(first.markerReset, true, "first read has no marker");
    s.create({ title: "e2" });
    s.create({ title: "e3" });
    s.create({ title: "e4" });
    // age e2 and e3 beyond retention, then purge
    db.exec("UPDATE change_log SET changed_at = '2000-01-01T00:00:00.000Z' WHERE note_id IN (3, 4)");
    s.purgeChangeLog();
    assert.equal(s.changeLogPurgedTo() > 0, true);
    const r = runChanges(s, { since: "last", consumer: "idle" });
    assert.equal(r.markerReset, true, "events between the marker and the oldest retained one are gone");
    assert.deepEqual(r.changes.map((c) => c.title), ["e4"]);
    // a consumer already past the purge point is not flagged
    const again = runChanges(s, { since: "last", consumer: "idle" });
    assert.equal(again.markerReset, undefined);
    s.close();
  });
});

describe("markdown restore of reserved tags", () => {
  test("tasks, handoffs and legacy `task` notes survive an export/import round trip; approvals do not", async () => {
    const a = new Store(":memory:");
    const src = mk("om-r3-md-");
    try {
      const task = putTask(a, { title: "real task", namespace: NS, command: { action: "mark", params: { p: "x" } }, target: "pc-1" }).task;
      approveTask(a, { id: task.id, if_rev: a.read(task.id)!.rev });
      a.create({ title: "legacy task note", body: "from 1.2.x", tags: ["task", "mine"] });
      a.create({ title: "a handoff", body: "Summary: s", tags: ["handoff", "surface:phone"] });
      a.create({ title: "plain", body: "p" });
      exportMarkdown(a, src);
      const b = new Store(":memory:");
      const r = await importMarkdown(b, src);
      assert.equal(r.counts.rejected, 0);
      assert.equal(r.counts.created, 4);
      const titles = b.list({ limit: 50 }).notes.map((n) => n.title).sort();
      assert.deepEqual(titles, ["a handoff", "legacy task note", "plain", "real task"]);
      const restored = b.list({ withTags: ["task"], limit: 50 }).notes.find((n) => n.title === "real task")!;
      assert.equal(getTask(b, restored.id).command!.action, "mark");
      assert.equal(getTask(b, restored.id).approval, "none", "an approval never travels by file");
      assert.ok(!restored.tags.some((t) => t.startsWith("task.approval:")));
      assert.ok(b.read(b.list({ withTags: ["handoff"] }).notes[0].id)!.tags.includes("handoff"));
      b.close();
    } finally {
      a.close();
      rmSync(src, { recursive: true, force: true });
    }
  });

  test("CLI import prints a loud rejected count and exits non-zero", () => {
    const dir = mk("om-r3-imp-");
    try {
      const db = join(dir, "state.db");
      new Store(db).close();
      const files = join(dir, "files");
      const s = new Store(db);
      const self = s.storeId();
      s.close();
      // claims a note of this store that this store never exported -> rejected
      const f = join(files, "default");
      require_mkdir(f);
      writeFileSync(join(f, "forged.md"), `---\nid: 1\norigin: ${self}\nnamespace: default\ntitle: forged\ntags: []\n---\nbody\n`);
      writeFileSync(join(f, "ok.md"), "---\ntitle: fine\n---\nhello\n");
      const s2 = new Store(db);
      s2.create({ title: "occupies id 1" });
      s2.close();
      const env = { ...process.env, ONEMEMORY_HOME: dir, ONEMEMORY_DB_PATH: db };
      const r = spawnSync(process.execPath, [CLI, "import", "--dir", files], { env, encoding: "utf8" });
      assert.equal(r.status, 1, r.stdout + r.stderr);
      assert.match(r.stderr, /1 FILE\(S\) WERE REJECTED/);
      assert.match(r.stdout, /1 rejected/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function require_mkdir(p: string): void {
  spawnSync(process.execPath, ["-e", `require('fs').mkdirSync(${JSON.stringify(p)},{recursive:true})`]);
}

describe("audit log rotation under concurrent writers", () => {
  test("3 processes, tiny files: no line is lost", async () => {
    const dir = mk("om-r3-audit-");
    try {
      const log = join(dir, "audit.log");
      const script = `const {audit}=require(${JSON.stringify(join(process.cwd(), "dist/src/security.js"))});` +
        `for(let i=0;i<1500;i++)audit({op:"t",id:i,label:process.argv[1]});`;
      const env = { ...process.env, ONEMEMORY_HOME: dir, ONEMEMORY_AUDIT_LOG: log, ONEMEMORY_AUDIT_MAX_BYTES: "20000", ONEMEMORY_AUDIT_KEEP: "500" };
      // dist is ESM: use a dynamic import instead of require
      const esm = `import(${JSON.stringify("file://" + join(process.cwd(), "dist/src/security.js"))}).then(({audit})=>{for(let i=0;i<1500;i++)audit({op:"t",id:i,label:process.argv[1]});});`;
      void script;
      const kids = [0, 1, 2].map(
        (n) =>
          new Promise<number | null>((res) => {
            const c = spawn(process.execPath, ["-e", esm, String(n)], { env, stdio: "ignore" });
            c.on("exit", (code) => res(code));
          })
      );
      const codes = await Promise.all(kids);
      assert.deepEqual(codes, [0, 0, 0]);
      let lines = 0;
      for (const f of readdirSync(dir)) {
        if (f.startsWith("audit.log") && !f.endsWith(".lock")) lines += readFileSync(join(dir, f), "utf8").split("\n").filter(Boolean).length;
      }
      assert.equal(lines, 4500);
      assert.ok(readdirSync(dir).filter((f) => f.startsWith("audit.log.")).length > 2, "it did rotate");
      assert.ok(!existsSync(log + ".lock"), "the lock is released");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("onememory watch stops on signals", () => {
  test("SIGTERM while a handler runs: the handler is killed and the watcher exits promptly", async () => {
    const dir = mk("om-r3-watch-");
    try {
      const db = join(dir, "state.db");
      const s = new Store(db);
      s.close();
      const env = { ...process.env, ONEMEMORY_HOME: dir, ONEMEMORY_DB_PATH: db };
      const child = spawn(
        process.execPath,
        [CLI, "watch", "--consumer", "w", "--wait", "1", "--exec", process.execPath, "-e", "setTimeout(()=>{},40000)"],
        { env, stdio: ["ignore", "pipe", "pipe"] }
      );
      let out = "";
      child.stdout!.on("data", (d) => (out += d));
      const exited = new Promise<number | null>((res) => child.once("exit", (c) => res(c)));
      await sleep(1500);
      const w = new Store(db);
      w.create({ title: "wake up", source: "other" });
      w.close();
      for (let i = 0; i < 60 && !out.includes("wake up"); i++) await sleep(100);
      assert.ok(out.includes("wake up"), "the batch reached the handler");
      await sleep(300);
      const t0 = Date.now();
      child.kill("SIGTERM");
      const code = await Promise.race([exited, sleep(8000).then(() => "timeout" as const)]);
      assert.notEqual(code, "timeout", "watch must exit within 8s of SIGTERM");
      assert.ok(Date.now() - t0 < 8000);
      if (code === "timeout") child.kill("SIGKILL");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("watchLoop passes its AbortSignal to the handler and does not retry-sleep after an abort", async () => {
    const s = new Store(":memory:");
    const ac = new AbortController();
    let got: AbortSignal | undefined;
    s.create({ title: "x", source: "other" });
    const t0 = Date.now();
    const batches = await watchLoop(s, {
      consumer: "c",
      waitSeconds: 1,
      exec: ["whatever"],
      signal: ac.signal,
      retryMs: 5000,
      log: () => {},
      run: async (_a, _i, _e, sig) => {
        got = sig;
        ac.abort();
        return 1;
      },
    });
    assert.equal(got, ac.signal);
    assert.ok(Date.now() - t0 < 3000, "no 5s retry pause after an abort");
    assert.equal(batches, 0);
    s.close();
  });
});
void RUNNER;
