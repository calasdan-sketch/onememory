// 1.2.1 core fixes: REST/MCP surfaces (namespace-scoped sweep, fail-closed
// token pins, tampered-row handling, rate limiting, input validation, MCP
// version/explain/forget_after, stdio parse errors, --version, key perms).
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Store } from "../src/store.js";
import { createApiServer } from "../src/api.js";
import { createMcpServer } from "../src/mcp-server-core.js";
import { ensureKey } from "../src/crypto.js";
import { PRIVATE_FILES, PROJECT_ROOT, PACKAGE_VERSION } from "../src/config.js";
import type { TokenEntry } from "../src/config.js";

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const STDIO = fileURLToPath(new URL("../src/mcp-stdio.js", import.meta.url));
const raw = (s: Store): DatabaseSync => (s as unknown as { db: DatabaseSync }).db;
const bearer = (t: string) => ({ Authorization: `Bearer ${t}`, "Content-Type": "application/json" });

const A = "tok-a-admin";
const B = "tok-b-admin";
const ROOT = "tok-root-admin";

describe("REST: namespaces, tampered rows, validation", () => {
  let dir: string;
  let store: Store;
  let server: ReturnType<typeof createApiServer>;
  let base: string;
  let idA: number;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "om-core121a-"));
    ensureKey(dir);
    store = new Store(join(dir, "state.db"));
    const tokens: TokenEntry[] = [
      { token: A, scope: "admin", label: "a", namespace: "nsA" },
      { token: B, scope: "admin", label: "b", namespace: "nsB" },
      { token: ROOT, scope: "admin", label: "root" },
    ];
    server = createApiServer(store, tokens);
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    idA = store.create({ namespace: "nsA", title: "a note", body: "secret of A", forget_after: 1 }).id;
    store.create({ namespace: "nsB", title: "b note", body: "text of B", forget_after: 1 });
  });
  after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("POST /sweep-expired by a namespace-pinned admin only archives its own namespace", async () => {
    // make both notes expired
    raw(store).prepare("UPDATE notes SET expires_at = '2000-01-01T00:00:00.000Z'").run();
    const r = await fetch(`${base}/sweep-expired`, { method: "POST", headers: bearer(B) });
    assert.equal((await r.json()).archived, 1);
    assert.equal(store.read(idA)!.archived_at, undefined, "nsA note untouched by nsB principal");
    const r2 = await fetch(`${base}/sweep-expired`, { method: "POST", headers: bearer(ROOT) });
    assert.equal((await r2.json()).archived, 1, "unpinned admin sweeps the rest");
  });

  test("REST restore of an expired note does not get re-archived by the next sweep", async () => {
    const r = await fetch(`${base}/notes/${idA}/restore`, { method: "POST", headers: bearer(A) });
    assert.equal(r.status, 200);
    const sweep = await fetch(`${base}/sweep-expired`, { method: "POST", headers: bearer(ROOT) });
    assert.equal((await sweep.json()).archived, 0);
  });

  test("a tampered row does not block another namespace's /export; its own export fails loudly", async () => {
    const other = store.create({ namespace: "nsA", title: "second", body: "second body" });
    const encOther = (raw(store).prepare("SELECT body_enc FROM notes WHERE id = ?").get(other.id) as any).body_enc;
    raw(store).prepare("UPDATE notes SET body_enc = ? WHERE id = ?").run(encOther, idA); // wrong row's ciphertext
    // nsB export: unaffected, completes
    const okRes = await fetch(`${base}/export`, { headers: bearer(B) });
    assert.equal(okRes.status, 200);
    const okJson = (await okRes.json()) as { notes: Array<{ namespace: string }> };
    assert.ok(okJson.notes.length >= 1 && okJson.notes.every((n) => n.namespace === "nsB"));
    // nsA export: stream is aborted (never a valid-looking truncated backup)
    await assert.rejects(async () => {
      const res = await fetch(`${base}/export`, { headers: bearer(A) });
      await res.text();
    });
    // tolerant mode writes a marker instead
    const tol = await fetch(`${base}/export?skipUnreadable=1`, { headers: bearer(A) });
    const tj = (await tol.json()) as { notes: Array<{ id: number; unreadable?: boolean }> };
    assert.equal(tj.notes.find((n) => n.id === idA)!.unreadable, true);
    // list in the damaged namespace: clear error, not a bare "internal error"
    const list = await fetch(`${base}/notes`, { headers: bearer(A) });
    assert.equal(list.status, 500);
    assert.match((await list.json()).error, new RegExp(`note ${idA} cannot be decrypted`));
    // other namespace lists fine
    assert.equal((await fetch(`${base}/notes`, { headers: bearer(B) })).status, 200);
  });

  test("invalid forget_after / limit / mode / when answer 400; explain=true works", async () => {
    for (const fa of [-3, "x"]) {
      const r = await fetch(`${base}/notes`, { method: "POST", headers: bearer(ROOT), body: JSON.stringify({ title: "t", forget_after: fa }) });
      assert.equal(r.status, 400, `forget_after ${fa}`);
    }
    const inf = await fetch(`${base}/notes`, { method: "POST", headers: bearer(ROOT), body: '{"title":"t","forget_after":1e400}' });
    assert.equal(inf.status, 400);
    for (const q of ["limit=-1", "limit=abc", "limit=0", "mode=bogus", "when=garbage-phrase-xyz"]) {
      const r = await fetch(`${base}/search?q=note&${q}`, { headers: bearer(ROOT) });
      assert.equal(r.status, 400, q);
    }
    assert.equal((await fetch(`${base}/notes?limit=abc`, { headers: bearer(ROOT) })).status, 400);
    store.create({ namespace: "default", title: "explain probe", body: "probe words" });
    const ok = await fetch(`${base}/search?q=explain%20probe&explain=true`, { headers: bearer(ROOT) });
    assert.equal(ok.status, 200);
    const j = await ok.json();
    assert.ok(j.results.length > 0 && j.results[0].breakdown, "explain=true attaches breakdown");
    const ok1 = await (await fetch(`${base}/search?q=explain%20probe&explain=1`, { headers: bearer(ROOT) })).json();
    assert.ok(ok1.results[0].breakdown);
  });

  test("REST import honours archived_at/expires_at and ?dedupe=1", async () => {
    const body = JSON.stringify({
      notes: [{ title: "imp", body: "x", archived_at: "2026-01-01T00:00:00.000Z", expires_at: "2027-01-01T00:00:00.000Z", created_at: "2025-05-05T00:00:00.000Z" }],
    });
    const r1 = await (await fetch(`${base}/import?dedupe=1`, { method: "POST", headers: bearer(ROOT), body })).json();
    assert.equal(r1.imported, 1);
    const r2 = await (await fetch(`${base}/import?dedupe=1`, { method: "POST", headers: bearer(ROOT), body })).json();
    assert.equal(r2.imported, 0);
    assert.equal(r2.skipped, 1);
    const arch = await (await fetch(`${base}/notes?archived=1&namespace=default`, { headers: bearer(ROOT) })).json();
    assert.ok(arch.notes.some((n: any) => n.title === "imp" && n.expires_at));
  });
});

