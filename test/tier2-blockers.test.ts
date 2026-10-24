// Regression tests for the Tier 2 panel's DO NOT SHIP blockers 1-2.
//
// BLOCKER 1 -- rebuild-edges was an O(n^2) blocking transaction that froze
// the server: per-pair re-tokenization inside a single BEGIN IMMEDIATE /
// COMMIT, no yields, no progress, not resumable, and the CLI second-process
// path failed every server write with SQLITE_BUSY. Now: term-frequency maps
// precomputed once per note, cooperative async rebuild with setImmediate
// yields, per-chunk transactions with _meta resume markers, an MCP confirm
// gate above the note threshold, and CLI pair-count printing +
// confirmation + stderr progress + write-lock refusal.
//
// BLOCKER 2 -- touch() turned every read into 3 writes via the ungated FTS
// trigger: notes_au had no WHEN clause, so a metadata-only UPDATE fired a
// full FTS5 delete + re-insert. Now: migration v5 gates the trigger on
// content columns, and search-service's bumpAccess batches into one UPDATE
// via store.touchMany().
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  Store,
  REBUILD_BAND_NOTES,
  REBUILD_CONFIRM_NOTE_COUNT,
} from "../src/store.js";
import { createMcpServer } from "../src/mcp-server-core.js";
import { runSearch } from "../src/search-service.js";

/** A scratch file-backed store plus its directory (for cleanup). */
function tempStore(tag: string): { dir: string; path: string; store: Store } {
  const dir = mkdtempSync(join(tmpdir(), `onememory-tier2-${tag}-`));
  const path = join(dir, "test.db");
  return { dir, path, store: new Store(path) };
}

function closeTemp(t: { dir: string; store: Store }): void {
  t.store.close();
  rmSync(t.dir, { recursive: true, force: true });
}

