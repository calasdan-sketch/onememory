// Hardening regressions on the HTTP API: oversized bodies answer 413 (not a
// generic 500), /export is exempt from the response-size cap so a grown store
// can still be backed up, /ready reports DB health, and the audit log records
// operations WITHOUT note content.
import { test, describe, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { createApiServer } from "../src/api.js";

const TOKEN = "hardening-token";
const auth = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };

describe("API hardening", () => {
  let store: Store;
  let server: ReturnType<typeof createApiServer>;
  let base: string;

  before(async () => {
    store = new Store(":memory:");
    server = createApiServer(store, TOKEN);
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
  });

  test("GET /ready reports readiness", async () => {
    const res = await fetch(`${base}/ready`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).status, "ready");
  });

  test("a request body over 1MB is 413, not 500", async () => {
    const big = "a".repeat(1_100_000);
    const res = await fetch(`${base}/notes`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ title: "big", body: big }),
    });
    assert.equal(res.status, 413);
  });

  test("/export is not truncated by the 2MB response cap", async () => {
    // Seed > 2MB directly via the shared store (each body ~230KB, under the
    // per-note 256KB limit). A capped /export would 413 here.
    const chunk = "z".repeat(230_000);
    for (let i = 0; i < 12; i++) store.create({ title: `big-${i}`, body: chunk });

    const res = await fetch(`${base}/export`, { headers: auth });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(Array.isArray(json.notes), true);
    assert.equal(json.notes.length, 12);
  });

  test("the 2MB response cap still fires on normal routes (not just exempt /export)", async () => {
    // Seed > 2MB in its own namespace, then request it all in one page. A normal
    // route must 413 -- proving the cap exemption is scoped to /export only and
    // the cap isn't globally disabled. (Genuinely large, so it would NOT pass if
    // the cap were removed.)
    const chunk = "y".repeat(230_000);
    for (let i = 0; i < 12; i++) {
      store.create({ namespace: "capns", title: `cap-${i}`, body: chunk });
    }
    const res = await fetch(`${base}/notes?namespace=capns&limit=500`, { headers: auth });
    assert.equal(res.status, 413);
  });
});

describe("audit log records operations but not note content", () => {
  let dir: string;
  let logPath: string;
  const SAVE = process.env.ONEMEMORY_AUDIT_LOG;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "onememory-audit-"));
    logPath = join(dir, "audit.log");
    process.env.ONEMEMORY_AUDIT_LOG = logPath;
  });
  afterEach(() => {
    /* keep the log across the describe's single test */
  });
  after(() => {
    if (SAVE === undefined) delete process.env.ONEMEMORY_AUDIT_LOG;
    else process.env.ONEMEMORY_AUDIT_LOG = SAVE;
    rmSync(dir, { recursive: true, force: true });
  });

  test("create/update/delete are logged, body text is not", () => {
    const store = new Store(":memory:");
    const marker = "SUPER-SECRET-BODY-MARKER-9f3a";
    const note = store.create({ title: "titled", body: marker });
    store.update(note.id, { body: marker + "-updated" });
    store.delete(note.id);
    store.close();

    assert.equal(existsSync(logPath), true);
    const log = readFileSync(logPath, "utf8");
    assert.match(log, /"op":"create"/);
    assert.match(log, /"op":"update"/);
    assert.match(log, /"op":"delete"/);
    // The note body must never appear in the audit trail.
    assert.equal(log.includes(marker), false);
  });
});