describe("rate limiter counts failed auths, not all requests", () => {
  test("125 garbage requests do not lock out a valid token; repeated failures still hit 429", async () => {
    const store = new Store(":memory:");
    // The failed-auth tarpit (covered in core-122) would make 140 sequential
    // failures take minutes; switch it off for this limiter-focused test.
    const prevStep = process.env.ONEMEMORY_TARPIT_STEP_MS;
    process.env.ONEMEMORY_TARPIT_STEP_MS = "0";
    const server = createApiServer(store, [{ token: ROOT, scope: "admin", label: "r" }]);
    if (prevStep === undefined) delete process.env.ONEMEMORY_TARPIT_STEP_MS;
    else process.env.ONEMEMORY_TARPIT_STEP_MS = prevStep;
    await new Promise<void>((r) => server.listen(0, r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      // 125 *authenticated* requests from one IP would have tripped the old
      // per-IP limiter for everybody; mix in valid ones first.
      for (let i = 0; i < 60; i++) await fetch(`${base}/notes?limit=1`, { headers: bearer(ROOT) });
      for (let i = 0; i < 60; i++) await fetch(`${base}/notes`, { headers: bearer("nope") });
      const valid = await fetch(`${base}/notes?limit=1`, { headers: bearer(ROOT) });
      assert.equal(valid.status, 200, "valid token not locked out by failures from the same IP");
      let last = 0;
      for (let i = 0; i < 80; i++) last = (await fetch(`${base}/notes`, { headers: bearer("nope") })).status;
      assert.equal(last, 429, "failed auths are still limited per IP");
      assert.equal((await fetch(`${base}/notes?limit=1`, { headers: bearer(ROOT) })).status, 200);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      store.close();
    }
  });
});

const P = (n: string): string => n.padEnd(32, "-"); // user tokens must be >= 32 chars
describe("token namespace pins fail closed", () => {
  test("wrong-typed or empty namespace rejects the token instead of leaving it unpinned", () => {
    const home = mkdtempSync(join(tmpdir(), "om-tok-"));
    try {
      const CONFIG_JS = fileURLToPath(new URL("../src/config.js", import.meta.url));
      const toks = JSON.stringify([
        { token: P("t-num"), scope: "admin", namespace: 5 },
        { token: P("t-empty"), scope: "admin", namespace: "" },
        { token: P("t-arr"), scope: "admin", namespace: ["a"] },
        { token: P("t-ok"), scope: "admin", namespace: "work" },
        { token: P("t-none"), scope: "read" },
      ]);
      const r = spawnSync(
        process.execPath,
        ["--no-warnings", "--input-type=module", "-e", `const c = await import(${JSON.stringify("file://" + CONFIG_JS)}); console.log(JSON.stringify(c.resolveTokens().map(t => [t.token, t.namespace ?? null])));`],
        { env: { ...process.env, ONEMEMORY_HOME: home, HOME: home, ONEMEMORY_TOKENS: toks, ONEMEMORY_TOKEN: P("primary-token-for-test") }, encoding: "utf8" }
      );
      assert.equal(r.status, 0, r.stderr);
      const got = JSON.parse(r.stdout.trim().split("\n").pop()!) as Array<[string, string | null]>;
      const names = got.map((g) => g[0]);
      assert.ok(!names.includes(P("t-num")) && !names.includes(P("t-empty")) && !names.includes(P("t-arr")));
      assert.ok(names.includes(P("t-ok")) && names.includes(P("t-none")));
      assert.match(r.stderr, /namespace" must be a non-empty string/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("MCP: real version, explain, forget_after", () => {
  let client: Client;
  let store: Store;
  before(async () => {
    store = new Store(":memory:");
    const server = createMcpServer(store);
    const [c, s] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "t", version: "1" });
    await Promise.all([client.connect(c), server.connect(s)]);
  });
  after(async () => {
    await client.close();
    store.close();
  });
  const json = (r: any) => JSON.parse(r.content[0].text.slice(r.content[0].text.indexOf("{")));

  test("serverInfo.version and --version equal package.json", () => {
    const pkg = JSON.parse(readFileSync(join(PROJECT_ROOT, "package.json"), "utf8")) as { version: string };
    assert.equal(client.getServerVersion()!.version, pkg.version);
    assert.equal(PACKAGE_VERSION, pkg.version);
    for (const flag of ["--version", "-v"]) {
      const r = spawnSync(process.execPath, ["--no-warnings", CLI, flag], { encoding: "utf8", env: { ...process.env, ONEMEMORY_HOME: tmpdir() } });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout.trim(), pkg.version);
    }
  });

  test("state_write accepts forget_after; state_search explain attaches a breakdown", async () => {
    const w = json(await client.callTool({ name: "state_write", arguments: { title: "ttl note", body: "mcp retention", forget_after: 3 } }));
    assert.ok(w.note.expires_at);
    const bad = await client.callTool({ name: "state_write", arguments: { title: "x", forget_after: -1 } });
    assert.equal((bad as any).isError, true);
    const res = json(await client.callTool({ name: "state_search", arguments: { query: "retention", explain: true } }));
    assert.ok(res.results[0].breakdown);
    const plain = json(await client.callTool({ name: "state_search", arguments: { query: "retention" } }));
    assert.equal(plain.results[0].breakdown, undefined);
  });
});

async function killAndWait(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const done = new Promise<void>((r) => child.once("exit", () => r()));
  child.kill();
  await done;
}

describe("stdio MCP answers malformed JSON with -32700", () => {
  test("{bad on stdin yields a JSON-RPC parse error", async () => {
    const home = mkdtempSync(join(tmpdir(), "om-stdio-"));
    const child = spawn(process.execPath, ["--no-warnings", STDIO], {
      env: { ...process.env, ONEMEMORY_HOME: home, HOME: home },
      stdio: ["pipe", "pipe", "ignore"],
    });
    try {
      let out = "";
      const got = new Promise<string>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("no reply: " + out)), 8000);
        child.stdout.on("data", (d) => {
          out += d;
          if (out.includes("\n")) {
            clearTimeout(t);
            resolve(out);
          }
        });
      });
      await new Promise((r) => setTimeout(r, 600));
      child.stdin.write("{bad\n");
      const reply = JSON.parse((await got).split("\n")[0]);
      assert.equal(reply.error.code, -32700);
      assert.equal(reply.id, null);
    } finally {
      await killAndWait(child);
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});

describe(".key is in the private-file permission repair", () => {
  test("PRIVATE_FILES lists .key", () => {
    assert.ok(PRIVATE_FILES.includes(".key"));
  });
  test("prepareDataDir tightens a 0644 key file", { skip: process.platform === "win32" }, () => {
    const home = mkdtempSync(join(tmpdir(), "om-keyperm-"));
    try {
      writeFileSync(join(home, ".key"), Buffer.alloc(32, 1));
      chmodSync(join(home, ".key"), 0o644);
      const CONFIG_JS = fileURLToPath(new URL("../src/config.js", import.meta.url));
      const r = spawnSync(process.execPath, ["--no-warnings", "--input-type=module", "-e", `(await import(${JSON.stringify("file://" + CONFIG_JS)})).prepareDataDir();`], {
        env: { ...process.env, ONEMEMORY_HOME: home, HOME: home },
        encoding: "utf8",
      });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(statSync(join(home, ".key")).mode & 0o777, 0o600);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
