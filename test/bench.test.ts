// `onememory bench`: the provenance benchmark. These tests check the benchmark itself: that the scenario set is
// well-formed and big enough, that the engine judges honestly (a wrong system FAILS), that a run is repeatable, and
// that the CLI behaves (exit codes, JSON, no side effects). The scenarios' own verdicts on OneMemory are checked once,
// in "against OneMemory".
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { PROJECT_ROOT, PACKAGE_VERSION } from "../src/config.js";
import { benchMain, defaultScenarioDir, runBench } from "../src/bench/index.js";
import { loadKnownGaps, loadScenarios, runScenario, seededWord, validateScenario } from "../src/bench/engine.js";
import { OneMemoryAdapter, normalizeNote } from "../src/bench/onememory-adapter.js";
import { SUITES, type BenchNote, type Capability, type MemoryAdapter, type OpResult, type Scenario, type SearchOpts, type UpdateInput, type WorldSpec, type WriteInput } from "../src/bench/types.js";
import type { Report } from "../src/bench/report.js";

const DIR = defaultScenarioDir();
const gaps = loadKnownGaps(DIR);
const read = (rel: string): string => readFileSync(join(PROJECT_ROOT, rel), "utf8");
const tidy = (p: string): void => {
  try {
    rmSync(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    /* a leftover temp folder is harmless */
  }
};

/**
 * A tiny in-memory memory system, to prove the adapter interface is enough to run the benchmark against something that
 * is not OneMemory, and to prove the benchmark FAILS a system that behaves badly.
 */
class ToyAdapter implements MemoryAdapter {
  readonly name = "toy";
  readonly capabilities: ReadonlySet<Capability> = new Set<Capability>(["read", "list", "tenants"]);
  private notes = new Map<string, BenchNote & { ns: string }>();
  private actors: WorldSpec["actors"] = {};
  private next = 1;
  constructor(
    private readonly opt: { isolate?: boolean; replaceOnUpdate?: boolean; denyEverything?: boolean; noDelete?: boolean } = {}
  ) {
    this.opt = { isolate: true, replaceOnUpdate: true, ...opt };
  }
  async open(world: WorldSpec): Promise<void> {
    this.actors = world.actors;
    this.notes.clear();
    this.next = 1;
  }
  async close(): Promise<void> {}
  private ns(actor: string): string {
    return this.actors[actor].namespace ?? "";
  }
  private visible(actor: string, n: BenchNote & { ns: string }): boolean {
    return !this.opt.isolate || n.ns === this.ns(actor);
  }
  private deny(actor: string, need: "write" | "admin"): boolean {
    const s = this.actors[actor].scope;
    return Boolean(this.opt.denyEverything) || (need === "write" ? s === "read" : s !== "admin");
  }
  async write(actor: string, input: WriteInput): Promise<OpResult> {
    if (this.deny(actor, "write")) return { outcome: "denied", detail: "no" };
    const id = String(this.next++);
    // A careless system trusts the namespace the client names.
    const ns = this.opt.isolate ? this.ns(actor) : (input.namespace ?? this.ns(actor));
    const n = { id, title: input.title, body: input.body, tags: input.tags ?? [], writer: this.actors[actor].writer, creator: this.actors[actor].writer, namespace: ns, ns, rev: 1 };
    this.notes.set(id, n);
    return { outcome: "ok", note: { ...n } };
  }
  async update(actor: string, id: string, patch: UpdateInput): Promise<OpResult> {
    if (this.deny(actor, "write")) return { outcome: "denied", detail: "no" };
    const cur = this.notes.get(id);
    if (!cur || !this.visible(actor, cur)) return { outcome: "not_found", detail: "not found" };
    if (this.opt.replaceOnUpdate) {
      Object.assign(cur, { ...(patch.title !== undefined ? { title: patch.title } : {}), ...(patch.body !== undefined ? { body: patch.body } : {}), writer: this.actors[actor].writer });
      return { outcome: "ok", note: { ...cur } };
    }
    // A system that keeps the old version around as a separate, equally findable note.
    const nid = String(this.next++);
    this.notes.set(nid, { ...cur, id: nid, title: patch.title ?? cur.title, body: patch.body ?? cur.body });
    return { outcome: "ok", note: { ...cur } };
  }
  async delete(actor: string, id: string): Promise<OpResult> {
    if (this.deny(actor, "admin")) return { outcome: "denied", detail: "no" };
    const cur = this.notes.get(id);
    if (!cur || !this.visible(actor, cur)) return { outcome: "not_found", detail: "not found" };
    if (!this.opt.noDelete) this.notes.delete(id);
    return { outcome: "ok" };
  }
  async search(actor: string, query: string, opts: SearchOpts = {}): Promise<OpResult> {
    if (this.opt.denyEverything) return { outcome: "denied", detail: "no" };
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const hits = [...this.notes.values()]
      .filter((n) => this.visible(actor, n))
      .filter((n) => words.every((w) => `${n.title} ${n.body}`.toLowerCase().includes(w)))
      .reverse() // newest first
      .slice(0, opts.limit ?? 10)
      .map((n) => ({ ...n }));
    return { outcome: "ok", hits };
  }
  async read(actor: string, id: string): Promise<OpResult> {
    const cur = this.notes.get(id);
    if (!cur || !this.visible(actor, cur)) return { outcome: "not_found", detail: "not found" };
    return { outcome: "ok", note: { ...cur } };
  }
  async list(actor: string, opts: { namespace?: string } = {}): Promise<OpResult> {
    const ns = this.opt.isolate ? this.ns(actor) : (opts.namespace ?? this.ns(actor));
    return { outcome: "ok", notes: [...this.notes.values()].filter((n) => n.ns === ns).map((n) => ({ ...n })) };
  }
}

const sc = (over: Partial<Scenario> & Pick<Scenario, "steps" | "expect">): Scenario => ({
  id: "A99",
  suite: "stale",
  title: "t",
  what: "w",
  actors: { alice: { scope: "write" } },
  ...over,
});

describe("scenario files", () => {
  const all = loadScenarios(DIR, gaps);
  const bySuite = (s: string): Scenario[] => all.filter((x) => x.suite === s);

  test("enough scenarios per suite (A,B,C >= 15, D >= 8)", () => {
    assert.ok(bySuite("stale").length >= 15, "A");
    assert.ok(bySuite("contradiction").length >= 15, "B");
    assert.ok(bySuite("isolation").length >= 15, "C");
    assert.ok(bySuite("provenance").length >= 8, "D");
  });

  test("ids are unique and carry the suite letter", () => {
    const letter: Record<string, string> = { stale: "A", contradiction: "B", isolation: "C", provenance: "D" };
    assert.equal(new Set(all.map((s) => s.id)).size, all.length);
    for (const s of all) assert.equal(s.id[0], letter[s.suite], `${s.id} is in suite ${s.suite}`);
  });

  test("file names start with the scenario id", () => {
    const files = readdirSync(DIR).filter((f) => f.endsWith(".json") && f !== "known-gaps.json");
    for (const s of all) assert.ok(files.some((f) => f.startsWith(`${s.id}-`)), `${s.id} has a file named ${s.id}-*.json`);
  });

  test("every known_gap marker is described, and every described gap is used", () => {
    const used = new Set(all.map((s) => s.known_gap).filter(Boolean));
    for (const g of used) assert.ok(gaps[g as string], `${g} is in known-gaps.json`);
    for (const g of Object.keys(gaps)) {
      assert.ok(used.has(g) || gaps[g].status === "fixed", `${g} is used by a scenario (or marked fixed)`);
      assert.ok(gaps[g].title && gaps[g].summary, `${g} has a title and a summary`);
    }
  });

  test("every scenario explains itself in plain words", () => {
    for (const s of all) {
      assert.ok(s.what.length > 30, `${s.id} has a real 'what'`);
      assert.ok(s.expect.every((c) => c.desc.length > 8), `${s.id} checks all have a description`);
    }
  });

  test("the isolation suite tags its probes so leakage and denials can be counted", () => {
    const tags = bySuite("isolation").flatMap((s) => s.expect.map((c) => c.metric));
    assert.ok(tags.filter((t) => t === "leak").length >= 30);
    assert.ok(tags.filter((t) => t === "unexpected_denial").length >= 10);
  });

  test("a scenario that breaks the format is rejected with a clear message", () => {
    const ok = sc({ steps: [{ op: "write", as: "alice", ref: "n", title: "t", body: "b" }, { op: "search", as: "alice", q: "t", id: "s" }], expect: [{ check: "top", step: "s", ref: "n", desc: "the note is first" }] });
    assert.equal(validateScenario(ok), null);
    assert.match(validateScenario({ ...ok, id: "x1" }) ?? "", /id must look like/);
    assert.match(validateScenario({ ...ok, suite: "nope" as never }) ?? "", /suite must be/);
    assert.match(validateScenario({ ...ok, steps: [{ op: "explode", as: "alice" } as never] }) ?? "", /unknown op/);
    assert.match(validateScenario({ ...ok, steps: [{ op: "write", as: "ghost", ref: "n", title: "t", body: "b" }] }) ?? "", /must name one of the actors/);
    assert.match(validateScenario({ ...ok, steps: [{ op: "update", as: "alice", ref: "zzz", body: "x" }] }) ?? "", /was not created/);
    assert.match(validateScenario({ ...ok, expect: [{ check: "top", step: "nope", ref: "n", desc: "d" }] }) ?? "", /does not exist/);
    assert.match(validateScenario({ ...ok, expect: [] }) ?? "", /expect is required/);
    assert.match(validateScenario({ ...ok, known_gap: "GAP-NOPE" }, gaps) ?? "", /not listed/);
  });

  test("loadScenarios names the broken file", () => {
    const d = mkdtempSync(join(tmpdir(), "om-benchload-"));
    try {
      writeFileSync(join(d, "A01-bad.json"), "{ not json");
      assert.throws(() => loadScenarios(d), /A01-bad\.json: not valid JSON/);
    } finally {
      tidy(d);
    }
  });
});

describe("seeded words", () => {
  test("same inputs, same word; any input changed, a different word", () => {
    assert.equal(seededWord(1, "A01", "x"), seededWord(1, "A01", "x"));
    assert.notEqual(seededWord(1, "A01", "x"), seededWord(2, "A01", "x"));
    assert.notEqual(seededWord(1, "A01", "x"), seededWord(1, "A02", "x"));
    assert.notEqual(seededWord(1, "A01", "x"), seededWord(1, "A01", "y"));
  });
  test("words are plain lowercase letters plus two digits (safe for keyword search)", () => {
    for (let i = 0; i < 200; i++) assert.match(seededWord(i, "B05", `w${i}`), /^[a-z]{8}[0-9]{2}$/);
  });
});

describe("the engine judges honestly (toy systems)", () => {
  const staleIds = ["A01", "A02", "A14", "A18"];
  const run = (adapter: MemoryAdapter, only: string[]): Promise<Report> => runBench({ adapter, only }).then((r) => r.report);

  test("a system that replaces a note on update passes the in-place stale scenarios", async () => {
    const r = await run(new ToyAdapter(), staleIds);
    assert.equal(r.summary.fail, 0, JSON.stringify(r.scenarios.filter((s) => s.status === "fail")));
    assert.equal(r.summary.pass, 4);
    assert.equal(r.ok, true);
  });

  test("a system that keeps the old version after an update FAILS and shows stale hits", async () => {
    const r = await run(new ToyAdapter({ replaceOnUpdate: false }), ["A01", "A14", "A18"]);
    assert.equal(r.ok, false);
    assert.ok(r.summary.fail >= 3);
    const m = r.suites.stale.metrics as Record<string, { count: number; of: number }>;
    assert.ok(m["stale-hit-rate@5"].count >= 3, "old values show up in the top 5");
    assert.ok(m["stale-hit-rate@5"].count >= m["stale-hit-rate@1"].count);
    const unflagged = r.suites.stale.metrics["unflagged-stale-hit-rate@5"] as { count: number };
    assert.ok(unflagged.count >= 3, "and nothing flags them as stale");
  });

  test("a system that never deletes FAILS the delete scenario", async () => {
    const r = await run(new ToyAdapter({ noDelete: true }), ["A02"]);
    assert.equal(r.scenarios[0].status, "fail");
  });

  test("a system without tenant isolation leaks and the leak count is not zero", async () => {
    const good = await run(new ToyAdapter(), ["C01", "C02", "C03", "C04", "C05", "C06"]);
    assert.equal(good.suites.isolation.metrics["leakage-count"], 0);
    assert.equal(good.ok, true);
    const bad = await run(new ToyAdapter({ isolate: false }), ["C01", "C02", "C03", "C04", "C05", "C06"]);
    assert.equal(bad.ok, false);
    assert.ok((bad.suites.isolation.metrics["leakage-count"] as number) >= 4, `leaks: ${bad.suites.isolation.metrics["leakage-count"]}`);
  });

  test("a system that refuses everything shows unexpected denials", async () => {
    const r = await run(new ToyAdapter({ denyEverything: true }), ["C01", "C05"]);
    assert.ok((r.suites.isolation.metrics["unexpected-denials"] as number) >= 1);
    assert.equal(r.ok, false);
  });

  test("scenarios needing operations the adapter lacks are SKIPPED, never passed", async () => {
    const r = await run(new ToyAdapter(), ["A04", "A12", "B04", "D01"]);
    assert.equal(r.summary.skipped, 4);
    assert.equal(r.summary.pass, 0);
    assert.match(r.scenarios[0].skipped_reason ?? "", /lacks: restore/);
    assert.equal(r.ok, true, "a skip is not a failure");
  });

  test("each check type can fail (no check is a rubber stamp)", async () => {
    const toy = new ToyAdapter();
    const write = { op: "write", as: "alice", ref: "n", title: "t{{k}}", body: "b{{k}}" } as const;
    const search = { op: "search", as: "alice", q: "t{{k}}", id: "s" } as const;
    const cases: Array<[string, Partial<Scenario> & Pick<Scenario, "steps" | "expect">]> = [
      ["outcome", { steps: [write, search], expect: [{ check: "outcome", step: "s", is: "denied", desc: "wrongly expects a refusal" }] }],
      ["top", { steps: [write, { op: "write", as: "alice", ref: "m", title: "t{{k}} more", body: "x" }, search], expect: [{ check: "top", step: "s", ref: "n", desc: "newest-first toy puts m first" }] }],
      ["has", { steps: [write, { op: "search", as: "alice", q: "nothingmatches", id: "s" }], expect: [{ check: "has", step: "s", ref: "n", desc: "n should be found" }] }],
      ["lacks", { steps: [write, search], expect: [{ check: "lacks", step: "s", ref: "n", desc: "n should be absent" }] }],
      ["hit_count", { steps: [write, search], expect: [{ check: "hit_count", step: "s", is: 3, desc: "three hits" }] }],
      ["field", { steps: [write, { op: "read", as: "alice", ref: "n", id: "r" }], expect: [{ check: "field", step: "r", path: "writer", equals: "someone-else", desc: "writer mismatch" }] }],
      ["no_text", { steps: [write, search], expect: [{ check: "no_text", step: "s", text: "b{{k}}", desc: "body must not appear" }] }],
      ["contains_text", { steps: [write, search], expect: [{ check: "contains_text", step: "s", text: "zzz-not-there", desc: "text must appear" }] }],
      ["fresh_answer", { steps: [write, search], expect: [{ check: "fresh_answer", step: "s", current: "n", stale_text: ["b{{k}}"], desc: "old text is in the current note" }] }],
      ["recoverable", { steps: [write, { op: "read", as: "alice", ref: "n", id: "r" }], expect: [{ check: "recoverable", step: "r", value: "nobody", verified_in: ["writer"], claim_in: ["claimed_writer"], desc: "lost value" }] }],
      ["same_response", { steps: [write, { op: "read", as: "alice", ref: "n", id: "r1" }, { op: "read", as: "alice", ref: "n", id: "r2" }], expect: [{ check: "same_response", steps: ["r1", "r2"], desc: "two successes are not 'refused identically' unless same; here both ok so equal" }] }],
    ];
    for (const [name, c] of cases) {
      const s = sc({ ...c, needs: ["read"] });
      assert.equal(validateScenario(s), null, `${name}: scenario is valid`);
      const r = await runScenario(toy, s, gaps, { seed: 1 });
      if (name === "same_response") assert.equal(r.status, "pass", "identical responses pass");
      else assert.equal(r.status, "fail", `${name} must fail on a wrong expectation (got ${r.status}: ${JSON.stringify(r.checks.map((x) => x.actual))})`);
    }
  });

  test("recoverable tells verified, claim-only and lost apart", async () => {
    class W extends ToyAdapter {
      override async read(): Promise<OpResult> {
        return { outcome: "ok", note: { id: "1", title: "t", body: "b", writer: "importer", claimed_writer: "alice" } };
      }
    }
    const base = { id: "D99", suite: "provenance" as const, title: "t", what: "w", actors: { alice: { scope: "write" as const } } };
    const steps = [{ op: "write" as const, as: "alice", ref: "n", title: "t", body: "b" }, { op: "read" as const, as: "alice", ref: "n", id: "r" }];
    const mk = (value: string, is?: string): Scenario => ({ ...base, steps, needs: ["read"], expect: [{ check: "recoverable", step: "r", value, ...(is ? { is } : {}), verified_in: ["writer"], claim_in: ["claimed_writer"], metric: "field", desc: "where is the writer" }] });
    const verified = await runScenario(new W(), mk("importer"), gaps, { seed: 1 });
    assert.equal(verified.status, "pass");
    const claimStrict = await runScenario(new W(), mk("alice"), gaps, { seed: 1 });
    assert.equal(claimStrict.status, "fail", "a claim does not satisfy a request for a verified value");
    assert.match(claimStrict.checks[0].actual, /unverified claim/);
    const claimOk = await runScenario(new W(), mk("alice", "claim"), gaps, { seed: 1 });
    assert.equal(claimOk.status, "pass");
    assert.equal(claimOk.checks[0].measure?.claim_only, true);
    const lost = await runScenario(new W(), mk("nobody", "claim"), gaps, { seed: 1 });
    assert.equal(lost.status, "fail");
    assert.equal(lost.checks[0].measure?.lost, true);
  });

  test("a known gap that now passes is reported as gap_closed and fails the run", async () => {
    const d = mkdtempSync(join(tmpdir(), "om-benchgap-"));
    try {
      const a01 = readdirSync(DIR).find((f) => f.startsWith("A01-"))!;
      const s = JSON.parse(readFileSync(join(DIR, a01), "utf8")) as Scenario;
      writeFileSync(join(d, a01), JSON.stringify({ ...s, known_gap: "GAP-X" }));
      writeFileSync(join(d, "known-gaps.json"), JSON.stringify({ "GAP-X": { title: "x", summary: "y", status: "roadmap" } }));
      const { report } = await runBench({ dir: d });
      assert.equal(report.scenarios[0].status, "gap_closed");
      assert.equal(report.ok, false);
      const out: string[] = [];
      assert.equal(await benchMain(["--dir", d], (x) => out.push(x)), 1);
      assert.match(out.join("\n"), /known gap now PASSES/);
    } finally {
      tidy(d);
    }
  });

  test("a known gap that still fails does not fail the run, unless --strict-gaps", async () => {
    const d = mkdtempSync(join(tmpdir(), "om-benchgap2-"));
    try {
      const f = readdirSync(DIR).find((x) => x.startsWith("A01-"))!;
      const s = JSON.parse(readFileSync(join(DIR, f), "utf8")) as Scenario;
      s.known_gap = "GAP-X";
      s.expect.push({ check: "outcome", step: "now", is: "denied", desc: "deliberately wrong, so this gap stays open" });
      writeFileSync(join(d, f), JSON.stringify(s));
      writeFileSync(join(d, "known-gaps.json"), JSON.stringify({ "GAP-X": { title: "x", summary: "y", status: "roadmap" } }));
      const out: string[] = [];
      assert.equal(await benchMain(["--dir", d], (x) => out.push(x)), 0);
      assert.match(out.join("\n"), /KNOWN GAPS/);
      assert.equal(await benchMain(["--dir", d, "--strict-gaps"], () => undefined), 1);
    } finally {
      tidy(d);
    }
  });
});

describe("against OneMemory", () => {
  let first: Report;
  let second: Report;
  let other: Report;
  before(async () => {
    first = (await runBench({ seed: 1 })).report;
    second = (await runBench({ seed: 1 })).report;
    other = (await runBench({ seed: 99 })).report;
  });

  test("the run passes and nothing is skipped or unexpectedly closed", () => {
    const failing = first.scenarios.filter((s) => s.status === "fail" || s.status === "gap_closed" || s.status === "skipped");
    assert.deepEqual(failing.map((s) => `${s.id} ${s.status} ${s.error ?? ""}`), []);
    assert.equal(first.ok, true);
  });

  test("scenario counts per suite meet the targets", () => {
    assert.ok(first.suites.stale.scenarios >= 15);
    assert.ok(first.suites.contradiction.scenarios >= 15);
    assert.ok(first.suites.isolation.scenarios >= 15);
    assert.ok(first.suites.provenance.scenarios >= 8);
    assert.equal(first.summary.scenarios, SUITES.reduce((n, s) => n + first.suites[s].scenarios, 0));
  });

  test("permission isolation: zero leaks and zero unexpected denials", () => {
    assert.equal(first.suites.isolation.metrics["leakage-count"], 0);
    assert.equal(first.suites.isolation.metrics["unexpected-denials"], 0);
    assert.ok((first.suites.isolation.metrics["leak-probes"] as number) >= 30, "enough probes behind the zero");
  });

  test("the stale-memory numbers are reported and the gaps behind them are named", () => {
    const m = first.suites.stale.metrics as Record<string, { count: number; of: number; rate: number }>;
    assert.ok(m["stale-hit-rate@1"].of >= 12, "enough stale queries behind the rate");
    assert.ok(m["current-recall@1"].of >= 10);
    for (const k of ["stale-hit-rate@1", "stale-hit-rate@5", "current-recall@1"]) assert.ok(k in m, k);
    // Every scenario that fails does so under a named, documented gap.
    for (const s of first.scenarios.filter((x) => x.status === "known_gap")) assert.ok(s.known_gap && gaps[s.known_gap], s.id);
  });

  test("the four gaps found in 1.5.0 are recorded as fixed in 1.6.0, and no scenario is marked as a gap any more", () => {
    for (const id of ["GAP-SUPERSEDE", "GAP-RECENCY", "GAP-HISTORY", "GAP-CONFIDENCE"]) {
      assert.equal(gaps[id].status, "fixed", id);
      assert.equal(gaps[id].fixed_in, "1.6.0", id);
    }
    assert.deepEqual(first.known_gaps, []);
    assert.equal(first.summary.known_gap, 0);
    assert.ok(first.scenarios.every((s) => s.known_gap === undefined));
  });

  test("the scenarios that used to be gaps now pass, and say what they test", () => {
    const status = new Map(first.scenarios.map((s) => [s.id, s.status]));
    for (const id of ["A05", "A06", "A10", "A11", "A20", "B03", "B08", "B09", "D10"]) assert.equal(status.get(id), "pass", id);
  });

  test("the new replace, history, trust-guard and confidence scenarios exist and pass", () => {
    const want = ["A21", "A22", "A23", "A24", "A25", "A26", "A27", "A28", "A29", "A30", "A31", "A32", "B21", "B22", "B23", "B24", "B25", "B26", "B27", "B28", "B29", "B30", "B31", "C22", "C23", "C24", "C25", "C26", "C27", "D15", "D16", "D17", "D18", "D19"];
    const status = new Map(first.scenarios.map((s) => [s.id, s.status]));
    for (const id of want) assert.equal(status.get(id), "pass", id);
  });

  test("two runs with the same seed give the same report (apart from the clock)", () => {
    const strip = (r: Report): string => JSON.stringify({ ...r, run: undefined });
    assert.equal(strip(first), strip(second));
  });

  test("another seed gives the same verdicts but different words", () => {
    assert.deepEqual(other.scenarios.map((s) => [s.id, s.status]), first.scenarios.map((s) => [s.id, s.status]));
    assert.notEqual(JSON.stringify(other.scenarios[0].checks), JSON.stringify(first.scenarios[0].checks));
  });

  test("the JSON has every scenario with expected and actual for every check", () => {
    assert.equal(first.scenarios.length, first.summary.scenarios);
    for (const s of first.scenarios) {
      assert.ok(s.checks.length > 0, `${s.id} ran checks`);
      for (const c of s.checks) assert.ok(c.expected && c.actual && typeof c.pass === "boolean", `${s.id}: ${c.desc}`);
    }
    assert.ok(first.limits.length >= 4);
    assert.equal(first.tool, "onememory-bench");
    assert.equal(first.version, PACKAGE_VERSION);
  });

  test("the JSON contains no secrets: no token and no server id", () => {
    const text = JSON.stringify(first);
    assert.ok(!/bench-[a-z0-9]+-[0-9a-f]{32}/i.test(text), "no bearer token");
    assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.test(text), "no server uuid");
  });

  test("provenance: fields lost are counted and none is lost any more (the confidence field is kept)", () => {
    const m = first.suites.provenance.metrics;
    assert.ok((m["fields-checked"] as number) >= 30);
    assert.equal(m["fields-lost"], 0);
    const lost = first.scenarios.flatMap((s) => s.checks.filter((c) => c.metric === "field" && !c.pass).map(() => s.id));
    assert.deepEqual(lost, []);
  });
});