describe("blocker 1: cooperative edge rebuild", () => {
  test("rebuildEdgesCooperative scores the same graph as the old semantics", async () => {
    const s = new Store(":memory:");
    try {
      const a = s.create({
        title: "alpha project status",
        body: "shipping the alpha release this week",
      });
      const b = s.create({
        title: "alpha project review",
        body: "reviewing the alpha release this week",
      });
      const c = s.create({ title: "grocery list", body: "milk eggs bread" });
      // create() already linked a<->b; the rebuild must delete and re-create
      // exactly that set (a no-op rebuild reports equal created/removed).
      const res = await s.rebuildEdgesCooperative({});
      assert.ok(res.created > 0, "similar notes should form edges");
      assert.equal(res.created, res.removed);
      assert.deepEqual(
        s.listNeighbors(a.id).map((n) => n.id),
        [b.id]
      );
      assert.deepEqual(
        s.listNeighbors(b.id).map((n) => n.id),
        [a.id]
      );
      assert.deepEqual(s.listNeighbors(c.id), []);
      // A no-op rebuild deletes and re-inserts the identical set.
      const res2 = await s.rebuildEdgesCooperative({});
      assert.equal(res2.created, res2.removed);
      // Same-namespace-only: a same-titled note in another namespace gets
      // no edge to a, even in a whole-store rebuild.
      const d = s.create({
        title: "alpha project status",
        body: "shipping the alpha release this week",
        namespace: "other",
      });
      await s.rebuildEdgesCooperative({});
      assert.ok(!s.listNeighbors(a.id).some((n) => n.id === d.id));
      assert.deepEqual(
        s.listNeighbors(d.id).map((n) => n.id),
        []
      );
    } finally {
      s.close();
    }
  });

  test("onProgress fires and completes at (pairsTotal, pairsTotal)", async () => {
    const s = new Store(":memory:");
    try {
      for (let i = 0; i < 10; i++) {
        s.create({ title: `uniquememo${i}`, body: `uniquebody${i}` });
      }
      const seen: Array<[number, number]> = [];
      await s.rebuildEdgesCooperative({
        onProgress: (done, total) => seen.push([done, total]),
      });
      assert.ok(seen.length > 0, "progress should fire at least once");
      const total = (10 * 9) / 2;
      for (const [done, t] of seen) {
        assert.equal(t, total);
        assert.ok(done <= total, `done ${done} must not exceed total ${total}`);
      }
      for (let i = 1; i < seen.length; i++) {
        assert.ok(
          seen[i][0] >= seen[i - 1][0],
          "progress must be non-decreasing"
        );
      }
      assert.deepEqual(seen[seen.length - 1], [total, total]);
    } finally {
      s.close();
    }
  });

  test("an interrupted rebuild resumes from the chunk marker (no restart)", async () => {
    const N = REBUILD_BAND_NOTES + 44; // two bands: [0, BAND) and [BAND, N)
    const band0Pairs = (() => {
      let p = 0;
      for (let i = 0; i < REBUILD_BAND_NOTES; i++) p += N - 1 - i;
      return p;
    })();
    // Notes share most of their tokens within one of 10 topics, so
    // same-topic pairs reliably clear the TF-IDF edge threshold at any
    // corpus size (a unique-per-note token would see its IDF weight grow
    // with the corpus and swamp the shared signal).
    const build = (): Store => {
      const st = new Store(":memory:");
      for (let i = 0; i < N; i++) {
        const topic = `topic${i % 10}`;
        st.create({
          title: `alpha project ${topic} status`,
          body: `status report on ${topic} for the alpha project`,
        });
      }
      return st;
    };
    const s = build();
    try {
      // Interrupt after band 0 committed: throw on the first progress call
      // that reports MORE than band 0's pairs (band 0's commit -- and its
      // _meta marker -- happen before band 1's first progress report).
      let threw = false;
      await assert.rejects(
        s.rebuildEdgesCooperative({
          onProgress: (done) => {
            if (!threw && done > band0Pairs) {
              threw = true;
              throw new Error("simulated interrupt");
            }
          },
        }),
        /simulated interrupt/
      );
      assert.ok(threw, "the interrupt should have fired mid-rebuild");

      // Resume: must NOT re-delete the completed band (removed === 0) and
      // must finish the remaining band.
      const resumed = await s.rebuildEdgesCooperative({});
      assert.equal(
        resumed.removed,
        0,
        "resume must skip the delete -- completed bands are kept"
      );
      assert.ok(resumed.created > 0, "resume must finish the remaining band");

      // The resumed graph must equal a clean full rebuild, edge for edge.
      const ref = build();
      try {
        await ref.rebuildEdgesCooperative({});
        const sigOf = (st: Store): string => {
          const parts: string[] = [];
          for (let id = 1; id <= N; id++) {
            parts.push(
              st
                .listNeighbors(id)
                .map((n) => `${n.id}:${n.score.toFixed(6)}`)
                .join(",")
            );
          }
          return parts.join("|");
        };
        assert.equal(sigOf(s), sigOf(ref), "resumed graph != clean rebuild");
      } finally {
        ref.close();
      }
    } finally {
      s.close();
    }
  });

  test("a note deleted mid-rebuild neither aborts the run nor leaves dangling edges", async () => {
    const t = tempStore("rebuild-delete");
    const a = t.store;
    const b = new Store(t.path);
    try {
      const ids: number[] = [];
      for (let i = 0; i < 6; i++) {
        ids.push(
          a.create({
            title: `alpha project report ${i}`,
            body: `alpha project body ${i}`,
          }).id
        );
      }
      // Delete one note from a SECOND connection during the rebuild's
      // scoring phase (no lock held) -- the chunk commit's live-id
      // re-check must filter it instead of FK-aborting.
      let deleted = false;
      const res = await a.rebuildEdgesCooperative({
        onProgress: () => {
          if (!deleted) {
            deleted = true;
            assert.equal(b.delete(ids[2]), true);
          }
        },
      });
      assert.ok(deleted);
      assert.ok(res.created > 0);
      // No edge may reference the deleted note, in either direction.
      for (const id of ids) {
        if (id === ids[2]) continue;
        assert.ok(
          !a.listNeighbors(id).some((n) => n.id === ids[2]),
          `dangling edge to deleted note ${ids[2]}`
        );
      }
      assert.deepEqual(a.listNeighbors(ids[2]), []);
      // The surviving notes still link to each other.
      const n0 = a.listNeighbors(ids[0]).map((n) => n.id);
      assert.ok(n0.includes(ids[1]) && n0.includes(ids[3]));
    } finally {
      b.close();
      closeTemp(t);
    }
  });

  test("writeLockHeld detects a write lock held by another connection", () => {
    const t = tempStore("lock");
    const peer = new Store(t.path);
    try {
      assert.equal(t.store.writeLockHeld(), false);
      assert.equal(new Store(":memory:").writeLockHeld(), false);
      t.store.transaction(() => {
        assert.equal(
          peer.writeLockHeld(),
          true,
          "peer should see the held write lock"
        );
      });
      assert.equal(t.store.writeLockHeld(), false);
    } finally {
      peer.close();
      closeTemp(t);
    }
  });

  test("rebuildPlan reports per-namespace note and pair counts", () => {
    const s = new Store(":memory:");
    try {
      s.create({ title: "one" });
      s.create({ title: "two" });
      s.create({ title: "three" });
      s.create({ title: "uno", namespace: "es" });
      s.create({ title: "dos", namespace: "es" });
      const plan = s.rebuildPlan();
      assert.deepEqual(plan, [
        { namespace: "default", notes: 3, pairs: 3 },
        { namespace: "es", notes: 2, pairs: 1 },
      ]);
      assert.deepEqual(s.rebuildPlan({ namespace: "es" }), [
        { namespace: "es", notes: 2, pairs: 1 },
      ]);
      assert.deepEqual(s.rebuildPlan({ namespace: "missing" }), []);
    } finally {
      s.close();
    }
  });

  test("MCP memory_rebuild_edges refuses above the threshold without confirm", async () => {
    const store = new Store(":memory:");
    // Unique tokens per note: no edges form, so setup stays fast.
    for (let i = 0; i < REBUILD_CONFIRM_NOTE_COUNT + 1; i++) {
      store.create({ title: `m${i}`, body: `b${i}` });
    }
    const server = createMcpServer(store);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });
    try {
      await Promise.all([
        client.connect(clientTransport),
        server.connect(serverTransport),
      ]);
      const refused: any = await client.callTool({
        name: "memory_rebuild_edges",
        arguments: {},
      });
      assert.equal(refused.isError, true);
      assert.match(refused.content[0].text, /confirm: true/);
      assert.match(refused.content[0].text, /pairs/);
    } finally {
      await client.close();
      store.close();
    }
  });

  test("MCP memory_rebuild_edges runs without confirm under the threshold", async () => {
    const store = new Store(":memory:");
    for (let i = 0; i < 6; i++) {
      store.create({
        title: `alpha report ${i}`,
        body: `shared alpha words ${i}`,
      });
    }
    const server = createMcpServer(store);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });
    try {
      await Promise.all([
        client.connect(clientTransport),
        server.connect(serverTransport),
      ]);
      const result: any = await client.callTool({
        name: "memory_rebuild_edges",
        arguments: {},
      });
      assert.ok(!result.isError, JSON.stringify(result));
      const text = result.content[0].text as string;
      const payload = JSON.parse(text.slice(text.indexOf("{")));
      assert.equal(payload.pairs, 15); // 6 notes -> 15 pairs
      assert.equal(typeof payload.created, "number");
      assert.equal(typeof payload.removed, "number");
      assert.ok(payload.created > 0, "similar notes should form edges");
    } finally {
      await client.close();
      store.close();
    }
  });

  test("CLI rebuild-edges --yes runs non-interactively and reports counts", () => {
    const t = tempStore("cli");
    t.store.create({ title: "cli alpha one", body: "shared alpha words" });
    t.store.create({ title: "cli alpha two", body: "shared alpha words" });
    t.store.close();
    try {
      const out = execFileSync(
        "node",
        ["dist/src/cli.js", "rebuild-edges", "--yes"],
        {
          env: { ...process.env, ONEMEMORY_DB_PATH: t.path },
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        }
      ) as unknown as string;
      assert.match(out, /Rebuilt similarity edges/);
      assert.match(out, /\d+ created, \d+ removed/);
      assert.match(out, /pairs scored/);
    } finally {
      rmSync(t.dir, { recursive: true, force: true });
    }
  });
});

