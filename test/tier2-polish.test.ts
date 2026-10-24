// Regression tests for the Tier 2 HIGH/MEDIUM/LOW polish pass (panel
// findings: Protocol P-*, IR I-*, S-LOW-3, Y-HIGH-2/3 CLI/REST surface).
// Blockers 1-4 and the I-HIGH/D-HIGH redesigns are covered by their own
// workers' test files (tier2-blockers*.test.ts).
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Store } from "../src/store.js";
import { createMcpServer } from "../src/mcp-server-core.js";
import { createApiServer } from "../src/api.js";
import { extractKeywords } from "../src/keywords.js";
import {
  runRelevantSearch,
  roundRobin,
} from "../src/search-service.js";
import { autoConsolidate, autoConsolidateCooperative } from "../src/consolidate.js";
import { UNTRUSTED_BANNER } from "../src/security.js";

function parseToolText(result: any): any {
  const item = result.content[0];
  assert.equal(item.type, "text");
  const text = item.text as string;
  const payload = text.startsWith(UNTRUSTED_BANNER)
    ? text.slice(UNTRUSTED_BANNER.length)
    : text;
  return JSON.parse(payload);
}

describe("keywords: hashtag/bare-stem dedupe (I-MEDIUM-3)", () => {
  test("hashtag and prose twin yield one keyword (prose first)", () => {
    assert.deepEqual(extractKeywords("status of the #status report"), [
      "status",
      "report",
    ]);
  });

  test("hashtag and prose twin yield one keyword (hashtag first)", () => {
    assert.deepEqual(extractKeywords("#status and the status report"), [
      "#status",
      "report",
    ]);
  });

  test("distinct hashtags still both survive", () => {
    const kws = extractKeywords("#status #goal quarterly review");
    assert.ok(kws.includes("#status"));
    assert.ok(kws.includes("#goal"));
    assert.ok(kws.includes("quarterly"));
  });
});

describe("keywords: digit carve-out + filler stop-words (I-MEDIUM-3/4)", () => {
  test("short tokens with digits survive the length drop", () => {
    const kws = extractKeywords("migrate S3 to EC2");
    assert.ok(kws.includes("s3"), `missing s3 in ${kws}`);
    assert.ok(kws.includes("ec2"), `missing ec2 in ${kws}`);
    assert.ok(kws.includes("migrate"));
  });

  test("digit carve-out keeps Q3", () => {
    assert.deepEqual(extractKeywords('Budget, INVOICES! "Q3"'), [
      "budget",
      "invoices",
      "q3",
    ]);
  });

  test("conversational filler is not keyword material", () => {
    assert.deepEqual(extractKeywords("hey thanks for the update"), ["update"]);
    assert.deepEqual(extractKeywords("hi, what did we decide?"), ["decide"]);
  });

  test("plain short tokens are still dropped", () => {
    assert.deepEqual(extractKeywords("an ox ate my pie on tv"), ["ate", "pie"]);
  });
});

describe("runRelevantSearch: bm25-weighted merge (I-MEDIUM-2)", () => {
  let store: Store;
  before(() => {
    store = new Store(":memory:");
    store.create({
      title: "Acme billing",
      body: "acme acme acme invoicing details here",
    });
    store.create({
      title: "Random note",
      body: "mentions acme once in passing among other words",
    });
  });
  after(() => store.close());

  test("central-topic hit outranks a passing mention at equal keyword count", async () => {
    // Both notes match exactly one keyword ("acme"); the old count-only
    // merge broke the tie by recency. The bm25-weighted merge must put the
    // central-topic note first.
    const { keywords, results } = await runRelevantSearch(store, "acme");
    assert.deepEqual(keywords, ["acme"]);
    assert.equal(results.length, 2);
    assert.equal(results[0].title, "Acme billing");
  });
});

