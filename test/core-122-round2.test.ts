// 1.2.1 round-2 core fixes: key stranded by a crashed `encrypt disable`,
// unreadable export markers, REST/MCP validation parity, auth tarpit,
// blank stdio lines, doctor honesty, v1 ciphertext upgrade on open.
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Store, SCHEMA_VERSION } from "../src/store.js";
import type { ImportReport } from "../src/store.js";
import { createApiServer } from "../src/api.js";
import { createMcpServer } from "../src/mcp-server-core.js";
import { AuthTarpit } from "../src/security.js";
import { ensureKey, encrypt } from "../src/crypto.js";

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const STDIO = fileURLToPath(new URL("../src/mcp-stdio.js", import.meta.url));
const raw = (s: Store): DatabaseSync => (s as unknown as { db: DatabaseSync }).db;
const DEAD_PID = 99999999; // above pid_max: never a live process
const TOK = "r2-root-token-r2-root-token-r2-root-token";

let dir: string;
let savedKeyFile: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "om-core122-"));
  savedKeyFile = process.env.ONEMEMORY_KEY_FILE;
  delete process.env.ONEMEMORY_KEY_FILE;
});
afterEach(() => {
  if (savedKeyFile === undefined) delete process.env.ONEMEMORY_KEY_FILE;
  else process.env.ONEMEMORY_KEY_FILE = savedKeyFile;
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("1: key stranded by a crashed `encrypt disable`", () => {
  test("opening the Store restores .key from a dead process's .key.disabling-PID", () => {
    ensureKey(dir);
    const s = new Store(join(dir, "state.db"));
    const n = s.create({ title: "t", body: "secret body" });
    s.close();
    renameSync(join(dir, ".key"), join(dir, `.key.disabling-${DEAD_PID}`)); // the crash
    const again = new Store(join(dir, "state.db"));
    assert.ok(existsSync(join(dir, ".key")), "key put back");
    assert.equal(again.read(n.id)!.body, "secret body");
    const m = again.create({ title: "after", body: "sealed again" });
    assert.equal(m.encrypted, true);
    again.close();
  });

  test("no key and no aside copy: reads fail and writes are refused (no plaintext next to ciphertext)", () => {
    ensureKey(dir);
    const s = new Store(join(dir, "state.db"));
    const n = s.create({ title: "t", body: "secret body" });
    s.close();
    rmSync(join(dir, ".key"));
    const again = new Store(join(dir, "state.db"));
    assert.throws(() => again.read(n.id));
    assert.throws(() => again.create({ title: "x", body: "plain" }), /refusing to write plaintext/);
    assert.equal((raw(again).prepare("SELECT COUNT(*) c FROM notes WHERE body_enc IS NULL").get() as any).c, 0);
    again.close();
  });

  test("a plaintext store without a key still writes normally", () => {
    const s = new Store(join(dir, "state.db"));
    assert.equal(s.create({ title: "a", body: "b" }).encrypted, undefined);
    s.close();
  });

  test("CLI `encrypt disable` after a crash restores the key and finishes the job", () => {
    ensureKey(dir);
    const s = new Store(join(dir, "state.db"));
    const n = s.create({ title: "t", body: "secret body" });
    s.close();
    renameSync(join(dir, ".key"), join(dir, `.key.disabling-${DEAD_PID}`));
    const r = spawnSync(process.execPath, ["--no-warnings", CLI, "encrypt", "disable"], {
      env: { ...process.env, ONEMEMORY_HOME: dir, HOME: dir },
      encoding: "utf8",
    });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.ok(!existsSync(join(dir, ".key")));
    const after = new Store(join(dir, "state.db"));
    assert.equal(after.read(n.id)!.body, "secret body");
    assert.equal(after.encryptedCount(), 0);
    after.close();
  });
});

describe("2: unreadable export markers", () => {
  test("marker has no body field and import rejects it", async () => {
    const key = ensureKey(dir);
    const s = new Store(join(dir, "state.db"));
    const n = s.create({ title: "tampered", body: "real body" });
    raw(s).prepare("UPDATE notes SET body_enc = ? WHERE id = ?").run(encrypt("other", key, "999|default"), n.id);
    const batch = s.exportBatch(0, 50, { skipUnreadable: true });
    assert.equal(batch.length, 1);
    assert.equal((batch[0] as any).unreadable, true);
    assert.ok(!("body" in batch[0]), "no body on a marker");
    const report: ImportReport = { quarantined: [], rejected: [] };
    const created = await s.importNotes(JSON.parse(JSON.stringify(batch)), { report });
    assert.equal(created.length, 0);
    assert.equal(report.rejected.length, 1);
    assert.match(report.rejected[0].error, /unreadable/);
    s.close();
  });
});

describe("3: REST/MCP validation", () => {
  test("REST accepts numeric strings for forget_after, still 400s garbage; restore validates", async () => {
    const store = new Store(join(dir, "state.db"));
    const server = createApiServer(store, [{ token: TOK, scope: "admin", label: "r" }]);
    await new Promise<void>((r) => server.listen(0, r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const h = { Authorization: `Bearer ${TOK}`, "Content-Type": "application/json" };
    try {
      const ok = await fetch(`${base}/notes`, { method: "POST", headers: h, body: JSON.stringify({ title: "t", forget_after: "5" }) });
      assert.equal(ok.status, 201);
      const nj = await ok.json();
      const note = { id: (nj.note?.id ?? nj.id) as number };
      assert.ok(store.read(note.id)!.expires_at, "numeric string became a TTL");
      const put = await fetch(`${base}/notes/${note.id}`, { method: "PUT", headers: h, body: JSON.stringify({ forget_after: "0" }) });
      assert.equal(put.status, 200);
      assert.equal(store.read(note.id)!.expires_at, undefined, "forget_after \"0\" clears the TTL");
      for (const bad of ["abc", "-1", "", "1e999"]) {
        const r = await fetch(`${base}/notes`, { method: "POST", headers: h, body: JSON.stringify({ title: "t", forget_after: bad }) });
        assert.equal(r.status, 400, `forget_after ${JSON.stringify(bad)}`);
      }
      const rel2 = await fetch(`${base}/relevant`, { method: "POST", headers: h, body: JSON.stringify({ message: "hello", limit: "x" }) });
      assert.equal(rel2.status, 400);
      store.archive(note.id);
      const rb = await fetch(`${base}/notes/${note.id}/restore`, { method: "POST", headers: h, body: JSON.stringify({ forget_after: "-5" }) });
      assert.equal(rb.status, 400);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      store.close();
    }
  });

  test("Store.restore rejects a negative forget_after", () => {
    const s = new Store(join(dir, "state.db"));
    const n = s.create({ title: "t", body: "b" });
    s.archive(n.id);
    assert.throws(() => s.restore(n.id, { forget_after: -5 }), /forget_after/);
    s.close();
  });

  test("MCP state_search gives the same errors as REST for limit=0 and unknown `when`", async () => {
    const s = new Store(join(dir, "state.db"));
    s.create({ title: "findme", body: "findme" });
    const server = createMcpServer(s, "admin");
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "1" });
    await Promise.all([server.connect(a), client.connect(b)]);
    const call = async (args: Record<string, unknown>) => {
      const r: any = await client.callTool({ name: "state_search", arguments: args });
      const text: string = r.content[0].text;
      return JSON.parse(text.slice(text.indexOf("{")));
    };
    assert.match((await call({ query: "findme", limit: 0 })).error, /limit must be an integer >= 1/);
    assert.match((await call({ query: "findme", when: "garbage-phrase-xyz" })).error, /unrecognized time phrase/);
    assert.ok((await call({ query: "findme" })).results.length > 0);
    await client.close();
    s.close();
  });
});

describe("4: auth tarpit", () => {
  test("AuthTarpit: free failures are instant, later ones escalate and are capped", async () => {
    const t = new AuthTarpit(2, 40, 100);
    const time = async () => {
      const t0 = Date.now();
      await t.failed("ip");
      return Date.now() - t0;
    };
    assert.ok((await time()) < 30);
    assert.ok((await time()) < 30);
    assert.ok((await time()) >= 35, "3rd failure waits ~40ms");
    assert.ok((await time()) >= 75, "4th waits ~80ms");
    assert.ok((await time()) < 400, "capped at 100ms");
    const other = Date.now();
    await t.failed("other-ip");
    assert.ok(Date.now() - other < 30, "per-IP tracking");
  });

  test("REST: wrong tokens get slower, a valid token is never delayed", async () => {
    const prev = process.env.ONEMEMORY_TARPIT_STEP_MS;
    process.env.ONEMEMORY_TARPIT_STEP_MS = "60";
    const store = new Store(join(dir, "state.db"));
    const server = createApiServer(store, [{ token: TOK, scope: "admin", label: "r" }]);
    if (prev === undefined) delete process.env.ONEMEMORY_TARPIT_STEP_MS;
    else process.env.ONEMEMORY_TARPIT_STEP_MS = prev;
    await new Promise<void>((r) => server.listen(0, r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const times: number[] = [];
      for (let i = 0; i < 9; i++) {
        const t0 = Date.now();
        const r = await fetch(`${base}/notes`, { headers: { Authorization: `Bearer wrong-${i}` } });
        assert.equal(r.status, 401);
        times.push(Date.now() - t0);
      }
      assert.ok(times[8] >= 150, `9th failure delayed (${times.join(",")})`);
      assert.ok(times[0] < 100);
      const t0 = Date.now();
      const ok = await fetch(`${base}/notes`, { headers: { Authorization: `Bearer ${TOK}` } });
      assert.equal(ok.status, 200);
      assert.ok(Date.now() - t0 < 100, "valid token not delayed");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      store.close();
    }
  });
});

describe("5: low items", () => {
  test("stdio ignores blank / whitespace-only lines (still answers real parse errors)", async () => {
    const child = spawn(process.execPath, ["--no-warnings", STDIO], {
      env: { ...process.env, ONEMEMORY_HOME: dir, HOME: dir },
      stdio: ["pipe", "pipe", "ignore"],
    });
    try {
      let out = "";
      child.stdout.on("data", (d) => (out += d));
      await new Promise((r) => setTimeout(r, 600));
      child.stdin.write("\n   \n\t\n\r\n");
      await new Promise((r) => setTimeout(r, 500));
      assert.equal(out, "", "blank lines produce no reply");
      child.stdin.write("{bad\n");
      await new Promise((r) => setTimeout(r, 500));
      const lines = out.split("\n").filter(Boolean);
      assert.equal(lines.length, 1);
      assert.equal(JSON.parse(lines[0]).error.code, -32700);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const done = new Promise<void>((r) => child.once("exit", () => r()));
        child.kill();
        await done; // Windows cannot rmSync a directory the child still holds open
      }
    }
  });

  test("doctor does not claim the recall hook smoke test passed after a database problem", () => {
    const db = new DatabaseSync(join(dir, "state.db"));
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 5}`);
    db.close();
    const r = spawnSync(process.execPath, ["--no-warnings", CLI, "doctor"], {
      env: { ...process.env, ONEMEMORY_HOME: dir, HOME: dir },
      encoding: "utf8",
    });
    const out = r.stdout + r.stderr;
    assert.match(out, /database problem/);
    assert.doesNotMatch(out, /recall hook smoke test passed/);
    assert.match(out, /recall hook smoke test FAILED/);
  });

  test("opening an encrypted store upgrades v1 ciphertext to row-bound v2", () => {
    const key = ensureKey(dir);
    const s = new Store(join(dir, "state.db"));
    const n = s.create({ title: "legacy", body: "x" });
    raw(s).prepare("UPDATE notes SET body = '', body_enc = ? WHERE id = ?").run(encrypt("v1 body", key), n.id);
    s.close();
    const again = new Store(join(dir, "state.db"));
    const env = (raw(again).prepare("SELECT body_enc FROM notes WHERE id = ?").get(n.id) as any).body_enc as string;
    assert.ok(env.startsWith("v2:"), "upgraded on open");
    assert.equal(again.read(n.id)!.body, "v1 body");
    again.close();
  });
});