describe("blocker 2: gated FTS trigger", () => {
  test("migration v5 gates notes_au on content columns and adds _meta", () => {
    const t = tempStore("migrate");
    try {
      const probe = new DatabaseSync(t.path);
      try {
        const v = (probe.prepare("PRAGMA user_version").get() as {
          user_version: number;
        }).user_version;
        // v5 introduced the gated trigger + _meta; later migrations (v6+)
        // may exist -- assert the floor, not the exact version.
        assert.ok(v >= 5, `user_version should be >= 5, got ${v}`);
        const trig = (
          probe
            .prepare(
              "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'notes_au'"
            )
            .get() as { sql: string }
        ).sql;
        assert.match(trig, /WHEN/);
        assert.match(trig, /old\.title IS NOT new\.title/);
        const meta = probe
          .prepare("SELECT name FROM sqlite_master WHERE name = '_meta'")
          .get();
        assert.ok(meta, "_meta table should exist");
      } finally {
        probe.close();
      }
      // Reopening must be idempotent: version stays 5 and the gated
      // trigger is NOT clobbered by init()'s CREATE TRIGGER IF NOT EXISTS.
      t.store.close();
      const reopened = new Store(t.path);
      t.store = reopened;
      const probe2 = new DatabaseSync(t.path);
      try {
        const trig = (
          probe2
            .prepare(
              "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'notes_au'"
            )
            .get() as { sql: string }
        ).sql;
        assert.match(trig, /WHEN/, "reopen must keep the gated trigger");
      } finally {
        probe2.close();
      }
    } finally {
      closeTemp(t);
    }
  });

  test("touch()/touchMany() do not change the FTS index row count", () => {
    const t = tempStore("fts-touch");
    try {
      const id = t.store.create({
        title: "alpha note",
        body: "the quick brown fox",
      }).id;
      const probe = new DatabaseSync(t.path);
      try {
        const ftsRows = (): number =>
          (
            probe.prepare("SELECT COUNT(*) AS c FROM notes_fts").get() as {
              c: number;
            }
          ).c;
        assert.equal(ftsRows(), 1);
        // Metadata-only writes: the gated trigger must not fire.
        t.store.touch(id);
        t.store.touchMany([id, id, 999999]);
        assert.equal(ftsRows(), 1, "touch must not re-index");
        // The index still answers correctly.
        assert.equal(t.store.search("quick")[0].id, id);
      } finally {
        probe.close();
      }
    } finally {
      closeTemp(t);
    }
  });

  test("content UPDATEs still re-index through the gated trigger", () => {
    const t = tempStore("fts-update");
    try {
      const id = t.store.create({
        title: "alpha note",
        body: "the quick brown fox",
      }).id;
      assert.equal(t.store.search("quick")[0].id, id);
      assert.deepEqual(t.store.search("zebra"), []);
      t.store.update(id, { body: "zebra stripes everywhere" });
      const hits = t.store.search("zebra");
      assert.equal(hits.length, 1);
      assert.equal(hits[0].id, id);
      assert.deepEqual(
        t.store.search("quick"),
        [],
        "old terms must be de-indexed"
      );
      // Tags are content columns too: changing only tags re-indexes.
      t.store.update(id, { tags: ["savanna"] });
      assert.equal(t.store.search("savanna")[0].id, id);
    } finally {
      closeTemp(t);
    }
  });

  test("runSearch bumps each returned note's counter exactly once (batched)", async () => {
    const s = new Store(":memory:");
    try {
      const a = s.create({ title: "uniquealpha one", body: "x" });
      const b = s.create({ title: "uniquealpha two", body: "y" });
      const results = await runSearch(s, "uniquealpha", { limit: 10 });
      assert.equal(results.length, 2);
      // bumpAccess is one UPDATE ... WHERE id IN (...) now, not a per-note
      // loop -- the observable contract is unchanged: +1 per returned note.
      assert.equal(s.read(a.id)!.access_count, 1);
      assert.equal(s.read(b.id)!.access_count, 1);
      assert.ok(s.read(a.id)!.last_accessed !== null);
    } finally {
      s.close();
    }
  });
});
