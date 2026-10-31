// Search orchestration shared by the HTTP API and the MCP tools.
//
// Three modes:
//   - "keyword"  : FTS5 only (the default, zero-dependency path).
//   - "semantic" : embedding cosine only (needs embeddings enabled).
//   - "hybrid"   : fuse keyword + semantic with Reciprocal Rank Fusion.
//
// If embeddings are disabled, the endpoint is down, or the query can't be
// embedded, every mode degrades to keyword search -- a query must never fail
// because an optional embedding server is unavailable.

import { Store, NoteRecord, clampInt } from "./store.js";
import { embed, embeddingsEnabled, embeddingsConfig, noteEmbeddingText } from "./embeddings.js";
import { filterByTimeRange } from "./time-parse.js";
import { extractKeywords } from "./keywords.js";
import {
  stalenessConfig,
  stalePenaltyFactor,
  isStale,
  type StalenessConfig,
} from "./staleness.js";

/** The allowed search modes; single source of truth for the API + MCP schema. */
export const SEARCH_MODES = ["keyword", "semantic", "hybrid"] as const;
export type SearchMode = (typeof SEARCH_MODES)[number];

/**
 * Best-effort: when embeddings are on, compute and store a note's vector so it
 * appears in semantic search. Never throws -- the note is already saved in
 * SQLite; the embedding is a bonus, and a down embedding server must not fail
 * a write.
 */
export async function maybeEmbed(store: Store, note: NoteRecord): Promise<void> {
  if (!embeddingsEnabled()) return;
  try {
    const cfg = embeddingsConfig();
    const vec = await embed(noteEmbeddingText(note.title, note.body), cfg);
    if (vec) store.setVector(note.id, vec, cfg.model);
  } catch {
    /* swallow: the write succeeded; the embedding is best-effort */
  }
}

export function parseMode(raw: string | undefined | null): SearchMode {
  const m = (raw || "").trim().toLowerCase();
  if (m === "semantic" || m === "hybrid" || m === "keyword") return m;
  // Default: hybrid when embeddings are on, otherwise plain keyword.
  return embeddingsEnabled() ? "hybrid" : "keyword";
}

/**
 * Reciprocal Rank Fusion. Merges several ranked id lists into one ranking by
 * summing 1/(k + rank). Robust across differently-scaled scorers (FTS rank vs
 * cosine) without normalizing either. k=60 is the common default.
 */
