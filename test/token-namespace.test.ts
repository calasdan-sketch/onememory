// Per-token namespace isolation: the feature that makes ONE shared bridge
// safe for several agents.
//
// Before this, `namespace` was a per-PROCESS constant resolved once from the
// server's cwd, so every token hitting a shared server saw the same
// namespace. Scoped tokens gated ACTIONS (read/write/admin) but never WHICH
// namespace -- which is exactly the "shared memory every agent can read"
// hole. These tests pin a namespace to a token and prove the boundary holds,
// including under concurrent requests (the failure mode that would silently
// leak one agent's notes into another's response).
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { Store } from "../src/store.js";
import { createApiServer } from "../src/api.js";
import { resolveRequestNamespace, NS_DISABLED, readableIn, ctxCanRead } from "../src/namespace.js";
import { authenticateEntry, authenticate } from "../src/security.js";
import type { TokenEntry } from "../src/config.js";
import type { IncomingMessage } from "node:http";

const WORK = "tok-work-xyz";
const PERSONAL = "tok-personal-xyz";
const FREE = "tok-free-xyz"; // no pin
const ADMIN = "tok-admin-xyz"; // no pin, admin
const WORK_ADMIN = "tok-work-admin-xyz"; // pinned to work, admin scope

const TOKENS: TokenEntry[] = [
  { token: WORK, scope: "write", label: "work-agent", namespace: "work" },
  { token: PERSONAL, scope: "write", label: "personal-agent", namespace: "personal" },
  { token: FREE, scope: "write", label: "free-agent" },
  { token: ADMIN, scope: "admin", label: "operator" },
  { token: WORK_ADMIN, scope: "admin", label: "work-admin", namespace: "work" },
];

describe("resolveRequestNamespace(): precedence", () => {
  const server = { namespace: "server-ns", readsFrom: { "server-ns": ["shared"] } };

  test("a token pin WINS over the server's namespace", () => {
    const ctx = resolveRequestNamespace("work", server);
    assert.equal(ctx.active, true);
    assert.equal(ctx.ownNamespace, "work", "token pin must override the server namespace");
  });

  test("an unpinned token inherits the server namespace (backward compat)", () => {
    const ctx = resolveRequestNamespace(undefined, server);
    assert.equal(ctx.active, true);
    assert.equal(ctx.ownNamespace, "server-ns");
  });

  test("a pin on a server with NO namespace still activates isolation", () => {
    const ctx = resolveRequestNamespace("work", null);
    assert.equal(ctx.active, true);
    assert.equal(ctx.ownNamespace, "work");
  });

  test("no pin + no server namespace = disabled (legacy permissive)", () => {
    const ctx = resolveRequestNamespace(undefined, null);
    assert.equal(ctx, NS_DISABLED);
    assert.equal(ctx.active, false);
  });

  test("grants come from the SERVER config, never the token", () => {
    // A token pinned to "work" picks up the operator's grants FOR "work" --
    // it cannot supply its own.
    const ctx = resolveRequestNamespace("work", server);
    assert.deepEqual(ctx.readsFrom, { "server-ns": ["shared"] });
    // "work" has no grants configured, so it reads only itself.
    assert.deepEqual(readableIn(ctx), ["work"]);
    assert.equal(ctxCanRead(ctx, "personal"), false, "a pin must not grant extra reads");
  });

  test("whitespace-only / empty pins are treated as no pin", () => {
    assert.equal(resolveRequestNamespace("   ", server).ownNamespace, "server-ns");
    assert.equal(resolveRequestNamespace("", server).ownNamespace, "server-ns");
  });

  test("a pinned token DOES inherit the operator's grant for its namespace", () => {
    const g = { work: ["shared"] } as Record<string, string[]>;
    const ctx = resolveRequestNamespace("work", { namespace: "server-ns", readsFrom: g });
    assert.deepEqual(readableIn(ctx), ["work", "shared"]);
    assert.equal(ctxCanRead(ctx, "shared"), true);
  });
});

describe("authenticateEntry()", () => {
  const req = (auth?: string): IncomingMessage =>
    ({ headers: auth ? { authorization: auth } : {} }) as unknown as IncomingMessage;

  test("returns the full entry including the namespace pin", () => {
    const e = authenticateEntry(req(`Bearer ${WORK}`), TOKENS);
    assert.equal(e?.namespace, "work");
    assert.equal(e?.scope, "write");
  });

  test("authenticate() still returns just the scope (backward compat)", () => {
    assert.equal(authenticate(req(`Bearer ${WORK}`), TOKENS), "write");
    assert.equal(authenticate(req(`Bearer nope`), TOKENS), null);
  });

  test("an unpinned entry has no namespace", () => {
    assert.equal(authenticateEntry(req(`Bearer ${ADMIN}`), TOKENS)?.namespace, undefined);
  });
});

