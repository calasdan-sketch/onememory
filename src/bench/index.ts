// `onememory bench`: run the benchmark. Also what `npm run bench` calls.
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PACKAGE_VERSION } from "../config.js";
import { loadKnownGaps, loadScenarios, runScenario, type KnownGap } from "./engine.js";
import { OneMemoryAdapter } from "./onememory-adapter.js";
import { buildReport, renderTable, type Report } from "./report.js";
import { SUITES, type MemoryAdapter, type Scenario, type Suite } from "./types.js";

export interface BenchOptions {
  /** Folder holding the scenario `*.json` files (and known-gaps.json). Default: the one shipped with the package. */
  dir?: string;
  seed?: number;
  /** Only these suites. */
  suites?: Suite[];
  /** Only scenarios whose id starts with one of these (for example "A01" or "B"). */
  only?: string[];
  /** Treat known gaps as failures too. */
  strictGaps?: boolean;
  /** Test a different system: pass your own adapter. Default: OneMemory. */
  adapter?: MemoryAdapter;
  /** Called after each scenario, for progress output. */
  onResult?: (id: string, status: string) => void;
}

/** bench/scenarios next to the package root: dist/src/bench -> ../../../bench/scenarios. */
export function defaultScenarioDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "..", "..", "bench", "scenarios");
}

export async function runBench(opts: BenchOptions = {}): Promise<{ report: Report; scenarios: Scenario[] }> {
  const dir = opts.dir ?? defaultScenarioDir();
  if (!existsSync(dir)) throw new Error(`scenario folder not found: ${dir}`);
  const gaps: Record<string, KnownGap> = loadKnownGaps(dir);
  let scenarios = loadScenarios(dir, gaps);
  if (opts.suites?.length) scenarios = scenarios.filter((s) => opts.suites!.includes(s.suite));
  if (opts.only?.length) scenarios = scenarios.filter((s) => opts.only!.some((p) => s.id.startsWith(p)));
  if (scenarios.length === 0) throw new Error("no scenarios match that selection");
  const seed = opts.seed ?? 1;
  const adapter = opts.adapter ?? new OneMemoryAdapter();

  // The benchmark must not read your own configuration (tokens, encryption key, retention, staleness thresholds):
  // hide every ONEMEMORY_* variable while it runs, then put them back.
  const saved: Record<string, string> = {};
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("ONEMEMORY_")) {
      saved[k] = process.env[k] as string;
      delete process.env[k];
    }
  }
  const started = Date.now();
  const results = [];
  try {
    for (const s of scenarios) {
      const r = await runScenario(adapter, s, gaps, { seed });
      results.push(r);
      opts.onResult?.(r.id, r.status);
    }
  } finally {
    await adapter.close().catch(() => undefined);
    for (const [k, v] of Object.entries(saved)) process.env[k] = v;
  }
  const report = buildReport(results, gaps, { version: PACKAGE_VERSION, adapter: adapter.name, seed, elapsedMs: Date.now() - started }, opts.strictGaps === true);
  return { report, scenarios };
}

export const BENCH_USAGE = [
  "onememory bench [options]",
  "",
  "  Run the provenance benchmark against a throwaway store (your own data is never touched):",
  "  stale memory, contradiction recovery, permission isolation, provenance retention, memory poisoning.",
  "  Offline, no model, same result every run. Exits 1 if any scenario fails.",
  "",
  "  --json               Print the full machine-readable report (every scenario, expected vs actual).",
  "  --suite <name>       Only one suite: stale, contradiction, isolation, provenance or poison (repeatable).",
  "  --only <id-prefix>   Only scenarios whose id starts with this, e.g. B or A07 (repeatable).",
  "  --seed <n>           Seed for the made-up words in the scenarios (default 1).",
  "  --dir <folder>       Use your own scenario folder (default: the bundled bench/scenarios).",
  "  --strict-gaps        Also fail on known gaps (default: they are listed but do not fail the run).",
  "  --verbose            Show every failing check, including the known gaps, with expected vs actual.",
  "  --help               This text.",
].join("\n");

/** Parse argv (the part after the word `bench`), run, print, and return the process exit code. */
export async function benchMain(argv: string[], out: (s: string) => void = console.log): Promise<number> {
  const o: BenchOptions = {};
  let json = false;
  let verbose = false;
  const take = (i: number, flag: string): string => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw new Error(`${flag} needs a value`);
    return v;
  };
  try {
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (a === "--help" || a === "-h") {
        out(BENCH_USAGE);
        return 0;
      } else if (a === "--json") json = true;
      else if (a === "--verbose") verbose = true;
      else if (a === "--strict-gaps") o.strictGaps = true;
      else if (a === "--seed") {
        const n = Number(take(i++, a));
        if (!Number.isInteger(n) || n < 0 || n > 2 ** 31) throw new Error("--seed must be a whole number from 0 to 2147483648");
        o.seed = n;
      } else if (a === "--suite") {
        const v = take(i++, a) as Suite;
        if (!SUITES.includes(v)) throw new Error(`--suite must be one of ${SUITES.join(", ")}`);
        (o.suites ??= []).push(v);
      } else if (a === "--only") (o.only ??= []).push(take(i++, a));
      else if (a === "--dir") o.dir = resolve(take(i++, a));
      else if (a === "--") continue;
      else throw new Error(`unknown option ${a} (try: onememory bench --help)`);
    }
    const { report } = await runBench(o);
    out(json ? JSON.stringify(report, null, 2) : renderTable(report, { verbose }));
    return report.ok ? 0 : 1;
  } catch (e) {
    console.error(`bench: ${(e as Error).message}`);
    return 2;
  }
}

