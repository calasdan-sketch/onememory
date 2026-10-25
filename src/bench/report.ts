// Totals, the JSON report and the human table.
import { SUITES, type CheckResult, type Metric, type ScenarioResult, type Suite } from "./types.js";
import type { KnownGap } from "./engine.js";

export const SUITE_NAMES: Record<Suite, string> = {
  stale: "A  Stale memory",
  contradiction: "B  Contradiction recovery",
  isolation: "C  Permission isolation",
  provenance: "D  Provenance retention",
};

/** What this benchmark does NOT show. Printed with every report and included in the JSON. */
export const LIMITS: string[] = [
  "These are deterministic behaviour checks, not a retrieval-quality or semantic benchmark. Search here is keyword search (no embeddings, no model), and the scenarios use made-up, unique words so ranking is never the thing being tested.",
  "Each scenario runs on a fresh store in one process, through the REST API on the loopback interface (plus one MCP tool for merging). It says nothing about speed, large stores, concurrency or a deployed server.",
  "Timestamps are the real clock. Notes that must look old (or already expired) are placed in the past through the admin import path, so such a note is stamped with the importing admin as its writer.",
  "A pass means the behaviour held in that scenario. It is not a proof that no other path leaks; 0 leaks is the count over the probes written here, nothing more.",
  "The scenarios encode one reading of the five provenance fields (source, timestamp, confidence, tenant, deletion policy). Another system may reasonably choose differently; scenario files are plain JSON so they can be changed.",
];

export interface SuiteSummary {
  scenarios: number;
  pass: number;
  fail: number;
  known_gap: number;
  gap_closed: number;
  skipped: number;
  metrics: Record<string, unknown>;
}

export interface Report {
  tool: "onememory-bench";
  version: string;
  adapter: string;
  seed: number;
  ok: boolean;
  summary: { scenarios: number; pass: number; fail: number; known_gap: number; gap_closed: number; skipped: number; checks: number; checks_failed: number };
  suites: Record<Suite, SuiteSummary>;
  scenarios: ScenarioResult[];
  known_gaps: Array<{ id: string; title: string; summary: string; status: string; fixed_in?: string; scenarios: string[] }>;
  limits: string[];
  /** Wall-clock details. Everything outside `run` is identical for two runs with the same seed. */
  run: { elapsed_ms: number; node: string; platform: string };
}

const rate = (n: number, d: number): { count: number; of: number; rate: number | null } => ({ count: n, of: d, rate: d === 0 ? null : Math.round((n / d) * 1000) / 1000 });

function measures(results: ScenarioResult[]): CheckResult[] {
  return results.flatMap((r) => r.checks).filter((c) => c.measure);
}

