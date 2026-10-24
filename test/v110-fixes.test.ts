// v1.1.0 review fixes: regression tests, one block per finding.
//
//  1  memory_consolidation_candidates: admin scope, single-flight, deadline,
//     byte cap, abort.
//  2  planEdges() uses a cached inverted index: bounded write latency,
//     identical edge scores.
//  3  importNotes() scores only the imported notes (no full rebuild).
//  4  importNotes() keeps created_at / updated_at.
//  5  multi-namespace listing is paged in SQL (no 500-per-namespace cap).
//  6  namespace path matching is case-insensitive on win32/darwin.
//  7  doctor warns when a store has notes but no edges.
//  8  default timezone is the host's, not UTC.
//  9  ONEMEMORY_ACCESS_BOOST=0 disables the access/staleness re-rank.
// 10  rebuilds are single-flight and never re-insert a changed note's edges.
// 11  REST POST /rebuild-edges has the confirm gate + single-flight.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  Store,
  RebuildBusyError,
  REBUILD_CONFIRM_NOTE_COUNT,
  type NoteRecord,
} from "../src/store.js";
import {
  findCandidates,
  findCandidatesCooperative,
  findCandidatesGuarded,
  precomputeTfMaps,
  computeDocFreqs,
  cosineTfIdf,
  sharedTokenCount,
  MAX_CANDIDATE_BYTES,
  MIN_SHARED_TOKENS_FOR_EDGE,
} from "../src/consolidate.js";
import { createMcpServer } from "../src/mcp-server-core.js";
import { createApiServer } from "../src/api.js";
import { resolveNamespace } from "../src/namespace.js";
import { resolveTimeZone } from "../src/time-parse.js";
import { runSearch } from "../src/search-service.js";

// Deterministic pseudo-random note text over a fixed vocabulary.
function textGen(seed: number, vocab = 2000): (n: number) => string {
  const words = Array.from({ length: vocab }, (_, i) => `w${i.toString(36)}q`);
  let s = seed;
  const rnd = (): number => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
  return (n) => Array.from({ length: n }, () => words[Math.floor(rnd() * words.length)]).join(" ");
}

function record(id: number, over: Partial<NoteRecord> = {}): NoteRecord {
  return {
    id,
    namespace: "default",
    title: `note ${id}`,
    body: "",
    tags: [],
    rev: 1,
    source: "",
    written_by: "",
    created_by: "",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    access_count: 0,
    last_accessed: null,
    ...over,
  };
}

function parseToolText(result: any): any {
  const text = (result.content[0] as { text: string }).text;
  const start = text.indexOf("{");
  return JSON.parse(start >= 0 ? text.slice(start) : text);
}

async function mcpClient(
  store: Store,
  scope: "read" | "write" | "admin",
  opts: { namespace?: string; readsFrom?: Record<string, string[]> } = {}
): Promise<Client> {
  const server = createMcpServer(store, scope, opts);
  const [c, s] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await Promise.all([client.connect(c), server.connect(s)]);
  return client;
}

/** Brute-force reference for planEdges: score against the whole namespace. */
function referencePlan(
  store: Store,
  namespace: string,
  title: string,
  body: string,
  threshold: number,
  exclude: Set<number>
): Array<{ neighborId: number; score: number }> {
  const others = store
    .exportAll()
    .filter((n) => n.namespace === namespace && !exclude.has(n.id));
  const docs = [{ id: -1, title, body }, ...others];
  const tf = precomputeTfMaps(docs);
  const df = computeDocFreqs(tf.values());
  const mine = tf.get(-1)!;
  const out: Array<{ neighborId: number; score: number }> = [];
  if (mine.size === 0) return out;
  for (const o of others) {
    const fo = tf.get(o.id)!;
    if (fo.size === 0 || sharedTokenCount(mine, fo) < MIN_SHARED_TOKENS_FOR_EDGE) continue;
    const score = cosineTfIdf(mine, fo, df, docs.length);
    if (score + 1e-9 >= threshold) out.push({ neighborId: o.id, score });
  }
  return out.sort((a, b) => a.neighborId - b.neighborId);
}

