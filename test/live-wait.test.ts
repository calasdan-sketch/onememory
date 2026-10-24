// Live wait on the change feed: GET /changes?wait=N and memory_since
// wait_seconds. Covers wake-ups (in-process and cross-process), scope,
// timeouts, client disconnects, caps, and that nothing leaks afterwards.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Store, ValidationError } from "../src/store.js";
import { waitForChanges, parseWait, activeWaiters, WaitBusyError, WAIT_MAX_SECONDS } from "../src/change-wait.js";
import { createMcpServer } from "../src/mcp-server-core.js";
import { createApiServer } from "../src/api.js";

process.env.ONEMEMORY_WAIT_POLL_MS = "50"; // fast cross-process fallback for tests

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const listeners = (s: Store): number => (s as unknown as { changeListeners: Set<unknown> }).changeListeners.size;
function parseTool(r: any): any {
  const t: string = r.content[0].text;
  return JSON.parse(t.slice(t.indexOf("{")));
}
async function settled(fn: () => boolean, ms = 2000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await sleep(20);
  }
  return fn();
}
const req = (consumer: string, extra: object = {}) => ({ since: "last", consumer, ...extra });
/** Mark `consumer` as caught up so a wait starts from "now". */
function prime(store: Store, consumer: string, namespaces?: string[]): void {
  void waitForChanges(store, { ...req(consumer), namespaces }, { waitSeconds: 0, key: "k" });
}

describe("parseWait", () => {
  test("accepts 0..max, rejects the rest", () => {
    assert.equal(parseWait(undefined), 0);
    assert.equal(parseWait(null), 0);
    assert.equal(parseWait(""), 0);
    assert.equal(parseWait("30"), 30);
    assert.equal(parseWait(WAIT_MAX_SECONDS), WAIT_MAX_SECONDS);
    for (const bad of [-1, 56, 1.5, "abc", "1e3", "99999", NaN]) {
      assert.throws(() => parseWait(bad), ValidationError, String(bad));
    }
  });
});