describe("runRelevantSearch: same pipeline as search (I-MEDIUM-1)", () => {
  let store: Store;
  before(() => {
    store = new Store(":memory:");
    // Identical keyword content: same bm25, same keyword count. The only
    // ranking signal left is the access boost -- which only applies if the
    // relevant path runs the shared finalize pipeline.
    store.create({ title: "Alpha widget", body: "widget specs and pricing" });
    store.create({ title: "Beta widget", body: "widget specs and pricing" });
    const alpha = store.list({}).notes.find((n) => n.title === "Alpha widget")!;
    for (let i = 0; i < 5; i++) store.touch(alpha.id);
  });
  after(() => store.close());

  test("access boost applies on the relevant path", async () => {
    const { results } = await runRelevantSearch(store, "widget specs");
    assert.equal(results[0].title, "Alpha widget");
  });

  test("returned notes get their access counters bumped", async () => {
    const beforeCounts = new Map(
      store.list({}).notes.map((n) => [n.title, n.access_count])
    );
    await runRelevantSearch(store, "widget specs", { limit: 2 });
    const afterCounts = new Map(
      store.list({}).notes.map((n) => [n.title, n.access_count])
    );
    for (const [title, c] of afterCounts) {
      assert.ok(
        (c as number) >= (beforeCounts.get(title) as number),
        `${title}: access_count must not decrease`
      );
    }
  });
});

describe("roundRobin (I-LOW-2)", () => {
  test("interleaves per-namespace lists", () => {
    assert.deepEqual(
      roundRobin(
        [
          [1, 2, 3],
          [4, 5],
        ],
        4
      ),
      [1, 4, 2, 5]
    );
  });

  test("truncates to the limit", () => {
    assert.deepEqual(
      roundRobin(
        [
          [1, 2],
          [3, 4],
        ],
        3
      ),
      [1, 3, 2]
    );
  });

  test("empty lists are skipped", () => {
    assert.deepEqual(roundRobin([[], [7], []], 5), [7]);
  });

  test("a later namespace is never starved at small limits", () => {
    const out = roundRobin(
      [
        ["a1", "a2", "a3", "a4", "a5"],
        ["b1"],
      ],
      5
    );
    assert.ok(out.includes("b1"), `b1 starved: ${out}`);
  });
});

describe("MCP: searchedNamespaces echo (S-LOW-3)", () => {
  let store: Store;
  let client: Client;
  before(async () => {
    store = new Store(":memory:");
    store.create({ namespace: "work", title: "Work note", body: "quarterly planning" });
    store.create({ namespace: "shared", title: "Shared note", body: "planning doc" });
    store.create({ namespace: "private", title: "Private note", body: "planning secrets" });
    const server = createMcpServer(store, "admin", {
      namespace: "work",
      readsFrom: { work: ["shared"] },
    });
    const [c, s] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test-client", version: "1.0.0" });
    await Promise.all([client.connect(c), server.connect(s)]);
  });
  after(async () => {
    await client.close();
    store.close();
  });

  test("state_search echoes the readable set on unreadable hint", async () => {
    const r: any = await client.callTool({
      name: "state_search",
      arguments: { query: "planning", namespace: "private" },
    });
    const out = parseToolText(r);
    assert.deepEqual([...out.searchedNamespaces].sort(), ["shared", "work"]);
  });

  test("state_search echoes the trusted hint when readable", async () => {
    const r: any = await client.callTool({
      name: "state_search",
      arguments: { query: "planning", namespace: "shared" },
    });
    assert.deepEqual(parseToolText(r).searchedNamespaces, ["shared"]);
  });

  test("state_relevant echoes searchedNamespaces", async () => {
    const r: any = await client.callTool({
      name: "state_relevant",
      arguments: { message: "planning", namespace: "private" },
    });
    const out = parseToolText(r);
    assert.deepEqual([...out.searchedNamespaces].sort(), ["shared", "work"]);
    // I-MEDIUM-1: results carry the staleness fields.
    assert.ok(
      out.results.every(
        (n: any) => typeof n.stale === "boolean" && typeof n.ageDays === "number"
      ),
      "relevant results must carry staleness fields"
    );
  });

  test("state_list echoes searchedNamespaces", async () => {
    const r: any = await client.callTool({ name: "state_list", arguments: {} });
    assert.deepEqual([...parseToolText(r).searchedNamespaces].sort(), [
      "shared",
      "work",
    ]);
  });
});

