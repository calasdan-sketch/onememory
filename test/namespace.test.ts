// Server-side namespace resolution (Feature 2).
//
// Unit tests for src/namespace.ts (resolveNamespace, loadNamespaceConfig,
// canRead, validateSpacePaths, resolveStartupNamespace) plus MCP- and
// REST-level enforcement when resolution is active, and backward
// compatibility when it is not configured.
import { test, describe, before, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Store } from "../src/store.js";
import { createMcpServer } from "../src/mcp-server-core.js";
import { createApiServer } from "../src/api.js";
import {
  resolveNamespace,
  loadNamespaceConfig,
  namespaceConfigSource,
  canRead,
  readableNamespaces,
  validateSpacePaths,
  resolveStartupNamespace,
  type NamespaceConfig,
} from "../src/namespace.js";

// --- env hygiene: resolveNamespace/loadNamespaceConfig read these ---------
const ENV_KEYS = ["ONEMEMORY_SPACE", "ONEMEMORY_SPACES"] as const;
let savedEnv: Record<string, string | undefined> = {};
beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

function cfg(spaces: Record<string, string>, def = "default"): NamespaceConfig {
  return { spaces, default_namespace: def };
}

describe("resolveNamespace", () => {
  test("ONEMEMORY_SPACE override wins over everything", () => {
    const parent = join(tmpdir(), "ns-parent");
    process.env.ONEMEMORY_SPACE = "ops";
    assert.equal(
      resolveNamespace(join(parent, "sub"), cfg({ [parent]: "work" })),
      "ops"
    );
  });

  test("empty ONEMEMORY_SPACE is ignored", () => {
    process.env.ONEMEMORY_SPACE = "   ";
    const parent = join(tmpdir(), "ns-parent2");
    assert.equal(resolveNamespace(join(parent, "sub"), cfg({ [parent]: "work" })), "work");
  });

  test("longest matching prefix wins", () => {
    const parent = join(tmpdir(), "ns-a");
    const child = join(parent, "sub");
    const c = cfg({ [parent]: "parent-ns", [child]: "child-ns" });
    assert.equal(resolveNamespace(join(child, "deep"), c), "child-ns");
    assert.equal(resolveNamespace(join(parent, "other"), c), "parent-ns");
  });

  test("exact directory matches, and subdirectories inherit", () => {
    const parent = join(tmpdir(), "ns-b");
    const c = cfg({ [parent]: "parent-ns" });
    assert.equal(resolveNamespace(parent, c), "parent-ns");
    assert.equal(resolveNamespace(join(parent, "x", "y"), c), "parent-ns");
  });

  test("trailing * is accepted as explicit prefix syntax", () => {
    const parent = join(tmpdir(), "ns-c");
    const c = cfg({ [parent + "/*"]: "star-ns" });
    assert.equal(resolveNamespace(join(parent, "proj"), c), "star-ns");
    assert.equal(resolveNamespace(parent, c), "star-ns");
  });

  test("falls back to default_namespace when nothing matches", () => {
    const c = cfg({ [join(tmpdir(), "ns-does-not-match")]: "x" }, "fallback");
    assert.equal(resolveNamespace(join(tmpdir(), "elsewhere"), c), "fallback");
  });

  test("equal-depth overlap mapping to different namespaces throws", () => {
    const parent = join(tmpdir(), "ns-d");
    // "/x" and "/x/" normalize to the same depth but disagree -> ambiguous.
    const c = cfg({ [parent]: "one", [parent + "/"]: "two" });
    assert.throws(
      () => resolveNamespace(join(parent, "sub"), c),
      /namespace overlap/
    );
  });

  test("equal-depth overlap mapping to the SAME namespace is fine", () => {
    const parent = join(tmpdir(), "ns-e");
    const c = cfg({ [parent]: "same", [parent + "/"]: "same" });
    assert.equal(resolveNamespace(join(parent, "sub"), c), "same");
  });

  test("different-depth matches never count as overlap", () => {
    const parent = join(tmpdir(), "ns-f");
    const child = join(parent, "sub");
    const c = cfg({ [parent]: "p", [child]: "c" });
    assert.equal(resolveNamespace(join(child, "deep"), c), "c");
  });
});