describe("the real scenarios catch a broken OneMemory (mutation checks)", () => {
  /** OneMemory with its tenant pins removed: every token can see every tenant. */
  class NoTenants extends OneMemoryAdapter {
    override async open(world: WorldSpec): Promise<void> {
      const actors: WorldSpec["actors"] = {};
      for (const [k, a] of Object.entries(world.actors)) actors[k] = { scope: a.scope, writer: a.writer, server: a.server };
      return super.open({ actors, grants: {} });
    }
  }
  /** OneMemory where every token is an admin: scopes mean nothing. */
  class AllAdmin extends OneMemoryAdapter {
    override async open(world: WorldSpec): Promise<void> {
      const actors: WorldSpec["actors"] = {};
      for (const [k, a] of Object.entries(world.actors)) actors[k] = { ...a, scope: "admin" };
      return super.open({ actors, grants: world.grants });
    }
  }

  test("with tenant pins removed, the isolation suite reports leaks", async () => {
    const { report } = await runBench({ adapter: new NoTenants(), suites: ["isolation"] });
    assert.equal(report.ok, false);
    assert.ok((report.suites.isolation.metrics["leakage-count"] as number) >= 10, `leaks: ${report.suites.isolation.metrics["leakage-count"]}`);
    const failed = new Set(report.scenarios.filter((s) => s.status === "fail").map((s) => s.id));
    for (const id of ["C01", "C03", "C04", "C05", "C06", "C07", "C11", "C20"]) assert.ok(failed.has(id), `${id} must fail when tenants are not isolated`);
  });

  test("with every token an admin, the scope and trust scenarios fail", async () => {
    const { report } = await runBench({ adapter: new AllAdmin(), only: ["B06", "B10", "C09", "C10"] });
    assert.equal(report.ok, false);
    const failed = new Set(report.scenarios.filter((s) => s.status === "fail").map((s) => s.id));
    for (const id of ["B06", "B10", "C09"]) assert.ok(failed.has(id), `${id} must fail when scopes are not enforced`);
  });
});

