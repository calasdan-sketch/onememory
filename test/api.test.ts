import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { Store } from "../src/store.js";
import { createApiServer } from "../src/api.js";

const TOKEN = "test-token-abc123";

describe("HTTP API", () => {
  let store: Store;
  let baseUrl: string;
  let server: ReturnType<typeof createApiServer>;

  before(async () => {
    store = new Store(":memory:");
    server = createApiServer(store, TOKEN);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  });

  test("GET /health requires no auth", async () => {
    const res = await fetch(`${baseUrl}/health`);
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.status, "ok");
  });

  test("every other route rejects missing bearer token", async () => {
    const routes: [string, string][] = [
      ["GET", "/notes"],
      ["GET", "/notes/1"],
      ["GET", "/search?q=x"],
      ["POST", "/notes"],
      ["PUT", "/notes/1"],
    ];
    for (const [method, path] of routes) {
      const res = await fetch(`${baseUrl}${path}`, { method });
      assert.equal(res.status, 401, `${method} ${path} should require auth`);
    }
  });

  test("wrong bearer token is rejected", async () => {
    const res = await fetch(`${baseUrl}/notes`, {
      headers: { Authorization: "Bearer wrong-token" },
    });
    assert.equal(res.status, 401);
  });

  test("malformed Authorization header is rejected", async () => {
    for (const header of ["not-bearer-format", "Bearer", "Basic abc123"]) {
      const res = await fetch(`${baseUrl}/notes`, {
        headers: { Authorization: header },
      });
      assert.equal(res.status, 401, `header "${header}" should be rejected`);
    }
  });

  const auth = { Authorization: `Bearer ${TOKEN}` };

  test("POST /notes creates a note", async () => {
    const res = await fetch(`${baseUrl}/notes`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ title: "API note", body: "hello", tags: ["t1"] }),
    });
    assert.equal(res.status, 201);
    const { note } = await res.json();
    assert.equal(note.title, "API note");
    assert.ok(note.id);
  });

  test("POST /notes without title is rejected", async () => {
    const res = await fetch(`${baseUrl}/notes`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ body: "no title here" }),
    });
    assert.equal(res.status, 400);
  });

  test("POST /notes with invalid JSON is rejected", async () => {
    const res = await fetch(`${baseUrl}/notes`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: "{not json",
    });
    assert.equal(res.status, 400);
  });

  test("GET /notes/:id reads it back", async () => {
    const create = await fetch(`${baseUrl}/notes`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Readable" }),
    });
    const { note } = await create.json();

    const res = await fetch(`${baseUrl}/notes/${note.id}`, { headers: auth });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.note.id, note.id);
  });

  test("GET /notes/:id returns 404 for missing id", async () => {
    const res = await fetch(`${baseUrl}/notes/999999`, { headers: auth });
    assert.equal(res.status, 404);
  });

  test("PUT /notes/:id updates it", async () => {
    const create = await fetch(`${baseUrl}/notes`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Before" }),
    });
    const { note } = await create.json();

    const res = await fetch(`${baseUrl}/notes/${note.id}`, {
      method: "PUT",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ title: "After" }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.note.title, "After");
  });

  test("PUT /notes/:id returns 404 for missing id", async () => {
    const res = await fetch(`${baseUrl}/notes/999999`, {
      method: "PUT",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ title: "whatever" }),
    });
    assert.equal(res.status, 404);
  });

  test("GET /notes lists with total", async () => {
    const res = await fetch(`${baseUrl}/notes`, { headers: auth });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.notes));
    assert.ok(typeof body.total === "number");
  });

  test("GET /search finds a freshly written note (no stale results)", async () => {
    const unique = `zzzneedle${Date.now()}`;
    await fetch(`${baseUrl}/notes`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Search me", body: unique }),
    });

    const res = await fetch(`${baseUrl}/search?q=${unique}`, { headers: auth });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.results.length, 1);
    assert.ok(body.results[0].body.includes(unique));
  });

  test("GET /search reflects an update, not the stale original", async () => {
    const create = await fetch(`${baseUrl}/notes`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Mutable", body: "beforeword" }),
    });
    const { note } = await create.json();

    await fetch(`${baseUrl}/notes/${note.id}`, {
      method: "PUT",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ body: "afterword" }),
    });

    const staleCheck = await fetch(`${baseUrl}/search?q=beforeword`, { headers: auth });
    const staleBody = await staleCheck.json();
    assert.equal(
      staleBody.results.find((n: any) => n.id === note.id),
      undefined,
      "search still returns pre-update content"
    );

    const freshCheck = await fetch(`${baseUrl}/search?q=afterword`, { headers: auth });
    const freshBody = await freshCheck.json();
    assert.ok(freshBody.results.some((n: any) => n.id === note.id));
  });

  test("GET /search without q is rejected", async () => {
    const res = await fetch(`${baseUrl}/search`, { headers: auth });
    assert.equal(res.status, 400);
  });

  test("unknown route returns 404", async () => {
    const res = await fetch(`${baseUrl}/nope`, { headers: auth });
    assert.equal(res.status, 404);
  });
});