describe("loadNamespaceConfig", () => {
  test("missing config (no env, no file) returns null", () => {
    assert.equal(namespaceConfigSource(), null);
    assert.equal(loadNamespaceConfig(), null);
  });

  test("invalid JSON returns null instead of throwing", () => {
    process.env.ONEMEMORY_SPACES = "{not json";
    assert.equal(namespaceConfigSource(), "env");
    assert.equal(loadNamespaceConfig(), null);
  });

  test("invalid shape returns null instead of throwing", () => {
    for (const bad of [
      `{"spaces": "nope", "default_namespace": "d"}`,
      `{"spaces": {}, "default_namespace": ""}`,
      `{"spaces": {}, "default_namespace": "d", "reads_from": {"a": "not-an-array"}}`,
      `[1, 2, 3]`,
    ]) {
      process.env.ONEMEMORY_SPACES = bad;
      assert.equal(loadNamespaceConfig(), null, bad);
    }
  });

  test("valid env JSON parses, with reads_from", () => {
    process.env.ONEMEMORY_SPACES = JSON.stringify({
      spaces: { "/work": "work-ns" },
      default_namespace: "default",
      reads_from: { "work-ns": ["shared"] },
    });
    const c = loadNamespaceConfig();
    assert.ok(c);
    assert.equal(c.default_namespace, "default");
    assert.deepEqual(c.spaces, { "/work": "work-ns" });
    assert.deepEqual(c.reads_from, { "work-ns": ["shared"] });
  });
});

describe("resolveStartupNamespace", () => {
  test("returns null when unconfigured (feature disabled)", () => {
    assert.equal(resolveStartupNamespace(tmpdir()), null);
  });

  test("resolves from env config and honors the override", () => {
    const parent = join(tmpdir(), "ns-startup");
    process.env.ONEMEMORY_SPACES = JSON.stringify({
      spaces: { [parent]: "work-ns" },
      default_namespace: "default",
      reads_from: { "work-ns": ["shared"] },
    });
    const r = resolveStartupNamespace(join(parent, "proj"));
    assert.ok(r);
    assert.equal(r.namespace, "work-ns");
    assert.deepEqual(r.readsFrom, { "work-ns": ["shared"] });

    process.env.ONEMEMORY_SPACE = "manual";
    assert.equal(resolveStartupNamespace(join(parent, "proj"))?.namespace, "manual");
  });
});

describe("canRead / readableNamespaces", () => {
  test("own namespace is always readable", () => {
    assert.equal(canRead(undefined, "a", "a"), true);
    assert.equal(canRead({}, "a", "a"), true);
  });

  test("granted namespaces are readable", () => {
    const grants = { "agent-a": ["shared"] };
    assert.equal(canRead(grants, "agent-a", "shared"), true);
  });

  test("grants are one-directional: reverse is not granted", () => {
    const grants = { "agent-a": ["shared"] };
    assert.equal(canRead(grants, "shared", "agent-a"), false);
  });

  test("unknown namespaces are not readable", () => {
    assert.equal(canRead({ "agent-a": ["shared"] }, "agent-a", "nope"), false);
    assert.equal(canRead(undefined, "agent-a", "shared"), false);
  });

  test("readableNamespaces lists own first, then grants, deduped", () => {
    assert.deepEqual(readableNamespaces("a", { a: ["shared", "a", "shared"] }), [
      "a",
      "shared",
    ]);
    assert.deepEqual(readableNamespaces("a", undefined), ["a"]);
  });
});

describe("validateSpacePaths", () => {
  test("reports configured paths missing from disk", () => {
    const missing = join(tmpdir(), "ns-definitely-not-here-xyz");
    const found = validateSpacePaths(
      cfg({ [tmpdir()]: "x", [missing]: "y", [join(tmpdir(), "also-missing-xyz") + "/*"]: "z" })
    );
    assert.ok(found.includes(join(tmpdir(), "also-missing-xyz")));
    assert.ok(!found.includes(tmpdir()));
    assert.equal(found.length, 2);
  });
});