describe("the replace scenarios catch a broken OneMemory (mutation checks)", () => {
  /** OneMemory whose "preview" quietly does the replacement too: asking 'are you sure?' must never change anything. */
  class PreviewThatActs extends OneMemoryAdapter {
    override async supersedePreview(actor: string, input: Parameters<NonNullable<OneMemoryAdapter["supersedePreview"]>>[1]): Promise<OpResult> {
      const p = await super.supersedePreview(actor, input);
      if (p.outcome === "ok") await super.supersedeConfirm(actor, { token: String(p.data?.token), ...(input.new_note ? { new_note: input.new_note } : {}) });
      return p;
    }
  }
  test("a preview that acts fails the 'a preview changes nothing' scenario", async () => {
    const { report } = await runBench({ adapter: new PreviewThatActs(), only: ["A21"] });
    assert.equal(report.scenarios[0].status, "fail");
  });

  /** OneMemory with history switched off underneath: nothing is kept. */
  class NoHistory extends OneMemoryAdapter {
    override async open(world: WorldSpec): Promise<void> {
      await super.open(world);
      process.env.ONEMEMORY_HISTORY_VERSIONS = "0"; // after open: open() clears leftovers first
    }
    override async close(): Promise<void> {
      delete process.env.ONEMEMORY_HISTORY_VERSIONS;
      return super.close();
    }
  }
  test("with history switched off, the history scenarios fail", async () => {
    const { report } = await runBench({ adapter: new NoHistory(), only: ["B08", "B09", "B25"] });
    const failed = new Set(report.scenarios.filter((s) => s.status === "fail").map((s) => s.id));
    for (const id of ["B08", "B09", "B25"]) assert.ok(failed.has(id), id);
  });

  test("an adapter without the replace operations has those scenarios SKIPPED, never passed", async () => {
    class Plain extends OneMemoryAdapter {
      override readonly capabilities: ReadonlySet<Capability> = new Set<Capability>(["read", "list"]);
    }
    const { report } = await runBench({ adapter: new Plain(), only: ["A21", "B25"] });
    assert.deepEqual(report.scenarios.map((s) => s.status), ["skipped", "skipped"]);
  });
});