describe("1: memory_consolidation_candidates is admin-only and bounded", () => {
  test("read scope is refused; admin scope works", async () => {
    const store = new Store(":memory:");
    store.create({ title: "dup", body: "same words here" });
    store.create({ title: "dup", body: "same words here" });
    const read = await mcpClient(store, "read");
    const admin = await mcpClient(store, "admin");
    try {
      const denied: any = await read.callTool({
        name: "memory_consolidation_candidates",
        arguments: {},
      });
      assert.equal(denied.isError, true);
      assert.match(denied.content[0].text, /admin/);
      const ok: any = await admin.callTool({
        name: "memory_consolidation_candidates",
        arguments: {},
      });
      assert.ok(!ok.isError);
      assert.equal(parseToolText(ok).count, 1);
    } finally {
      await read.close();
      await admin.close();
      store.close();
    }
  });

  const many = (): NoteRecord[] => {
    const gen = textGen(7);
    return Array.from({ length: 400 }, (_, i) => record(i + 1, { body: gen(20) }));
  };

  test("a scan past its deadline is abandoned", async () => {
    await assert.rejects(
      findCandidatesCooperative(many(), { deadlineMs: 1 }),
      /budget/
    );
  });

  test("an aborted signal stops the scan", async () => {
    const ac = new AbortController();
    const p = findCandidatesCooperative(many(), { signal: ac.signal });
    ac.abort();
    await assert.rejects(p, /cancelled/);
    await assert.rejects(
      findCandidatesCooperative(many(), { signal: AbortSignal.abort() }),
      /cancelled/
    );
  });

  test("guarded scans are single-flight", async () => {
    const first = findCandidatesGuarded(many());
    await assert.rejects(findCandidatesGuarded(many()), /already running/);
    await first;
    // The guard is released afterwards.
    assert.ok(Array.isArray(await findCandidatesGuarded([record(1), record(2)])));
  });

  test("the scan is capped by total text size, newest notes first", () => {
    const dupA = record(1, { body: "old duplicate body text", created_at: "2026-01-01T00:00:00.000Z" });
    const dupB = record(2, { body: "old duplicate body text", created_at: "2026-01-02T00:00:00.000Z" });
    assert.equal(findCandidates([dupA, dupB]).length, 1);
    const huge = record(3, {
      body: "x ".repeat(MAX_CANDIDATE_BYTES / 2),
      created_at: "2026-06-01T00:00:00.000Z",
    });
    // The newest note fills the budget: the old pair is out of scope.
    assert.equal(findCandidates([dupA, dupB, huge]).length, 0);
  });
});