// --- MCP-level enforcement -------------------------------------------------
function parseToolText(result: any): any {
  const item = result.content[0];
  assert.equal(item.type, "text");
  const text = item.text as string;
  const start = text.indexOf("{");
  return JSON.parse(start >= 0 ? text.slice(start) : text);
}

describe("MCP namespace resolution (active)", () => {
  let store: Store;
  let client: Client;
  let ownId: number;
  let sharedId: number;
  let secretId: number;

  before(async () => {
    store = new Store(":memory:");
    ownId = store.create({ namespace: "agent-a", title: "agent note", body: "zebra alpha" }).id;
    sharedId = store.create({ namespace: "shared", title: "shared note", body: "zebra beta" }).id;
    secretId = store.create({ namespace: "secret", title: "secret note", body: "zebra gamma" }).id;
    const server = createMcpServer(store, "admin", {
      namespace: "agent-a",
      readsFrom: { "agent-a": ["shared"] },
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test-client", version: "1.0.0" });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  });

  after(async () => {
    await client.close();
    store.close();
  });

  test("state_write ignores the model-supplied namespace on create", async () => {
    const result = await client.callTool({
      name: "state_write",
      arguments: { title: "sneaky", body: "x", namespace: "secret" },
    });
    const { note } = parseToolText(result);
    assert.equal(note.namespace, "agent-a");
  });

  test("state_write update drops the namespace patch and enforces own-namespace writes", async () => {
    // Same-namespace update: namespace patch ignored, edit applied.
    const okRes = await client.callTool({
      name: "state_write",
      arguments: { id: ownId, namespace: "secret", body: "zebra alpha edited" },
    });
    const { note } = parseToolText(okRes);
    assert.equal(note.namespace, "agent-a");
    assert.equal(note.body, "zebra alpha edited");

    // Cross-namespace update by id: denied.
    const denied: any = await client.callTool({
      name: "state_write",
      arguments: { id: secretId, body: "pwned" },
    });
    assert.equal(denied.isError, true);
    assert.match(parseToolText(denied).error, /no note with id/);
    assert.equal(store.read(secretId)?.body, "zebra gamma");
  });

  test("state_search with an unreadable hint searches readable namespaces only", async () => {
    const result = await client.callTool({
      name: "state_search",
      arguments: { query: "zebra", namespace: "secret" },
    });
    const { results } = parseToolText(result);
    const nss = new Set(results.map((r: any) => r.namespace));
    assert.ok(!nss.has("secret"), "unreadable hint must be ignored");
    assert.ok(nss.has("agent-a") || nss.has("shared"));
  });

  test("state_search with a readable hint restricts to it", async () => {
    const result = await client.callTool({
      name: "state_search",
      arguments: { query: "zebra", namespace: "shared" },
    });
    const { results } = parseToolText(result);
    assert.ok(results.length >= 1);
    for (const r of results) assert.equal(r.namespace, "shared");
  });

  test("state_search with no hint covers own namespace plus grants", async () => {
    const result = await client.callTool({
      name: "state_search",
      arguments: { query: "zebra" },
    });
    const { results } = parseToolText(result);
    const nss = new Set(results.map((r: any) => r.namespace));
    assert.ok(!nss.has("secret"));
    assert.ok(nss.has("shared"), "granted namespace should be searched");
  });

  test("state_list with an unreadable hint lists readable namespaces only", async () => {
    const result = await client.callTool({
      name: "state_list",
      arguments: { namespace: "secret", limit: 100 },
    });
    const { notes } = parseToolText(result);
    for (const n of notes) assert.notEqual(n.namespace, "secret");
  });

  test("state_read of an unreadable note looks missing; granted note is fine", async () => {
    const denied: any = await client.callTool({
      name: "state_read",
      arguments: { id: secretId },
    });
    assert.equal(denied.isError, true);
    assert.match(parseToolText(denied).error, /no note with id/);

    const okRes = await client.callTool({
      name: "state_read",
      arguments: { id: sharedId },
    });
    const { note } = parseToolText(okRes);
    assert.equal(note.namespace, "shared");
  });

  test("state_delete of an unreadable note looks missing", async () => {
    const denied: any = await client.callTool({
      name: "state_delete",
      arguments: { id: secretId },
    });
    assert.equal(denied.isError, true);
    assert.match(parseToolText(denied).error, /no note with id/);
    assert.ok(store.read(secretId), "note must survive a denied delete");
  });

  test("state_delete of a readable note still works", async () => {
    const scratch = store.create({ namespace: "agent-a", title: "temp", body: "bye" });
    const result = await client.callTool({
      name: "state_delete",
      arguments: { id: scratch.id },
    });
    assert.equal(parseToolText(result).deleted, scratch.id);
    assert.equal(store.read(scratch.id), null);
  });
});

describe("MCP without namespace opts (backward compatibility)", () => {
  let store: Store;
  let client: Client;

  before(async () => {
    store = new Store(":memory:");
    const server = createMcpServer(store); // no opts: legacy behavior
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test-client", version: "1.0.0" });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  });

  after(async () => {
    await client.close();
    store.close();
  });

  test("model-supplied namespace is honored when resolution is inactive", async () => {
    const result = await client.callTool({
      name: "state_write",
      arguments: { title: "legacy", body: "x", namespace: "custom" },
    });
    const { note } = parseToolText(result);
    assert.equal(note.namespace, "custom");

    const listed = await client.callTool({
      name: "state_list",
      arguments: { namespace: "custom" },
    });
    assert.equal(parseToolText(listed).notes.length, 1);

    const read = await client.callTool({
      name: "state_read",
      arguments: { id: note.id },
    });
    assert.equal(parseToolText(read).note.namespace, "custom");
  });
});

// --- REST-level enforcement ------------------------------------------------
const TOKEN = "ns-test-token";

async function startApi(store: Store, opts?: { namespace?: string; readsFrom?: Record<string, string[]> }) {
  const server = createApiServer(store, TOKEN, opts);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  const headers = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };
  return { server, base, headers };
}

describe("REST namespace resolution (active)", () => {
  let store: Store;
  let base: string;
  let headers: Record<string, string>;
  let server: ReturnType<typeof createApiServer>;
  let ownId: number;
  let secretId: number;

  before(async () => {
    store = new Store(":memory:");
    ownId = store.create({ namespace: "agent-a", title: "agent note", body: "zebra alpha" }).id;
    store.create({ namespace: "shared", title: "shared note", body: "zebra beta" });
    secretId = store.create({ namespace: "secret", title: "secret note", body: "zebra gamma" }).id;
    ({ server, base, headers } = await startApi(store, {
      namespace: "agent-a",
      readsFrom: { "agent-a": ["shared"] },
    }));
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  });

  test("POST /notes forces the server-resolved namespace", async () => {
    const res = await fetch(`${base}/notes`, {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "sneaky", namespace: "secret" }),
    });
    assert.equal(res.status, 201);
    const { note } = await res.json();
    assert.equal(note.namespace, "agent-a");
  });

  test("GET /notes/:id of an unreadable namespace looks missing", async () => {
    const denied = await fetch(`${base}/notes/${secretId}`, { headers });
    assert.equal(denied.status, 404);
    assert.match(((await denied.json()) as any).error, /not found/);

    const ok = await fetch(`${base}/notes/${ownId}`, { headers });
    assert.equal(ok.status, 200);
  });

  test("PUT /notes/:id strips namespace and enforces own-namespace writes", async () => {
    const ok = await fetch(`${base}/notes/${ownId}`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ namespace: "secret", body: "edited" }),
    });
    assert.equal(ok.status, 200);
    const { note } = await ok.json();
    assert.equal(note.namespace, "agent-a");
    assert.equal(note.body, "edited");

    const denied = await fetch(`${base}/notes/${secretId}`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ body: "pwned" }),
    });
    assert.equal(denied.status, 404);
  });

  test("DELETE /notes/:id of an unreadable namespace looks missing", async () => {
    const denied = await fetch(`${base}/notes/${secretId}`, {
      method: "DELETE",
      headers,
    });
    assert.equal(denied.status, 404);
    assert.ok(store.read(secretId));
  });

  test("GET /notes and /search treat namespace as an untrusted hint", async () => {
    const listed = await fetch(`${base}/notes?namespace=secret&limit=100`, { headers });
    const { notes } = await listed.json();
    for (const n of notes) assert.notEqual(n.namespace, "secret");

    const searched = await fetch(`${base}/search?q=zebra&namespace=secret`, { headers });
    const { results } = await searched.json();
    for (const r of results) assert.notEqual(r.namespace, "secret");
  });
});