describe("waitForChanges", () => {
  test("wait 0 behaves exactly like the plain feed", async () => {
    const store = new Store(":memory:");
    store.create({ title: "a" });
    const out = await waitForChanges(store, { since: "1h" }, { waitSeconds: 0, key: "k" });
    assert.equal(out.changes.length, 1);
    assert.equal(out.timedOut, undefined);
    store.close();
  });

  test("returns immediately when there is already something new", async () => {
    const store = new Store(":memory:");
    store.create({ title: "already here" });
    const t0 = Date.now();
    const out = await waitForChanges(store, { since: "1h" }, { waitSeconds: 30, key: "k" });
    assert.ok(Date.now() - t0 < 1000);
    assert.equal(out.changes[0].title, "already here");
    assert.equal(activeWaiters(), 0);
    store.close();
  });

  test("a write in this process wakes a parked waiter within milliseconds", async () => {
    const store = new Store(":memory:");
    prime(store, "pc");
    const t0 = Date.now();
    const p = waitForChanges(store, req("pc"), { waitSeconds: 30, key: "k" });
    await sleep(60);
    assert.equal(activeWaiters(), 1);
    store.create({ title: "idea from the phone", source: "phone" });
    const out = await p;
    assert.ok(Date.now() - t0 < 2000, "should not have waited out the timeout");
    assert.deepEqual(out.changes.map((c) => c.title), ["idea from the phone"]);
    assert.equal(out.timedOut, undefined);
    assert.equal(activeWaiters(), 0);
    assert.equal(listeners(store), 0);
    store.close();
  });

  test("update, archive, restore and delete each wake a waiter", async () => {
    const store = new Store(":memory:");
    const id = store.create({ title: "n" }).id;
    prime(store, "w");
    const steps: Array<[string, () => void]> = [
      ["update", () => store.update(id, { body: "changed" })],
      ["archive", () => store.archive(id)],
      ["restore", () => store.restore(id)],
      ["delete", () => store.delete(id)],
    ];
    for (const [name, act] of steps) {
      const p = waitForChanges(store, req("w"), { waitSeconds: 30, key: "k" });
      await sleep(30);
      const t0 = Date.now();
      act();
      const out = await p;
      assert.ok(Date.now() - t0 < 1500, `${name} did not wake the waiter`);
      assert.equal(out.changes.length, 1, name);
      assert.equal(out.timedOut, undefined, name);
    }
    store.close();
  });

  test("sweepExpired (retention) wakes a waiter", async () => {
    const store = new Store(":memory:");
    store.create({ title: "temp", forget_after: 1 });
    prime(store, "w");
    const p = waitForChanges(store, req("w"), { waitSeconds: 30, key: "k" });
    await sleep(30);
    assert.equal(store.sweepExpired(Date.now() + 3 * 86_400_000), 1);
    const out = await p;
    assert.equal(out.changes.length, 1);
    store.close();
  });

  test("a write from ANOTHER process/connection is caught by the poll fallback", async () => {
    const dir = mkdtempSync(join(tmpdir(), "om-wait-"));
    try {
      const a = new Store(join(dir, "state.db"));
      const b = new Store(join(dir, "state.db")); // stands in for the CLI
      prime(a, "w");
      const p = waitForChanges(a, req("w"), { waitSeconds: 30, key: "k" });
      await sleep(80);
      b.create({ title: "from the cli" });
      const out = await p;
      assert.deepEqual(out.changes.map((c) => c.title), ["from the cli"]);
      b.close();
      a.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("times out with an empty page, timedOut:true, and leaks nothing", async () => {
    const store = new Store(":memory:");
    prime(store, "w");
    const t0 = Date.now();
    const out = await waitForChanges(store, req("w"), { waitSeconds: 1, key: "k" });
    assert.ok(Date.now() - t0 >= 900);
    assert.equal(out.changes.length, 0);
    assert.equal(out.timedOut, true);
    assert.equal(activeWaiters(), 0);
    assert.equal(listeners(store), 0);
    store.close();
  });

  test("scope: writes outside the caller's namespaces never wake or reach it", async () => {
    const store = new Store(":memory:");
    prime(store, "w", ["work"]);
    const p = waitForChanges(store, { ...req("w"), namespaces: ["work"] }, { waitSeconds: 1, key: "k" });
    await sleep(30);
    store.create({ title: "secret plans", namespace: "home" });
    const out = await p;
    assert.equal(out.timedOut, true);
    assert.equal(out.changes.length, 0);
    // ...and a write in scope still gets through afterwards.
    const q = waitForChanges(store, { ...req("w"), namespaces: ["work"] }, { waitSeconds: 10, key: "k" });
    await sleep(30);
    store.create({ title: "work item", namespace: "work" });
    assert.deepEqual((await q).changes.map((c) => c.title), ["work item"]);
    store.close();
  });

  test("an unreadable (empty) scope waits out and returns nothing", async () => {
    const store = new Store(":memory:");
    const p = waitForChanges(store, { since: "1h", namespaces: [] }, { waitSeconds: 1, key: "k" });
    store.create({ title: "x" });
    const out = await p;
    assert.equal(out.timedOut, true);
    assert.equal(out.changes.length, 0);
    store.close();
  });

  test("client disconnect (abort) ends the wait at once and frees everything", async () => {
    const store = new Store(":memory:");
    prime(store, "w");
    const ac = new AbortController();
    const p = waitForChanges(store, req("w"), { waitSeconds: 55, key: "k", signal: ac.signal });
    await sleep(40);
    assert.equal(activeWaiters(), 1);
    const t0 = Date.now();
    ac.abort();
    await p;
    assert.ok(Date.now() - t0 < 500);
    assert.equal(activeWaiters(), 0);
    assert.equal(listeners(store), 0);
    // Already-aborted signal: returns without parking.
    await waitForChanges(store, req("w"), { waitSeconds: 55, key: "k", signal: ac.signal });
    assert.equal(activeWaiters(), 0);
    store.close();
  });

  test("cursor + wait is rejected (a cursor's window is frozen)", async () => {
    const store = new Store(":memory:");
    await assert.rejects(
      () => waitForChanges(store, { cursor: "x" }, { waitSeconds: 5, key: "k" }),
      /cannot be combined with cursor/
    );
    assert.equal(activeWaiters(), 0);
    store.close();
  });

  test("an invalid request while waiting frees the slot", async () => {
    const store = new Store(":memory:");
    await assert.rejects(() => waitForChanges(store, { since: "whenever" }, { waitSeconds: 5, key: "k" }), ValidationError);
    assert.equal(activeWaiters(), 0);
    store.close();
  });

  test("per-token cap: extra waiters are refused, other tokens are not, slots come back", async () => {
    process.env.ONEMEMORY_WAIT_MAX_PER_TOKEN = "2";
    try {
      const store = new Store(":memory:");
      prime(store, "w");
      const ac = new AbortController();
      const o = { waitSeconds: 55, signal: ac.signal };
      const p1 = waitForChanges(store, req("w"), { ...o, key: "tok-a" });
      const p2 = waitForChanges(store, req("w"), { ...o, key: "tok-a" });
      await assert.rejects(() => waitForChanges(store, req("w"), { ...o, key: "tok-a" }), WaitBusyError);
      const other = waitForChanges(store, req("w"), { ...o, key: "tok-b" }); // different token: fine
      assert.equal(activeWaiters(), 3);
      ac.abort();
      await Promise.all([p1, p2, other]);
      assert.equal(activeWaiters(), 0);
      const again = await waitForChanges(store, req("w"), { waitSeconds: 1, key: "tok-a" });
      assert.equal(again.timedOut, true);
      store.close();
    } finally {
      delete process.env.ONEMEMORY_WAIT_MAX_PER_TOKEN;
    }
  });

  test("global cap protects the process", async () => {
    process.env.ONEMEMORY_WAIT_MAX_TOTAL = "2";
    try {
      const store = new Store(":memory:");
      prime(store, "w");
      const ac = new AbortController();
      const o = { waitSeconds: 55, signal: ac.signal };
      const ps = [
        waitForChanges(store, req("w"), { ...o, key: "a" }),
        waitForChanges(store, req("w"), { ...o, key: "b" }),
      ];
      await assert.rejects(() => waitForChanges(store, req("w"), { ...o, key: "c" }), WaitBusyError);
      ac.abort();
      await Promise.all(ps);
      assert.equal(activeWaiters(), 0);
      store.close();
    } finally {
      delete process.env.ONEMEMORY_WAIT_MAX_TOTAL;
    }
  });

  test("many wake/timeout cycles leave no timers, listeners or slots behind", async () => {
    const store = new Store(":memory:");
    prime(store, "w");
    for (let i = 0; i < 25; i++) {
      const p = waitForChanges(store, req("w"), { waitSeconds: 5, key: "k" });
      await sleep(5);
      store.create({ title: `n${i}` });
      assert.equal((await p).changes.length, 1);
    }
    assert.equal(activeWaiters(), 0);
    assert.equal(listeners(store), 0);
    store.close();
  });
});

describe("memory_since wait_seconds (MCP)", () => {
  async function connect(store: Store, scope: "read" | "write" | "admin", opts = {}, conn = {}) {
    const server = createMcpServer(store, scope, opts, conn);
    const [c, s] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "1.0.0" });
    await Promise.all([client.connect(c), server.connect(s)]);
    return client;
  }

  test("a parked call returns when another session writes", async () => {
    const store = new Store(":memory:");
    const client = await connect(store, "read");
    await client.callTool({ name: "memory_since", arguments: { since: "last", consumer: "pc" } });
    const pending = client.callTool({
      name: "memory_since",
      arguments: { since: "last", consumer: "pc", wait_seconds: 20 },
    });
    await sleep(60);
    store.create({ title: "added from the phone", source: "phone" });
    const out = parseTool(await pending);
    assert.deepEqual(out.changes.map((c: any) => c.title), ["added from the phone"]);
    await client.close();
    store.close();
  });

  test("timeout returns timedOut:true; bad values are tool errors; scope and namespace still apply", async () => {
    const store = new Store(":memory:");
    const client = await connect(store, "read", { namespace: "work", readsFrom: {} });
    const out = parseTool(
      await client.callTool({ name: "memory_since", arguments: { since: "last", consumer: "x", wait_seconds: 1 } })
    );
    assert.equal(out.timedOut, true);
    const bad: any = await client.callTool({ name: "memory_since", arguments: { since: "1h", wait_seconds: 999 } });
    assert.equal(bad.isError, true);
    // A write in a namespace the server can't read does not wake it.
    const pending = client.callTool({ name: "memory_since", arguments: { since: "last", consumer: "x", wait_seconds: 1 } });
    await sleep(30);
    store.create({ title: "elsewhere", namespace: "home" });
    const res = parseTool(await pending);
    assert.equal(res.timedOut, true);
    assert.equal(res.changes.length, 0);
    await client.close();
    store.close();
  });

  test("the transport's disconnect signal frees the slot", async () => {
    const store = new Store(":memory:");
    const gone = new AbortController();
    const client = await connect(store, "read", {}, { waitKey: "mcp-tok", signal: gone.signal });
    await client.callTool({ name: "memory_since", arguments: { since: "last", consumer: "d" } });
    const pending = client.callTool({ name: "memory_since", arguments: { since: "last", consumer: "d", wait_seconds: 55 } });
    await sleep(60);
    assert.equal(activeWaiters(), 1);
    gone.abort();
    await pending;
    assert.equal(activeWaiters(), 0);
    await client.close();
    store.close();
  });

  test("busy cap is a tool error, not a hang", async () => {
    process.env.ONEMEMORY_WAIT_MAX_PER_TOKEN = "1";
    try {
      const store = new Store(":memory:");
      const gone = new AbortController();
      const client = await connect(store, "read", {}, { waitKey: "one", signal: gone.signal });
      await client.callTool({ name: "memory_since", arguments: { since: "last", consumer: "b" } });
      const first = client.callTool({ name: "memory_since", arguments: { since: "last", consumer: "b", wait_seconds: 55 } });
      await sleep(60);
      const second: any = await client.callTool({
        name: "memory_since",
        arguments: { since: "last", consumer: "b", wait_seconds: 55 },
      });
      assert.equal(second.isError, true);
      assert.match(second.content[0].text, /too many concurrent waits/);
      gone.abort();
      await first;
      await client.close();
      store.close();
    } finally {
      delete process.env.ONEMEMORY_WAIT_MAX_PER_TOKEN;
    }
  });
});

describe("REST GET /changes?wait=", () => {
  let store: Store;
  let base: string;
  let server: ReturnType<typeof createApiServer>;
  const READ = "read-token-wait";
  const PINNED = "pinned-token-wait";
  before(async () => {
    store = new Store(":memory:");
    server = createApiServer(store, [
      { token: READ, scope: "read", label: "read" },
      { token: PINNED, scope: "read", label: "pinned", namespace: "work" },
      { token: "writer-token-wait", scope: "write", label: "w" },
    ]);
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    await new Promise<void>((r) => {
      server.closeAllConnections?.();
      server.close(() => r());
    });
    store.close();
  });
  const h = (t = READ) => ({ headers: { Authorization: `Bearer ${t}` } });

  test("auth is still required", async () => {
    assert.equal((await fetch(`${base}/changes?since=last&wait=1`)).status, 401);
  });

  test("validation: bad wait and wait+cursor are 400", async () => {
    for (const q of ["wait=-1", "wait=56", "wait=abc", "wait=1.5", "since=1h&cursor=zzz&wait=2"]) {
      const r = await fetch(`${base}/changes?${q.includes("since") ? "" : "since=last&"}${q}`, h());
      assert.equal(r.status, 400, q);
    }
    assert.equal(activeWaiters(), 0);
  });

  test("parked request is answered when a write lands", async () => {
    await fetch(`${base}/changes?since=last&consumer=pc`, h());
    const p = fetch(`${base}/changes?since=last&consumer=pc&wait=20`, h());
    await sleep(80);
    assert.equal(activeWaiters(), 1);
    store.create({ title: "idea from the phone", source: "phone" });
    const res = await p;
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.deepEqual(j.changes.map((c: any) => c.title), ["idea from the phone"]);
    assert.equal(j.timedOut, undefined);
    assert.equal(activeWaiters(), 0);
  });

  test("timeout answers 200 with timedOut and the empty page", async () => {
    await fetch(`${base}/changes?since=last&consumer=t`, h());
    const res = await fetch(`${base}/changes?since=last&consumer=t&wait=1`, h());
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.equal(j.timedOut, true);
    assert.deepEqual(j.changes, []);
    assert.equal(activeWaiters(), 0);
  });

  test("a client that hangs up frees its slot and listener", async () => {
    await fetch(`${base}/changes?since=last&consumer=gone`, h());
    const before = listeners(store);
    const ac = new AbortController();
    const p = fetch(`${base}/changes?since=last&consumer=gone&wait=55`, { ...h(), signal: ac.signal }).catch((e) => e);
    await sleep(100);
    assert.equal(activeWaiters(), 1);
    ac.abort();
    await p;
    assert.ok(await settled(() => activeWaiters() === 0), "waiter slot leaked after disconnect");
    assert.ok(await settled(() => listeners(store) === before), "store listener leaked after disconnect");
  });

  test("429 when the token already has its maximum parked requests", async () => {
    process.env.ONEMEMORY_WAIT_MAX_PER_TOKEN = "1";
    try {
      await fetch(`${base}/changes?since=last&consumer=cap`, h());
      const ac = new AbortController();
      const first = fetch(`${base}/changes?since=last&consumer=cap&wait=55`, { ...h(), signal: ac.signal }).catch((e) => e);
      await sleep(100);
      const second = await fetch(`${base}/changes?since=last&consumer=cap&wait=55`, h());
      assert.equal(second.status, 429);
      // another token is unaffected
      const other = await fetch(`${base}/changes?since=last&consumer=cap2&wait=1`, h("writer-token-wait"));
      assert.equal(other.status, 200);
      ac.abort();
      await first;
      assert.ok(await settled(() => activeWaiters() === 0));
    } finally {
      delete process.env.ONEMEMORY_WAIT_MAX_PER_TOKEN;
    }
  });

  test("a namespace-pinned token is only woken by its own namespace", async () => {
    await fetch(`${base}/changes?since=last&consumer=pin`, h(PINNED));
    const p = fetch(`${base}/changes?since=last&consumer=pin&wait=2`, h(PINNED));
    await sleep(60);
    store.create({ title: "other ns", namespace: "home" });
    await sleep(200);
    store.create({ title: "my ns", namespace: "work" });
    const j = await (await p).json();
    assert.deepEqual(j.changes.map((c: any) => c.title), ["my ns"]);
    assert.ok(j.changes.every((c: any) => c.namespace === "work"));
  });
});