describe("scenario validation (replace steps)", () => {
  const base = (): Scenario => sc({ steps: [{ op: "write", as: "alice", ref: "a", title: "t", body: "b" }, { op: "write", as: "alice", ref: "b", title: "u", body: "c" }], expect: [{ check: "top", step: "s", ref: "a", desc: "the note is first" }] });
  test("a confirm must name an earlier preview, and a preview needs exactly one replacement", () => {
    const s = base();
    s.steps.push({ op: "supersede_confirm", as: "alice", id: "c", from: "nope" });
    assert.match(validateScenario(s) ?? "", /earlier supersede_preview/);
    s.steps[2] = { op: "supersede_preview", as: "alice", id: "p", old: ["a"] } as never;
    assert.match(validateScenario(s) ?? "", /exactly one of new_note or new_ref/);
    s.steps[2] = { op: "supersede_preview", as: "alice", id: "p", old: ["a"], new_ref: "b" };
    s.steps[3] = { op: "supersede_confirm", as: "alice", id: "c", from: "p" };
    s.expect = [{ check: "outcome", step: "c", is: "ok", desc: "the confirm works" }];
    assert.equal(validateScenario(s), null);
  });
  test("a preview must name earlier notes", () => {
    const s = base();
    s.steps.push({ op: "supersede_preview", as: "alice", id: "p", old: ["ghost"], new_ref: "b" });
    assert.match(validateScenario(s) ?? "", /old must name earlier writes/);
  });
});