describe("REST API: per-token namespace isolation", () => {
  let store: Store;
  let server: ReturnType<typeof createApiServer>;
  let baseUrl: string;

  before(async () => {
    store = new Store(":memory:");
    // NO server-level namespace: isolation must come from the tokens alone.
    server = createApiServer(store, TOKENS);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  });

  const call = (token: string, method: string, path: string, body?: unknown) =>
    fetch(`${baseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });

  test("each pinned token writes into its OWN namespace", async () => {
    const w = await call(WORK, "POST", "/notes", { title: "work note", body: "w" });
    assert.equal(w.status, 201);
    const wn = (await w.json()).note;
    assert.equal(wn.namespace, "work", "work token must write to 'work'");

    const p = await call(PERSONAL, "POST", "/notes", { title: "personal note", body: "p" });
    assert.equal(p.status, 201);
    const pn = (await p.json()).note;
    assert.equal(pn.namespace, "personal", "personal token must write to 'personal'");
  });

  test("a pinned token cannot read another namespace's note (404, not 403)", async () => {
    // Find the personal note's id from the personal token's own view.
    const list = await (await call(PERSONAL, "GET", "/notes")).json();
    const personalNote = list.notes.find((n: { title: string }) => n.title === "personal note");
    assert.ok(personalNote, "personal token sees its own note");

    // The work token must NOT be able to read it -- and 404 (not 403) so the
    // id can't be used as an existence oracle across namespaces.
    const res = await call(WORK, "GET", `/notes/${personalNote.id}`);
    assert.equal(res.status, 404, "cross-namespace read must 404");
  });

  test("a pinned token's list/search only sees its own namespace", async () => {
    const list = await (await call(WORK, "GET", "/notes")).json();
    assert.ok(list.notes.length > 0);
    for (const n of list.notes) assert.equal(n.namespace, "work");

    const search = await (await call(WORK, "GET", "/search?q=note")).json();
    for (const n of search.results) assert.equal(n.namespace, "work");
  });

  test("a pinned token cannot write to or delete another namespace's note", async () => {
    const list = await (await call(PERSONAL, "GET", "/notes")).json();
    const personalNote = list.notes.find((n: { title: string }) => n.title === "personal note");

    // Cross-namespace PUT 404s: the write reaches the namespace gate, and a
    // note in another namespace is reported absent (not forbidden) so the id
    // can't be used as an existence oracle.
    assert.equal((await call(WORK, "PUT", `/notes/${personalNote.id}`, { title: "hijack" })).status, 404);

    // A WRITE-scoped token is rejected with 403 for DELETE at the SCOPE gate
    // (delete requires admin) -- before namespace is even considered. That is
    // correct and worth pinning down: scope is checked first.
    assert.equal((await call(WORK, "DELETE", `/notes/${personalNote.id}`)).status, 403);

    // An ADMIN token that is PINNED to "work" clears the scope gate but is
    // still confined by the namespace gate -> 404. This is the real proof
    // that a pin constrains even a privileged token.
    assert.equal(
      (await call(WORK_ADMIN, "DELETE", `/notes/${personalNote.id}`)).status,
      404,
      "an admin token pinned to another namespace must not delete across it"
    );

    // Still there, unharmed, from the owner's view.
    const after = await (await call(PERSONAL, "GET", `/notes/${personalNote.id}`)).json();
    assert.equal(after.note.title, "personal note", "note must be untouched");
  });

  test("a client-supplied namespace hint is untrusted (forced to the token's ns)", async () => {
    // The work token tries to plant a note into "personal".
    const res = await call(WORK, "POST", "/notes", { title: "spoof", namespace: "personal" });
    assert.equal(res.status, 201);
    const note = (await res.json()).note;
    assert.equal(note.namespace, "work", "client-supplied namespace must be overridden");

    // And tries to search "personal" -- silently falls back to its own.
    const search = await (await call(WORK, "GET", "/search?q=spoof&namespace=personal")).json();
    assert.deepEqual(search.searchedNamespaces, ["work"]);
  });

  test("an UNPINNED token is not confined (legacy behavior preserved)", async () => {
    // The free token has no pin and the server has no namespace, so it sees
    // everything -- exactly as before this feature existed.
    const list = await (await call(FREE, "GET", "/notes")).json();
    const namespaces = new Set(list.notes.map((n: { namespace: string }) => n.namespace));
    assert.ok(namespaces.has("work") && namespaces.has("personal"), "unpinned token sees all");
  });

  test("the unpinned ADMIN token can read across namespaces (operator escape hatch)", async () => {
    const list = await (await call(ADMIN, "GET", "/notes")).json();
    const namespaces = new Set(list.notes.map((n: { namespace: string }) => n.namespace));
    assert.ok(namespaces.has("work") && namespaces.has("personal"));
  });
});

describe("REST API: pin beats an existing server namespace", () => {
  let store: Store;
  let server: ReturnType<typeof createApiServer>;
  let baseUrl: string;

  before(async () => {
    store = new Store(":memory:");
    // Server resolved to "server-ns" from its cwd -- but the token is pinned
    // elsewhere. The PIN must win, per-request.
    server = createApiServer(store, TOKENS, { namespace: "server-ns" });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  });

  const call = (token: string, method: string, path: string, body?: unknown) =>
    fetch(`${baseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });

  test("a pinned token overrides the server's own namespace", async () => {
    const res = await call(WORK, "POST", "/notes", { title: "pinned", body: "x" });
    const note = (await res.json()).note;
    assert.equal(note.namespace, "work", "token pin must beat the server namespace");
  });

  test("an unpinned token still uses the server's namespace", async () => {
    const res = await call(FREE, "POST", "/notes", { title: "unpinned", body: "x" });
    const note = (await res.json()).note;
    assert.equal(note.namespace, "server-ns");
  });

  test("the two are isolated from each other", async () => {
    const list = await (await call(WORK, "GET", "/notes")).json();
    for (const n of list.notes) assert.equal(n.namespace, "work");
  });
});

