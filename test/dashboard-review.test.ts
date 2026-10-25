// The dashboard's Review view: notes an AI agent wrote that nobody has looked at yet. The page script is run in a
// stub browser so the filtering and the accept/delete calls are tested for real.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { DASHBOARD_HTML, DASHBOARD_JS } from "../src/dashboard.js";

interface Call {
  path: string;
  method: string;
  body?: any;
}

function page(notes: any[]) {
  const calls: Call[] = [];
  const els = new Map<string, any>();
  const el = (id: string): any => {
    if (!els.has(id)) els.set(id, { value: "", style: {}, textContent: "", innerHTML: "", checked: false, addEventListener() {}, focus() {}, appendChild() {} });
    return els.get(id);
  };
  const store: Record<string, any[]> = { notes };
  const ctx: any = {
    document: { getElementById: el, createElement: () => ({ style: {} }) },
    sessionStorage: { getItem: () => "tok", setItem() {}, removeItem() {} },
    alert: (m: string) => void calls.push({ path: "alert:" + m, method: "ALERT" }),
    confirm: () => true,
    setTimeout,
    clearTimeout,
    encodeURIComponent,
    fetch: async (path: string, opts: any = {}) => {
      const body = opts.body ? JSON.parse(opts.body) : undefined;
      calls.push({ path, method: opts.method ?? "GET", body });
      let json: any = { notes: store.notes };
      const m = /^\/notes\/(\d+)$/.exec(path);
      if (m && (opts.method ?? "GET") === "GET") json = { note: store.notes.find((n) => n.id === Number(m[1])) };
      if (m && opts.method === "PUT") {
        const n = store.notes.find((x) => x.id === Number(m[1]));
        n.tags = body.tags;
        json = { note: n };
      }
      if (m && opts.method === "DELETE") {
        store.notes = store.notes.filter((x) => x.id !== Number(m[1]));
        json = { ok: true };
      }
      if (path.startsWith("/runner/status")) json = {};
      return { ok: true, status: 200, json: async () => json };
    },
  };
  vm.createContext(ctx);
  vm.runInContext(DASHBOARD_JS, ctx);
  return { ctx, calls, el };
}

const N = (id: number, by: string, tags: string[] = []) => ({ id, title: "t" + id, body: "b", tags, namespace: "default", written_by: by, rev: 1, updated_at: "2026-10-25T10:00:00Z" });
const settle = () => new Promise((r) => setTimeout(r, 20));