export function rrfMerge(lists: number[][], k = 60): number[] {
  const score = rrfScores(lists, k);
  return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

/** The fused per-id scores rrfMerge sorts on (exposed for importance weighting). */
export function rrfScores(lists: number[][], k = 60): Map<number, number> {
  const score = new Map<number, number>();
  for (const list of lists) {
    list.forEach((id, i) => {
      score.set(id, (score.get(id) ?? 0) + 1 / (k + i + 1));
    });
  }
  return score;
}

/**
 * Importance weight from access tracking, recency-aware (I-HIGH-2).
 * Memories you actually re-read *recently* rank higher. The log dampening
 * keeps a runaway note from swallowing the ranking, and the recency decay
 * keeps old popularity from counting forever:
 *
 *   boost = 1 + 0.1 * log10(1 + c) * exp(-daysSinceLastAccess / 30)
 *
 * A note read 10 times today gets ~+10%; the same 10 reads from a year ago
 * get ~+0%. Never-read notes get no boost at all. Among equally-accessed,
 * equally-recent notes the boost is identical, so the native ranking (FTS
 * relevance, cosine, RRF fusion) is preserved exactly.
 *
 * Why the decay: the old flat boost let a stale note with >= 10 accesses
 * erase the staleness penalty entirely (1.104 * 0.9 = 0.994 ~= a fresh
 * note's 1.0), and finalize()'s bumpAccess made it rich-get-richer --
 * ranking highly today bought tomorrow's boost, unbounded over months.
 * last_accessed was tracked in-schema but never used in ranking; now it
 * is the decay signal.
 */
export const ACCESS_BOOST_FACTOR = 0.1;
/** Recency decay horizon (τ) for the access boost, in days. */
export const ACCESS_BOOST_TAU_DAYS = 30;

/** Whole days since an ISO timestamp; null when missing/unparseable. */
function daysSinceAccess(lastAccessed: string | null | undefined): number | null {
  if (!lastAccessed) return null;
  const t = Date.parse(lastAccessed);
  if (!Number.isFinite(t)) return null;
  // A future last_accessed (clock skew) is 0 days ago, never negative.
  return Math.max(0, (Date.now() - t) / 86_400_000);
}

/**
 * The access-boost MULTIPLIER (>= 1.0) for a note's read history, exposed
 * separately so the retrieval-explain layer can report the exact factor that
 * ranking applied rather than reverse-engineering it from two scores.
 * Refactor of accessBoost(): identical math, factored so 1.0 means "no boost".
 */
export function accessBoostFactor(
  accessCount: number,
  lastAccessed: string | null
): number {
  const c = Math.max(0, Math.floor(accessCount));
  if (c === 0) return 1; // no read signal -> no boost
  const days = daysSinceAccess(lastAccessed);
  // Unparseable last_accessed with a positive count shouldn't happen
  // (touch() always sets both); trust the count rather than zeroing it.
  const decay = days === null ? 1 : Math.exp(-days / ACCESS_BOOST_TAU_DAYS);
  return 1 + ACCESS_BOOST_FACTOR * Math.log10(1 + c) * decay;
}

function accessBoost(
  baseScore: number,
  accessCount: number,
  lastAccessed: string | null
): number {
  return baseScore * accessBoostFactor(accessCount, lastAccessed);
}

/** Multiply each hit's recency-aware access boost and re-rank (stable). */
function boostAndRank(
  hits: Array<{ note: NoteRecord; score: number }>
): Array<{ note: NoteRecord; score: number }> {
  return hits
    .map((h) => ({ ...h, score: accessBoost(h.score, h.note.access_count, h.note.last_accessed) }))
    .sort((a, b) => b.score - a.score);
}

/**
 * Stale-note penalty: graded by age (stalePenaltyFactor(): 0.95 per 90-day
 * band), so an equally-relevant fresh note outranks a stale one while the
 * stale note stays findable. Applied after the access boost, before
 * truncation. The config is read once per search, not per hit.
 *
 * Documented history (I-HIGH-2): the old flat 0.9 penalty was
 * arithmetically erased at >= 10 accesses (1 + 0.1*log10(11) = 1.104;
 * 1.104 * 0.9 = 0.994 ~= fresh 1.0). The graded penalty deepens with age
 * instead of staying constant, and the boost now decays with recency, so
 * only a *recently* re-read stale note can still outrank fresh -- which is
 * the intended recency signal, not a bug.
 */
function applyStalePenalty(
  hits: Array<{ note: NoteRecord; score: number }>,
  cfg: StalenessConfig
): Array<{ note: NoteRecord; score: number }> {
  return hits
    .map((h) => ({ ...h, score: h.score * stalePenaltyFactor(h.note, cfg) }))
    .sort((a, b) => b.score - a.score); // stable: ties keep fetch order
}

/**
 * A flagged-stale note never outranks a newer, fresh note about the SAME topic (1.6.0, GAP-RECENCY).
 *
 * The staleness penalty is a mild multiplier on the text-match score, so an old note whose words match the query a little
 * better could still come first even though a newer note on the same subject is right there in the results. This pass looks
 * only at stale hits and only at fresh hits that are close neighbours of them in the similarity graph (the same edges that
 * power `neighbors`, built from the notes' own words), and moves the stale hit to just behind the newest such neighbour.
 *
 * It does not hide or drop anything, does not touch unrelated notes, and does nothing when the store has no edge between
 * them (a deferred bulk import): a stable old fact with no newer neighbour keeps its place. Returns the ids that were
 * moved and what they were put behind, for the explain view.
 */
/** A stale note whose read boost is at least this (about nine reads today, fewer if recent and many) is left where it ranks. */
export const STALE_TWIN_ACTIVE_BOOST = 1.1;

function demoteStaleTwins(
  store: Store,
  ranked: Array<{ note: NoteRecord; score: number }>,
  cfg: StalenessConfig
): { ranked: Array<{ note: NoteRecord; score: number }>; behind: Map<number, number> } {
  const behind = new Map<number, number>();
  if (ranked.length < 2) return { ranked, behind };
  const out = [...ranked];
  const staleIds = out.filter((h) => isStale(h.note, cfg).stale).map((h) => h.note.id);
  if (staleIds.length === 0 || staleIds.length === out.length) return { ranked, behind };
  for (const sid of staleIds) {
    const si = out.findIndex((h) => h.note.id === sid);
    const stale = out[si];
    // A stale note somebody keeps coming back to (a clearly active read signal, boost >= 10%) keeps the place its reads earned:
    // recency of USE is a relevance signal of its own (see accessBoostFactor), and this pass is only about notes nobody reads.
    if (accessBoostFactor(stale.note.access_count, stale.note.last_accessed) >= STALE_TWIN_ACTIVE_BOOST) continue;
    const near = store.neighbourIds(sid);
    if (near.size === 0) continue;
    // The LAST (lowest-ranked) fresh, newer neighbour below or above: the stale hit goes behind the lowest-ranked of them,
    // so it is behind every newer fresh twin, wherever they sit.
    let anchor = -1;
    for (let i = 0; i < out.length; i++) {
      const h = out[i];
      if (h.note.id === sid || !near.has(h.note.id)) continue;
      if (isStale(h.note, cfg).stale) continue;
      if (Date.parse(h.note.updated_at) <= Date.parse(stale.note.updated_at)) continue;
      anchor = i;
    }
    if (anchor > si) {
      out.splice(si, 1);
      out.splice(anchor, 0, stale); // after removal the anchor shifted up by one, so this lands right behind it
      behind.set(sid, out[anchor - 1].note.id);
    }
  }
  return { ranked: out, behind };
}

/**
 * Bump access counters for notes *returned* to the caller (the top N), never
 * for every note the scorer scanned. Importance weighting should reflect
 * actual reads, not index churn.
 */
function bumpAccess(store: Store, notes: NoteRecord[]): void {
  // One UPDATE for the whole result set (BLOCKER 3): the old per-note loop
  // issued up to 200 autocommit UPDATEs per search -- each a WAL fsync --
  // which is also what made read bursts self-inflict write contention.
  // touchMany is best-effort, like touch().
  if (notes.length === 0) return;
  store.touchMany(notes.map((n) => n.id));
}

/**
 * The access-boost + staleness re-rank is on by default; set
 * ONEMEMORY_ACCESS_BOOST=0 to rank by native relevance only (FTS bm25,
 * cosine, RRF) -- the 1.0.0 ordering. Read per search so it can be flipped
 * without a restart in tests. Access counters still bump either way.
 */
export function accessRerankEnabled(): boolean {
  return (process.env.ONEMEMORY_ACCESS_BOOST ?? "").trim() !== "0";
}

/**
 * Boost, stale-penalize, truncate to the result limit, bump access.
 * Shared by runSearch and runRelevantSearch so every search mode honors
 * the same contract: importance-weighted, staleness-aware, and
 * access-counted on what was actually returned.
 */
function finalizeResults(
  store: Store,
  hits: Array<{ note: NoteRecord; score: number }>,
  limit: number,
  staleCfg: StalenessConfig
): NoteRecord[] {
  const notes = rankHits(store, hits, staleCfg).slice(0, limit);
  bumpAccess(store, notes);
  return notes;
}

/**
 * The ranking half of finalizeResults (access boost, staleness penalty, stale-twin demotion) without the truncation and
 * the access bump: the session-start context ranks its own pool and decides itself what it shows (context-inject.ts).
 */
export function rankHits(store: Store, hits: Array<{ note: NoteRecord; score: number }>, staleCfg: StalenessConfig = stalenessConfig()): NoteRecord[] {
  const ranked = accessRerankEnabled()
    ? demoteStaleTwins(store, applyStalePenalty(boostAndRank(hits), staleCfg), staleCfg).ranked
    : [...hits].sort((a, b) => b.score - a.score); // native relevance only (stable)
  return ranked.map((h) => h.note);
}

// ---- Retrieval visibility --------------------------------------------------
// "Visibility into why a memory was retrieved." Search ranking is three
// multiplicative stages -- native relevance (bm25/cosine/RRF) -> recency-
// decayed access boost -> graded staleness penalty -- and until now every
// intermediate was discarded, so an agent (or a user) could see WHICH notes
// came back but never WHY one outranked another. These types expose the
// actual factors the scorer used, computed from the same functions, so the
// explanation can never drift from the ranking.

/** Why one note outranked another, using the scorer's real factors. */
export interface ScoreBreakdown {
  /** Final score after all stages (higher = better). */
  finalScore: number;
  /** Native relevance before boosts/penalties: bm25, cosine, or RRF fusion. */
  baseScore: number;
  /** Recency-decayed access boost multiplier (1.0 = no boost). */
  accessBoost: number;
  /** Graded staleness penalty (1.0 = fresh, <1 = demoted). */
  stalePenalty: number;
  /** Read count that produced the boost (0 = never read). */
  accessCount: number;
  /** Whole days since the last read; null = never read. */
  daysSinceAccess: number | null;
  /** Days since updated_at; the staleness input. */
  ageDays: number;
  /** True when the staleness penalty was applied. */
  stale: boolean;
  /** Human-readable one-liner, e.g. "strong keyword match; read 3x yesterday; 40d old (demoted)". */
  explanation: string;
}

/** A search hit carrying its ranking rationale alongside the note. */
export interface ExplainedHit {
  note: NoteRecord;
  breakdown: ScoreBreakdown;
}

/**
 * Build the human-readable one-liner from the computed factors. Kept pure and
 * separate so it is testable without running a search.
 */
export function describeBreakdown(b: Omit<ScoreBreakdown, "explanation">): string {
  const parts: string[] = [];
  // Base-relevance descriptor: rough bands on the multiplicative base score.
  if (b.baseScore <= 0) parts.push("no native relevance signal");
  else if (b.baseScore >= 1) parts.push("strong text match");
  else if (b.baseScore >= 0.3) parts.push("moderate text match");
  else parts.push("weak text match");

  if (b.accessCount > 0) {
    const when =
      b.daysSinceAccess === null
        ? "time unknown"
        : b.daysSinceAccess < 1
          ? "today"
          : `${Math.round(b.daysSinceAccess)}d ago`;
    parts.push(`read ${b.accessCount}x, last ${when} (boost x${b.accessBoost.toFixed(3)})`);
  } else {
    parts.push("never read (no boost)");
  }

  if (b.stale) {
    parts.push(`${b.ageDays}d old (demoted x${b.stalePenalty.toFixed(3)})`);
  } else {
    parts.push(`fresh (${b.ageDays}d old)`);
  }
  return parts.join("; ") + ".";
}

/**
 * finalizeResults twin that keeps the intermediate factors. Ranking order is
 * byte-identical to finalizeResults -- both call the same boostAndRank /
 * applyStalePenalty functions -- so adding explain never reorders results.
 */
function finalizeExplained(
  store: Store,
  hits: Array<{ note: NoteRecord; score: number }>,
  limit: number,
  staleCfg: StalenessConfig
): ExplainedHit[] {
  // Capture native relevance per id BEFORE any boost, so the breakdown can
  // report the true base rather than the post-boost score.
  const baseById = new Map<number, number>(hits.map((h) => [h.note.id, h.score]));
  const demoted = accessRerankEnabled()
    ? demoteStaleTwins(store, applyStalePenalty(boostAndRank(hits), staleCfg), staleCfg)
    : { ranked: [...hits].sort((a, b) => b.score - a.score), behind: new Map<number, number>() };
  const ranked = demoted.ranked;
  const top = ranked.slice(0, limit);
  bumpAccess(store, top.map((h) => h.note));

  return top.map((h) => {
    const base = baseById.get(h.note.id) ?? h.score;
    const accessBoost = accessRerankEnabled()
      ? accessBoostFactor(h.note.access_count, h.note.last_accessed)
      : 1;
    const staleInfo = isStale(h.note, staleCfg);
    const stalePenalty = accessRerankEnabled() ? stalePenaltyFactor(h.note, staleCfg) : 1;
    const partial = {
      finalScore: h.score,
      baseScore: base,
      accessBoost,
      stalePenalty,
      accessCount: h.note.access_count ?? 0,
      daysSinceAccess: daysSinceAccess(h.note.last_accessed),
      ageDays: staleInfo.ageDays,
      stale: staleInfo.stale,
    };
    const behindId = demoted.behind.get(h.note.id);
    const explanation = describeBreakdown(partial) + (behindId !== undefined ? ` Kept behind the newer note #${behindId} on the same topic.` : "");
    return { note: h.note, breakdown: { ...partial, explanation } };
  });
}

/**
 * Fair multi-namespace merge: round-robin interleave of per-namespace
 * ranked lists, truncated to `limit`. Concatenating in namespace order
 * starves later namespaces (at limit=5 the second namespace gets zero
 * hits); interleaving guarantees each namespace a fair share while
 * preserving every list's internal relevance order.
 */
export function roundRobin<T>(lists: T[][], limit: number): T[] {
  const out: T[] = [];
  const lim = Math.max(0, Math.floor(limit));
  for (let i = 0; out.length < lim; i++) {
    let advanced = false;
    for (const list of lists) {
      if (i < list.length) {
        out.push(list[i]);
        advanced = true;
        if (out.length >= lim) return out;
      }
    }
    if (!advanced) break;
  }
  return out;
}

export interface SearchOpts {
  namespace?: string;
  limit?: number;
  mode?: SearchMode;
  /**
   * Optional UTC [start, end) window (usually from parseTimePhrase()).
   * Scopes results to notes created inside the window; keywords still rank
   * within it. When the query is blank, behaves like a time-scoped list
   * (newest first).
   */
  timeRange?: { start: Date; end: Date };
  /** Only notes whose server-stamped last writer (written_by) is exactly this. */
  writtenBy?: string;
  /** Only notes whose server-stamped last writer is NOT this. */
  notWrittenBy?: string;
  /** Also return notes whose writer is on the namespace's distrust list. Default: they are left out. */
  includeDistrusted?: boolean;
  /** Also return notes a confirmed replacement retired (always labelled `status: "superseded"`). Default: they are left out. */
  includeSuperseded?: boolean;
}

/**
 * How a time range is applied (documented for operators):
 *
 * - Blank query + timeRange -> store.list() with the range pushed into SQL
 *   (newest-first, same ordering as state_list).
 * - Keyword mode (or embeddings unavailable) -> the range is pushed into the
 *   FTS SQL query via store.search()'s startISO/endISO, so ranking sees only
 *   in-range notes.
 * - Semantic/hybrid -> the range is pushed into the *vector* SQL via
 *   store.semanticSearch()'s startISO/endISO, so the top-200 cosine ranking
 *   is computed within the window, not globally. The old design fetched the
 *   global top-200 and discarded out-of-window notes in JS, which silently
 *   returned nothing when 200+ out-of-window notes outscored the in-window
 *   ones. The JS-side filterByTimeRange calls below are now a no-op safety
 *   net; a note outside the window can never enter the fusion because it
 *   never leaves SQL.
 */
async function runSearchInner(
  store: Store,
  query: string,
  opts: SearchOpts = {}
): Promise<NoteRecord[]> {
  // Clamp here too: the store methods clamp their own queries, but the hybrid
  // path slices fused ids by this value, so an unclamped 0/negative/NaN would
  // silently return [] or misorder despite real matches.
  const limit = clampInt(opts.limit, 20, 1, 200);
  const mode: SearchMode = opts.mode ?? parseMode(undefined);
  const range = opts.timeRange;
  const writerOpts = {
    ...(opts.writtenBy !== undefined ? { writtenBy: opts.writtenBy } : {}),
    ...(opts.notWrittenBy !== undefined ? { notWrittenBy: opts.notWrittenBy } : {}),
  };
  const rangeOpts = {
    ...(range !== undefined
      ? { startISO: range.start.toISOString(), endISO: range.end.toISOString() }
      : {}),
    ...writerOpts,
    ...(opts.includeDistrusted ? { includeDistrusted: true } : {}),
    ...(opts.includeSuperseded ? { includeSuperseded: true } : {}),
  };
  const staleCfg = stalenessConfig();

  // Time-only query: no keywords to rank by -> time-scoped newest-first list.
  // A newest-first list has no relevance ranking to boost, but the returned
  // notes were still read by the caller, so their access counters bump.
  if ((range !== undefined || Object.keys(writerOpts).length > 0) && !query.trim()) {
    const listed = store.list({ namespace: opts.namespace, limit, ...rangeOpts }).notes;
    bumpAccess(store, listed);
    return listed;
  }

  // Keyword hits with their FTS5 bm25 rank as the base score (higher =
  // better match). Identical documents score identically, so the access
  // boost breaks ties toward the note actually read most often.
  const keyword = (fetchLimit: number): Array<{ note: NoteRecord; score: number }> =>
    keywordWithFallback(store, query, fetchLimit, { namespace: opts.namespace, ...rangeOpts });

  /** Boost, stale-penalize, truncate to the result limit, bump access. */
  const finalize = (
    hits: Array<{ note: NoteRecord; score: number }>
  ): NoteRecord[] => finalizeResults(store, hits, limit, staleCfg);

  if (mode === "keyword" || !embeddingsEnabled()) return finalize(keyword(limit));

  const qv = await embed(query);
  if (!qv) return finalize(keyword(limit)); // endpoint down / not embeddable -> graceful fallback

  // Oversample (limit*5, capped at the 200 max) so hybrid RRF has a rich
  // candidate pool on both sides; the window is pushed into the vector SQL,
  // so the semantic ranking is already computed within the time range.
  const poolLimit = clampInt(limit * 5, 100, 1, 200);
  const semHits = store.semanticSearch(qv, {
    namespace: opts.namespace,
    limit: poolLimit,
    ...rangeOpts,
  });

  if (mode === "semantic") {
    let hits = semHits.map((h) => ({ note: h.note, score: h.score }));
    if (range !== undefined) {
      const inRange = new Set(
        filterByTimeRange(
          hits.map((h) => h.note),
          range
        ).map((n) => n.id)
      );
      hits = hits.filter((h) => inRange.has(h.note.id));
    }
    return finalize(hits);
  }

  // hybrid: fuse the two rankings, then resolve ids back to records.
  const ftsHits = keyword(poolLimit);
  const fusedScores = rrfScores([
    ftsHits.map((h) => h.note.id),
    semHits.map((h) => h.note.id),
  ]);

  const byId = new Map<number, NoteRecord>();
  for (const h of ftsHits) byId.set(h.note.id, h.note);
  for (const h of semHits) byId.set(h.note.id, h.note);
  let hits = [...fusedScores.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id, score]) => ({ note: byId.get(id)!, score }))
    .filter((h) => h.note !== undefined);
  if (range !== undefined) {
    const inRange = new Set(filterByTimeRange(hits.map((h) => h.note), range).map((n) => n.id));
    hits = hits.filter((h) => inRange.has(h.note.id));
  }
  return finalize(hits);
}

