// `onememory bench --longmemeval | --locomo`: a retrieval benchmark on public long-conversation datasets.
// No LLM, no judge: each conversation is loaded into a fresh throwaway Store, the question is searched, and the
// retrieved sessions/turns are scored against the dataset's gold evidence (recall@k, nDCG@10, MRR).
import { BENCH_HOME } from "./retrieval-env.js"; // first: isolate ONEMEMORY_HOME before config.js loads
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { DATA_DIR, DB_PATH } from "../config.js";
import { Store } from "../store.js";
import { LIMITS } from "../security.js";
import { embed, embeddingsEnabled } from "../embeddings.js";
import { maybeEmbed, runRelevantSearch, runSearch } from "../search-service.js";
import { aggregate, dedupe, percentile, scoreQuestion, type MetricRow, type QuestionScore } from "./retrieval-metrics.js";

const SOURCES = {
  longmemeval: {
    file: "longmemeval_s_cleaned.json",
    url: "https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json",
  },
  locomo: { file: "locomo10.json", url: "https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json" },
} as const;
type Dataset = keyof typeof SOURCES;
type Granularity = "session" | "turn";
const CACHE_DIR = join(homedir(), ".cache", "onememory-bench");
const TOP = 50;

interface Doc {
  unit: string; // what gold ids refer to after mapping (session id, or dialog id)
  title: string;
  body: string;
  date?: string;
}
interface Question {
  id: string;
  type: string;
  query: string;
  gold: Set<string>;
}
interface Haystack {
  docs: Doc[];
  questions: Question[];
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

/** "2023/05/20 (Sat) 02:21" -> ISO, or undefined. */
export function lmeDate(s: string): string | undefined {
  const m = /^(\d{4})\/(\d{2})\/(\d{2})\D+(\d{2}):(\d{2})/.exec(s);
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00.000Z` : undefined;
}

/** LoCoMo "1:56 pm on 8 May, 2023" -> ISO, or undefined. */
export function locomoDate(s: string): string | undefined {
  const m = /(\d{1,2}):(\d{2})\s*(am|pm)\s+on\s+(\d{1,2})\s+(\w+),?\s+(\d{4})/i.exec(s);
  if (!m) return undefined;
  const h = (Number(m[1]) % 12) + (m[3].toLowerCase() === "pm" ? 12 : 0);
  const t = Date.parse(`${m[4]} ${m[5]} ${m[6]} ${h}:${m[2]}:00 UTC`);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}

const turnText = (t: unknown): string => `${str(rec(t).role)}: ${str(rec(t).content)}`;

/** LongMemEval-S: one haystack per question; `_abs` (abstention) questions have no gold session and are skipped. */
export function longMemEvalHaystacks(data: unknown, g: Granularity): Haystack[] {
  const out: Haystack[] = [];
  for (const raw of arr(data)) {
    const q = rec(raw);
    const id = str(q.question_id);
    const gold = new Set(arr(q.answer_session_ids).map(str).filter(Boolean));
    if (!id || id.endsWith("_abs") || gold.size === 0 || !str(q.question)) continue;
    const ids = arr(q.haystack_session_ids).map(str);
    const dates = arr(q.haystack_dates).map(str);
    const docs: Doc[] = [];
    arr(q.haystack_sessions).forEach((s, i) => {
      const sid = ids[i] || `session_${i}`;
      const date = lmeDate(dates[i] ?? "");
      const turns = arr(s);
      if (g === "session") docs.push({ unit: sid, title: sid, body: turns.map(turnText).join("\n"), date });
      else turns.forEach((t, j) => docs.push({ unit: sid, title: `${sid}#${j}`, body: turnText(t), date }));
    });
    out.push({ docs, questions: [{ id, type: str(q.question_type) || "unknown", query: str(q.question), gold }] });
  }
  return out;
}