describe("scenario validation (more)", () => {
  const base = (): Scenario => sc({ steps: [{ op: "write", as: "alice", ref: "n", title: "t", body: "b" }, { op: "read", as: "alice", ref: "n", id: "r" }, { op: "search", as: "alice", q: "t", id: "s" }], expect: [{ check: "top", step: "s", ref: "n", desc: "the note is first" }] });
  test("a compare-and-swap step must point at an earlier read", () => {
    const s = base();
    s.steps.push({ op: "update", as: "alice", ref: "n", body: "x", if_rev_of: "nope" });
    assert.match(validateScenario(s) ?? "", /if_rev_of/);
    s.steps[s.steps.length - 1] = { op: "update", as: "alice", ref: "n", body: "x", if_rev_of: "r" };
    assert.equal(validateScenario(s), null);
  });
  test("same_as and differs_from must name real steps and refs", () => {
    const s = base();
    s.expect = [{ check: "field", step: "r", path: "title", same_as: { step: "ghost", path: "title" }, desc: "compare" }];
    assert.match(validateScenario(s) ?? "", /step "ghost" does not exist/);
    s.expect = [{ check: "field", step: "r", path: "title", differs_from: { step: "r", of: "ghost", path: "title" }, desc: "compare" }];
    assert.match(validateScenario(s) ?? "", /ref "ghost"/);
  });
  test("distractors are bounded, and known_gap cannot be a prototype key", () => {
    assert.match(validateScenario({ ...base(), distractors: 100000 }) ?? "", /distractors/);
    assert.match(validateScenario({ ...base(), known_gap: "toString" }, gaps) ?? "", /not listed/);
  });
});