/**
 * runSearch twin that also returns each hit's ranking rationale.
 *
 * Mirrors runSearch's branching exactly (time-only list, keyword-only,
 * semantic, hybrid) and swaps finalizeExplained for finalizeResults, so the
 * notes and their order are identical to runSearch -- only the explanation
 * is added. Exposed on the API via GET /search?explain=1 and on the MCP
 * state_search tool, so an agent can see WHY a memory was recalled instead
 * of silently trusting the ranking.
 */
async function runSearchExplainedInner(
  store: Store,
  query: string,
  opts: SearchOpts = {}
): Promise<ExplainedHit[]> {
  const limit = clampInt(opts.limit, 20, 1, 200);
  const mode: SearchMode = opts.mode ?? parseMode(undefined);
  const range = opts.timeRange;
  const writerOpts = {
    ...(opts.writtenBy !== undefined ? { writtenBy: opts.writtenBy } : {}),
    ...(opts.notWrittenBy !== undefined ? { notWrittenBy: opts.notWrittenBy } : {}),
  };
  const rangeOpts = {
    ...(range !== undefined
      ? { startISO: range.start.toISOString(), endISO: range.end.toISOString() }
      : {}),
    ...writerOpts,
    ...(opts.includeDistrusted ? { includeDistrusted: true } : {}),
    ...(opts.includeSuperseded ? { includeSuperseded: true } : {}),
  };
  const staleCfg = stalenessConfig();

  // Time-only query: a recency list has no relevance score to explain, but
  // the notes were still read by the caller, so bump access like runSearch.
  if ((range !== undefined || Object.keys(writerOpts).length > 0) && !query.trim()) {
    const listed = store.list({ namespace: opts.namespace, limit, ...rangeOpts }).notes;
    bumpAccess(store, listed);
    return listed.map((note) => ({
      note,
      breakdown: explainedRecencyOnly(note),
    }));
  }

  const keyword = (fetchLimit: number): Array<{ note: NoteRecord; score: number }> =>
    keywordWithFallback(store, query, fetchLimit, { namespace: opts.namespace, ...rangeOpts });

  const finalize = (hits: Array<{ note: NoteRecord; score: number }>): ExplainedHit[] =>
    finalizeExplained(store, hits, limit, staleCfg);

  if (mode === "keyword" || !embeddingsEnabled()) return finalize(keyword(limit));

  const qv = await embed(query);
  if (!qv) return finalize(keyword(limit));

  const poolLimit = clampInt(limit * 5, 100, 1, 200);
  const semHits = store.semanticSearch(qv, {
    namespace: opts.namespace,
    limit: poolLimit,
    ...rangeOpts,
  });

  if (mode === "semantic") {
    let hits = semHits.map((h) => ({ note: h.note, score: h.score }));
    if (range !== undefined) {
      const inRange = new Set(
        filterByTimeRange(hits.map((h) => h.note), range).map((n) => n.id)
      );
      hits = hits.filter((h) => inRange.has(h.note.id));
    }
    return finalize(hits);
  }

  // hybrid
  const ftsHits = keyword(poolLimit);
  const fusedScores = rrfScores([
    ftsHits.map((h) => h.note.id),
    semHits.map((h) => h.note.id),
  ]);
  const byId = new Map<number, NoteRecord>();
  for (const h of ftsHits) byId.set(h.note.id, h.note);
  for (const h of semHits) byId.set(h.note.id, h.note);
  let hits = [...fusedScores.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id, score]) => ({ note: byId.get(id)!, score }))
    .filter((h) => h.note !== undefined);
  if (range !== undefined) {
    const inRange = new Set(filterByTimeRange(hits.map((h) => h.note), range).map((n) => n.id));
    hits = hits.filter((h) => inRange.has(h.note.id));
  }
  return finalize(hits);
}

