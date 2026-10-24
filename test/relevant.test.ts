// Tests for the state_relevant tool: keyword extraction, the permissive
// relevant search, the MCP tool wrapper (including Tier 1 namespace gating),
// and POST /relevant.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Store } from "../src/store.js";
import { createMcpServer } from "../src/mcp-server-core.js";
import { createApiServer } from "../src/api.js";
import { extractKeywords, MAX_KEYWORDS } from "../src/keywords.js";
import { runRelevantSearch } from "../src/search-service.js";
import { UNTRUSTED_BANNER } from "../src/security.js";

function parseToolText(result: any): any {
  const item = result.content[0];
  assert.equal(item.type, "text");
  const text = item.text as string;
  // Retrieval results are prefixed with the untrusted-data banner; strip
  // anything before the JSON payload before parsing.
  assert.ok(text.startsWith(UNTRUSTED_BANNER));
  return JSON.parse(text.slice(UNTRUSTED_BANNER.length));
}

describe("extractKeywords", () => {
  test("empty input -> empty list", () => {
    assert.deepEqual(extractKeywords(""), []);
    assert.deepEqual(extractKeywords("   "), []);
  });

  test("stop-words are removed", () => {
    const kws = extractKeywords("I was thinking about the meeting yesterday and what we decided");
    assert.deepEqual(kws, ["thinking", "meeting", "yesterday", "decided"]);
  });

  test("lowercases and strips punctuation", () => {
    // Digit carve-out (I-MEDIUM-4): "Q3" survives the short-token drop.
    assert.deepEqual(extractKeywords("Budget, INVOICES! \"Q3\""), ["budget", "invoices", "q3"]);
  });

  test("tokens shorter than 3 chars are dropped", () => {
    const kws = extractKeywords("an ox ate my pie on tv");
    assert.deepEqual(kws, ["ate", "pie"]);
  });

  test("contractions split on the apostrophe and drop the stem", () => {
    // "don't" -> "don" (stop-word) + "t" (too short)
    assert.deepEqual(extractKeywords("don't worry about it"), ["worry"]);
  });

  test("hashtags are preserved unstemmed and kept even when short", () => {
    const kws = extractKeywords("check the #status and #goal board, plus #AI updates");
    assert.ok(kws.includes("#status"), `missing #status in ${kws}`);
    assert.ok(kws.includes("#goal"), `missing #goal in ${kws}`);
    assert.ok(kws.includes("#ai"), `missing #ai in ${kws}`);
    // Hashtag bodies are not stemmed: "#statuses" stays "#statuses".
    assert.deepEqual(extractKeywords("#statuses"), ["#statuses"]);
  });

  test("hashtags are exempt from stop-word removal", () => {
    assert.deepEqual(extractKeywords("about the #the plan"), ["#the", "plan"]);
  });

  test("duplicates are removed, first-occurrence order kept", () => {
    assert.deepEqual(extractKeywords("deploy deploy DEPLOY service"), ["deploy", "service"]);
  });

  test("result is capped at MAX_KEYWORDS", () => {
    const words = Array.from({ length: 40 }, (_, i) => `keyword${i}`).join(" ");
    const kws = extractKeywords(words);
    assert.equal(kws.length, MAX_KEYWORDS);
    assert.equal(kws[0], "keyword0");
    assert.equal(kws[MAX_KEYWORDS - 1], `keyword${MAX_KEYWORDS - 1}`);
  });

  test("deterministic: same input, same output", () => {
    const msg = "Hey, what did we decide about the Acme launch timeline? #goal";
    assert.deepEqual(extractKeywords(msg), extractKeywords(msg));
  });
});

describe("runRelevantSearch", () => {
  let store: Store;

  before(() => {
    store = new Store(":memory:");
    store.create({
      title: "Sourdough starter",
      body: "Feed the starter every morning with rye flour.",
    });
    store.create({
      title: "Acme launch",
      body: "Ship the Acme integration on Thursday; marketing email goes out Wednesday.",
    });
    store.create({
      title: "Unrelated",
      body: "A note about garden gnomes and absolutely nothing else.",
    });
  });

  after(() => {
    store.close();
  });

  test("returns keywords used alongside results", async () => {
    const { keywords, results } = await runRelevantSearch(
      store,
      "what did we decide about the acme launch?"
    );
    assert.deepEqual(keywords, ["decide", "acme", "launch"]);
    assert.ok(results.length >= 1);
    assert.ok(results.some((n) => n.title === "Acme launch"));
  });

  test("permissive OR semantics: a single keyword hit qualifies", async () => {
    // "rye flour morning starter" -> only "rye"+"flour"+"morning"+"starter"
    // exist; an AND search would need a note containing all four.
    const { results } = await runRelevantSearch(store, "rye flour morning starter");
    assert.ok(results.some((n) => n.title === "Sourdough starter"));
  });

  test("notes matching more keywords rank first", async () => {
    const { results } = await runRelevantSearch(store, "acme launch thursday");
    assert.equal(results[0].title, "Acme launch");
  });

  test("empty message -> empty keywords and empty results, no throw", async () => {
    assert.deepEqual(await runRelevantSearch(store, ""), { keywords: [], results: [] });
    assert.deepEqual(await runRelevantSearch(store, "the and or"), {
      keywords: [],
      results: [],
    });
  });

  test("limit is respected", async () => {
    const { results } = await runRelevantSearch(store, "note", { limit: 1 });
    assert.ok(results.length <= 1);
  });

  test("namespace option scopes the search", async () => {
    const { results } = await runRelevantSearch(store, "gnomes", { namespace: "nope" });
    assert.deepEqual(results, []);
  });
});