describe("the OneMemory adapter", () => {
  test("opens a fresh store, closes it, and leaves nothing behind (safe to close twice)", async () => {
    const a = new OneMemoryAdapter();
    await a.open({ actors: { alice: { scope: "write", writer: "alice", server: "main" } }, grants: {} });
    const dir = (a as unknown as { dir: string }).dir;
    assert.ok(existsSync(dir), "the work folder exists while open");
    const w = await a.write("alice", { title: "hello", body: "world" });
    assert.equal(w.outcome, "ok");
    await a.close();
    assert.ok(!existsSync(dir), "the work folder is gone after close");
    await a.close();
  });

  test("a second open starts empty (no state leaks between scenarios)", async () => {
    const a = new OneMemoryAdapter();
    const world: WorldSpec = { actors: { alice: { scope: "write", writer: "alice", server: "main" } }, grants: {} };
    await a.open(world);
    await a.write("alice", { title: "kept only in the first store", body: "zzfirstonly" });
    await a.open(world);
    const r = await a.search("alice", "zzfirstonly");
    assert.equal(r.hits?.length, 0);
    await a.close();
  });

  test("scope and tenant refusals map to the shared outcome words", async () => {
    const a = new OneMemoryAdapter();
    await a.open({
      actors: {
        viewer: { scope: "read", writer: "viewer", server: "main", namespace: "t1" },
        writer: { scope: "write", writer: "writer", server: "main", namespace: "t1" },
        other: { scope: "write", writer: "other", server: "main", namespace: "t2" },
      },
      grants: {},
    });
    const w = await a.write("writer", { title: "mine", body: "x" });
    assert.equal((await a.write("viewer", { title: "no", body: "x" })).outcome, "denied");
    assert.equal((await a.read("other", w.note!.id)).outcome, "not_found");
    assert.equal((await a.update("other", w.note!.id, { body: "y" })).outcome, "not_found");
    assert.equal((await a.delete("writer", w.note!.id)).outcome, "denied", "a write token cannot delete");
    await a.close();
  });

  test("a note placed in the past reads as stale, and an expired one is swept", async () => {
    const a = new OneMemoryAdapter();
    await a.open({ actors: { boss: { scope: "admin", writer: "boss", server: "main" } }, grants: {} });
    const old = await a.write("boss", { title: "old thing", body: "ancient", age_days: 200 });
    assert.equal(old.outcome, "ok");
    const s = await a.search("boss", "ancient");
    assert.equal(s.hits?.[0].stale, true);
    const gone = await a.write("boss", { title: "expired thing", body: "shortlived", expires_in_days: -1 });
    assert.equal(gone.outcome, "ok");
    assert.equal((await a.search("boss", "shortlived")).hits?.length, 1, "still visible before the sweep");
    assert.equal((await a.sweep("boss")).outcome, "ok");
    assert.equal((await a.search("boss", "shortlived")).hits?.length, 0);
    await a.close();
  });

  test("normalizeNote maps OneMemory's fields to the benchmark's words", () => {
    const n: BenchNote = normalizeNote({
      id: 7, title: "t", body: "b", namespace: "ns", tags: ["x"], source: "s", written_by: "w", created_by: "c", created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-02T00:00:00.000Z", expires_at: "2026-02-01T00:00:00.000Z", stale: true, distrusted: true, imported_unverified: true,
      imported_written_by: "claimed", attested_writer: "att", merged_from_writers: ["a", "b"], rev: 3,
    });
    assert.deepEqual(
      { id: n.id, writer: n.writer, creator: n.creator, claimed: n.claimed_writer, att: n.attested_writer, taint: n.taint, stale: n.stale, d: n.distrusted, u: n.imported_unverified, rev: n.rev },
      { id: "7", writer: "w", creator: "c", claimed: "claimed", att: "att", taint: ["a", "b"], stale: true, d: true, u: true, rev: 3 }
    );
    assert.equal(normalizeNote({ id: 1, title: "t", body: "b" }).confidence, undefined);
  });
});