/** Breakdown for a recency-only listing: no relevance signal to report. */
function explainedRecencyOnly(note: NoteRecord): ScoreBreakdown {
  const staleInfo = isStale(note, stalenessConfig());
  const partial = {
    finalScore: 0,
    baseScore: 0,
    accessBoost: 1,
    stalePenalty: 1,
    accessCount: note.access_count ?? 0,
    daysSinceAccess: daysSinceAccess(note.last_accessed),
    ageDays: staleInfo.ageDays,
    stale: staleInfo.stale,
  };
  return {
    ...partial,
    explanation: `recency listing (no relevance query); ${describeBreakdown(partial)}`,
  };
}

export interface RelevantOpts {
  namespace?: string;
  limit?: number;
  writtenBy?: string;
  notWrittenBy?: string;
  includeDistrusted?: boolean;
}

/**
 * "Vague user message -> relevant memories" search, backing the
 * `state_relevant` MCP tool and `POST /relevant`. Extracts keywords from
 * free-form text and runs a permissive keyword search: a note qualifies on
 * ANY single keyword hit (OR semantics), which is a deliberately lower
 * threshold than runSearch/store.search's AND conjunction -- with up to 20
 * keywords, an AND would return almost nothing for a rambling message.
 *
 * Ranking merges the per-keyword FTS5 bm25 rankings with Reciprocal Rank
 * Fusion, multiplied by the keyword-branch count: a note matching several
 * distinct keywords still outranks a single-keyword hit, but within the
 * same count the bm25 relevance wins -- a central-topic hit outranks a
 * passing mention instead of every branch counting the same and ties
 * breaking by recency.
 *
 * The merged hits run through the same finalize pipeline as runSearch
 * (access boost, staleness penalty, truncation, access bump), so the
 * vague-message path -- the one most likely to act on outdated facts --
 * honors the same staleness contract. Callers annotate results with
 * annotateStaleness for the stale/ageDays/staleWarning fields.
 */