/** LoCoMo: one haystack per conversation, all its QAs. Gold = evidence dialog ids ("D1:3"), or their sessions ("D1"). */
export function locomoHaystacks(data: unknown, g: Granularity): Haystack[] {
  const out: Haystack[] = [];
  for (const raw of arr(data)) {
    const sample = rec(raw);
    const conv = rec(sample.conversation);
    const docs: Doc[] = [];
    for (const key of Object.keys(conv)) {
      const m = /^session_(\d+)$/.exec(key);
      if (!m) continue;
      const sess = `D${m[1]}`;
      const date = locomoDate(str(conv[`${key}_date_time`]));
      const lines = arr(conv[key]).map((t) => {
        const r = rec(t);
        const cap = str(r.blip_caption);
        return { dia: str(r.dia_id), text: `${str(r.speaker)}: ${str(r.text)}${cap ? ` [shares image: ${cap}]` : ""}` };
      });
      if (g === "session") docs.push({ unit: sess, title: sess, body: lines.map((l) => l.text).join("\n"), date });
      else for (const l of lines) if (l.dia) docs.push({ unit: l.dia, title: l.dia, body: l.text, date });
    }
    const sid = str(sample.sample_id) || `conv${out.length}`;
    const questions: Question[] = [];
    arr(sample.qa).forEach((raw2, i) => {
      const qa = rec(raw2);
      // Evidence is sometimes "D8:6; D9:17" in one string: split it.
      const ev = arr(qa.evidence).flatMap((e) => str(e).split(/[;,\s]+/)).filter((e) => /^D\d+:\d+$/.test(e));
      const gold = new Set(g === "session" ? ev.map((e) => e.split(":")[0]) : ev);
      if (gold.size === 0 || !str(qa.question)) return;
      questions.push({ id: `${sid}#${i}`, type: `category ${String(qa.category ?? "?")}`, query: str(qa.question), gold });
    });
    if (questions.length) out.push({ docs, questions });
  }
  return out;
}