describe("MCP: tool annotations (P-LOW-7)", () => {
  let store: Store;
  let client: Client;
  before(async () => {
    store = new Store(":memory:");
    const server = createMcpServer(store, "admin");
    const [c, s] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test-client", version: "1.0.0" });
    await Promise.all([client.connect(c), server.connect(s)]);
  });
  after(async () => {
    await client.close();
    store.close();
  });

  test("read-only tools advertise readOnlyHint", async () => {
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));
    for (const name of ["memory_stats", "state_relevant", "memory_consolidation_candidates"]) {
      assert.equal(
        (byName.get(name) as any).annotations?.readOnlyHint,
        true,
        `${name} should have readOnlyHint`
      );
    }
  });

  test("destructive tools advertise destructiveHint", async () => {
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));
    for (const name of ["state_delete", "memory_consolidate", "memory_rebuild_edges"]) {
      assert.equal(
        (byName.get(name) as any).annotations?.destructiveHint,
        true,
        `${name} should have destructiveHint`
      );
    }
  });

  test("memory_rebuild_edges is idempotent", async () => {
    const { tools } = await client.listTools();
    const tool: any = tools.find((t) => t.name === "memory_rebuild_edges");
    assert.equal(tool.annotations?.idempotentHint, true);
  });
});

describe("MCP: memory_stats carries the untrusted banner (P-MEDIUM-1)", () => {
  test("mostAccessed titles are bannered", async () => {
    const store = new Store(":memory:");
    store.create({ title: "seed", body: "hello" });
    const server = createMcpServer(store, "admin");
    const [c, s] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await Promise.all([client.connect(c), server.connect(s)]);
    try {
      const r: any = await client.callTool({ name: "memory_stats", arguments: {} });
      assert.ok(!r.isError);
      const text = r.content[0].text as string;
      assert.ok(
        text.startsWith(UNTRUSTED_BANNER),
        "memory_stats must carry the untrusted-data banner"
      );
      const payload = JSON.parse(text.slice(UNTRUSTED_BANNER.length));
      assert.ok(typeof payload.totalNotes === "number");
    } finally {
      await client.close();
      store.close();
    }
  });
});

describe("REST: GET /stats (P-MEDIUM-2)", () => {
  const TOKEN = "test-token-stats";
  let store: Store;
  let baseUrl: string;
  let server: ReturnType<typeof createApiServer>;
  before(async () => {
    store = new Store(":memory:");
    store.create({ namespace: "work", title: "w1", body: "x" });
    store.create({ namespace: "other", title: "o1", body: "y" });
    server = createApiServer(store, TOKEN);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });
  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  });
  const get = (path: string, token: string | null = TOKEN) =>
    fetch(`${baseUrl}${path}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });

  test("200 with totals and searchedNamespaces", async () => {
    const res = await get("/stats");
    assert.equal(res.status, 200);
    const json: any = await res.json();
    assert.equal(json.totalNotes, 2);
    assert.deepEqual(json.searchedNamespaces, []);
  });

  test("namespace param scopes the counts", async () => {
    const res = await get("/stats?namespace=work");
    assert.equal(res.status, 200);
    const json: any = await res.json();
    assert.equal(json.totalNotes, 1);
    assert.deepEqual(json.searchedNamespaces, ["work"]);
  });

  test("requires auth", async () => {
    assert.equal((await get("/stats", null)).status, 401);
  });

  test("read-scoped token may use /stats", async () => {
    const readServer = createApiServer(store, [
      { token: "read-only", scope: "read", label: "r" },
    ]);
    await new Promise<void>((resolve) => readServer.listen(0, resolve));
    const { port } = readServer.address() as AddressInfo;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/stats`, {
        headers: { Authorization: "Bearer read-only" },
      });
      assert.equal(res.status, 200);
    } finally {
      await new Promise<void>((resolve) => readServer.close(() => resolve()));
    }
  });
});