describe("REST API: isolation holds under CONCURRENT requests", () => {
  let store: Store;
  let server: ReturnType<typeof createApiServer>;
  let baseUrl: string;

  before(async () => {
    store = new Store(":memory:");
    server = createApiServer(store, TOKENS);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  });

  test("interleaved writes from two pinned tokens never cross namespaces", async () => {
    // This is the regression test for a real bug: the namespace context was
    // initially a factory-scoped `let` mutated per request. Because handlers
    // `await` mid-request (readBody), an interleaved request would clobber
    // the context before the earlier request's gate read it -- leaking one
    // token's namespace into another's write. Firing many concurrent posts
    // with large-ish bodies (widening the await window) and asserting every
    // result landed in its owner's namespace.
    const pad = "x".repeat(20_000); // widen the readBody await window
    const ops: Array<Promise<{ token: string; namespace: string }>> = [];
    for (let i = 0; i < 24; i++) {
      const tok = i % 2 === 0 ? WORK : PERSONAL;
      const expectNs = i % 2 === 0 ? "work" : "personal";
      ops.push(
        fetch(`${baseUrl}/notes`, {
          method: "POST",
          headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
          body: JSON.stringify({ title: `conc-${i}`, body: pad }),
        }).then(async (r) => {
          assert.equal(r.status, 201);
          return { token: tok, namespace: (await r.json()).note.namespace as string };
        })
      );
    }
    const results = await Promise.all(ops);
    for (const r of results) {
      const expected = r.token === WORK ? "work" : "personal";
      assert.equal(
        r.namespace,
        expected,
        `a request for ${expected} leaked into "${r.namespace}" under concurrency`
      );
    }
  });

  test("interleaved cross-namespace reads never leak", async () => {
    // Seed one note per namespace, then hammer concurrent reads with each
    // token, asserting no response ever contains the other's note.
    const w = await (await fetch(`${baseUrl}/notes`, {
      method: "POST",
      headers: { Authorization: `Bearer ${WORK}`, "Content-Type": "application/json" },
      body: JSON.stringify({ title: "w-secret", body: "alpha" }),
    })).json();
    const p = await (await fetch(`${baseUrl}/notes`, {
      method: "POST",
      headers: { Authorization: `Bearer ${PERSONAL}`, "Content-Type": "application/json" },
      body: JSON.stringify({ title: "p-secret", body: "beta" }),
    })).json();

    const reads: Array<Promise<void>> = [];
    for (let i = 0; i < 20; i++) {
      reads.push(
        fetch(`${baseUrl}/notes/${p.note.id}`, {
          headers: { Authorization: `Bearer ${WORK}` },
        }).then(async (r) => {
          assert.equal(r.status, 404, "work token must never read the personal note");
        })
      );
      reads.push(
        fetch(`${baseUrl}/notes/${w.note.id}`, {
          headers: { Authorization: `Bearer ${PERSONAL}` },
        }).then(async (r) => {
          assert.equal(r.status, 404, "personal token must never read the work note");
        })
      );
    }
    await Promise.all(reads);
  });
});
