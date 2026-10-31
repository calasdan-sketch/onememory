// 1.3.0 infra fixes: backup, audit rotation, waiter caps, graceful shutdown,
// change-log purge timer, `watch`.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, statSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../src/store.js";
import { ensureKey } from "../src/crypto.js";
import { backupStore } from "../src/backup.js";
import { audit } from "../src/security.js";
import { waitForChanges, abortAllWaiters, activeWaiters, WaitBusyError } from "../src/change-wait.js";
import { watchLoop } from "../src/watch.js";
import { runChanges } from "../src/changes.js";

const mk = (p: string) => mkdtempSync(join(tmpdir(), p));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("onememory backup", () => {
  test("hot copy opens, is consistent, includes the key (0600) and a clear warning file", () => {
    const dir = mk("om-bk-");
    const prevHome = process.env.ONEMEMORY_ENCRYPT;
    try {
      ensureKey(dir);
      const db = join(dir, "state.db");
      const s = new Store(db);
      s.create({ title: "secret thing", body: "the body is sealed at rest" });
      s.create({ title: "second", body: "more" });
      // a second connection mid-transaction does not break the copy
      const out = join(dir, "bk");
      const r = backupStore(s, db, out);
      assert.equal(r.notes, 2);
      assert.ok(r.key && existsSync(r.key));
      if (process.platform !== "win32") {
        assert.equal(statSync(r.key!).mode & 0o777, 0o600);
        assert.equal(statSync(r.db).mode & 0o777, 0o600);
      }
      assert.match(readFileSync(join(out, "README.txt"), "utf8"), /SEPARATELY|Move it somewhere else/);
      // the copy is a working store (with the key beside it)
      const restored = new Store(r.db);
      assert.equal(restored.list({}).notes.find((n) => n.title === "secret thing")!.body, "the body is sealed at rest");
      restored.close();
      // the on-disk copy really is ciphertext
      const raw = new DatabaseSync(r.db, { readOnly: true });
      const rows = raw.prepare("SELECT body FROM notes").all() as Array<{ body: string }>;
      raw.close();
      assert.ok(!rows.some((x) => x.body.includes("sealed at rest")));
      // never overwrites
      assert.throws(() => backupStore(s, db, out), /already exists/);
      s.close();
    } finally {
      if (prevHome === undefined) delete process.env.ONEMEMORY_ENCRYPT;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("without encryption there is no .key; CLI prints the warning only when a key was copied", () => {
    const dir = mk("om-bk-cli-");
    try {
      const db = join(dir, "state.db");
      const s = new Store(db);
      s.create({ title: "n" });
      s.close();
      const env = { ...process.env, ONEMEMORY_HOME: dir, ONEMEMORY_DB_PATH: db };
      const r = spawnSync(process.execPath, [join(process.cwd(), "dist/src/cli.js"), "backup", "--out", join(dir, "b1")], { env, encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /Backed up 1 note/);
      assert.ok(!r.stdout.includes("WARNING"));
      assert.ok(!existsSync(join(dir, "b1", ".key")));
      ensureKey(dir);
      const r2 = spawnSync(process.execPath, [join(process.cwd(), "dist/src/cli.js"), "backup", "--out", join(dir, "b2")], { env, encoding: "utf8" });
      // the db was written before the key existed; opening it with a key present is still fine
      assert.equal(r2.status, 0, r2.stderr);
      assert.match(r2.stdout, /WARNING/);
      assert.ok(existsSync(join(dir, "b2", ".key")));
      const again = spawnSync(process.execPath, [join(process.cwd(), "dist/src/cli.js"), "backup", "--out", join(dir, "b2")], { env, encoding: "utf8" });
      assert.equal(again.status, 1);
      assert.match(again.stderr, /already exists/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("audit.log rotation", () => {
  test("rotates by size and keeps N files", () => {
    const dir = mk("om-rot-");
    const prev = { l: process.env.ONEMEMORY_AUDIT_LOG, m: process.env.ONEMEMORY_AUDIT_MAX_BYTES, k: process.env.ONEMEMORY_AUDIT_KEEP };
    process.env.ONEMEMORY_AUDIT_LOG = join(dir, "audit.log");
    process.env.ONEMEMORY_AUDIT_MAX_BYTES = "3000";
    process.env.ONEMEMORY_AUDIT_KEEP = "3";
    try {
      for (let i = 0; i < 1500; i++) audit({ op: "create", id: i, namespace: "default", bytes: 10 });
      const files = readdirSync(dir).sort();
      assert.deepEqual(files, ["audit.log", "audit.log.1", "audit.log.2", "audit.log.3"]);
      for (const f of files) assert.ok(statSync(join(dir, f)).size < 3000 + 50 * 120, `${f} stays near the limit`);
    } finally {
      for (const [k, v] of [["ONEMEMORY_AUDIT_LOG", prev.l], ["ONEMEMORY_AUDIT_MAX_BYTES", prev.m], ["ONEMEMORY_AUDIT_KEEP", prev.k]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("waiters", () => {
  test("per-token cap defaults to 16 and the 429 text explains itself", async () => {
    const s = new Store(":memory:");
    const aborts = Array.from({ length: 16 }, () => new AbortController());
    const waits = aborts.map((a, i) => waitForChanges(s, { since: "last", consumer: `c${i}` }, { waitSeconds: 5, signal: a.signal, key: "tok", scopeKey: `s${i}` }));
    await sleep(50);
    assert.equal(activeWaiters(), 16);
    await assert.rejects(
      waitForChanges(s, { since: "last", consumer: "x" }, { waitSeconds: 5, key: "tok", scopeKey: "other" }),
      (e: unknown) => e instanceof WaitBusyError && /429/.test(e.message) && /ONEMEMORY_WAIT_MAX_PER_TOKEN/.test(e.message) && /disconnect/.test(e.message)
    );
    aborts.forEach((a) => a.abort());
    await Promise.all(waits);
    assert.equal(activeWaiters(), 0);
    s.close();
  });

  test("per-namespace-scope cap is shared across tokens", async () => {
    const s = new Store(":memory:");
    process.env.ONEMEMORY_WAIT_MAX_PER_NAMESPACE = "2";
    try {
      const a = [new AbortController(), new AbortController()];
      const waits = a.map((c, i) => waitForChanges(s, { since: "last", consumer: `c${i}` }, { waitSeconds: 5, signal: c.signal, key: `tok${i}`, scopeKey: "work" }));
      await sleep(30);
      await assert.rejects(
        waitForChanges(s, { since: "last", consumer: "z" }, { waitSeconds: 5, key: "tok-other", scopeKey: "work" }),
        (e: unknown) => e instanceof WaitBusyError && /namespace scope/.test(e.message)
      );
      // another scope is unaffected
      const ok = new AbortController();
      const p = waitForChanges(s, { since: "last", consumer: "q" }, { waitSeconds: 5, signal: ok.signal, key: "tok-other", scopeKey: "home" });
      await sleep(30);
      ok.abort();
      await p;
      a.forEach((c) => c.abort());
      await Promise.all(waits);
    } finally {
      delete process.env.ONEMEMORY_WAIT_MAX_PER_NAMESPACE;
    }
    s.close();
  });

  test("abortAllWaiters ends every wait promptly with timedOut and frees the slots", async () => {
    const s = new Store(":memory:");
    const t0 = Date.now();
    const waits = [0, 1, 2].map((i) => waitForChanges(s, { since: "last", consumer: `c${i}` }, { waitSeconds: 55, key: `t${i}` }));
    await sleep(80);
    assert.equal(activeWaiters(), 3);
    abortAllWaiters();
    const outs = await Promise.all(waits);
    assert.ok(outs.every((o) => o.timedOut === true));
    assert.ok(Date.now() - t0 < 1000);
    assert.equal(activeWaiters(), 0);
    s.close();
  });
});

describe("watch", () => {
  test("runs the handler without a shell, passes data on stdin, acks only on success", async () => {
    const s = new Store(":memory:");
    runChanges(s, { since: "last", consumer: "w" }); // establish the marker
    const calls: Array<{ argv: string[]; stdin: string; env: Record<string, string> }> = [];
    let fail = true;
    const abort = new AbortController();
    const evil = "x; rm -rf / $(whoami) `id`";
    const loop = watchLoop(s, {
      consumer: "w",
      waitSeconds: 1,
      exec: ["notify", "--title", "OneMemory"],
      signal: abort.signal,
      log: () => {},
      retryMs: 10,
      maxBatches: 2,
      run: async (argv, stdin, env) => {
        calls.push({ argv, stdin, env });
        if (fail) {
          fail = false;
          return 3;
        }
        return 0;
      },
    });
    await sleep(100);
    s.create({ title: evil, source: "phone" });
    const batches = await loop;
    assert.equal(batches, 2, "failed batch is delivered again, then succeeds");
    assert.deepEqual(calls[0].argv, ["notify", "--title", "OneMemory"], "argv exactly as given");
    assert.ok(calls.every((c) => !c.argv.join(" ").includes("rm -rf")), "titles never reach argv");
    assert.equal(JSON.parse(calls[1].stdin).changes[0].title, evil);
    assert.equal(calls[1].env.ONEMEMORY_CHANGE_COUNT, "1");
    // acked: nothing left
    assert.equal(runChanges(s, { since: "last", consumer: "w" }).changes.length, 0);
    s.close();
  });

  test("a handler that always fails is given up on after maxFailures in a row (no endless retry)", async () => {
    const s = new Store(":memory:");
    runChanges(s, { since: "last", consumer: "w3" });
    let calls = 0;
    const loop = watchLoop(s, { consumer: "w3", waitSeconds: 1, exec: ["x"], log: () => {}, retryMs: 1, maxFailures: 3, run: async () => (calls++, 1) });
    await sleep(100);
    s.create({ title: "boom", source: "phone" });
    await assert.rejects(loop, /giving up after 3 failures in a row/);
    assert.equal(calls, 3);
    s.close();
  });

  test("a real program receives the JSON on stdin (no shell)", async () => {
    const dir = mk("om-watch-");
    try {
      const s = new Store(":memory:");
      runChanges(s, { since: "last", consumer: "w2" });
      const out = join(dir, "got.json");
      const prog = `require('fs').writeFileSync(${JSON.stringify(out)}, require('fs').readFileSync(0,'utf8'))`;
      const loop = watchLoop(s, { consumer: "w2", waitSeconds: 1, exec: [process.execPath, "-e", prog], log: () => {}, maxBatches: 1 });
      await sleep(100);
      s.create({ title: "hello there", source: "phone" });
      await loop;
      assert.equal(JSON.parse(readFileSync(out, "utf8")).changes[0].title, "hello there");
      s.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const p = (srv.address() as { port: number }).port;
      srv.close(() => resolve(p));
    });
  });
}

function startServer(env: Record<string, string>) {
  const child = spawn(process.execPath, [join(process.cwd(), "dist/src/start.js")], {
    env: { ...process.env, ONEMEMORY_TOKEN: "infra-test-token-0123456789abcdef0123456789abcdef", ...env },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let log = "";
  child.stderr!.on("data", (d) => (log += d));
  const ready = new Promise<void>((resolve, reject) => {
    const iv = setInterval(() => {
      if (log.includes("MCP over HTTP")) (clearInterval(iv), resolve());
      if (child.exitCode !== null) (clearInterval(iv), reject(new Error("server exited: " + log)));
    }, 25);
  });
  return { child, ready, log: () => log };
}

describe("server process", () => {
  test("SIGTERM with a live wait: the waiter gets timedOut:true and the process drains fast", { skip: process.platform === "win32" && "Windows has no SIGTERM: child.kill() is a hard TerminateProcess, so graceful drain cannot be observed" }, async () => {
    const dir = mk("om-term-");
    const apiPort = await freePort();
    const mcpPort = await freePort();
    const srv = startServer({ ONEMEMORY_HOME: dir, ONEMEMORY_PORT: String(apiPort), ONEMEMORY_MCP_PORT: String(mcpPort) });
    try {
      await srv.ready;
      const t0 = Date.now();
      const exited = new Promise<number | null>((res) => srv.child.once("exit", (c) => res(c)));
      const pending = fetch(`http://127.0.0.1:${apiPort}/changes?since=last&consumer=t&wait=25`, { headers: { Authorization: "Bearer infra-test-token-0123456789abcdef0123456789abcdef" } });
      await sleep(400);
      srv.child.kill("SIGTERM");
      const res = await pending;
      assert.equal(res.status, 200);
      const body = (await res.json()) as { timedOut?: boolean };
      assert.equal(body.timedOut, true, "clean timedOut, not a reset socket");
      assert.equal(await exited, 0);
      assert.ok(Date.now() - t0 < 2500, `drained in ${Date.now() - t0}ms`);
    } finally {
      srv.child.kill("SIGKILL");
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the change log is purged on a timer, without anyone reading the feed", async () => {
    const dir = mk("om-purge-");
    const db = join(dir, "state.db");
    const s = new Store(db);
    for (let i = 0; i < 5; i++) s.create({ title: `n${i}` });
    s.close();
    const raw = new DatabaseSync(db);
    raw.exec("UPDATE change_log SET changed_at = '2020-01-01T00:00:00.000Z'");
    const before = Number((raw.prepare("SELECT COUNT(*) AS c FROM change_log").get() as { c: number }).c);
    assert.ok(before >= 5);
    raw.close();
    const apiPort = await freePort();
    const mcpPort = await freePort();
    const srv = startServer({ ONEMEMORY_HOME: dir, ONEMEMORY_DB_PATH: db, ONEMEMORY_PORT: String(apiPort), ONEMEMORY_MCP_PORT: String(mcpPort), ONEMEMORY_CHANGE_LOG_PURGE_MS: "200" });
    try {
      await srv.ready;
      let left = before;
      for (let i = 0; i < 40 && left > 0; i++) {
        await sleep(100);
        const c = new DatabaseSync(db, { readOnly: true });
        left = Number((c.prepare("SELECT COUNT(*) AS c FROM change_log").get() as { c: number }).c);
        c.close();
      }
      assert.equal(left, 0, "old change_log rows were purged by the timer");
    } finally {
      srv.child.kill("SIGKILL");
      await sleep(50);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