async function runRelevantSearchInner(
  store: Store,
  message: string,
  opts: RelevantOpts = {}
): Promise<{ keywords: string[]; results: NoteRecord[] }> {
  const keywords = extractKeywords(message);
  const limit = clampInt(opts.limit, 10, 1, 200);
  if (keywords.length === 0) return { keywords, results: [] };
  // Oversample per keyword (limit*2, clamped to 1..200 -- the 50 here is the
  // clampInt *default* for non-numeric input, not a floor) so the merge has
  // a real candidate pool before the final limit cut.
  const perKeyword = clampInt(Math.ceil(limit * 2), 50, 1, 200);
  const byId = new Map<number, NoteRecord>();
  const counts = new Map<number, number>();
  const lists: number[][] = [];
  for (const kw of keywords) {
    // searchRanked (not search): keep each hit's FTS5 bm25 score for the
    // merge below instead of discarding it.
    const ranked = store.searchRanked(kw, {
      namespace: opts.namespace,
      limit: perKeyword,
      ...(opts.writtenBy !== undefined ? { writtenBy: opts.writtenBy } : {}),
      ...(opts.notWrittenBy !== undefined ? { notWrittenBy: opts.notWrittenBy } : {}),
      ...(opts.includeDistrusted ? { includeDistrusted: true } : {}),
    });
    const ids: number[] = [];
    for (const h of ranked) {
      ids.push(h.note.id);
      if (!byId.has(h.note.id)) byId.set(h.note.id, h.note);
      counts.set(h.note.id, (counts.get(h.note.id) ?? 0) + 1);
    }
    lists.push(ids);
  }
  const fused = rrfScores(lists);
  const hits = [...fused.entries()].map(([id, rrf]) => ({
    note: byId.get(id)!,
    score: rrf * (counts.get(id) ?? 1),
  }));
  return {
    keywords,
    results: finalizeResults(store, hits, limit, stalenessConfig()),
  };
}

