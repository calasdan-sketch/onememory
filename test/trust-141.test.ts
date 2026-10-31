// 1.4.1: regression tests for the second expert review. Each test pins one verified exploit or defect
// of 1.4.0 (distrust laundering, signing-key handling, import robustness, ...).
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, statSync, readFileSync, writeFileSync, mkdirSync, chmodSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { sign } from "node:crypto";
import type { AddressInfo } from "node:net";
import { Store, type ImportNote, type ImportReport } from "../src/store.js";
import { actorStore, cleanWriter } from "../src/actor.js";
import { createApiServer } from "../src/api.js";
import { createMcpServer } from "../src/mcp-server-core.js";
import { putTask, writeHandoff, listTasks } from "../src/tasks.js";
import { autoConsolidate, consolidateNotes } from "../src/consolidate.js";
import { exportMarkdown, importMarkdown } from "../src/sync.js";
import { parseWriterRef, matchesDistrust, canonicalRuleWriter, type DistrustRule } from "../src/trust.js";
import {
  ATTEST_KEY_FILENAME,
  loadOrCreateSigningKey,
  peekSigningKey,
  signRecord,
  verifyRecord,
  contentHash,
  parseTrustedAttestersEnvDetailed,
  isServerId,
  type TrustedAttester,
} from "../src/attest.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const as = <T>(label: string, fn: () => T): T => actorStore.run({ label, authed: true }, fn);
const exported = (s: Store, attest = true): ImportNote[] => s.exportBatch(0, 1000, { attest }) as unknown as ImportNote[];
const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.js");

async function importInto(b: Store, notes: ImportNote[]): Promise<{ created: Awaited<ReturnType<Store["importNotes"]>>; report: ImportReport }> {
  const report: ImportReport = { quarantined: [], rejected: [] };
  const created = await b.importNotes(structuredClone(notes), { report });
  return { created, report };
}
async function mcp(store: Store, scope: "read" | "write" | "admin", conn: any = {}, opts: any = {}) {
  const server = createMcpServer(store, scope, opts, conn);
  const [c, s] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1.0.0" });
  await Promise.all([client.connect(c), server.connect(s)]);
  return client;
}