describe("MCP state_relevant tool", () => {
  let store: Store;
  let client: Client;

  before(async () => {
    store = new Store(":memory:");
    store.create({
      title: "Acme launch",
      body: "Ship the Acme integration on Thursday.",
    });
    const server = createMcpServer(store);
    const [c, s] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test-client", version: "1.0.0" });
    await Promise.all([client.connect(c), server.connect(s)]);
  });

  after(async () => {
    await client.close();
    store.close();
  });

  test("returns keywords and results", async () => {
    const result: any = await client.callTool({
      name: "state_relevant",
      arguments: { message: "when do we ship the acme integration?" },
    });
    assert.ok(!result.isError);
    const out = parseToolText(result);
    assert.ok(Array.isArray(out.keywords), "keywords must be present");
    assert.ok(out.keywords.includes("acme"), `keywords: ${out.keywords}`);
    assert.ok(Array.isArray(out.results));
    assert.ok(out.results.some((n: any) => n.title === "Acme launch"));
  });

  test("empty message is an input error, not a silent empty search", async () => {
    const result: any = await client.callTool({
      name: "state_relevant",
      arguments: { message: "   " },
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /message is required/);
  });

  test("default limit is 5", async () => {
    for (let i = 0; i < 8; i++) {
      store.create({ title: `filler ${i}`, body: "filler filler filler filler filler" });
    }
    const result: any = await client.callTool({
      name: "state_relevant",
      arguments: { message: "filler" },
    });
    const out = parseToolText(result);
    assert.ok(out.results.length <= 5, `got ${out.results.length} results`);
  });
});

describe("MCP state_relevant namespace gating (Tier 1)", () => {
  let store: Store;
  let client: Client;

  before(async () => {
    store = new Store(":memory:");
    store.create({ namespace: "work", title: "Work note", body: "quarterly planning" });
    store.create({ namespace: "shared", title: "Shared note", body: "planning doc" });
    store.create({ namespace: "private", title: "Private note", body: "planning secrets" });
    // Server resolved to "work", with a one-directional grant to read "shared".
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

  test("unreadable hint falls back to the readable namespaces", async () => {
    const result: any = await client.callTool({
      name: "state_relevant",
      arguments: { message: "planning", namespace: "private" },
    });
    const out = parseToolText(result);
    const nss = out.results.map((n: any) => n.namespace);
    assert.ok(nss.includes("work"), "own namespace searched");
    assert.ok(nss.includes("shared"), "granted namespace searched");
    assert.ok(!nss.includes("private"), "unreadable hint must not be searched");
  });

  test("trusted hint to a granted namespace searches it", async () => {
    const result: any = await client.callTool({
      name: "state_relevant",
      arguments: { message: "planning", namespace: "shared" },
    });
    const out = parseToolText(result);
    assert.ok(out.results.length > 0);
    assert.ok(out.results.every((n: any) => n.namespace === "shared"));
  });
});

describe("POST /relevant", () => {
  const TOKEN = "test-token-abc123";
  let store: Store;
  let baseUrl: string;
  let server: ReturnType<typeof createApiServer>;

  before(async () => {
    store = new Store(":memory:");
    store.create({
      title: "Acme launch",
      body: "Ship the Acme integration on Thursday.",
    });
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
    fetch(`${baseUrl}/relevant`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });

  test("returns keywords and results", async () => {
    const res = await post({ message: "when do we ship the acme integration?" });
    assert.equal(res.status, 200);
    const json = (await res.json()) as { keywords: string[]; results: any[] };
    assert.ok(Array.isArray(json.keywords) && json.keywords.includes("acme"));
    assert.ok(json.results.some((n) => n.title === "Acme launch"));
  });

  test("missing message -> 400", async () => {
    const res = await post({});
    assert.equal(res.status, 400);
    assert.match((await res.text()), /message is required/);
  });

  test("invalid JSON -> 400", async () => {
    const res = await fetch(`${baseUrl}/relevant`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}` },
      body: "{not json",
    });
    assert.equal(res.status, 400);
  });

  test("requires auth", async () => {
    const res = await post({ message: "hello" }, null);
    assert.equal(res.status, 401);
  });

  test("read-scoped token may use /relevant (it is a read)", async () => {
    // Spin a second API server whose only token is read-scoped: POST
    // /relevant must succeed while POST /notes (write) must be refused.
    const readServer = createApiServer(store, [
      { token: "read-only-token", scope: "read", label: "r" },
    ]);
    await new Promise<void>((resolve) => readServer.listen(0, resolve));
    const { port } = readServer.address() as AddressInfo;
    const url = `http://127.0.0.1:${port}`;
    try {
      const rel = await fetch(`${url}/relevant`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer read-only-token",
        },
        body: JSON.stringify({ message: "acme" }),
      });
      assert.equal(rel.status, 200, "read token must be allowed POST /relevant");
      const write = await fetch(`${url}/notes`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer read-only-token",
        },
        body: JSON.stringify({ title: "nope" }),
      });
      assert.equal(write.status, 403, "read token must be refused POST /notes");
    } finally {
      await new Promise<void>((resolve) => readServer.close(() => resolve()));
    }
  });
});
