import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { IncomingMessage } from "node:http";
import { Store } from "../src/store.js";
import { createApiServer } from "../src/api.js";
import { authenticate, scopeAllows } from "../src/security.js";
import type { TokenEntry } from "../src/config.js";

describe("scope helpers", () => {
  test("scopeAllows respects the read < write < admin order", () => {
    assert.equal(scopeAllows("read", "read"), true);
    assert.equal(scopeAllows("read", "write"), false);
    assert.equal(scopeAllows("read", "admin"), false);
    assert.equal(scopeAllows("write", "read"), true);
    assert.equal(scopeAllows("write", "write"), true);
    assert.equal(scopeAllows("write", "admin"), false);
    assert.equal(scopeAllows("admin", "admin"), true);
  });

  test("authenticate returns the matched token's scope, or null", () => {
    const tokens: TokenEntry[] = [
      { token: "AAA", scope: "admin", label: "primary" },
      { token: "RRR", scope: "read", label: "reader" },
    ];
    const req = (auth?: string): IncomingMessage =>
      ({ headers: auth ? { authorization: auth } : {} }) as unknown as IncomingMessage;
    assert.equal(authenticate(req("Bearer AAA"), tokens), "admin");
    assert.equal(authenticate(req("Bearer RRR"), tokens), "read");
    assert.equal(authenticate(req("Bearer nope"), tokens), null);
    assert.equal(authenticate(req(), tokens), null);
  });
});

describe("HTTP API scope enforcement", () => {
  let store: Store;
  let baseUrl: string;
  let server: ReturnType<typeof createApiServer>;
  const READ = "read-token-xyz";
  const WRITE = "write-token-xyz";
  const ADMIN = "admin-token-xyz";

  before(async () => {
    store = new Store(":memory:");
    store.create({ title: "seed" });
    server = createApiServer(store, [
      { token: READ, scope: "read", label: "r" },
      { token: WRITE, scope: "write", label: "w" },
      { token: ADMIN, scope: "admin", label: "a" },
    ]);
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

  test("read token can read but not write or delete", async () => {
    assert.equal((await call(READ, "GET", "/notes")).status, 200);
    assert.equal((await call(READ, "GET", "/search?q=seed")).status, 200);
    assert.equal((await call(READ, "POST", "/notes", { title: "x" })).status, 403);
    assert.equal((await call(READ, "PUT", "/notes/1", { title: "y" })).status, 403);
    assert.equal((await call(READ, "DELETE", "/notes/1")).status, 403);
  });

  test("write token can write but not delete or import", async () => {
    assert.equal((await call(WRITE, "POST", "/notes", { title: "w1" })).status, 201);
    assert.equal((await call(WRITE, "DELETE", "/notes/1")).status, 403);
    assert.equal((await call(WRITE, "POST", "/import", { notes: [] })).status, 403);
  });

  test("admin token can delete and import", async () => {
    const created = await (await call(ADMIN, "POST", "/notes", { title: "to-delete" })).json();
    assert.equal((await call(ADMIN, "DELETE", `/notes/${created.note.id}`)).status, 200);
    assert.equal((await call(ADMIN, "POST", "/import", { notes: [] })).status, 200);
  });

  test("an unknown token is still 401", async () => {
    assert.equal((await call("totally-wrong", "GET", "/notes")).status, 401);
  });

  test("/ready needs no auth and reports the store is reachable", async () => {
    const res = await fetch(`${baseUrl}/ready`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).status, "ready");
  });

  test("a read token cannot pull a full /export (admin only)", async () => {
    assert.equal((await call(READ, "GET", "/export")).status, 403);
    assert.equal((await call(ADMIN, "GET", "/export")).status, 200);
  });
});