describe("dashboard review queue", () => {
  test("the page has a Review button", () => {
    assert.match(DASHBOARD_HTML, /onclick="loadReview\(\)"/);
    assert.match(DASHBOARD_HTML, />Review</);
  });
  test("the script is valid JavaScript", () => {
    assert.doesNotThrow(() => new vm.Script(DASHBOARD_JS));
  });
  test("the page says OneMemory, not the old name", () => {
    assert.ok(!/claude<span/.test(DASHBOARD_HTML));
    assert.match(DASHBOARD_HTML, /one<span/);
  });
  test("queue = agent-written notes that are not yet reviewed; your own and imported notes are not queued", () => {
    const { ctx } = page([]);
    const q = ctx.reviewQueue([N(1, "claude-code-token"), N(2, "cli"), N(3, "stdio"), N(4, "import:claude"), N(5, "phone", ["reviewed"]), N(6, ""), N(7, "server")]);
    assert.deepEqual(q.map((n: any) => n.id), [1, 3]);
  });
  test("filtering by writer", () => {
    const { ctx } = page([]);
    const all = [N(1, "alice-token"), N(2, "bob-token"), N(3, "alice-token")];
    assert.deepEqual(ctx.reviewQueue(all, "alice-token").map((n: any) => n.id), [1, 3]);
    assert.deepEqual(ctx.reviewQueue(all, "nobody"), []);
  });
  test("loading the view lists the queue with a writer picker and accept/delete buttons", async () => {
    const { ctx, el } = page([N(1, "claude-code-token"), N(2, "cli")]);
    ctx.loadReview();
    await settle();
    const html = el("list").innerHTML;
    assert.match(html, /<select id='rv_writer'/);
    assert.match(html, /claude-code-token \(1\)/);
    assert.match(html, /acceptNote\(1\)/);
    assert.ok(!/acceptNote\(2\)/.test(html), "the cli-written note is not queued");
    assert.match(el("count").textContent, /1 to review/);
  });
  test("accept adds the tag reviewed (keeping the others) with the revision it read, then the note leaves the queue", async () => {
    const { ctx, calls, el } = page([N(1, "agent", ["x"])]);
    ctx.acceptNote(1);
    await settle();
    const put = calls.find((c) => c.method === "PUT")!;
    assert.equal(put.path, "/notes/1");
    assert.deepEqual(put.body.tags, ["x", "reviewed"]);
    assert.equal(put.body.if_rev, 1);
    assert.match(el("list").innerHTML, /Nothing waiting for review/);
  });
  test("accepting twice does not duplicate the tag", async () => {
    const { ctx, calls } = page([N(1, "agent", ["reviewed"])]);
    ctx.acceptNote(1);
    await settle();
    assert.deepEqual(calls.find((c) => c.method === "PUT")!.body.tags, ["reviewed"]);
  });
  test("delete from the review view refreshes the review, not the main list", async () => {
    const { ctx, calls } = page([N(1, "agent"), N(2, "agent")]);
    ctx.loadReview();
    await settle();
    ctx.del(1);
    await settle();
    assert.ok(calls.some((c) => c.method === "DELETE" && c.path === "/notes/1"));
    const last = calls.filter((c) => c.method === "GET").pop()!;
    assert.match(last.path, /^\/notes\?limit=500/);
  });
  test("note text is escaped, not injected as HTML", async () => {
    const evil = { ...N(1, "agent"), title: "<img src=x onerror=alert(1)>", body: "<script>alert(1)</script>" };
    const { ctx, el } = page([evil]);
    ctx.loadReview();
    await settle();
    assert.ok(!el("list").innerHTML.includes("<img src=x"));
    assert.ok(!el("list").innerHTML.includes("<script>alert"));
    assert.match(el("list").innerHTML, /&lt;img src=x/);
  });
});

describe("dashboard review queue against the real REST API", () => {
  test("the API gives the page what it needs: written_by on each note, and a tag-only edit keeps the writer", async () => {
    const { createApiServer } = await import("../src/api.js");
    const { Store } = await import("../src/store.js");
    const store = new Store(":memory:");
    const server = createApiServer(store, [
      { token: "t".repeat(40), scope: "write", label: "claude-code" },
      { token: "a".repeat(40), scope: "admin", label: "owner" },
    ]);
    await new Promise<void>((r) => server.listen(0, r));
    const base = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
    const h = (t: string) => ({ Authorization: `Bearer ${t}`, "Content-Type": "application/json" });
    try {
      const made = (await (await fetch(`${base}/notes`, { method: "POST", headers: h("t".repeat(40)), body: JSON.stringify({ title: "agent note", body: "x" }) })).json()) as { note: any };
      const list = (await (await fetch(`${base}/notes?limit=500`, { headers: h("a".repeat(40)) })).json()) as { notes: any[] };
      assert.equal(list.notes[0].written_by, "claude-code");
      const put = await fetch(`${base}/notes/${made.note.id}`, { method: "PUT", headers: h("a".repeat(40)), body: JSON.stringify({ tags: ["reviewed"], if_rev: made.note.rev }) });
      assert.equal(put.status, 200);
      const after = (await (await fetch(`${base}/notes/${made.note.id}`, { headers: h("a".repeat(40)) })).json()) as { note: any };
      assert.deepEqual(after.note.tags, ["reviewed"]);
      assert.equal(after.note.written_by, "claude-code", "accepting does not take over authorship");
      const { DASHBOARD_JS } = await import("../src/dashboard.js");
      const ctx: any = { document: { getElementById: () => ({ addEventListener() {}, style: {}, focus() {}, value: "", textContent: "", innerHTML: "" }) }, sessionStorage: { getItem: () => "x" }, fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }), setTimeout, clearTimeout, encodeURIComponent };
      vm.createContext(ctx);
      vm.runInContext(DASHBOARD_JS, ctx);
      assert.deepEqual(ctx.reviewQueue(list.notes).map((n: any) => n.id), [made.note.id], "before accepting it is queued");
      assert.deepEqual(ctx.reviewQueue([after.note]), [], "after accepting it is not");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      store.close();
    }
  });
});
