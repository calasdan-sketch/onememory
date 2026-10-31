// The dashboard's Sessions view: the session list and one session's timeline (GET /sessions, GET /sessions/:id). The page
// script runs in a stub browser; every stored string is hostile markup, and none of it may come out as live HTML.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { DASHBOARD_HTML, DASHBOARD_JS } from "../src/dashboard.js";

const XSS = `<img src=x onerror=alert(1)>'"`;

function page(json: (path: string) => unknown) {
  const calls: string[] = [];
  const els = new Map<string, any>();
  const el = (id: string): any => {
    if (!els.has(id)) els.set(id, { value: "", style: {}, textContent: "", innerHTML: "", checked: false, addEventListener() {}, focus() {}, appendChild() {} });
    return els.get(id);
  };
  const ctx: any = {
    document: { getElementById: el, createElement: () => ({ style: {} }) },
    sessionStorage: { getItem: () => "tok", setItem() {}, removeItem() {} },
    alert() {},
    confirm: () => true,
    setTimeout,
    clearTimeout,
    encodeURIComponent,
    fetch: async (path: string) => {
      calls.push(path);
      return { ok: true, status: 200, json: async () => json(path) };
    },
  };
  vm.createContext(ctx);
  vm.runInContext(DASHBOARD_JS, ctx);
  return { ctx, calls, el };
}
const settle = () => new Promise((r) => setTimeout(r, 20));
/** No tag from the data survived: every "<" in the output belongs to the page's own markup. */
function noLiveMarkup(html: string): void {
  assert.doesNotMatch(html, /<img/i);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
}

describe("dashboard: Sessions view", () => {
  test("has a Sessions button", () => {
    assert.match(DASHBOARD_HTML, /onclick="loadSessions\(\)"[^>]*>Sessions</);
  });

  test("the session list escapes everything and passes the id through a data attribute", async () => {
    const p = page(() => ({ sessions: [{ id: `s1${XSS}`, namespace: XSS, cwd: XSS, started_at: "2026-10-30T10:00:00Z", ended_at: null, prompt_count: 2, event_count: 9, summary: XSS }] }));
    p.ctx.loadSessions();
    await settle();
    assert.ok(p.calls.some((c) => c.startsWith("/sessions?limit=100")), p.calls.join());
    const html = p.el("list").innerHTML as string;
    noLiveMarkup(html);
    assert.doesNotMatch(html, /data-sid='[^']*'"/, "the quote in the id cannot close the attribute");
    assert.match(html, /data-sid='s1&lt;img src=x onerror=alert\(1\)&gt;&#39;&quot;'/);
    assert.match(html, /onclick='loadSession\(this\.getAttribute\(&quot;data-sid&quot;\)\)'/);
    assert.equal(p.el("count").textContent, "1 session");
  });

  test("one session: summary first, then prompts and observations oldest first, all escaped; the id is URL-encoded", async () => {
    const p = page(() => ({
      session: { id: "a/b", cwd: XSS },
      summary: { id: 7, title: XSS, body: XSS, updated_at: "2026-10-30T10:05:00Z" },
      prompts: [{ at: "2026-10-30T10:00:00Z", text: `first ${XSS}` }],
      rows: [
        { id: 9, kind: "observation", type: XSS, title: `later ${XSS}`, date: "2026-10-30T10:02:00Z", files: [XSS] },
        { id: 8, kind: "observation", type: "bugfix", title: "earlier fix", date: "2026-10-30T10:01:00Z", files: [] },
        { id: 7, kind: "summary", type: "summary", title: "dup summary row", date: "2026-10-30T10:03:00Z", files: [] },
      ],
    }));
    p.ctx.loadSession("a/b");
    await settle();
    assert.ok(p.calls.includes("/sessions/a%2Fb"), p.calls.join());
    const html = p.el("list").innerHTML as string;
    noLiveMarkup(html);
    const order = ["summary #7", "first &lt;img", "earlier fix", "later &lt;img"].map((s) => html.indexOf(s));
    assert.ok(order.every((i) => i >= 0), JSON.stringify(order));
    assert.deepEqual([...order].sort((a, b) => a - b), order);
    assert.doesNotMatch(html, /dup summary row/, "the summary is shown once, on top");
    assert.equal(p.el("count").textContent, "3 timeline entries");
  });
});