describe("REST: POST /rebuild-edges (P-MEDIUM-2)", () => {
  const TOKEN = "test-token-rebuild";
  let store: Store;
  let baseUrl: string;
  let server: ReturnType<typeof createApiServer>;
  before(async () => {
    store = new Store(":memory:");
    store.create({ title: "alpha one", body: "first note about alpha" });
    store.create({ title: "alpha two", body: "second note about alpha" });
    server = createApiServer(store, TOKEN);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });
  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  });
  const post = (body: unknown, token: string | null = TOKEN) =>
    fetch(`${baseUrl}/rebuild-edges`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });

  test("admin token rebuilds and reports counts", async () => {
    const res = await post({});
    assert.equal(res.status, 200);
    const json: any = await res.json();
    assert.ok(typeof json.created === "number");
    assert.ok(typeof json.removed === "number");
  });

  test("read-scoped token is refused (admin-only)", async () => {
    const readServer = createApiServer(store, [
      { token: "read-only", scope: "read", label: "r" },
    ]);
    await new Promise<void>((resolve) => readServer.listen(0, resolve));
    const { port } = readServer.address() as AddressInfo;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/rebuild-edges`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer read-only",
        },
        body: "{}",
      });
      assert.equal(res.status, 403);
    } finally {
      await new Promise<void>((resolve) => readServer.close(() => resolve()));
    }
  });

  test("invalid threshold -> 400, not 500", async () => {
    const res = await post({ threshold: 5 });
    assert.equal(res.status, 400);
  });

  test("requires auth", async () => {
    assert.equal((await post({}, null)).status, 401);
  });
});

describe("REST: /relevant limit validation (P-LOW-6)", () => {
  const TOKEN = "test-token-rellimit";
  let store: Store;
  let baseUrl: string;
  let server: ReturnType<typeof createApiServer>;
  before(async () => {
    store = new Store(":memory:");
    store.create({ title: "note", body: "some content here" });
    server = createApiServer(store, TOKEN);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });
  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  });
  const post = (body: unknown) =>
    fetch(`${baseUrl}/relevant`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify(body),
    });

  test("float limit -> 400", async () => {
    const res = await post({ message: "content", limit: 2.5 });
    assert.equal(res.status, 400);
    assert.match(await res.text(), /integer/);
  });

  test("string limit -> 400", async () => {
    assert.equal((await post({ message: "content", limit: "5" })).status, 400);
  });

  test("integer limit still works", async () => {
    const res = await post({ message: "content", limit: 5 });
    assert.equal(res.status, 200);
  });
});

describe("REST: GET /notes/:id?neighbors=true (P-LOW-4) + neighbor staleness (I-LOW-1)", () => {
  const TOKEN = "test-token-neighbors";
  let store: Store;
  let baseUrl: string;
  let server: ReturnType<typeof createApiServer>;
  let noteId: number;
  before(async () => {
    store = new Store(":memory:");
    const a = store.create({ title: "deploy checklist", body: "steps to deploy the api server" });
    store.create({ title: "deployment steps", body: "how to deploy the api server safely" });
    noteId = a.id;
    await store.rebuildEdgesCooperative({ threshold: 0.2 });
    server = createApiServer(store, TOKEN);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });
  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  });
  const get = (path: string) =>
    fetch(`${baseUrl}${path}`, { headers: { Authorization: `Bearer ${TOKEN}` } });

  test("neighbors=true attaches neighbors with staleness fields", async () => {
    const res = await get(`/notes/${noteId}?neighbors=true`);
    assert.equal(res.status, 200);
    const json: any = await res.json();
    assert.ok(Array.isArray(json.note.neighbors), "neighbors must be present");
    assert.ok(json.note.neighbors.length >= 1, "expected at least one neighbor");
    assert.ok(json.note.neighbors.length <= 10, "10-cap");
    for (const n of json.note.neighbors) {
      assert.equal(typeof n.stale, "boolean");
      assert.equal(typeof n.ageDays, "number");
      assert.ok(n.score <= 1 && n.score >= 0);
    }
  });

  test("neighbors absent by default", async () => {
    const res = await get(`/notes/${noteId}`);
    assert.equal(res.status, 200);
    const json: any = await res.json();
    assert.ok(!("neighbors" in json.note));
  });

  test("store-level: listNeighbors entries carry staleness", () => {
    const note = store.read(noteId, { withNeighbors: true })!;
    assert.ok(note.neighbors && note.neighbors.length >= 1);
    assert.equal(typeof note.neighbors[0].stale, "boolean");
    assert.equal(typeof note.neighbors[0].ageDays, "number");
  });
});

describe("janitor: autoConsolidateCooperative matches autoConsolidate (Y-HIGH-2)", () => {
  test("byte-identical results on a duplicate-heavy store", async () => {
    const mk = () => {
      const s = new Store(":memory:");
      for (let i = 0; i < 6; i++) {
        s.create({ title: "exact duplicate", body: "same body here" });
      }
      s.create({ title: "unique note", body: "nothing like the others" });
      return s;
    };
    const s1 = mk();
    const s2 = mk();
    try {
      const syncRes = autoConsolidate(s1);
      const coopRes = await autoConsolidateCooperative(s2);
      assert.deepEqual(
        { candidateCount: coopRes.candidateCount, merged: coopRes.merged, skipped: coopRes.skipped },
        { candidateCount: syncRes.candidateCount, merged: syncRes.merged, skipped: syncRes.skipped }
      );
    } finally {
      s1.close();
      s2.close();
    }
  });
});