/** Download `url` to `dest` once (streamed, progress on stderr). Returns dest. */
async function fetchOnce(url: string, dest: string): Promise<string> {
  if (existsSync(dest)) return dest;
  mkdirSync(CACHE_DIR, { recursive: true });
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status} for ${url}`);
  const total = Number(res.headers.get("content-length")) || 0;
  let got = 0;
  let last = 0;
  const progress = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      got += chunk.length;
      if (got - last > 8 << 20 || got === total) {
        last = got;
        process.stderr.write(`\rdownloading ${dest}: ${(got / 1e6).toFixed(0)}${total ? ` / ${(total / 1e6).toFixed(0)}` : ""} MB`);
      }
      cb(null, chunk);
    },
  });
  const part = `${dest}.part`;
  await pipeline(Readable.fromWeb(res.body as import("node:stream/web").ReadableStream), progress, createWriteStream(part));
  process.stderr.write("\n");
  renameSync(part, dest);
  return dest;
}

export interface RetrievalOptions {
  dataset: Dataset;
  data?: string;
  limit?: number;
  mode: "keyword" | "hybrid";
  granularity: Granularity;
}

interface ModeResult {
  metrics: Record<string, MetricRow>;
  latencyMs: { p50: number; p95: number };
}

export interface RetrievalReport {
  dataset: string;
  granularity: Granularity;
  questions: number;
  haystacks: number;
  notes: number;
  truncatedBodies: number;
  indexMs: { total: number; p50PerHaystack: number };
  keyword: ModeResult;
  relevant: ModeResult;
  hybrid: ModeResult | { skipped: string };
  node: string;
  date: string;
}

/** Refuse to run unless config resolved the database inside the throwaway home (see retrieval-env.ts). */
function assertIsolated(): void {
  const home = resolve(BENCH_HOME);
  if (resolve(DATA_DIR) !== home || !resolve(DB_PATH).startsWith(home + sep)) {
    throw new Error(`refusing to run: data path ${DB_PATH} is not inside the benchmark temp folder ${home}`);
  }
}

export async function runRetrieval(o: RetrievalOptions): Promise<RetrievalReport> {
  assertIsolated();
  const file = o.data ?? (await fetchOnce(SOURCES[o.dataset].url, join(CACHE_DIR, SOURCES[o.dataset].file)));
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8")); // untrusted: parsed as data only
  let stacks = o.dataset === "longmemeval" ? longMemEvalHaystacks(parsed, o.granularity) : locomoHaystacks(parsed, o.granularity);
  if (o.limit) stacks = stacks.slice(0, o.limit);

  let hybridSkip = "";
  if (o.mode === "hybrid") {
    if (!embeddingsEnabled()) hybridSkip = "embeddings are off (set ONEMEMORY_EMBEDDINGS=on and an embedding server)";
    else if (!(await embed("probe"))) hybridSkip = "embedding endpoint did not return a vector";
  }
  const useHybrid = o.mode === "hybrid" && !hybridSkip;

  const kw: Array<{ type: string; score: QuestionScore }> = [];
  const hy: typeof kw = [];
  const rel: typeof kw = [];
  const relLat: number[] = [];
  const kwLat: number[] = [];
  const hyLat: number[] = [];
  const indexTimes: number[] = [];
  let notes = 0;
  let truncated = 0;
  let nq = 0;
  for (const [i, h] of stacks.entries()) {
    const dir = join(BENCH_HOME, `h${i}`);
    const store = new Store(join(dir, "state.db"));
    try {
      const unitOf = new Map<number, string>();
      const t0 = performance.now();
      const created = store.transaction(() =>
        h.docs.map((d) => {
          if (d.body.length > LIMITS.body) truncated++;
          const n = store.create(
            { title: d.title, body: d.body.slice(0, LIMITS.body), created_at: d.date },
            { skipEdges: true, lint: "none", updatedAt: d.date }
          );
          unitOf.set(n.id, d.unit);
          return n;
        })
      );
      if (useHybrid) for (const n of created) await maybeEmbed(store, n);
      indexTimes.push(performance.now() - t0);
      notes += created.length;
      const units = (ids: number[]): string[] => dedupe(ids.map((id) => unitOf.get(id) ?? ""));
      for (const q of h.questions) {
        nq++;
        let t = performance.now();
        const hits = store.searchRanked(q.query, { limit: TOP });
        kwLat.push(performance.now() - t);
        kw.push({ type: q.type, score: scoreQuestion(units(hits.map((x) => x.note.id)), q.gold) });
        t = performance.now();
        const relHits = (await runRelevantSearch(store, q.query, { limit: TOP })).results;
        relLat.push(performance.now() - t);
        rel.push({ type: q.type, score: scoreQuestion(units(relHits.map((n) => n.id)), q.gold) });
        if (useHybrid) {
          t = performance.now();
          const res = await runSearch(store, q.query, { mode: "hybrid", limit: TOP });
          hyLat.push(performance.now() - t);
          hy.push({ type: q.type, score: scoreQuestion(units(res.map((n) => n.id)), q.gold) });
        }
      }
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
    if ((i + 1) % 25 === 0 || i + 1 === stacks.length) process.stderr.write(`${i + 1}/${stacks.length} haystacks, ${nq} questions\n`);
  }
  const lat = (xs: number[]): { p50: number; p95: number } => ({ p50: percentile(xs, 50), p95: percentile(xs, 95) });
  return {
    dataset: o.dataset === "longmemeval" ? "LongMemEval-S (cleaned)" : "LoCoMo-10",
    granularity: o.granularity,
    questions: nq,
    haystacks: stacks.length,
    notes,
    truncatedBodies: truncated,
    indexMs: { total: indexTimes.reduce((a, b) => a + b, 0), p50PerHaystack: percentile(indexTimes, 50) },
    keyword: { metrics: aggregate(kw), latencyMs: lat(kwLat) },
    relevant: { metrics: aggregate(rel), latencyMs: lat(relLat) },
    hybrid: useHybrid ? { metrics: aggregate(hy), latencyMs: lat(hyLat) } : { skipped: hybridSkip || "not requested (--mode hybrid)" },
    node: process.version,
    date: new Date().toISOString(),
  };
}

const pct = (x: number): string => (x * 100).toFixed(1).padStart(6);

export function renderRetrieval(r: RetrievalReport): string {
  const lines = [
    `${r.dataset}, ${r.granularity} granularity: ${r.questions} questions over ${r.haystacks} haystacks, ${r.notes} notes` +
      (r.truncatedBodies ? ` (${r.truncatedBodies} bodies cut to ${LIMITS.body} chars)` : ""),
    `indexing: ${(r.indexMs.total / 1000).toFixed(1)} s total, p50 ${r.indexMs.p50PerHaystack.toFixed(1)} ms per haystack`,
  ];
  const table = (name: string, m: ModeResult): void => {
    lines.push("", `${name} (search p50 ${m.latencyMs.p50.toFixed(2)} ms, p95 ${m.latencyMs.p95.toFixed(2)} ms)`);
    lines.push(`${"type".padEnd(28)}${"n".padStart(5)}    R@5   R@10 Rall@10 nDCG@10    MRR`);
    const keys = ["all", ...Object.keys(m.metrics).filter((k) => k !== "all").sort()];
    for (const k of keys) {
      const x = m.metrics[k];
      lines.push(`${k.padEnd(28)}${String(x.n).padStart(5)} ${pct(x.r5)} ${pct(x.r10)}  ${pct(x.rAll10)}  ${pct(x.ndcg10)} ${pct(x.mrr)}`);
    }
  };
  table("keyword (store.searchRanked: FTS5 BM25, every query word must match)", r.keyword);
  table("relevant (runRelevantSearch / state_relevant: stop-words dropped, any keyword matches, RRF)", r.relevant);
  if ("skipped" in r.hybrid) lines.push("", `hybrid: skipped, ${r.hybrid.skipped}`);
  else table("hybrid (runSearch mode=hybrid, BM25 + embeddings RRF)", r.hybrid);
  return lines.join("\n");
}

/** argv: the bench arguments; returns the exit code. */
export async function retrievalMain(argv: string[], out: (s: string) => void = console.log): Promise<number> {
  try {
    const o: RetrievalOptions = { dataset: argv.includes("--locomo") ? "locomo" : "longmemeval", mode: "keyword", granularity: "session" };
    if (argv.includes("--locomo")) o.granularity = "turn";
    let json = false;
    const take = (i: number, flag: string): string => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) throw new Error(`${flag} needs a value`);
      return v;
    };
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (a === "--longmemeval" || a === "--locomo" || a === "--") continue;
      else if (a === "--json") json = true;
      else if (a === "--data") o.data = resolve(take(i++, a));
      else if (a === "--limit") {
        const n = Number(take(i++, a));
        if (!Number.isInteger(n) || n < 1) throw new Error("--limit must be a whole number above 0");
        o.limit = n;
      } else if (a === "--mode") {
        const v = take(i++, a);
        if (v !== "keyword" && v !== "hybrid") throw new Error("--mode must be keyword or hybrid");
        o.mode = v;
      } else if (a === "--granularity") {
        const v = take(i++, a);
        if (v !== "session" && v !== "turn") throw new Error("--granularity must be session or turn");
        o.granularity = v;
      } else throw new Error(`unknown option ${a} (try: onememory bench --help)`);
    }
    const r = await runRetrieval(o);
    out(json ? JSON.stringify(r, null, 2) : renderRetrieval(r));
    return 0;
  } catch (e) {
    console.error(`bench: ${(e as Error).message}`);
    return 2;
  }
}