describe("bench() entry point", () => {
  test("hides ONEMEMORY_* settings while it runs and puts them back", async () => {
    process.env.ONEMEMORY_TOKEN = "must-survive";
    process.env.ONEMEMORY_RATE_MAX = "1"; // would make the server refuse almost everything if it leaked in
    try {
      const { report } = await runBench({ only: ["A01"] });
      assert.equal(report.scenarios[0].status, "pass");
      assert.equal(process.env.ONEMEMORY_TOKEN, "must-survive");
      assert.equal(process.env.ONEMEMORY_RATE_MAX, "1");
    } finally {
      delete process.env.ONEMEMORY_TOKEN;
      delete process.env.ONEMEMORY_RATE_MAX;
    }
  });

  test("usage mistakes exit 2 and do not run anything", async () => {
    const err = console.error;
    console.error = () => undefined;
    try {
      assert.equal(await benchMain(["--suite", "nope"], () => undefined), 2);
      assert.equal(await benchMain(["--seed", "abc"], () => undefined), 2);
      assert.equal(await benchMain(["--bogus"], () => undefined), 2);
      assert.equal(await benchMain(["--only", "Z99"], () => undefined), 2);
      assert.equal(await benchMain(["--dir", join(tmpdir(), "does-not-exist-bench")], () => undefined), 2);
      assert.equal(await benchMain(["--seed"], () => undefined), 2);
    } finally {
      console.error = err;
    }
  });

  test("--help prints usage and exits 0", async () => {
    const out: string[] = [];
    assert.equal(await benchMain(["--help"], (s) => out.push(s)), 0);
    assert.match(out.join("\n"), /--strict-gaps/);
  });

  test("--suite and --only narrow the run", async () => {
    const out: string[] = [];
    assert.equal(await benchMain(["--suite", "provenance", "--only", "D0", "--json"], (s) => out.push(s)), 0);
    const j = JSON.parse(out.join("")) as Report;
    assert.ok(j.scenarios.length > 0 && j.scenarios.every((s) => s.id.startsWith("D0")));
    assert.equal(j.suites.stale.scenarios, 0);
  });

  test("the human table has the four suites, the numbers, the gaps and the limits", async () => {
    const out: string[] = [];
    await benchMain(["--suite", "stale"], (s) => out.push(s));
    const t = out.join("\n");
    for (const w of ["Stale memory", "stale-hit-rate@1", "current-recall@1", "What this does not show", "RESULT:"]) assert.ok(t.includes(w), w);
  });
});