describe("A: distrust cannot be laundered", () => {
  let s: Store;
  beforeEach(() => {
    s = new Store(":memory:");
  });
  afterEach(() => s.close());

  test("a trusted writer rewriting, or merely tagging, a distrusted writer's note does not make it visible", () => {
    const n = as("evil", () => s.create({ title: "doc", body: "poison" }));
    s.distrustAdd("default", "evil");
    as("good", () => s.update(n.id, { body: "cleaned?" }));
    assert.equal(s.list().notes.length, 0);
    as("good", () => s.update(n.id, { tags: ["reviewed"] }));
    assert.equal(s.list().notes.length, 0);
    assert.equal(s.search("cleaned").length, 0);
    assert.equal(s.readVisible(n.id), null);
    assert.ok(s.readVisible(n.id, { includeDistrusted: true })?.distrusted);
  });

  test("a note a distrusted writer only EDITED stays hidden after the rule is added later", () => {
    const n = as("good", () => s.create({ title: "doc", body: "v1" }));
    as("evil", () => s.update(n.id, { body: "v2" }));
    as("good", () => s.update(n.id, { body: "v3" }));
    s.distrustAdd("default", "evil");
    assert.equal(s.list().notes.length, 0);
  });

  test("the janitor never merges a distrusted copy into a trusted note", () => {
    s.distrustAdd("default", "evil");
    const good = as("good", () => s.create({ title: "deploy steps", body: "run the migration then restart the service" }));
    as("evil", () => s.create({ title: "deploy steps", body: "run the migration then restart the service" }));
    const r = autoConsolidate(s, { threshold: 0.9 });
    assert.equal(r.merged.length, 0, "the pair is not even a candidate");
    assert.ok(s.read(good.id), "the trusted original is intact and visible");
    assert.equal(s.list().notes.length, 1);
  });

  test("consolidating a mix of distrusted and trusted notes is refused; two distrusted ones are fine", () => {
    s.distrustAdd("default", "evil");
    const a = as("evil", () => s.create({ title: "tip one", body: "alpha tips" }));
    const b = as("good", () => s.create({ title: "tip two", body: "beta tips" }));
    const c = as("evil", () => s.create({ title: "tip three", body: "gamma tips" }));
    assert.throws(() => as("admin", () => consolidateNotes(s, [a.id, b.id])), /distrust/i);
    assert.ok(s.read(a.id) && s.read(b.id), "nothing was merged or deleted");
    const both = as("admin", () => consolidateNotes(s, [a.id, c.id]));
    assert.ok(both.id > 0);
  });

  test("a tags-only update through the API does not echo a hidden note's body (404 for a non-admin)", async () => {
    const e = as("evil", () => s.create({ title: "secret plan", body: "PAYLOAD-IN-BODY" }));
    s.distrustAdd("default", "evil");
    const server = createApiServer(s, [
      { token: "w".repeat(32), scope: "write", label: "good" },
      { token: "a".repeat(32), scope: "admin", label: "adm" },
    ]);
    await new Promise<void>((r) => server.listen(0, r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const put = (tok: string, body: unknown) =>
        fetch(`${base}/notes/${e.id}`, { method: "PUT", headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const r1 = await put("w".repeat(32), { tags: ["x"] });
      assert.equal(r1.status, 404);
      assert.ok(!(await r1.text()).includes("PAYLOAD-IN-BODY"));
      // archive / restore are admin-scoped routes: a pinned admin of ANOTHER namespace gets 404 too
      assert.equal(s.read(e.id)!.tags.length, 0, "the tag change was not applied");
      const r2 = await put("a".repeat(32), { tags: ["x"] });
      assert.equal(r2.status, 200, "an admin may act on it");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  test("MCP state_write on a hidden note id is refused for a non-admin, and state_read says not found", async () => {
    const e = as("evil", () => s.create({ title: "x", body: "PAYLOAD-IN-BODY" }));
    s.distrustAdd("default", "evil");
    const c = await mcp(s, "write", { label: "good", authed: true });
    const w: any = await c.callTool({ name: "state_write", arguments: { id: e.id, tags: ["t"] } });
    assert.equal(w.isError, true);
    assert.ok(!JSON.stringify(w).includes("PAYLOAD-IN-BODY"));
    const r: any = await c.callTool({ name: "state_read", arguments: { id: e.id } });
    assert.equal(r.isError, true);
    assert.ok(!JSON.stringify(r).includes("PAYLOAD-IN-BODY"));
    await c.close();
  });

  test("client_key replay cannot return, or collide with, a distrusted writer's task or handoff", () => {
    const evilTask = as("evil", () => putTask(s, { title: "evil task", namespace: "work", client_key: "k-1" })).task;
    const evilHand = as("evil", () => writeHandoff(s, { surface: "box", summary: "evil summary", namespace: "work", client_key: "h-1" } as any)).handoff;
    s.distrustAdd("work", "evil");
    // a trusted writer reusing the same key gets its own task, not the hidden one
    const mine = as("good", () => putTask(s, { title: "good task", namespace: "work", client_key: "k-1" }));
    assert.notEqual(mine.task.id, evilTask.id);
    assert.equal(mine.task.title, "good task");
    assert.equal(mine.replayed, undefined);
    const myHand = as("good", () => writeHandoff(s, { surface: "box2", summary: "good summary", namespace: "work", client_key: "h-1" } as any));
    assert.notEqual(myHand.handoff.id, evilHand.id);
    assert.equal(myHand.handoff.summary, "good summary");
    // a client_key names one task per namespace: the visible task wins, so a replay never piles up duplicates
    const again = as("evil", () => putTask(s, { title: "evil task", namespace: "work", client_key: "k-1" }));
    assert.equal(again.task.id, mine.task.id);
    // and when ONLY the distrusted writer holds the key, its own replay is still idempotent
    const solo = as("evil", () => putTask(s, { title: "solo", namespace: "work", client_key: "k-solo" })).task;
    const solo2 = as("evil", () => putTask(s, { title: "solo", namespace: "work", client_key: "k-solo" }));
    assert.equal(solo2.task.id, solo.id);
    assert.equal(solo2.replayed, true);
    const other = as("good", () => putTask(s, { title: "mine", namespace: "work", client_key: "k-solo" }));
    assert.notEqual(other.task.id, solo.id, "a trusted writer never gets the distrusted writer's task back");
    assert.deepEqual(listTasks(s, { namespaces: ["work"] }).tasks.map((t) => t.title).sort(), ["good task", "mine"]);
  });

  test("a hidden task cannot be updated through task_put by id (looks like not found)", () => {
    const t = as("evil", () => putTask(s, { title: "evil task", namespace: "work" })).task;
    s.distrustAdd("work", "evil");
    assert.throws(() => as("good", () => putTask(s, { id: t.id, title: "hijack", namespace: "work" } as any)), /not found|no task/i);
  });

  test("an import with the writer claim stripped or rewritten cannot remove taint; claims only ever ADD it", async () => {
    const a = new Store(":memory:");
    try {
      const id = a.identity();
      as("mallory", () => a.create({ title: "tip", body: "do the bad thing" }));
      s.attesterAdd({ public_key: id.public_key, server_id: id.server_id });
      // 1. verified import: the original writer is kept as an attested pair and is distrustable
      const v = await importInto(s, exported(a));
      assert.equal(v.report.attestations!.verified, 1);
      s.distrustAdd("*", `${id.server_id}/mallory`);
      assert.equal(s.list().notes.length, 0);
      // 2. that note re-exported PLAIN (attestation stripped) and imported into a third server: the claim survives as taint
      const plain = exported(s, false);
      const c = new Store(":memory:");
      try {
        await importInto(c, plain);
        c.distrustAdd("*", "mallory");
        assert.equal(c.list().notes.length, 0, "the stripped export still carries the claim, which folds into the taint");
        assert.equal(c.list({ includeDistrusted: true }).notes.length, 1);
      } finally {
        c.close();
      }
      // 3. dropping the attester from the trust list later does not erase what was recorded
      s.attesterRemove(id.key_id);
      assert.equal(s.list().notes.length, 0);
    } finally {
      a.close();
    }
  });

  test("a note imported from a file that omits every writer field is simply stamped; nothing is lost from earlier hops", async () => {
    const a = new Store(":memory:");
    try {
      as("mallory", () => a.create({ title: "tip", body: "x" }));
      const stripped = exported(a, false).map((n) => ({ ...n, written_by: "", created_by: "", imported_written_by: "" }));
      await importInto(s, stripped as ImportNote[]);
      assert.equal(s.list().notes.length, 1, "no claim, no taint: this is the documented limit of unsigned files");
    } finally {
      a.close();
    }
  });

  test("the markdown vault: distrusted notes are left out (and their older files pruned), or marked with --include-distrusted", () => {
    const dir = mkdtempSync(join(tmpdir(), "om-vault-"));
    try {
      as("good", () => s.create({ title: "fine note", body: "ok" }));
      const e = as("evil", () => s.create({ title: "bad note", body: "poison" }));
      exportMarkdown(s, dir);
      assert.equal(readdirSync(join(dir, "default")).length, 2);
      s.distrustAdd("default", "evil");
      const r = exportMarkdown(s, dir, { prune: true });
      const files = readdirSync(join(dir, "default"));
      assert.equal(files.length, 1, `the hidden note's file was pruned: ${files.join(",")}`);
      assert.ok(!files.some((f) => readFileSync(join(dir, "default", f), "utf8").includes("poison")));
      void r;
      const inc = mkdtempSync(join(tmpdir(), "om-vault-inc-"));
      try {
        exportMarkdown(s, inc, { includeDistrusted: true });
        const texts = readdirSync(join(inc, "default")).map((f) => readFileSync(join(inc, "default", f), "utf8"));
        assert.equal(texts.length, 2);
        assert.ok(texts.some((t) => t.includes("poison") && /^distrusted: true$/m.test(t)), "the hidden note is marked in its front matter");
        assert.ok(texts.some((t) => !/distrusted: true/.test(t)));
      } finally {
        rmSync(inc, { recursive: true, force: true });
      }
      void e;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a vault file whose origin_writer names a distrusted writer is imported as tainted", async () => {
    const dir = mkdtempSync(join(tmpdir(), "om-vault-claim-"));
    const a = new Store(":memory:");
    try {
      as("mallory", () => a.create({ title: "from afar", body: "payload" }));
      exportMarkdown(a, dir);
      await importMarkdown(s, dir);
      s.distrustAdd("*", "mallory");
      assert.equal(s.list().notes.length, 0);
    } finally {
      a.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("D: writer references and rules", () => {
  test("a writer_id whose label is 64+ characters keeps its server id and matches the stored form of the label", () => {
    const sid = "0b9b0a4e-1111-4222-8333-444455556666";
    for (const len of [63, 64, 65, 120, 400]) {
      const label = "a".repeat(len);
      const ref = parseWriterRef(`${sid}/${label}`);
      assert.equal(ref.serverId, sid, `the server id survives a ${len}-char label (1.4.0 cut the whole string first)`);
      assert.equal(ref.label, cleanWriter(label), "the label is normalised exactly as a stored written_by is");
      if (len <= 64) assert.equal(ref.label, label);
    }
    // end to end: a rule written as <this server>/<long label> hides that writer's notes
    const s = new Store(":memory:");
    try {
      const long = "L".repeat(150).toLowerCase();
      as(long, () => s.create({ title: "n", body: "b" }));
      assert.equal(s.list().notes.length, 1);
      s.distrustAdd("*", `${s.serverId()}/${long}`);
      assert.equal(s.list().notes.length, 0);
    } finally {
      s.close();
    }
  });

  test("rules that can never match are rejected", () => {
    const sid = "0b9b0a4e-1111-4222-8333-444455556666";
    assert.equal(canonicalRuleWriter("").ok, false);
    assert.equal(canonicalRuleWriter(sid).ok, false, "a server id with no label");
    assert.equal(canonicalRuleWriter(`${sid}/`).ok, false);
    assert.equal(canonicalRuleWriter("   ").ok, false);
    assert.equal(canonicalRuleWriter("alice").ok, true);
    const s = new Store(":memory:");
    assert.throws(() => s.distrustAdd("*", sid), /label|writer/i);
    s.close();
  });

  test("SQL and JS agree on quotes, backslashes, unicode, case and whitespace", () => {
    const s = new Store(":memory:");
    try {
      const labels = [`o"brien`, `back\\slash`, `quote'single`, `ünï-cödé`, `日本語`, `Mixed Case`, `a  b`, `x/y`, `%_like`, `[json]`];
      for (const l of labels) {
        const n = as(l, () => s.create({ title: `n ${l}`, body: `body ${l}` }));
        // taint-only: a different last writer, with `l` in the merged set
        const t = as("someone-else", () => s.create({ title: `t ${l}`, body: `tb ${l}` }));
        s.update(t.id, { body: `tb2 ${l}` }, { writtenBy: "someone-else", alsoTouchedBy: [l] });
        void n;
      }
      for (const l of labels) {
        s.distrustAdd("*", l);
      }
      const rules = s.distrustRules();
      const all = s.list({ includeDistrusted: true, limit: 200 }).notes;
      assert.equal(all.length, labels.length * 2);
      const visible = new Set(s.list({ limit: 200 }).notes.map((n) => n.id));
      for (const n of all) {
        const js = matchesDistrust(rules, n, s.serverId());
        assert.equal(visible.has(n.id), !js, `SQL and JS disagree on #${n.id} (${n.written_by}; ${JSON.stringify(n.merged_from_writers)})`);
      }
      assert.equal(visible.size, 0, "every label's notes (written or merged) are hidden");
    } finally {
      s.close();
    }
  });

  test("NULL and empty writer columns behave as 'not distrusted' in SQL and JS alike", () => {
    const s = new Store(":memory:");
    try {
      const a = s.create({ title: "no writer", body: "x" }, { writtenBy: "" });
      s.distrustAdd("*", "somebody");
      assert.equal(s.list().notes.length, 1);
      // Why the COALESCE wrapper could go (1.4.1): every column the predicate reads is NOT NULL, so a NULL cannot occur.
      for (const [table, names] of [
        ["notes", ["written_by", "attested_writer", "attested_by", "merged_from_writers", "namespace"]],
        ["change_log", ["note_written_by", "note_attested_writer", "note_attested_by", "note_merged_from", "namespace"]],
      ] as const) {
        const info = (s as any).db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; notnull: number }>;
        for (const n of names) assert.equal(info.find((c) => c.name === n)?.notnull, 1, `${table}.${n} is NOT NULL`);
      }
      assert.throws(() => (s as any).db.prepare("UPDATE notes SET written_by = NULL WHERE id = ?").run(a.id), /NOT NULL/);
      assert.equal(s.list().notes.length, 1, "an empty writer is never distrusted");
      assert.equal(s.search("writer").length, 1);
      const rules: DistrustRule[] = s.distrustRules();
      assert.equal(matchesDistrust(rules, { namespace: "default", written_by: "" }, s.serverId()), false);
    } finally {
      s.close();
    }
  });
});

describe("C: include_distrusted is admin-only; a pinned admin sees only its own policy", () => {
  let s: Store;
  let server: ReturnType<typeof createApiServer>;
  let base: string;
  const T = { admin: "a".repeat(32), pin: "p".repeat(32), write: "w".repeat(32), read: "r".repeat(32) };
  const call = (tok: string, method: string, path: string, body?: unknown) =>
    fetch(base + path, { method, headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  beforeEach(async () => {
    s = new Store(":memory:");
    server = createApiServer(s, [
      { token: T.admin, scope: "admin", label: "adm" },
      { token: T.pin, scope: "admin", label: "pinadm", namespace: "work" },
      { token: T.write, scope: "write", label: "w" },
      { token: T.read, scope: "read", label: "r" },
    ]);
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    s.close();
  });

  test("every read route refuses include_distrusted for a non-admin, with a clear message", async () => {
    for (const [method, path, body] of [
      ["GET", "/notes?include_distrusted=1", undefined],
      ["GET", "/search?q=x&include_distrusted=true", undefined],
      ["GET", "/changes?since=1h&include_distrusted=yes", undefined],
      ["GET", "/tasks?include_distrusted=1", undefined],
      ["GET", "/handoffs?include_distrusted=1", undefined],
      ["GET", "/catch-up?consumer=z&include_distrusted=1", undefined],
      ["POST", "/relevant", { message: "x", include_distrusted: true }],
    ] as const) {
      for (const tok of [T.read, T.write]) {
        const r = await call(tok, method, path, body);
        assert.equal(r.status, 403, `${method} ${path}`);
        assert.match(await r.text(), /admin/i);
      }
      assert.notEqual((await call(T.admin, method, path, body)).status, 403, `${method} ${path} for admin`);
    }
  });

  test("a namespace-pinned admin sees its own rules and log only, no attesters, and cannot read the global trust log", async () => {
    s.distrustAdd("other", "x1");
    s.distrustAdd("*", "x2");
    s.distrustAdd("work", "x3");
    s.attesterAdd({ public_key: loadOrCreateSigningKey(mkdtempSync(join(tmpdir(), "om-k-"))).publicKey, any_server: true, label: "peer" });
    const seen = await (await call(T.pin, "GET", "/trust")).json();
    assert.deepEqual(seen.distrust.map((r: any) => r.namespace).sort(), ["*", "work"].sort(), "its own namespace plus the global rules that also apply to it");
    assert.deepEqual(seen.attesters, []);
    assert.ok(seen.log.every((l: any) => l.namespace === "work" || l.namespace === "*"), JSON.stringify(seen.log));
    assert.ok(!JSON.stringify(seen.log).includes("x1"));
    assert.ok(!JSON.stringify(seen.log).includes("attester"));
    const full = await (await call(T.admin, "GET", "/trust")).json();
    assert.equal(full.distrust.length, 3);
    assert.equal(full.attesters.length, 1);
  });

  test("the MCP trust_policy and runner_status follow the same pinning", async () => {
    s.distrustAdd("other", "x1");
    s.distrustAdd("work", "x3");
    const c = await mcp(s, "admin", { label: "pinadm", authed: true }, { namespace: "work" });
    const r: any = await c.callTool({ name: "trust_policy", arguments: { action: "list" } });
    const j = JSON.parse(r.content[0].text.slice(r.content[0].text.indexOf("{")));
    assert.deepEqual(j.distrust.map((x: any) => x.namespace), ["work"]);
    assert.deepEqual(j.attesters, []);
    await c.close();
  });

  test("the trust log is bounded and the rule cap is per namespace", () => {
    for (let i = 0; i < 1100; i++) {
      s.distrustAdd("ns", `w${i % 40}`);
      s.distrustRemove("ns", `w${i % 40}`);
    }
    const n = (s as any).db.prepare("SELECT COUNT(*) AS c FROM trust_log").get().c as number;
    assert.ok(n <= 1000, `trust_log holds ${n} rows`);
    assert.equal(s.trustLog(5)[0].action, "undistrust", "the newest rows are the ones kept");
    for (let i = 0; i < 50; i++) s.distrustAdd("a", `w${i}`);
    assert.throws(() => s.distrustAdd("a", "extra"), /full/);
    assert.doesNotThrow(() => s.distrustAdd("b", "extra"), "another namespace is not blocked by it");
  });
});

describe("G: attestation keys, pinning, rotation, versions", () => {
  let dir: string;
  let a: Store;
  let b: Store;
  const prevEnv = process.env.ONEMEMORY_TRUSTED_ATTESTERS;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "om-att141-"));
    a = new Store(join(dir, "a", "state.db"));
    b = new Store(":memory:");
    delete process.env.ONEMEMORY_TRUSTED_ATTESTERS;
  });
  afterEach(() => {
    a.close();
    b.close();
    if (prevEnv === undefined) delete process.env.ONEMEMORY_TRUSTED_ATTESTERS;
    else process.env.ONEMEMORY_TRUSTED_ATTESTERS = prevEnv;
    rmSync(dir, { recursive: true, force: true });
  });

  test("a key must be pinned to a server_id unless --any-server is explicit; the entry shows the difference", () => {
    const id = a.identity();
    assert.throws(() => b.attesterAdd({ public_key: id.public_key }), /server_id is required/);
    const pinned = b.attesterAdd({ public_key: id.public_key, server_id: id.server_id });
    assert.equal(pinned.server_id, id.server_id);
    const open = b.attesterAdd({ public_key: id.public_key, any_server: true });
    assert.deepEqual(open.replaced && { s: open.replaced.server_id }, { s: id.server_id }, "replacing a pin is reported");
    assert.ok(b.attesterList().some((x) => x.unpinned === true));
    assert.ok(b.trustLog(5).some((l) => /ANY-SERVER/.test(l.subject)), "the audit log says it was unpinned");
  });

  test("a pinned key cannot vouch for another server id (impersonation of a peer)", async () => {
    const id = a.identity();
    b.attesterAdd({ public_key: id.public_key, server_id: "11111111-1111-4111-8111-111111111111" });
    as("alice", () => a.create({ title: "n", body: "b" }));
    const { report } = await importInto(b, exported(a));
    assert.equal(report.attestations!.verified, 0);
    assert.ok(report.attestations!.reasons["server id does not match the trusted key"]);
  });

  test("not_after: exports signed after the cutoff are refused, earlier ones are believed; bad dates are rejected", async () => {
    const id = a.identity();
    assert.throws(() => b.attesterAdd({ public_key: id.public_key, server_id: id.server_id, not_after: "next tuesday" }), /not_after/);
    as("alice", () => a.create({ title: "n", body: "b" }));
    const notes = exported(a);
    b.attesterAdd({ public_key: id.public_key, server_id: id.server_id, not_after: new Date(Date.now() + 3600_000).toISOString() });
    assert.equal((await importInto(new Store(":memory:"), notes)).report.attestations!.verified, 0, "control: a fresh store trusts nobody");
    assert.equal((await importInto(b, notes)).report.attestations!.verified, 1, "signed before the cutoff");
    const b2 = new Store(":memory:");
    b2.attesterAdd({ public_key: id.public_key, server_id: id.server_id, not_after: new Date(Date.now() - 3600_000).toISOString() });
    const r2 = await importInto(b2, notes);
    assert.equal(r2.report.attestations!.verified, 0);
    assert.ok(r2.report.attestations!.reasons["attester key expired"], JSON.stringify(r2.report.attestations));
    b2.close();
  });

  test("v2 signs created_at, source, expires_at, archived_at and rev: changing any of them breaks the signature", async () => {
    const id = a.identity();
    b.attesterAdd({ public_key: id.public_key, server_id: id.server_id });
    as("alice", () => a.create({ title: "n", body: "b", source: "claude" }));
    (a as any).db.prepare("UPDATE notes SET expires_at = ? WHERE id = 1").run(new Date(Date.now() + 86_400_000).toISOString());
    const base = exported(a);
    assert.ok(base[0].expires_at, "the note carries an expiry");
    assert.equal(base[0].attestation!.v, 2);
    assert.ok(base[0].attestation!.exported_at);
    const tweaks: Array<[string, (n: any) => void]> = [
      ["created_at", (n) => (n.created_at = "2001-01-01T00:00:00.000Z")],
      ["source", (n) => (n.source = "somebody-else")],
      ["expires_at", (n) => (n.expires_at = null)],
      ["archived_at", (n) => (n.archived_at = "2030-01-01T00:00:00.000Z")],
      ["rev", (n) => (n.rev = 99)],
      ["written_by", (n) => (n.written_by = "mallory")],
      ["exported_at", (n) => (n.attestation.exported_at = "2001-01-01T00:00:00.000Z")],
    ];
    for (const [name, f] of tweaks) {
      const c = structuredClone(base) as any[];
      f(c[0]);
      const r = await importInto(new Store(":memory:"), c);
      void r;
      const store = new Store(":memory:");
      store.attesterAdd({ public_key: id.public_key, server_id: id.server_id });
      const rep = (await importInto(store, c)).report.attestations!;
      assert.equal(rep.verified, 0, `tampering with ${name} must break the signature`);
      store.close();
    }
    assert.equal((await importInto(b, base)).report.attestations!.verified, 1, "control: the untouched export verifies");
  });

  test("a version-1 attestation (1.4.0 exports) still verifies; a malformed server_id is rejected before anything else", () => {
    const key = loadOrCreateSigningKey(join(dir, "k1"));
    const sid = "22222222-2222-4222-8222-222222222222";
    const rec = { id: 7, namespace: "n", title: "t", body: "b", tags: ["x"], written_by: "w", created_by: "c", updated_at: "2026-01-01T00:00:00.000Z" };
    const hash = contentHash(rec.title, rec.body, rec.tags);
    const bytes = Buffer.from(JSON.stringify(["onememory-attest-v1", sid, rec.id, rec.namespace, hash, "w", "c", rec.updated_at, "", "", []]));
    const att = { v: 1, server_id: sid, key_id: key.keyId, content_hash: hash, sig: sign(null, bytes, key.privateKey).toString("base64url") };
    const trusted = new Map<string, TrustedAttester>([[key.keyId, { public_key: key.publicKey, server_id: sid, label: "old" }]]);
    assert.equal(verifyRecord(att, rec, trusted, null).ok, true, "1.4.0 exports are still accepted");
    // ... but not under a key that has an expiry (a v1 record has no signed export time)
    const exp = new Map<string, TrustedAttester>([[key.keyId, { public_key: key.publicKey, server_id: sid, label: "old", not_after: "2099-01-01T00:00:00Z" }]]);
    const v = verifyRecord(att, rec, exp, null);
    assert.equal(v.ok, false);
    for (const bad of ["not-a-uuid", "\u001b[31mred", "x".repeat(300), ""]) {
      const r = verifyRecord({ ...att, server_id: bad }, rec, trusted, null);
      assert.equal(r.ok, false);
      assert.equal((r as any).reason, "malformed attestation", JSON.stringify(bad));
    }
    assert.equal(isServerId(sid), true);
    assert.equal(isServerId("not-a-uuid"), false);
  });

  test("a verified record under a record id swapped from another note does not verify (id is signed)", () => {
    const key = loadOrCreateSigningKey(join(dir, "k2"));
    const sid = "33333333-3333-4333-8333-333333333333";
    const rec = { id: 1, namespace: "n", title: "t", body: "b", tags: [], written_by: "w", created_by: "w", updated_at: "2026-01-01T00:00:00.000Z" };
    const att = signRecord(key, sid, rec);
    const trusted = new Map<string, TrustedAttester>([[key.keyId, { public_key: key.publicKey, server_id: sid, label: "x" }]]);
    assert.equal(verifyRecord(att, rec, trusted, null).ok, true);
    assert.equal(verifyRecord(att, { ...rec, id: 2 }, trusted, null).ok, false);
    assert.equal(verifyRecord(att, { ...rec, namespace: "other" }, trusted, null).ok, false);
  });

  test("listing the trust state never creates a signing key; the first signed export or `identity` does", () => {
    const k = join(dir, "a", ATTEST_KEY_FILENAME);
    assert.ok(!existsSync(k));
    assert.equal(a.peekIdentity().public_key, undefined);
    a.trustView();
    a.attesterList();
    assert.ok(!existsSync(k), "reading the policy did not mint a key");
    a.identity();
    assert.ok(existsSync(k));
    assert.equal(a.peekIdentity().public_key, a.identity().public_key);
  });

  test("rotate keeps the old key aside, announces it in the log, and the new identity differs; export-key writes a 0600 copy", () => {
    const first = a.identity();
    const copy = join(dir, "backup-key.pem");
    const r0 = a.exportSigningKey(copy);
    assert.equal(r0.key_id, first.key_id);
    if (process.platform !== "win32") assert.equal(statSync(copy).mode & 0o777, 0o600);
    assert.throws(() => a.exportSigningKey(copy), /already exists/);
    assert.equal(readFileSync(copy, "utf8"), readFileSync(join(dir, "a", ATTEST_KEY_FILENAME), "utf8"));
    const r = a.rotateSigningKey();
    assert.equal(r.old_key_id, first.key_id);
    assert.notEqual(r.new_key_id, first.key_id);
    assert.equal(a.identity().key_id, r.new_key_id);
    assert.equal(r.old_key_file, null, "the old PRIVATE key is not kept by default");
    assert.ok(!readdirSync(join(dir, "a")).some((f) => f.endsWith(".old")), "no .old file was left behind");
    // ... but its PUBLIC key is recorded as a retired key of this server, so earlier exports still verify here
    const retired = a.trustedAttesters().get(first.key_id);
    assert.ok(retired, "the retired public key is a trusted key");
    assert.equal(retired!.public_key, first.public_key);
    assert.equal(retired!.server_id, a.serverId(), "pinned to this server's own id");
    assert.ok(a.trustLog(5).some((l) => l.action === "key-rotate"));
  });

  test("the key file is re-tightened to 0600 at startup", { skip: process.platform === "win32" }, async () => {
    a.identity();
    const k = join(dir, "a", ATTEST_KEY_FILENAME);
    chmodSync(k, 0o644);
    const { tightenKeyFile } = await import("../src/attest.js");
    tightenKeyFile(join(dir, "a"));
    assert.equal(statSync(k).mode & 0o777, 0o600);
  });

  test("the parsed public key is cached: 200 verifications under one key build ONE KeyObject (and a second key builds one more)", async () => {
    const { publicKeyBuildCount } = await import("../src/attest.js");
    as("alice", () => a.create({ title: "n", body: "b" }));
    const id = a.identity();
    const notes = exported(a);
    const trusted = new Map([[id.key_id, { public_key: id.public_key, server_id: id.server_id, label: "" }]]);
    const before = publicKeyBuildCount();
    for (let i = 0; i < 200; i++) assert.equal(verifyRecord(notes[0].attestation, notes[0] as any, trusted, null).ok, true);
    const first = publicKeyBuildCount() - before;
    assert.ok(first <= 1, `200 verifications built ${first} KeyObjects: the cache is not working`);
    const after = publicKeyBuildCount();
    for (let i = 0; i < 50; i++) verifyRecord(notes[0].attestation, notes[0] as any, trusted, null);
    assert.equal(publicKeyBuildCount(), after, "a repeat verification builds nothing");
  });

  test("ONEMEMORY_TRUSTED_ATTESTERS: <server_id>=<key> entries or a JSON array; a bare key is reported, never trusted", () => {
    const id = a.identity();
    const ok = parseTrustedAttestersEnvDetailed(`${id.server_id}=${id.public_key}`);
    assert.equal(ok.attesters.length, 1);
    assert.equal(ok.attesters[0].server_id, id.server_id);
    assert.deepEqual(ok.issues, []);
    const bare = parseTrustedAttestersEnvDetailed(id.public_key);
    assert.equal(bare.attesters.length, 0);
    assert.ok(bare.issues.length > 0);
    const json = parseTrustedAttestersEnvDetailed(JSON.stringify([{ public_key: id.public_key, server_id: id.server_id, label: "j" }]));
    assert.equal(json.attesters.length, 1);
    assert.equal(parseTrustedAttestersEnvDetailed("garbage ;; ,,").attesters.length, 0);
  });

  test("a variable that parses to nothing is announced loudly (once)", () => {
    const logged: string[] = [];
    const real = console.error;
    console.error = (...x: unknown[]) => void logged.push(x.join(" "));
    try {
      process.env.ONEMEMORY_TRUSTED_ATTESTERS = "this-is-not-valid";
      b.attesterList();
      b.attesterList();
    } finally {
      console.error = real;
    }
    const warnings = logged.filter((l) => /no usable entry/.test(l));
    assert.equal(warnings.length, 1, logged.join("\n"));
  });
});

describe("F: import robustness", () => {
  test("a corrupt .attest-key, or a key location that cannot exist, does not fail an import of unattested notes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "om-f-"));
    const prev = process.env.ONEMEMORY_ATTEST_KEY_FILE;
    try {
      const a = new Store(":memory:");
      as("alice", () => a.create({ title: "n", body: "b" }));
      const plain = exported(a, false);
      const attested = exported(a, true);
      a.close();
      const store = new Store(join(dir, "s", "state.db"));
      writeFileSync(join(dir, "s", ATTEST_KEY_FILENAME), "not a key");
      const r1 = await importInto(store, plain);
      assert.equal(r1.created.length, 1);
      const r2 = await importInto(store, attested); // an attested payload: no key to verify against, still no crash
      assert.equal(r2.report.attestations!.verified, 0);
      assert.equal(readFileSync(join(dir, "s", ATTEST_KEY_FILENAME), "utf8"), "not a key", "the damaged key was not touched");
      store.close();
      // a location that can never be created
      process.env.ONEMEMORY_ATTEST_KEY_FILE = join(dir, "a-file", "sub", "key");
      writeFileSync(join(dir, "a-file"), "x");
      const s2 = new Store(join(dir, "s2", "state.db"));
      const r3 = await importInto(s2, plain);
      assert.equal(r3.created.length, 1);
      s2.close();
    } finally {
      if (prev === undefined) delete process.env.ONEMEMORY_ATTEST_KEY_FILE;
      else process.env.ONEMEMORY_ATTEST_KEY_FILE = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the CLI prints no terminal escapes or fake commands taken from an import file", () => {
    const dir = mkdtempSync(join(tmpdir(), "om-f2-"));
    try {
      const evilSid = "\u001b[2J\u001b[31mRUN: onememory trust attester-add AAAA --any-server";
      const note = {
        id: 1,
        namespace: "n\u001b[2J",
        title: "t\u001b]0;pwned\u0007",
        body: "b",
        tags: [],
        written_by: "w",
        created_by: "w",
        updated_at: "2026-01-01T00:00:00.000Z",
        attestation: { v: 2, server_id: evilSid, key_id: "0123456789abcdef", content_hash: "x", sig: "y", exported_at: "2026-01-01T00:00:00.000Z" },
      };
      const file = join(dir, "in.json");
      writeFileSync(file, JSON.stringify({ notes: [note] }));
      const r = spawnSync(process.execPath, [CLI, "import", "--file", file], {
        env: { ...process.env, ONEMEMORY_DB_PATH: join(dir, "db", "state.db"), ONEMEMORY_HOME: join(dir, "home") },
        encoding: "utf8",
        timeout: 60000,
      });
      const out = r.stdout + r.stderr;
      assert.ok(!out.includes("\u001b"), `escape sequences reached the terminal: ${JSON.stringify(out)}`);
      assert.ok(!/attester-add AAAA/.test(out), "text from the file is never spliced into a suggested command");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("both export shapes import: the plain {notes} default, the attested envelope, and a bare array", async () => {
    const a = new Store(":memory:");
    try {
      as("alice", () => a.create({ title: "one", body: "1" }));
      as("alice", () => a.create({ title: "two", body: "2" }));
      const plain = exported(a, false);
      for (const shape of [{ notes: plain }, { export: a.exportHeader(), notes: exported(a, true) }, plain]) {
        const dir = mkdtempSync(join(tmpdir(), "om-shape-"));
        try {
          const file = join(dir, "x.json");
          writeFileSync(file, JSON.stringify(shape));
          const r = spawnSync(process.execPath, [CLI, "import", "--file", file, "--json"], {
            env: { ...process.env, ONEMEMORY_DB_PATH: join(dir, "db", "state.db"), ONEMEMORY_HOME: join(dir, "home") },
            encoding: "utf8",
            timeout: 60000,
          });
          assert.equal(r.status, 0, r.stderr);
          assert.equal(JSON.parse(r.stdout).imported, 2);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    } finally {
      a.close();
    }
  });
});

describe("H: export shape", () => {
  test("GET /export is byte-compatible with 1.3.x by default; ?attest=1 adds the header and signatures; /import takes all shapes", async () => {
    const s = new Store(":memory:");
    as("alice", () => s.create({ title: "one", body: "1" }));
    const server = createApiServer(s, [{ token: "a".repeat(32), scope: "admin", label: "adm" }]);
    await new Promise<void>((r) => server.listen(0, r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const h = { Authorization: `Bearer ${"a".repeat(32)}`, "Content-Type": "application/json" };
    try {
      const plainText = await (await fetch(`${base}/export`, { headers: h })).text();
      assert.ok(plainText.startsWith('{"notes":['), plainText.slice(0, 40));
      const plain = JSON.parse(plainText);
      assert.deepEqual(Object.keys(plain), ["notes"]);
      assert.equal(plain.notes[0].attestation, undefined);
      for (const q of ["?attest=0", "?attest=false", "?attest=no", "?attest="]) {
        assert.equal(JSON.parse(await (await fetch(`${base}/export${q}`, { headers: h })).text()).export, undefined, q);
      }
      const att = JSON.parse(await (await fetch(`${base}/export?attest=1`, { headers: h })).text());
      assert.equal(att.export.format, "onememory-export");
      assert.ok(att.notes[0].attestation);
      const t = new Store(":memory:");
      const server2 = createApiServer(t, [{ token: "a".repeat(32), scope: "admin", label: "adm" }]);
      await new Promise<void>((r) => server2.listen(0, r));
      const base2 = `http://127.0.0.1:${(server2.address() as AddressInfo).port}`;
      try {
        for (const body of [plain, att, plain.notes]) {
          const r = await fetch(`${base2}/import`, { method: "POST", headers: h, body: JSON.stringify(body) });
          assert.equal(r.status, 200, await r.text());
        }
        assert.ok(t.list().total >= 1);
      } finally {
        await new Promise<void>((r) => server2.close(() => r()));
        t.close();
      }
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      s.close();
    }
  });
});

describe("I: migration backup", () => {
  test("the backup file is built as .partial and renamed only when verified; a stale partial is swept", async () => {
    const dir = mkdtempSync(join(tmpdir(), "om-bak-"));
    try {
      const path = join(dir, "state.db");
      const { downgradeTo } = await import("./legacy-db.js");
      const s = new Store(path);
      s.create({ title: "n", body: "b" });
      s.close();
      downgradeTo(path, 12);
      // a leftover from a crashed earlier attempt, old enough to be swept
      const stale = path + ".pre-v16-backup.99999.partial";
      writeFileSync(stale, "half a file");
      const old = new Date(Date.now() - 3600_000);
      (await import("node:fs")).utimesSync(stale, old, old);
      const real = console.error;
      const logged: string[] = [];
      console.error = (...x: unknown[]) => void logged.push(x.join(" "));
      try {
        new Store(path).close();
      } finally {
        console.error = real;
      }
      assert.ok(!existsSync(stale), "the stale partial was removed");
      assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith(".partial")), []);
      const bak = path + ".pre-v16-backup";
      assert.ok(Store.verifyBackupFile(bak, 1).ok);
      assert.equal(Store.preMigrationBackups(path).length, 1);
      assert.equal(Store.preMigrationBackups(path)[0].path, bak);
      assert.ok(logged.some((l) => /MOVE|move/.test(l)), "the rollback instructions say to MOVE the file back");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("verifyBackupFile rejects empty, truncated, garbage and a copy with the wrong note count", () => {
    const dir = mkdtempSync(join(tmpdir(), "om-bak2-"));
    try {
      const p = join(dir, "state.db");
      const s = new Store(p);
      s.create({ title: "n", body: "b" });
      s.close();
      assert.ok(Store.verifyBackupFile(p, 1).ok);
      assert.equal(Store.verifyBackupFile(p, 2).ok, false);
      const empty = join(dir, "empty");
      writeFileSync(empty, "");
      assert.equal(Store.verifyBackupFile(empty).ok, false);
      const junk = join(dir, "junk");
      writeFileSync(junk, "SQLite? no.");
      assert.equal(Store.verifyBackupFile(junk).ok, false);
      const trunc = join(dir, "trunc");
      writeFileSync(trunc, readFileSync(p).subarray(0, 600));
      assert.equal(Store.verifyBackupFile(trunc).ok, false);
      assert.equal(Store.verifyBackupFile(join(dir, "missing")).ok, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("doctor reports the pre-upgrade copy; backup --prune-premigration removes it; encrypt enable warns about plaintext copies", async () => {
    const dir = mkdtempSync(join(tmpdir(), "om-bak3-"));
    try {
      const { downgradeTo } = await import("./legacy-db.js");
      const path = join(dir, "db", "state.db");
      const s = new Store(path);
      s.create({ title: "n", body: "b" });
      s.close();
      downgradeTo(path, 12);
      const quiet = console.error;
      console.error = () => {};
      try {
        new Store(path).close();
      } finally {
        console.error = quiet;
      }
      const env = { ...process.env, ONEMEMORY_DB_PATH: path, ONEMEMORY_HOME: join(dir, "home") };
      const run = (...args: string[]) => spawnSync(process.execPath, [CLI, ...args], { env, encoding: "utf8", timeout: 60000 });
      const doc = run("doctor");
      assert.match(doc.stdout + doc.stderr, /pre-upgrade|pre-v15/i, doc.stdout + doc.stderr);
      const bak = path + ".pre-v16-backup";
      assert.ok(existsSync(bak));
      const enc = run("encrypt", "enable");
      assert.equal(enc.status, 0, enc.stderr + enc.stdout);
      assert.match(enc.stdout, /PLAINTEXT/);
      assert.match(enc.stdout, /prune-premigration/);
      const pr = run("backup", "--prune-premigration", "--out", join(dir, "out"));
      assert.equal(pr.status, 0, pr.stderr + pr.stdout);
      assert.ok(!existsSync(bak), "the pre-upgrade copy was removed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("backup: --include-attest-key", () => {
  test("a backup leaves the signing key out by default and says so; the flag includes it with 0600 and a README line", async () => {
    const dir = mkdtempSync(join(tmpdir(), "om-bk-key-"));
    try {
      const path = join(dir, "db", "state.db");
      const s = new Store(path);
      s.create({ title: "n", body: "b" });
      s.identity();
      s.close();
      const env = { ...process.env, ONEMEMORY_DB_PATH: path, ONEMEMORY_HOME: join(dir, "home") };
      const run = (...args: string[]) => spawnSync(process.execPath, [CLI, ...args], { env, encoding: "utf8", timeout: 60000 });
      const o1 = join(dir, "o1");
      const r1 = run("backup", "--out", o1);
      assert.equal(r1.status, 0, r1.stderr);
      const files1: string[] = readdirSync(o1, { recursive: true } as any).map(String);
      assert.ok(!files1.some((f) => f.includes(ATTEST_KEY_FILENAME)), files1.join(","));
      assert.match(r1.stdout, /attestation signing key \(\.attest-key\) was NOT copied/);
      const o2 = join(dir, "o2");
      const r2 = run("backup", "--out", o2, "--include-attest-key");
      assert.match(r2.stdout, /Included the attestation signing key/);
      assert.equal(r2.status, 0, r2.stderr);
      const files2: string[] = readdirSync(o2, { recursive: true } as any).map(String);
      const keyRel = files2.find((f) => f.includes(ATTEST_KEY_FILENAME));
      assert.ok(keyRel, files2.join(","));
      if (process.platform !== "win32") assert.equal(statSync(join(o2, keyRel!)).mode & 0o777, 0o600);
      const readme = files2.find((f) => /README/i.test(f));
      assert.match(readFileSync(join(o2, readme!), "utf8"), /attest/i);
      void mkdirSync;
      const reopened = new Store(path);
      try {
        assert.equal(peekSigningKey(join(dir, "db"))?.keyId, reopened.peekIdentity().key_id);
      } finally {
        reopened.close(); // Windows cannot delete a directory that holds an open database
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("L: CLI help", () => {
  test("`trust --help` and `trust help` print the actions and exit 0; an unknown action prints them and exits 1", () => {
    const dir = mkdtempSync(join(tmpdir(), "om-help-"));
    try {
      const env = { ...process.env, ONEMEMORY_DB_PATH: join(dir, "db", "state.db"), ONEMEMORY_HOME: join(dir, "home") };
      const run = (...a: string[]) => spawnSync(process.execPath, [CLI, "trust", ...a], { env, encoding: "utf8", timeout: 60000 });
      for (const flag of ["--help", "help", "-h"]) {
        const r = run(flag);
        assert.equal(r.status, 0, `${flag}: ${r.stderr}`);
        for (const word of ["attester-add", "distrust", "export-key", "rotate", "--not-after"]) assert.ok(r.stdout.includes(word), `${flag} lacks ${word}`);
      }
      assert.ok(!existsSync(join(dir, "db")), "asking for help does not create a database");
      const bad = run("frobnicate");
      assert.equal(bad.status, 1);
      assert.match(bad.stderr + bad.stdout, /attester-add/);
      const extra = run("distrust", "alice", "stray-arg", "another");
      assert.equal(extra.status, 1);
      assert.match(extra.stderr, /quote|Unexpected/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