function suiteMetrics(suite: Suite, results: ScenarioResult[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const fresh = measures(results).filter((c) => c.check === "fresh_answer");
  if (suite === "stale") {
    const withCurrent = fresh.filter((c) => c.measure!.current_at_1 !== undefined);
    out.queries = fresh.length;
    out["stale-hit-rate@1"] = rate(fresh.filter((c) => c.measure!.stale_at_1).length, fresh.length);
    out["stale-hit-rate@5"] = rate(fresh.filter((c) => c.measure!.stale_at_5).length, fresh.length);
    out["unflagged-stale-hit-rate@5"] = rate(fresh.filter((c) => c.measure!.unflagged_stale_at_5).length, fresh.length);
    out["current-recall@1"] = rate(withCurrent.filter((c) => c.measure!.current_at_1).length, withCurrent.length);
  }
  const tagged = (m: Metric): CheckResult[] => results.flatMap((r) => r.checks).filter((c) => c.metric === m);
  const tally = (m: Metric): { checks: number; failed: number } => ({ checks: tagged(m).length, failed: tagged(m).filter((c) => !c.pass).length });
  if (suite === "contradiction") {
    out["resolved-to-correction"] = tally("resolution");
    out["loser-stays-visible-with-provenance"] = tally("loser_visible");
    out["silent-overwrite-protection"] = tally("silent_overwrite");
  }
  if (suite === "isolation") {
    out["leakage-count"] = tally("leak").failed;
    out["leak-probes"] = tally("leak").checks;
    out["unexpected-denials"] = tally("unexpected_denial").failed;
    out["allowed-probes"] = tally("unexpected_denial").checks;
  }
  if (suite === "provenance") {
    const rec = measures(results).filter((c) => c.check === "recoverable");
    out["fields-checked"] = tally("field").checks;
    out["fields-lost"] = tally("field").failed;
    out["fields-kept-only-as-unverified-claim"] = rec.filter((c) => c.measure!.claim_only).length;
  }
  return out;
}

export function buildReport(
  results: ScenarioResult[],
  gaps: Record<string, KnownGap>,
  info: { version: string; adapter: string; seed: number; elapsedMs: number },
  strictGaps: boolean
): Report {
  const count = (s: ScenarioResult["status"], rs: ScenarioResult[] = results): number => rs.filter((r) => r.status === s).length;
  const suites = {} as Record<Suite, SuiteSummary>;
  for (const suite of SUITES) {
    const rs = results.filter((r) => r.suite === suite);
    suites[suite] = {
      scenarios: rs.length,
      pass: count("pass", rs),
      fail: count("fail", rs),
      known_gap: count("known_gap", rs),
      gap_closed: count("gap_closed", rs),
      skipped: count("skipped", rs),
      metrics: suiteMetrics(suite, rs),
    };
  }
  const allChecks = results.flatMap((r) => r.checks);
  const used = [...new Set(results.map((r) => r.known_gap).filter((g): g is string => Boolean(g)))].sort();
  const known = used.map((id) => ({
    id,
    title: gaps[id]?.title ?? id,
    summary: gaps[id]?.summary ?? "",
    status: gaps[id]?.status ?? "roadmap",
    ...(gaps[id]?.fixed_in ? { fixed_in: gaps[id].fixed_in } : {}),
    scenarios: results.filter((r) => r.known_gap === id).map((r) => r.id),
  }));
  const failing = count("fail") + count("gap_closed") + (strictGaps ? count("known_gap") : 0);
  return {
    tool: "onememory-bench",
    version: info.version,
    adapter: info.adapter,
    seed: info.seed,
    ok: failing === 0,
    summary: {
      scenarios: results.length,
      pass: count("pass"),
      fail: count("fail"),
      known_gap: count("known_gap"),
      gap_closed: count("gap_closed"),
      skipped: count("skipped"),
      checks: allChecks.length,
      checks_failed: allChecks.filter((c) => !c.pass).length,
    },
    suites,
    scenarios: results,
    known_gaps: known,
    limits: LIMITS,
    run: { elapsed_ms: info.elapsedMs, node: process.version, platform: process.platform },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Human table

const pad = (s: string, n: number): string => (s.length >= n ? s : s + " ".repeat(n - s.length));
const padL = (s: string, n: number): string => (s.length >= n ? s : " ".repeat(n - s.length) + s);
const pct = (m: unknown): string => {
  const r = m as { count: number; of: number; rate: number | null };
  return r.of === 0 ? "n/a" : `${r.count}/${r.of} (${Math.round((r.rate ?? 0) * 100)}%)`;
};

function headline(suite: Suite, m: Record<string, unknown>): string[] {
  if (suite === "stale")
    return [
      `stale-hit-rate@1 ${pct(m["stale-hit-rate@1"])}   @5 ${pct(m["stale-hit-rate@5"])}   unflagged@5 ${pct(m["unflagged-stale-hit-rate@5"])}`,
      `current-recall@1 ${pct(m["current-recall@1"])}`,
    ];
  if (suite === "contradiction") {
    const t = (k: string): string => {
      const v = m[k] as { checks: number; failed: number };
      return `${v.checks - v.failed}/${v.checks}`;
    };
    return [`resolved to the correction ${t("resolved-to-correction")}   loser still visible with provenance ${t("loser-stays-visible-with-provenance")}   weak overwrite protected ${t("silent-overwrite-protection")}`];
  }
  if (suite === "isolation") return [`leakage count ${m["leakage-count"]} (over ${m["leak-probes"]} probes)   unexpected denials ${m["unexpected-denials"]} (over ${m["allowed-probes"]} allowed actions)`];
  return [`fields checked ${m["fields-checked"]}   lost ${m["fields-lost"]}   kept only as an unverified claim ${m["fields-kept-only-as-unverified-claim"]}`];
}

export function renderTable(r: Report, opts: { verbose?: boolean } = {}): string {
  const L: string[] = [];
  L.push(`onememory bench ${r.version}   adapter: ${r.adapter}   seed: ${r.seed}`);
  L.push("");
  L.push(`${pad("Suite", 28)}${padL("Scenarios", 10)}${padL("Pass", 6)}${padL("Fail", 6)}${padL("Known gap", 11)}${padL("Skipped", 9)}`);
  L.push("-".repeat(70));
  for (const suite of SUITES) {
    const s = r.suites[suite];
    L.push(`${pad(SUITE_NAMES[suite], 28)}${padL(String(s.scenarios), 10)}${padL(String(s.pass), 6)}${padL(String(s.fail + s.gap_closed), 6)}${padL(String(s.known_gap), 11)}${padL(String(s.skipped), 9)}`);
  }
  L.push("-".repeat(70));
  const t = r.summary;
  L.push(`${pad("Total", 28)}${padL(String(t.scenarios), 10)}${padL(String(t.pass), 6)}${padL(String(t.fail + t.gap_closed), 6)}${padL(String(t.known_gap), 11)}${padL(String(t.skipped), 9)}`);
  L.push("");
  L.push("Key numbers");
  for (const suite of SUITES) {
    const lines = headline(suite, r.suites[suite].metrics);
    L.push(`  ${SUITE_NAMES[suite]}`);
    for (const l of lines) L.push(`      ${l}`);
  }
  const bad = r.scenarios.filter((s) => s.status === "fail" || s.status === "gap_closed");
  if (bad.length) {
    L.push("");
    L.push("FAILURES");
    for (const s of bad) {
      L.push(`  ${s.id} ${s.title}${s.status === "gap_closed" ? "  [known gap now PASSES: remove its known_gap marker]" : ""}`);
      if (s.error) L.push(`      error: ${s.error}`);
      for (const c of s.checks.filter((x) => !x.pass || s.status === "gap_closed" && opts.verbose)) {
        L.push(`      - ${c.desc}`);
        L.push(`          expected: ${c.expected}`);
        L.push(`          actual:   ${c.actual}`);
      }
    }
  }
  if (r.known_gaps.length) {
    L.push("");
    L.push("KNOWN GAPS (OneMemory does not do this yet; these scenarios fail on purpose and do not fail the run)");
    for (const g of r.known_gaps) {
      L.push(`  ${g.id} ${g.title} [${g.status}${g.fixed_in ? ` in ${g.fixed_in}` : ""}] scenarios: ${g.scenarios.join(", ")}`);
      if (opts.verbose) L.push(`      ${g.summary}`);
    }
    if (opts.verbose) {
      for (const s of r.scenarios.filter((x) => x.status === "known_gap")) {
        L.push(`  ${s.id} ${s.title}`);
        for (const c of s.checks.filter((x) => !x.pass)) {
          L.push(`      - ${c.desc}`);
          L.push(`          expected: ${c.expected}`);
          L.push(`          actual:   ${c.actual}`);
        }
      }
    }
  }
  const skipped = r.scenarios.filter((s) => s.status === "skipped");
  if (skipped.length) {
    L.push("");
    L.push(`SKIPPED (${skipped.length}): ${skipped.map((s) => s.id).join(", ")} -- ${skipped[0].skipped_reason}`);
  }
  L.push("");
  L.push("What this does not show");
  for (const l of r.limits) L.push(`  - ${l}`);
  L.push("");
  L.push(
    r.ok
      ? `RESULT: PASS (${t.pass} passed, ${t.known_gap} known gap${t.known_gap === 1 ? "" : "s"}, ${t.skipped} skipped) in ${(r.run.elapsed_ms / 1000).toFixed(1)}s`
      : `RESULT: FAIL (${t.fail + t.gap_closed} scenario${t.fail + t.gap_closed === 1 ? "" : "s"} failed) in ${(r.run.elapsed_ms / 1000).toFixed(1)}s`
  );
  return L.join("\n");
}