describe("2: edge scoring uses a cached inverted index", () => {
  test("planEdges matches the brute-force namespace scan exactly", () => {
    const s = new Store(":memory:");
    const gen = textGen(11, 300);
    try {
      for (let i = 0; i < 150; i++) s.create({ title: gen(4), body: gen(25) });
      for (let i = 0; i < 20; i++) s.create({ namespace: "other", title: gen(4), body: gen(25) });
      s.update(5, { body: gen(25) });
      s.delete(9);
      for (const threshold of [0.05, 0.25]) {
        for (let k = 0; k < 10; k++) {
          const title = gen(4);
          const body = gen(25);
          const excl = new Set([3, 40]);
          const got = s.planEdges("default", title, body, threshold, excl).pairs;
          assert.deepEqual(got, referencePlan(s, "default", title, body, threshold, excl));
        }
      }
      assert.ok(
        s.planEdges("default", gen(4), gen(25), 0.01).pairs.length > 0,
        "the corpus should actually produce edges"
      );
    } finally {
      s.close();
    }
  });

  test("the index sees writes from another connection", () => {
    const dir = mkdtempSync(join(tmpdir(), "onememory-v110-idx-"));
    const a = new Store(join(dir, "t.db"));
    const b = new Store(join(dir, "t.db"));
    try {
      a.create({ title: "solar panel installers", body: "winnipeg residential quotes" });
      const probe = (): number[] =>
        a.planEdges("default", "solar panel maintenance", "winnipeg residential", 0.01).pairs
          .map((p) => p.neighborId);
      assert.equal(probe().length, 1);
      const other = b.create({ title: "solar panel cleaning", body: "residential winnipeg" });
      assert.ok(probe().includes(other.id), "a foreign create must be indexed");
      b.update(other.id, { title: "dentist", body: "thursday appointment" });
      assert.ok(!probe().includes(other.id), "a foreign update must be re-indexed");
      b.delete(1);
      assert.deepEqual(probe(), [], "a foreign delete must be dropped");
    } finally {
      a.close();
      b.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // 1.1.0-rc measured ~70-110ms per write here (whole-namespace re-select +
  // re-tokenize); the indexed path is a few ms.
  test("create/update on a 2,000-note namespace stay under 25ms", () => {
    const s = new Store(":memory:");
    const gen = textGen(3, 3000);
    try {
      for (let i = 0; i < 2000; i++) s.create({ title: gen(6), body: gen(60) }, { skipEdges: true });
      s.create({ title: gen(6), body: gen(60) }); // first write builds the index
      const median = (fn: () => void): number => {
        const ts: number[] = [];
        for (let i = 0; i < 7; i++) {
          const t0 = performance.now();
          fn();
          ts.push(performance.now() - t0);
        }
        return ts.sort((x, y) => x - y)[3];
      };
      const createMs = median(() => s.create({ title: gen(6), body: gen(60) }));
      let id = 10;
      const updateMs = median(() => s.update(id++, { body: gen(60) }));
      assert.ok(createMs < 25, `create median ${createMs.toFixed(1)}ms`);
      assert.ok(updateMs < 25, `update median ${updateMs.toFixed(1)}ms`);
    } finally {
      s.close();
    }
  });
});

describe("3/4: importNotes", () => {
  test("a 1-note import into a 2,000-note store scores only that note", async () => {
    const s = new Store(":memory:");
    const gen = textGen(5);
    try {
      for (let i = 0; i < 2000; i++) s.create({ title: gen(6), body: gen(40) }, { skipEdges: true });
      let rebuilds = 0;
      const stub = s as unknown as { rebuildEdgesCooperative: () => Promise<unknown> };
      stub.rebuildEdgesCooperative = async () => {
        rebuilds++;
        return { created: 0, removed: 0 };
      };
      const title = gen(6);
      const body = gen(40);
      const t0 = performance.now();
      const [note] = await s.importNotes([{ title, body }]);
      const ms = performance.now() - t0;
      assert.equal(rebuilds, 0, "no full rebuild");
      assert.ok(ms < 1000, `import took ${ms.toFixed(0)}ms`);
      const expected = s.planEdges(
        "default",
        title,
        body,
        s.getEdgeThreshold(),
        new Set([note.id])
      ).pairs;
      const neighbors = s.listNeighbors(note.id, 100).map((n) => n.id).sort((a, b) => a - b);
      assert.deepEqual(neighbors, expected.map((p) => p.neighborId));
    } finally {
      s.close();
    }
  });

  test("a fresh-store import builds the same graph as a full rebuild", async () => {
    const gen = textGen(9, 200);
    const notes = Array.from({ length: 80 }, (_, i) => ({
      namespace: i % 3 === 0 ? "b" : "a",
      title: gen(4),
      body: gen(20),
    }));
    const a = new Store(":memory:");
    const b = new Store(":memory:");
    try {
      await a.importNotes(notes);
      for (const n of notes) b.create(n, { skipEdges: true });
      await b.rebuildEdgesCooperative();
      // Scores may differ in the last float bits (a pair is scored from
      // either side), which can reorder exact ties: compare by id.
      const graph = (st: Store): string =>
        notes
          .map((_, i) =>
            st
              .listNeighbors(i + 1, 100)
              .sort((x, y) => x.id - y.id)
              .map((n) => `${n.id}:${n.score.toFixed(12)}`)
              .join(",")
          )
          .join("|");
      assert.ok(graph(a).length > notes.length, "the corpus should produce edges");
      assert.equal(graph(a), graph(b));
    } finally {
      a.close();
      b.close();
    }
  });

  test("created_at / updated_at survive export -> import", async () => {
    const s = new Store(":memory:");
    try {
      const [restored, junk] = await s.importNotes([
        {
          title: "old note",
          body: "from a backup",
          created_at: "2024-03-01T10:00:00.000Z",
          updated_at: "2025-02-01T12:30:00+02:00",
        },
        { title: "bad dates", created_at: "not a date", updated_at: "nope" },
      ]);
      assert.equal(restored.created_at, "2024-03-01T10:00:00.000Z");
      assert.equal(restored.updated_at, "2025-02-01T10:30:00.000Z"); // normalized to UTC ISO
      const now = Date.now();
      assert.ok(Math.abs(Date.parse(junk.created_at) - now) < 60_000);
      assert.ok(Math.abs(Date.parse(junk.updated_at) - now) < 60_000);
    } finally {
      s.close();
    }
  });
});

describe("5: multi-namespace listing is paged in SQL", () => {
  const seed = (): Store => {
    const s = new Store(":memory:");
    for (let i = 0; i < 600; i++) s.create({ namespace: "a", title: `a${i}` }, { skipEdges: true });
    for (let i = 0; i < 30; i++) s.create({ namespace: "b", title: `b${i}` }, { skipEdges: true });
    s.create({ namespace: "secret", title: "hidden" }, { skipEdges: true });
    return s;
  };
  const opts = { namespace: "a", readsFrom: { a: ["b"] } };

  test("MCP state_list: exact total and deep pages", async () => {
    const s = seed();
    const client = await mcpClient(s, "admin", opts);
    try {
      const r = parseToolText(
        await client.callTool({ name: "state_list", arguments: { limit: 50, offset: 600 } })
      );
      assert.equal(r.total, 630);
      assert.equal(r.notes.length, 30);
      assert.ok(r.notes.every((n: NoteRecord) => n.namespace !== "secret"));
    } finally {
      await client.close();
      s.close();
    }
  });

  test("REST GET /notes: exact total and deep pages", async () => {
    const s = seed();
    const server = createApiServer(s, "tok", opts);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/notes?limit=50&offset=600`, {
        headers: { Authorization: "Bearer tok" },
      });
      const json: any = await res.json();
      assert.equal(json.total, 630);
      assert.equal(json.notes.length, 30);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      s.close();
    }
  });
});

describe("6: namespace paths are case-insensitive on win32/darwin", () => {
  const cfg = (spaces: Record<string, string>) => ({ spaces, default_namespace: "default" });

  test("win32 paths match regardless of case and separator", () => {
    const saved = process.env.ONEMEMORY_SPACE;
    delete process.env.ONEMEMORY_SPACE;
    try {
      const c = cfg({ "c:/users/dan/work": "work" });
      assert.equal(resolveNamespace("C:\\Users\\Dan\\Work\\proj", c, { platform: "win32" }), "work");
      assert.equal(resolveNamespace("C:\\Users\\Dan\\Work", c, { platform: "win32" }), "work");
      assert.equal(resolveNamespace("C:\\Users\\Dan\\Workshop", c, { platform: "win32" }), "default");
      assert.equal(
        resolveNamespace("/Users/Dan/Work/x", cfg({ "/users/dan/work": "work" }), { platform: "darwin" }),
        "work"
      );
      // Linux filesystems are case-sensitive: no folding there.
      assert.equal(
        resolveNamespace("/home/Dan/work", cfg({ "/home/dan/work": "work" }), { platform: "linux" }),
        "default"
      );
    } finally {
      if (saved !== undefined) process.env.ONEMEMORY_SPACE = saved;
    }
  });
});

describe("7: doctor flags a store with notes but no edges", () => {
  test("warns until rebuild-edges runs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "onememory-v110-doctor-"));
    const path = join(dir, "t.db");
    const s = new Store(path);
    // Simulates a 1.0.0 store: notes written before the edge graph existed.
    s.create({ title: "alpha project status", body: "alpha project report" }, { skipEdges: true });
    s.create({ title: "alpha project status two", body: "alpha project report" }, { skipEdges: true });
    const doctor = (): string =>
      execFileSync("node", ["dist/src/cli.js", "doctor"], {
        env: { ...process.env, ONEMEMORY_DB_PATH: path, ONEMEMORY_HOME: dir },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }) as unknown as string;
    try {
      assert.match(doctor(), /no similarity edges.*rebuild-edges/);
      await s.rebuildEdgesCooperative();
      assert.doesNotMatch(doctor(), /no similarity edges/);
    } finally {
      s.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("8: default timezone", () => {
  test("unset ONEMEMORY_TIMEZONE means the host timezone", () => {
    const saved = { tz: process.env.TZ, om: process.env.ONEMEMORY_TIMEZONE };
    delete process.env.ONEMEMORY_TIMEZONE;
    process.env.TZ = "Asia/Taipei";
    try {
      assert.equal(resolveTimeZone(), "Asia/Taipei");
    } finally {
      if (saved.tz === undefined) delete process.env.TZ;
      else process.env.TZ = saved.tz;
      if (saved.om !== undefined) process.env.ONEMEMORY_TIMEZONE = saved.om;
    }
  });
});

describe("9: ONEMEMORY_ACCESS_BOOST=0", () => {
  test("restores native relevance order", async () => {
    const s = new Store(":memory:");
    const saved = process.env.ONEMEMORY_ACCESS_BOOST;
    try {
      const a = s.create({ title: "falcon report", body: "falcon migration notes" });
      const b = s.create({ title: "falcon report", body: "falcon migration notes" });
      for (let i = 0; i < 5; i++) s.touch(b.id);
      delete process.env.ONEMEMORY_ACCESS_BOOST;
      const boosted = await runSearch(s, "falcon", { mode: "keyword" });
      assert.deepEqual(boosted.map((n) => n.id), [b.id, a.id]);
      process.env.ONEMEMORY_ACCESS_BOOST = "0";
      const native = await runSearch(s, "falcon", { mode: "keyword" });
      assert.deepEqual(native.map((n) => n.id), [a.id, b.id]);
    } finally {
      if (saved === undefined) delete process.env.ONEMEMORY_ACCESS_BOOST;
      else process.env.ONEMEMORY_ACCESS_BOOST = saved;
      s.close();
    }
  });
});

describe("10: rebuild single-flight + stale-rev skip", () => {
  test("a concurrent rebuild is refused", async () => {
    const s = new Store(":memory:");
    try {
      s.create({ title: "alpha project status", body: "alpha project report" });
      const first = s.rebuildEdgesCooperative();
      await assert.rejects(s.rebuildEdgesCooperative(), RebuildBusyError);
      await first;
      await s.rebuildEdgesCooperative(); // released afterwards
    } finally {
      s.close();
    }
  });

  test("a note updated mid-rebuild keeps its fresh edges", async () => {
    const s = new Store(":memory:");
    try {
      const ids = [0, 1, 2, 3].map(
        (i) =>
          s.create({ title: `alpha project status ${i}`, body: "alpha project status report" }).id
      );
      let updated = false;
      await s.rebuildEdgesCooperative({
        onProgress: () => {
          if (updated) return;
          updated = true;
          s.update(ids[0], { title: "zebra lighthouse", body: "quantum harbor" });
        },
      });
      assert.ok(updated);
      assert.deepEqual(s.listNeighbors(ids[0]), [], "stale snapshot edges were re-inserted");
      assert.ok(!s.listNeighbors(ids[1]).some((n) => n.id === ids[0]));
      assert.ok(s.listNeighbors(ids[1]).length > 0, "unchanged notes are still linked");
    } finally {
      s.close();
    }
  });
});

describe("11: REST POST /rebuild-edges", () => {
  test("confirm gate and single-flight", async () => {
    const s = new Store(":memory:");
    for (let i = 0; i <= REBUILD_CONFIRM_NOTE_COUNT; i++) {
      s.create({ namespace: "big", title: `n${i}` }, { skipEdges: true });
    }
    s.create({ namespace: "small", title: "alpha project status", body: "alpha project" });
    const server = createApiServer(s, "tok");
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;
    const post = (body: unknown) =>
      fetch(`http://127.0.0.1:${port}/rebuild-edges`, {
        method: "POST",
        headers: { Authorization: "Bearer tok", "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    try {
      const refused = await post({ namespace: "big" });
      assert.equal(refused.status, 409);
      const json: any = await refused.json();
      assert.equal(json.notes, REBUILD_CONFIRM_NOTE_COUNT + 1);
      assert.match(json.error, /confirm/);

      const small = await post({ namespace: "small" });
      assert.equal(small.status, 200);

      // While a rebuild is running, a second one is refused with 409.
      (s as unknown as { rebuildRunning: boolean }).rebuildRunning = true;
      const busy = await post({ namespace: "small" });
      (s as unknown as { rebuildRunning: boolean }).rebuildRunning = false;
      assert.equal(busy.status, 409);
      assert.match(((await busy.json()) as any).error, /already running/);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      s.close();
    }
  });
});