describe("the command line", () => {
  const cli = join(PROJECT_ROOT, "dist", "src", "cli.js");
  let home: string;
  before(() => {
    home = mkdtempSync(join(tmpdir(), "om-benchcli-"));
  });
  after(() => tidy(home));
  const env = (): NodeJS.ProcessEnv => ({ ...process.env, ONEMEMORY_HOME: home, ONEMEMORY_DB_PATH: join(home, "state.db") });

  test("`onememory bench --json` exits 0, prints one JSON document, and never touches the data directory", () => {
    const r = spawnSync(process.execPath, [cli, "bench", "--suite", "isolation", "--json"], { env: env(), encoding: "utf8", timeout: 120000, maxBuffer: 20 * 1024 * 1024 });
    assert.equal(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout) as Report;
    assert.equal(j.ok, true);
    assert.equal(j.suites.isolation.metrics["leakage-count"], 0);
    assert.deepEqual(readdirSync(home), [], "the user's data directory was not created into");
  });

  test("a failing scenario folder gives exit code 1 from the real command", () => {
    const d = mkdtempSync(join(tmpdir(), "om-benchfail-"));
    try {
      const a01 = readdirSync(DIR).find((f) => f.startsWith("A01-"))!;
      const s = JSON.parse(readFileSync(join(DIR, a01), "utf8")) as Scenario;
      s.expect.push({ check: "outcome", step: "now", is: "denied", desc: "deliberately wrong" });
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, a01), JSON.stringify(s));
      const r = spawnSync(process.execPath, [cli, "bench", "--dir", d], { env: env(), encoding: "utf8", timeout: 120000 });
      assert.equal(r.status, 1, r.stdout + r.stderr);
      assert.match(r.stdout, /FAILURES/);
      assert.match(r.stdout, /deliberately wrong/);
    } finally {
      tidy(d);
    }
  });

  test("`onememory bench --help` and the main help mention the command", () => {
    const h = spawnSync(process.execPath, [cli, "bench", "--help"], { env: env(), encoding: "utf8", timeout: 60000 });
    assert.equal(h.status, 0);
    assert.match(h.stdout, /provenance benchmark/);
    const main = spawnSync(process.execPath, [cli, "help"], { env: env(), encoding: "utf8", timeout: 60000 });
    assert.match(main.stdout, /\n  bench /);
  });

  test("an unknown option is a usage error (exit 2) with a hint", () => {
    const r = spawnSync(process.execPath, [cli, "bench", "--nope"], { env: env(), encoding: "utf8", timeout: 60000 });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /unknown option --nope/);
  });
});

describe("shipping and docs", () => {
  test("the package is 1.7.2 and ships the scenarios and the new docs", () => {
    const pkg = JSON.parse(read("package.json")) as { version: string; files: string[]; scripts: Record<string, string> };
    assert.equal(pkg.version, "1.7.2");
    assert.equal(PACKAGE_VERSION, "1.7.2");
    assert.ok(pkg.files.includes("bench/scenarios/*.json"));
    assert.ok(pkg.files.includes("docs/*.md"));
    assert.match(pkg.scripts.bench, /bench/);
    assert.ok(existsSync(join(PROJECT_ROOT, "docs", "BENCHMARK.md")));
  });

  test("README has a Benchmark section that says what it does not measure, and a known-gaps table with every gap", () => {
    const readme = read("README.md");
    assert.match(readme, /^## Benchmark/m);
    const section = readme.slice(readme.indexOf("## Benchmark"));
    assert.match(section, /not a retrieval|not a semantic|does not measure/i);
    assert.match(section, /known gaps/i);
    for (const id of Object.keys(gaps)) assert.ok(section.includes(id), `README lists ${id}`);
  });

  test("the README table states the real scenario counts per suite", () => {
    const all = loadScenarios(DIR, gaps);
    const section = read("README.md").slice(read("README.md").indexOf("## Benchmark"));
    const rows: Array<[string, string]> = [["A  Stale memory", "stale"], ["B  Contradiction recovery", "contradiction"], ["C  Permission isolation", "isolation"], ["D  Provenance retention", "provenance"]];
    for (const [label, suite] of rows) {
      const m = new RegExp(`\\| ${label} \\| (\\d+) \\|`).exec(section);
      assert.ok(m, `README row for ${label}`);
      assert.equal(Number(m![1]), all.filter((s) => s.suite === suite).length, `${label} count`);
    }
    assert.match(read("CHANGELOG.md"), new RegExp(`${all.length} deterministic`), "CHANGELOG states the total");
  });

  test("docs/BENCHMARK.md explains the scenario format and the adapter", () => {
    const doc = read("docs/BENCHMARK.md");
    for (const w of ["MemoryAdapter", "known_gap", "fresh_answer", "write", "update", "delete", "search", "--json", "--strict-gaps", "capabilities"]) assert.ok(doc.includes(w), w);
  });

  test("the CHANGELOG has 1.6.0 and 1.5.0 entries", () => {
    assert.match(read("CHANGELOG.md"), /^## \[1\.6\.0\]/m);
    assert.match(read("CHANGELOG.md"), /^## \[1\.5\.0\]/m);
  });
});
