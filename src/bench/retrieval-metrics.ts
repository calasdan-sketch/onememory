// Retrieval metrics for `onememory bench --longmemeval / --locomo`. Pure functions, no I/O.
// `ranked` is the retrieved unit ids best-first (already de-duplicated); `gold` the ids that answer the question.

/** 1 when any gold id is in the top k, else 0. */
export function recallAny(ranked: string[], gold: Set<string>, k: number): number {
  return ranked.slice(0, k).some((u) => gold.has(u)) ? 1 : 0;
}

/** 1 when every gold id is in the top k, else 0. */
export function recallAll(ranked: string[], gold: Set<string>, k: number): number {
  const top = new Set(ranked.slice(0, k));
  return [...gold].every((g) => top.has(g)) ? 1 : 0;
}

/** Binary-relevance nDCG@k. */
export function ndcg(ranked: string[], gold: Set<string>, k: number): number {
  let dcg = 0;
  ranked.slice(0, k).forEach((u, i) => {
    if (gold.has(u)) dcg += 1 / Math.log2(i + 2);
  });
  let idcg = 0;
  for (let i = 0; i < Math.min(gold.size, k); i++) idcg += 1 / Math.log2(i + 2);
  return idcg ? dcg / idcg : 0;
}

/** Reciprocal rank of the first gold id in the whole list, 0 when none was retrieved. */
export function reciprocalRank(ranked: string[], gold: Set<string>): number {
  const i = ranked.findIndex((u) => gold.has(u));
  return i < 0 ? 0 : 1 / (i + 1);
}

/** Keep the first occurrence of each id (turn-level hits mapped back to their session). */
export function dedupe(ids: string[]): string[] {
  return [...new Set(ids)];
}

/** Nearest-rank percentile (p in 0..100) of a list of numbers; 0 for an empty list. */
export function percentile(xs: number[], p: number): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
}

export interface QuestionScore {
  r5: number;
  r10: number;
  rAll10: number;
  ndcg10: number;
  mrr: number;
}

export function scoreQuestion(ranked: string[], gold: Set<string>): QuestionScore {
  return {
    r5: recallAny(ranked, gold, 5),
    r10: recallAny(ranked, gold, 10),
    rAll10: recallAll(ranked, gold, 10),
    ndcg10: ndcg(ranked, gold, 10),
    mrr: reciprocalRank(ranked, gold),
  };
}

export interface MetricRow extends QuestionScore {
  n: number;
}

/** Mean of each metric, overall ("all") and per type. */
export function aggregate(scores: Array<{ type: string; score: QuestionScore }>): Record<string, MetricRow> {
  const groups = new Map<string, QuestionScore[]>();
  for (const s of scores) {
    for (const g of ["all", s.type]) groups.set(g, [...(groups.get(g) ?? []), s.score]);
  }
  const out: Record<string, MetricRow> = {};
  for (const [g, xs] of groups) {
    const mean = (f: keyof QuestionScore): number => xs.reduce((a, x) => a + x[f], 0) / xs.length;
    out[g] = { n: xs.length, r5: mean("r5"), r10: mean("r10"), rAll10: mean("rAll10"), ndcg10: mean("ndcg10"), mrr: mean("mrr") };
  }
  return out;
}