describe("REST without namespace opts (backward compatibility)", () => {
  let store: Store;
  let base: string;
  let headers: Record<string, string>;
  let server: ReturnType<typeof createApiServer>;

  before(async () => {
    store = new Store(":memory:");
    ({ server, base, headers } = await startApi(store)); // no opts
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  });

  test("client-supplied namespace is honored when resolution is inactive", async () => {
    const res = await fetch(`${base}/notes`, {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "legacy", namespace: "custom" }),
    });
    assert.equal(res.status, 201);
    const { note } = await res.json();
    assert.equal(note.namespace, "custom");

    const listed = await fetch(`${base}/notes?namespace=custom`, { headers });
    assert.equal(((await listed.json()) as any).notes.length, 1);
  });
});

describe("consolidate tools under namespace resolution", () => {
  let store: Store;
  let client: Client;

  const parseToolText = (result: any): any => {
    const text = result.content[0].text as string;
    const body = text.includes("SECURITY NOTICE")
      ? text.slice(text.indexOf("{"))
      : text;
    return JSON.parse(body);
  };

  before(async () => {
    store = new Store(":memory:");
    // Two near-duplicates in own namespace, two in the granted-shared one.
    store.create({ namespace: "agent-a", title: "API base URL", body: "The API base URL is https://api.example.com/v1" });
    store.create({ namespace: "agent-a", title: "API base url", body: "The API base URL is https://api.example.com/v1." });
    store.create({ namespace: "shared", title: "Shared fact one", body: "Shared fact content here for dedup testing purposes" });
    store.create({ namespace: "shared", title: "Shared fact 1", body: "Shared fact content here for dedup testing purposes!" });
    const server = createMcpServer(store, "admin", {
      namespace: "agent-a",
      readsFrom: { "agent-a": ["shared"] },
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test-client", version: "1.0.0" });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  });

  after(async () => {
    await client.close();
    store.close();
  });

  test("candidates hint for an unreadable namespace is ignored, readable ones scanned", async () => {
    const result = await client.callTool({
      name: "memory_consolidation_candidates",
      arguments: { namespace: "secret", threshold: 0.9 },
    });
    const { candidates } = parseToolText(result);
    // Both agent-a and shared pairs are in the readable set, so both surface
    // even though the hint named something unreadable.
    assert.ok(candidates.length >= 2);
  });

  test("candidates with a readable hint restricts to that namespace", async () => {
    const result = await client.callTool({
      name: "memory_consolidation_candidates",
      arguments: { namespace: "shared", threshold: 0.9 },
    });
    const { candidates } = parseToolText(result);
    assert.ok(candidates.length >= 1);
  });

  test("consolidate refuses notes outside the server's own namespace (uniform error)", async () => {
    const sharedNotes = store.list({ namespace: "shared" }).notes;
    const ids = sharedNotes.map((n) => n.id);
    const result = await client.callTool({
      name: "memory_consolidate",
      arguments: { ids, dry_run: true },
    });
    // S-LOW-2: missing, foreign, and mixed ids all collapse to the same
    // uniform "no note" error -- no distinguishable "access denied".
    assert.match(parseToolText(result).error, /no note with id/);
    assert.doesNotMatch(parseToolText(result).error, /access denied/);
  });

  test("consolidate dry_run works for own-namespace notes", async () => {
    const ownNotes = store.list({ namespace: "agent-a" }).notes;
    const ids = ownNotes.map((n) => n.id);
    const result = await client.callTool({
      name: "memory_consolidate",
      arguments: { ids, dry_run: true },
    });
    const parsed = parseToolText(result);
    assert.equal(parsed.dry_run, true);
    assert.ok(parsed.would_create);
  });
});