/**
 * FTS5 search requires every term, so a whole natural-language question
 * ("what did I decide about the deploy region?") rarely matches anything:
 * LongMemEval-S session recall@5 was 11.9% that way vs 95.3% matching any
 * keyword. When the all-terms search leaves room under `limit` and the query
 * has two or more keywords, top it up with any-keyword hits, fused like
 * state_relevant. All-terms hits keep their own scores and always rank first;
 * fallback hits score below the weakest of them.
 */
export function keywordWithFallback(
  store: Store,
  query: string,
  limit: number,
  opts: Parameters<Store["searchRanked"]>[1]
): Array<{ note: NoteRecord; score: number }> {
  const strict = store.searchRanked(query, { ...opts, limit });
  const keywords = extractKeywords(query);
  if (strict.length >= limit || keywords.length < 2) return strict;
  const seen = new Set(strict.map((h) => h.note.id));
  const byId = new Map<number, NoteRecord>();
  const counts = new Map<number, number>();
  const lists: number[][] = [];
  for (const kw of keywords) {
    const ids: number[] = [];
    for (const h of store.searchRanked(kw, { ...opts, limit })) {
      if (seen.has(h.note.id)) continue;
      ids.push(h.note.id);
      byId.set(h.note.id, h.note);
      counts.set(h.note.id, (counts.get(h.note.id) ?? 0) + 1);
    }
    lists.push(ids);
  }
  // RRF scores are on another scale than bm25: map them under half the
  // weakest all-terms score so finalize's small boosts cannot lift a partial
  // match above a full one.
  const floor = strict.length ? Math.min(...strict.map((h) => h.score)) : 1;
  const loose = [...rrfScores(lists).entries()]
    .map(([id, rrf]) => ({ note: byId.get(id)!, score: rrf * (counts.get(id) ?? 1) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit - strict.length);
  const top = loose.length ? loose[0].score : 1;
  return [...strict, ...loose.map((h) => ({ note: h.note, score: (floor * 0.5 * h.score) / top }))];
}

// The public entry points. A caller that opted in with includeDistrusted gets
// notes whose writer the admin distrusts back flagged `distrusted: true`, so no
// surface can show one without the mark.
export async function runSearch(store: Store, query: string, opts: SearchOpts = {}): Promise<NoteRecord[]> {
  const r = await runSearchInner(store, query, opts);
  return opts.includeDistrusted ? store.markDistrusted(r) : r;
}

export async function runSearchExplained(store: Store, query: string, opts: SearchOpts = {}): Promise<ExplainedHit[]> {
  const r = await runSearchExplainedInner(store, query, opts);
  if (!opts.includeDistrusted) return r;
  const marked = new Map(store.markDistrusted(r.map((h) => h.note)).map((n) => [n.id, n]));
  return r.map((h) => ({ ...h, note: marked.get(h.note.id) ?? h.note }));
}

export async function runRelevantSearch(
  store: Store,
  message: string,
  opts: RelevantOpts = {}
): Promise<{ keywords: string[]; results: NoteRecord[] }> {
  const r = await runRelevantSearchInner(store, message, opts);
  return opts.includeDistrusted ? { ...r, results: store.markDistrusted(r.results) } : r;
}
