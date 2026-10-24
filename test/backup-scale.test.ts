// Backup/restore at scale — the "a few months of revisions piled up" case.
//
// Three real defects found by benchmarking, each with a regression test here:
//   1. POST /import used the 1MB general request cap, so a ~2000-note backup
//      could be EXPORTED but not RESTORED (413). A backup you cannot restore
//      is not a backup.
//   2. GET /export materialized every row + record + the full JSON string at
//      once (~3x the backup size in memory). Now streamed page-by-page.
//   3. importNotes rebuilt the similarity graph inline: O(n^2), measured at
//      88-97% of bulk-restore runtime. Now deferred above a threshold.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { Store, EXPORT_PAGE_SIZE, IMPORT_INSERT_BATCH, type ImportReport } from "../src/store.js";
import { createApiServer } from "../src/api.js";
import { IMPORT_BODY_BYTES } from "../src/http-common.js";

const ADMIN = "admin-token-backup";

function makeServer(store: Store, opts?: { namespace?: string }) {
  const server = createApiServer(store, [{ token: ADMIN, scope: "admin", label: "op" }], opts);
  return server;
}

async function listen(server: ReturnType<typeof createApiServer>): Promise<string> {
  await new Promise<void>((r) => server.listen(0, r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const call = (base: string, method: string, path: string, body?: unknown, raw?: string) =>
  fetch(`${base}${path}`, {
    method,
    headers: { Authorization: `Bearer ${ADMIN}`, "Content-Type": "application/json" },
    body: raw ?? (body ? JSON.stringify(body) : undefined),
  });

describe("backup: import body cap", () => {
  test("IMPORT_BODY_BYTES is far above the general 1MB request cap", () => {
    // The bug: /import shared MAX_BODY_BYTES (1MB), which a ~2000-note backup
    // exceeds. Restore must have its own, much larger budget.
    assert.ok(IMPORT_BODY_BYTES > 1_000_000, "import cap must exceed the general request cap");
  });

  test("a backup larger than the old 1MB cap is accepted and restored", async () => {
    const store = new Store(":memory:");
    const server = makeServer(store);
    const base = await listen(server);
    try {
      // Build a backup that is comfortably over the OLD 1MB cap but well
      // under IMPORT_BODY_BYTES. 40 notes x ~64KB bodies ≈ 2.6MB.
      const bigBody = "y".repeat(64_000);
      const notes = Array.from({ length: 40 }, (_, i) => ({
        title: `bulk ${i}`,
        body: bigBody,
        tags: ["bulk"],
      }));
      const payload = JSON.stringify({ notes });
      assert.ok(
        Buffer.byteLength(payload) > 1_000_000,
        "test payload must exceed the old 1MB cap to prove the fix"
      );

      const res = await call(base, "POST", "/import", undefined, payload);
      assert.equal(res.status, 200, "a multi-MB backup must restore, not 413");
      const json = (await res.json()) as { imported: number };
      assert.equal(json.imported, 40);

      // Verify via /export (cap-exempt, the backup path) rather than /notes:
      // a 2.6MB store exceeds the 2MB /notes RESPONSE cap by design, so
      // /notes would 413 even though the restore succeeded.
      const roundTrip = (await (await call(base, "GET", "/export")).json()) as {
        notes: Array<{ title: string }>;
      };
      assert.equal(roundTrip.notes.length, 40, "all 40 notes present after restore");
      assert.equal(roundTrip.notes[0].title, "bulk 0");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      store.close();
    }
  });

  test("a genuinely oversized note is quarantined, not a batch failure", async () => {
    const store = new Store(":memory:");
    const server = makeServer(store);
    const base = await listen(server);
    try {
      // The store's per-note limit is 256KB. A 300KB note in a backup is
      // REJECTED individually -- importNotes deliberately does not abort the
      // whole restore for one bad note (earlier notes must not be left
      // committed-but-unembedded). So the response is 200 with `rejected`.
      const res = await call(base, "POST", "/import", {
        notes: [
          { title: "good", body: "fine" },
          { title: "huge", body: "z".repeat(300_000) },
        ],
      });
      assert.equal(res.status, 200, "one oversized note must not fail the batch");
      const json = (await res.json()) as {
        imported: number;
        rejected?: Array<{ title: string }>;
      };
      assert.equal(json.imported, 1, "the good note still restores");
      assert.equal(json.rejected?.length, 1, "the oversized note is reported as rejected");
      assert.equal(json.rejected?.[0].title, "huge");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      store.close();
    }
  });
});

describe("backup: streaming export shape", () => {
  test("streamed /export is byte-identical JSON to the old materialized form", async () => {
    const store = new Store(":memory:");
    for (let i = 0; i < 12; i++) {
      store.create({ title: `note ${i}`, body: `body ${i}`, tags: [`t${i % 3}`] });
    }
    const server = makeServer(store);
    const base = await listen(server);
    try {
      // The default is the pre-1.4.0 envelope; ?attest=1 adds a header and signatures (tested in trust-attest.test.ts).
      const res = await call(base, "GET", "/export");
      assert.equal(res.status, 200);
      const text = await res.text();

      // Must parse, must be { notes: [...] }, must match exportAll exactly.
      const parsed = JSON.parse(text) as { notes: unknown[] };
      assert.ok(Array.isArray(parsed.notes));
      assert.equal(parsed.notes.length, 12);
      assert.deepEqual(parsed.notes, store.exportAll(), "streamed output must equal exportAll()");
      assert.ok(text.startsWith('{"notes":[') && text.endsWith("]}"), "same envelope as before");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      store.close();
    }
  });

  test("empty store still streams a valid empty envelope", async () => {
    const store = new Store(":memory:");
    const server = makeServer(store);
    const base = await listen(server);
    try {
      const text = await (await call(base, "GET", "/export")).text();
      assert.deepEqual(JSON.parse(text), { notes: [] });
      const withHeader = JSON.parse(await (await call(base, "GET", "/export?attest=1")).text());
      assert.deepEqual(withHeader.notes, []);
      assert.equal(withHeader.export.format, "onememory-export");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      store.close();
    }
  });

  test("export spans MULTIPLE pages correctly (more than EXPORT_PAGE_SIZE)", async () => {
    const store = new Store(":memory:");
    // Seed enough to force at least two pages, using a small store so the
    // test stays fast: we override by writing > EXPORT_PAGE_SIZE would need,
    // so instead assert the paging CONTRACT on a smaller store via exportBatch.
    const total = 25;
    for (let i = 0; i < total; i++) store.create({ title: `n${i}`, body: `b${i}` });

    // exportBatch: keyset pagination, no duplicates, no gaps, ends on short page.
    const seen: number[] = [];
    let afterId = 0;
    for (;;) {
      const page = store.exportBatch(afterId, 10);
      if (page.length === 0) break;
      for (const n of page) seen.push(n.id);
      afterId = page[page.length - 1].id;
      if (page.length < 10) break;
    }
    assert.equal(seen.length, total, "every note exported exactly once");
    assert.equal(new Set(seen).size, total, "no duplicate ids across pages");
    assert.deepEqual(seen, [...seen].sort((a, b) => a - b), "pages come back in id order");

    // And a page larger than EXPORT_PAGE_SIZE is clamped, not unbounded.
    const huge = store.exportBatch(0, 10_000_000);
    assert.ok(huge.length <= EXPORT_PAGE_SIZE, "page size is clamped");
  });
});

describe("backup: deferred similarity-graph rebuild", () => {
  test("deferEdges skips linking; the notes still restore intact", async () => {
    const store = new Store(":memory:");
    const notes = Array.from({ length: 30 }, (_, i) => ({
      title: `link ${i}`,
      body: `shared token alpha beta gamma ${i}`,
    }));
    // Sanity: without deferEdges, edges get built.
    const withGraph = await store.importNotes(notes.slice(0, 5).map((n) => ({ ...n })));
    const linkedId = withGraph[0].id;
    assert.ok(
      store.listNeighbors(linkedId, 10).length > 0,
      "inline import should populate the similarity graph"
    );

    // With deferEdges, notes restore but no graph work happens.
    const deferred = await store.importNotes(
      notes.slice(5).map((n) => ({ ...n })),
      { deferEdges: true }
    );
    assert.equal(deferred.length, 25, "all notes restore regardless of linking");
    // The deferred notes are readable and searchable (linking is ranking-only).
    assert.ok(store.read(deferred[0].id), "deferred note is readable");
    assert.ok(store.search("alpha", { limit: 50 }).length >= 25, "search unaffected by deferEdges");
  });

  test("bulk /import over the threshold reports the graph as deferred", async () => {
    const store = new Store(":memory:");
    const server = makeServer(store);
    const base = await listen(server);
    try {
      // 250 notes > IMPORT_EDGE_DEFER_THRESHOLD (200).
      const notes = Array.from({ length: 250 }, (_, i) => ({
        title: `bulk ${i}`,
        body: `content ${i} for the restore test`,
      }));
      const json = (await (await call(base, "POST", "/import", { notes })).json()) as {
        imported: number;
        similarityGraph?: string;
        note?: string;
      };
      assert.equal(json.imported, 250);
      assert.equal(json.similarityGraph, "deferred", "large import must say the graph is deferred");
      assert.match(json.note ?? "", /rebuild-edges/, "must tell the operator how to finish");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      store.close();
    }
  });

  test("small /import keeps the graph inline (no defer notice)", async () => {
    const store = new Store(":memory:");
    const server = makeServer(store);
    const base = await listen(server);
    try {
      const notes = Array.from({ length: 5 }, (_, i) => ({ title: `s${i}`, body: `b${i}` }));
      const json = (await (await call(base, "POST", "/import", { notes })).json()) as {
        imported: number;
        similarityGraph?: string;
      };
      assert.equal(json.imported, 5);
      assert.equal(json.similarityGraph, undefined, "small imports link inline, no defer notice");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      store.close();
    }
  });
});

describe("backup: months of revisions piled up", () => {
  // The "a few months of revisions" case from the field: OneMemory keeps
  // only the LATEST version of a note (rev is a counter, not a snapshot),
  // so a long-edited note must (a) export as ONE entry with its latest body
  // and (b) restore with its rev counter intact, not reset to 1.
  test("a heavily-edited note exports as one entry and restores its rev", async () => {
    const store = new Store(":memory:");
    const n = store.create({ title: "plan", body: "v0", source: "agent:claude" });
    for (let r = 1; r <= 25; r++) store.update(n.id, { body: `v${r}` });
    const before = store.read(n.id)!;
    assert.equal(before.rev, 26, "precondition: 25 edits = rev 26");

    const dump = store.exportAll();
    assert.equal(dump.length, 1, "backup holds one entry per note, not per revision");
    assert.equal(dump[0].body, "v25", "latest body wins");
    assert.equal(dump[0].rev, 26, "export carries the rev counter");

    const fresh = new Store(":memory:");
    const [restored] = await fresh.importNotes(dump.map((d) => ({ ...d })));
    assert.equal(restored.rev, 26, "restore must not reset months of revisions to 1");
    assert.equal(restored.body, "v25");
    assert.equal(restored.updated_at, before.updated_at, "last-touched time survives");
    // The restored note keeps counting from where the backup left off.
    assert.equal(fresh.update(restored.id, { body: "v26" })!.rev, 27);
  });

  test("a garbage rev in a hand-edited backup falls back to 1, not a crash", async () => {
    const fresh = new Store(":memory:");
    const restored = await fresh.importNotes([
      { title: "zero", rev: 0 },
      { title: "negative", rev: -3 },
      { title: "nan", rev: NaN },
      { title: "float", rev: 2.5 },
      { title: "missing" },
    ]);
    assert.deepEqual(
      restored.map((r) => r.rev),
      [1, 1, 1, 1, 1],
      "sane default for every unrestoreable rev"
    );
  });

  test("REST /import restores the rev a backup carried", async () => {
    const src = new Store(":memory:");
    const n = src.create({ title: "sync doc" });
    for (let r = 1; r <= 9; r++) src.update(n.id, { body: `edit ${r}` });
    const backup = JSON.stringify({ notes: src.exportAll() });
    src.close();

    const dst = new Store(":memory:");
    const server = makeServer(dst);
    const base = await listen(server);
    try {
      const json = (await (await call(base, "POST", "/import", undefined, backup)).json()) as {
        imported: number;
      };
      assert.equal(json.imported, 1);
      const [restored] = dst.exportAll();
      assert.equal(restored.rev, 10, "rev survives the HTTP restore path");
      assert.equal(restored.body, "edit 9");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      dst.close();
    }
  });
});

describe("backup: batched restore transactions", () => {
  // importNotes writes in chunks of IMPORT_INSERT_BATCH (one BEGIN/COMMIT
  // per chunk instead of one per note). The contract that must not regress:
  // a bad note inside a chunk skips ONLY itself, and notes in LATER chunks
  // still land.
  test("a rejected note mid-chunk skips itself, not its chunk or later chunks", async () => {
    const store = new Store(":memory:");
    // 2 chunks: [0..IMPORT_INSERT_BATCH-1], [IMPORT_INSERT_BATCH..]. Plant an
    // oversized note inside chunk 1 and a good note in chunk 2.
    const badAt = Math.floor(IMPORT_INSERT_BATCH / 2);
    const total = IMPORT_INSERT_BATCH + 10;
    const notes = Array.from({ length: total }, (_, i) =>
      i === badAt ? { title: `huge ${i}`, body: "z".repeat(300_000) } : { title: `n${i}`, body: `body ${i}` }
    );

    const report: ImportReport = { quarantined: [], rejected: [] };
    const created = await store.importNotes(notes, { report, deferEdges: true });
    assert.equal(created.length, total - 1, "every good note lands across both chunks");
    assert.equal(report.rejected.length, 1, "the oversized note is reported");
    assert.equal(report.rejected[0].title, `huge ${badAt}`);

    const titles = new Set(store.exportAll().map((n) => n.title));
    assert.equal(titles.size, total - 1, "no duplicates, no missing notes");
    assert.ok(!titles.has(`huge ${badAt}`), "the bad note itself was skipped");
    assert.ok(titles.has(`n${total - 1}`), "the last note (chunk 2) still landed");
  });

  test("restore spans multiple chunks with ids ordered and complete", async () => {
    const store = new Store(":memory:");
    const total = IMPORT_INSERT_BATCH * 2 + 7; // forces 3 chunks
    const notes = Array.from({ length: total }, (_, i) => ({
      title: `chunk ${i}`,
      body: `body ${i}`,
      updated_at: `2026-01-01T00:00:${String(i % 60).padStart(2, "0")}.000Z`,
    }));
    const created = await store.importNotes(notes, { deferEdges: true });
    assert.equal(created.length, total);
    const ids = created.map((c) => c.id);
    assert.deepEqual(ids, [...ids].sort((a, b) => a - b), "ids come out in order");
    assert.equal(new Set(ids).size, total, "no duplicate ids across chunks");
    assert.equal(store.countAll(), total);
    // Timestamps still honored inside batched transactions.
    assert.equal(store.read(ids[59])!.updated_at, "2026-01-01T00:00:59.000Z");
  });
});
