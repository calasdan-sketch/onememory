// Auto-consolidation / dedup: fights memory bloat from agents re-storing
// the same facts.
//
// Zero-dependency text similarity (cosine over term-frequency vectors as the
// primary metric, Jaccard as a secondary) finds near-duplicate notes, and
// consolidateNotes merges a set of duplicate ids into one note (union of
// tags, deduplicated bodies) with optional deletion of the sources.
//
// Safety notes:
// - Candidates are found same-namespace ONLY. Namespaces are an isolation
//   boundary; merging across them would leak one project's facts into
//   another's.
// - findCandidates is O(n^2). That's fine at personal-store scale, but the
//   input is capped: beyond 2000 notes (or MAX_CANDIDATE_BYTES of text)
//   only the most recently created notes are scanned. Async call sites (MCP tool, CLI) use
//   findCandidatesCooperative, which yields to the event loop every few
//   thousand pair checks so a large scan doesn't stall concurrent traffic.

// CandidateScanError lives in store.ts: subclassing ValidationError here
// would run during module evaluation, which the store <-> consolidate cycle
// does not allow.
import { Store, ValidationError, CandidateScanError, clampInt } from "./store.js";
import type { NoteRecord } from "./store.js";
import { maybeEmbed } from "./search-service.js";

/** ~30 common English stopwords dropped before similarity scoring. */
const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "of", "to", "in", "on", "for",
  "with", "is", "are", "was", "were", "be", "been", "being", "it", "its",
  "this", "that", "these", "those", "as", "at", "by", "from", "we",
  "you", "i", "he", "she", "they", "not", "no", "do", "does", "did",
  "my", "our", "your", "have", "has", "had", "am",
]);

/** Lowercase, split on non-alphanumeric, drop tokens < 2 chars + stopwords. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

/** Term-frequency map for one token list. Exported so callers can tokenize
 * once per note and score many pairs without re-tokenizing (see
 * Store.rebuildEdgesCooperative / recomputeEdgesFor). */
export function termFreq(tokens: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of tokens) m.set(t, (m.get(t) ?? 0) + 1);
  return m;
}

/** Cosine similarity directly over two precomputed term-frequency maps.
 * Exported alongside termFreq for the same tokenize-once/score-many
 * callers. Identical math to cosineSimilarity(a, b). */
export function cosineOfFreq(a: Map<string, number>, b: Map<string, number>): number {
  // Two inputs with no content tokens at all carry no similarity signal --
  // score 0, not 1. The old "both empty => identical" rule promoted
  // content-free notes to exact-duplicate candidates.
  if (a.size === 0 || b.size === 0) return 0;
  let dot = 0;
  for (const [tok, ca] of a) {
    const cb = b.get(tok);
    if (cb !== undefined) dot += ca * cb;
  }
  let na = 0;
  for (const ca of a.values()) na += ca * ca;
  let nb = 0;
  for (const cb of b.values()) nb += cb * cb;
  if (na === 0 || nb === 0) return 0;
  // Clamp to [0, 1]: term frequencies are non-negative so the true cosine
  // can't leave that range — only floating-point rounding can (e.g.
  // 1.0000000000000002 for identical inputs), which would break exact
  // comparisons like `score === 1` downstream.
  return Math.min(1, Math.max(0, dot / (Math.sqrt(na) * Math.sqrt(nb))));
}

/**
 * Cosine similarity of two texts over term-frequency vectors.
 * 1 = identical token multisets, 0 = no shared content tokens. Texts that
 * reduce to no content tokens (empty, stopwords only) score 0, not 1.
 */
export function cosineSimilarity(a: string, b: string): number {
  return cosineOfFreq(termFreq(tokenize(a)), termFreq(tokenize(b)));
}

/**
 * Jaccard similarity of two texts over token SETS (|intersection|/|union|).
 * Secondary metric — exported for tests and for callers that want a
 * set-overlap view rather than frequency weighting. Empty token sets score
 * 0, mirroring cosineSimilarity.
 */
export function jaccardSimilarity(a: string, b: string): number {
  const sa = new Set(tokenize(a));
  const sb = new Set(tokenize(b));
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  return inter / (sa.size + sb.size - inter);
}

/**
 * Tokenize-once: term-frequency maps for a batch of notes, keyed by note
 * id. Edge scoring compares every pair in a namespace, so tokenizing
 * per-pair inside the pair loop re-runs the tokenizer O(n^2) times.
 * Precompute once here, score many times below (D-MEDIUM-2). Notes with no
 * content tokens map to an empty TF map (they score 0 with everything, per
 * cosineOfFreq's convention); they are kept in the map so callers don't
 * have to special-case missing ids.
 */
export function precomputeTfMaps(
  notes: Array<{ id: number; title: string; body: string }>
): Map<number, Map<string, number>> {
  const out = new Map<number, Map<string, number>>();
  for (const n of notes) out.set(n.id, termFreq(tokenize(`${n.title} ${n.body}`)));
  return out;
}

/**
 * Document frequencies over a set of TF maps: term -> number of documents
 * containing the term. The edge graph computes these per namespace, per
 * rebuild/recompute, so the IDF weights always reflect the corpus actually
 * being scored (I-HIGH-1).
 */
export function computeDocFreqs(tfMaps: Iterable<Map<string, number>>): Map<string, number> {
  const df = new Map<string, number>();
  for (const tf of tfMaps) {
    for (const t of tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  }
  return df;
}

/**
 * Shared content-token count between two TF maps — the "minimum support"
 * floor for edge creation (I-HIGH-1). Iterates the smaller map.
 */
export function sharedTokenCount(a: Map<string, number>, b: Map<string, number>): number {
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  let n = 0;
  for (const t of small.keys()) if (big.has(t)) n++;
  return n;
}

/**
 * Smoothed inverse document frequency. The +1 in the numerator/denominator
 * plus the +1 floor keeps the weight strictly positive: a term present in
 * every document still carries its TF signal, and a term missing from the
 * DF table (can't happen in-graph, defensive anyway) doesn't zero out.
 */
export function idf(term: string, df: Map<string, number>, docCount: number): number {
  return idfFromCount(df.get(term) ?? 0, docCount);
}

/** idf() from a raw document frequency (for callers without a DF map). */
export function idfFromCount(docFreq: number, docCount: number): number {
  return Math.log((1 + docCount) / (1 + docFreq)) + 1;
}

/**
 * Minimum shared content tokens for a similarity edge. A single shared
 * token is the exact junk-edge mode raw-TF cosine had at 0.35
 * ("Dentist appointment" vs "see dentist thursday" scored 0.408 on one
 * token). The floor is IDF-independent, so it holds even when the corpus
 * is too small for IDF to discriminate (cold start). Chosen with the
 * threshold by the sweep in reviews/tier2-threshold-sweep/.
 */
export const MIN_SHARED_TOKENS_FOR_EDGE = 2;

/**
 * Cosine similarity over TF-IDF-weighted term vectors. Rare shared terms
 * count more than boilerplate that appears everywhere — the I-HIGH-1
 * correction: raw TF cosine let a single common token clear the edge
 * threshold, because TF has no notion of term rarity (llmem's 0.35 was
 * tuned on an IDF-weighted BM25 scale, a different metric entirely).
 *
 * docCount is the corpus size the DF table was computed over (per
 * namespace, per rebuild/recompute). Texts with no content tokens score 0,
 * not 1, mirroring cosineSimilarity.
 */
export function cosineTfIdf(
  a: Map<string, number>,
  b: Map<string, number>,
  df: Map<string, number>,
  docCount: number
): number {
  if (a.size === 0 || b.size === 0) return 0;
  let dot = 0;
  for (const [tok, ta] of a) {
    const tb = b.get(tok);
    if (tb !== undefined) {
      const w = idf(tok, df, docCount);
      dot += ta * w * tb * w;
    }
  }
  let na = 0;
  for (const [tok, ta] of a) {
    const w = ta * idf(tok, df, docCount);
    na += w * w;
  }
  let nb = 0;
  for (const [tok, tb] of b) {
    const w = tb * idf(tok, df, docCount);
    nb += w * w;
  }
  if (na === 0 || nb === 0) return 0;
  // Clamp to [0, 1]: TF-IDF weights are non-negative so the true cosine
  // can't leave that range — only floating-point rounding can.
  return Math.min(1, Math.max(0, dot / (Math.sqrt(na) * Math.sqrt(nb))));
}

export interface CandidatePair {
  idA: number;
  idB: number;
  score: number;
}

/**
 * Similarity-band bounds and a honesty note: 0.95 (near-duplicate review
 * band) and 0.99 (auto-merge band) are heuristic defaults, NOT validated
 * cutoffs. They were chosen on judgment, not measured against labeled
 * real-world notes; short notes are especially noisy near 0.95 (few tokens
 * -> high variance). The design treats 0.95 as review-only -- the janitor
 * auto-merges only exact-duplicate strings via isAutoMergeSafe, whatever
 * the score -- so the unvalidated threshold can surface candidates without
 * ever deleting on its say-so alone.
 */
export const THRESHOLD_MIN = 0.5;
export const THRESHOLD_MAX = 1.0;

/** Clamp a caller-supplied similarity threshold into a sane band (0.5..1.0). */
export function clampThreshold(v: number | undefined, def = 0.95): number {
  const n = typeof v === "number" && Number.isFinite(v) ? v : def;
  return Math.min(Math.max(n, THRESHOLD_MIN), THRESHOLD_MAX);
}

/**
 * True when clampThreshold(v) would rewrite a caller-supplied value, so
 * CLIs can warn instead of silently rewriting user input.
 */
export function thresholdWasClamped(v: number | undefined): boolean {
  return (
    v !== undefined &&
    (typeof v !== "number" ||
      !Number.isFinite(v) ||
      v < THRESHOLD_MIN ||
      v > THRESHOLD_MAX)
  );
}

/** Personal-store scale cap: scanning is O(n^2), so cap the input. */
export const MAX_CANDIDATE_NOTES = 2000;

/**
 * Size cap on the scanned text (title + body length in UTF-16 code units,
 * ~bytes; newest notes first): the
 * note-count cap alone still let 2000 near-max-size notes cost minutes of
 * CPU per scan.
 */
export const MAX_CANDIDATE_BYTES = 2 * 1024 * 1024;

/** Default wall-clock budget for a guarded (tool-facing) candidate scan. */
export const CANDIDATE_SCAN_DEADLINE_MS = 15_000;

/**
 * Cooperative-scan cadence: yield to the event loop this often while
 * scoring pairs. A 2000-note scan is ~2M pair checks (~1s of pure CPU);
 * without a yield that stalls every concurrent HTTP/MCP request. 8192
 * keeps each uninterrupted slice to a few milliseconds.
 */
export const CANDIDATE_YIELD_EVERY = 8192;

interface CandidateDoc {
  note: NoteRecord;
  freq: Map<string, number>;
}

/** All (i, j) index pairs with i < j over n docs. */
function* pairIndices(n: number): Generator<[number, number]> {
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) yield [i, j];
  }
}

function prepareCandidateDocs(
  notes: NoteRecord[],
  opts: { threshold?: number; limit?: number }
): { docs: CandidateDoc[]; threshold: number; limit: number } {
  const threshold = clampThreshold(opts.threshold, 0.95);
  const limit = clampInt(opts.limit, 50, 1, 500);

  const newestFirst = (list: NoteRecord[]): NoteRecord[] =>
    [...list].sort((x, y) => y.created_at.localeCompare(x.created_at) || y.id - x.id);
  let pool =
    notes.length > MAX_CANDIDATE_NOTES
      ? newestFirst(notes).slice(0, MAX_CANDIDATE_NOTES)
      : notes;
  const textBytes = (n: NoteRecord): number => n.title.length + n.body.length;
  if (pool.reduce((sum, n) => sum + textBytes(n), 0) > MAX_CANDIDATE_BYTES) {
    // Keep the newest notes that fit the byte budget.
    const kept: NoteRecord[] = [];
    let bytes = 0;
    for (const n of newestFirst(pool)) {
      bytes += textBytes(n);
      if (bytes > MAX_CANDIDATE_BYTES) break;
      kept.push(n);
    }
    pool = kept;
  }

  const docs = pool.map((note) => ({
    note,
    freq: termFreq(tokenize(`${note.title} ${note.body}`)),
  }));
  return { docs, threshold, limit };
}

/** Score one pair; append a CandidatePair when it clears the threshold. */
function collectCandidatePair(
  docs: CandidateDoc[],
  i: number,
  j: number,
  threshold: number,
  pairs: CandidatePair[]
): void {
  const na = docs[i].note;
  const nb = docs[j].note;
  if (na.id === nb.id) return;
  if (na.namespace !== nb.namespace) return; // never merge across namespaces
  const score = cosineOfFreq(docs[i].freq, docs[j].freq);
  // 1e-9 epsilon: floating-point rounding can put a true-1.0 score a hair
  // below the threshold (e.g. 0.9999999999999999 vs 1.0), which would
  // wrongly exclude exact duplicates at threshold 1.0.
  if (score + 1e-9 >= threshold) {
    // Snap FP noise at the boundary: a score within 1e-9 of 1 is an
    // exact duplicate as far as any consumer is concerned.
    const snapped = score > 1 - 1e-9 ? 1 : score;
    pairs.push({
      idA: Math.min(na.id, nb.id),
      idB: Math.max(na.id, nb.id),
      score: snapped,
    });
  }
}

function finalizeCandidatePairs(
  pairs: CandidatePair[],
  limit: number
): CandidatePair[] {
  pairs.sort((x, y) => y.score - x.score || x.idA - y.idA || x.idB - y.idB);
  return pairs.slice(0, limit);
}

/**
 * Find near-duplicate note pairs. Same-namespace only; each pair appears
 * once (idA < idB); sorted by score descending; capped at `limit`.
 * If more than 2000 notes are passed, only the 2000 most recently created
 * are scanned (documented performance guard).
 */
export function findCandidates(
  notes: NoteRecord[],
  opts: { threshold?: number; limit?: number } = {}
): CandidatePair[] {
  const { docs, threshold, limit } = prepareCandidateDocs(notes, opts);
  const pairs: CandidatePair[] = [];
  for (const [i, j] of pairIndices(docs.length)) {
    collectCandidatePair(docs, i, j, threshold, pairs);
  }
  return finalizeCandidatePairs(pairs, limit);
}

/**
 * Cooperative variant of findCandidates for async call sites (the MCP
 * candidates tool, the CLI): byte-identical results, but yields to the
 * event loop every CANDIDATE_YIELD_EVERY pair checks so a large scan
 * doesn't stall concurrent HTTP/MCP traffic. The background janitor keeps
 * the synchronous version -- its scan is already capped at
 * MAX_CANDIDATE_NOTES, and its callers (plus tests) rely on the sync
 * contract.
 */
export async function findCandidatesCooperative(
  notes: NoteRecord[],
  opts: {
    threshold?: number;
    limit?: number;
    /** Abort the scan (e.g. the requesting client disconnected). */
    signal?: AbortSignal;
    /** Give up after this many milliseconds of wall-clock time. */
    deadlineMs?: number;
  } = {}
): Promise<CandidatePair[]> {
  const deadline = opts.deadlineMs === undefined ? Infinity : Date.now() + opts.deadlineMs;
  // Checked before the scan and at every cooperative yield point.
  const checkBudget = (): void => {
    if (opts.signal?.aborted) throw new CandidateScanError("candidate scan cancelled");
    if (Date.now() > deadline) {
      throw new CandidateScanError(
        `candidate scan exceeded its ${opts.deadlineMs}ms budget; narrow it with a namespace`
      );
    }
  };
  checkBudget();
  const { docs, threshold, limit } = prepareCandidateDocs(notes, opts);
  const pairs: CandidatePair[] = [];
  let checked = 0;
  for (const [i, j] of pairIndices(docs.length)) {
    collectCandidatePair(docs, i, j, threshold, pairs);
    checked += 1;
    if (checked % CANDIDATE_YIELD_EVERY === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      checkBudget();
    }
  }
  return finalizeCandidatePairs(pairs, limit);
}

let guardedScanRunning = false;

/**
 * The tool-facing candidate scan: findCandidatesCooperative under a
 * process-wide single-flight guard (one scan at a time -- a second
 * concurrent call is refused, not queued) and a hard deadline (default
 * CANDIDATE_SCAN_DEADLINE_MS). Pass the request's AbortSignal so a
 * disconnected client stops burning CPU.
 */
export async function findCandidatesGuarded(
  notes: NoteRecord[],
  opts: { threshold?: number; limit?: number; signal?: AbortSignal; deadlineMs?: number } = {}
): Promise<CandidatePair[]> {
  if (guardedScanRunning) {
    throw new CandidateScanError(
      "another duplicate-candidate scan is already running; retry when it finishes"
    );
  }
  guardedScanRunning = true;
  try {
    return await findCandidatesCooperative(notes, {
      ...opts,
      deadlineMs: opts.deadlineMs ?? CANDIDATE_SCAN_DEADLINE_MS,
    });
  } finally {
    guardedScanRunning = false;
  }
}

export interface ConsolidationPreview {
  namespace: string;
  title: string;
  body: string;
  tags: string[];
  source: string;
}

/**
 * Compute what a merge of these notes would produce, without writing
 * anything. Shared by consolidateNotes and the dry-run paths.
 */
export function buildConsolidationPreview(
  notes: NoteRecord[],
  mergedTitle?: string
): ConsolidationPreview {
  const title =
    mergedTitle?.trim() ||
    notes.reduce((longest, n) =>
      n.title.length >= longest.title.length ? n : longest
    ).title;

  // Deduplicated concatenation: exact-duplicate bodies appear once.
  const seen = new Set<string>();
  const bodies: string[] = [];
  for (const n of notes) {
    if (!seen.has(n.body)) {
      seen.add(n.body);
      bodies.push(n.body);
    }
  }

  return {
    namespace: notes[0].namespace,
    title,
    body: bodies.join("\n\n---\n\n"),
    tags: [...new Set(notes.flatMap((n) => n.tags))],
    // store.create slices source to 200 chars; union here and let it enforce.
    source: [...new Set(notes.map((n) => n.source).filter(Boolean))].join(","),
  };
}

/**
 * Resolve + validate the ids for a consolidation: 2+ distinct ids, all
 * exist, all in one namespace. Throws ValidationError otherwise.
 */
export function resolveConsolidationNotes(store: Store, ids: number[]): NoteRecord[] {
  if (!ids || ids.length < 2) {
    throw new ValidationError("consolidation needs at least 2 note ids");
  }
  const uniqueIds = [...new Set(ids)];
  if (uniqueIds.length < 2) {
    throw new ValidationError("consolidation needs at least 2 distinct note ids");
  }
  const notes = uniqueIds.map((id) => {
    const n = store.read(id);
    if (!n) throw new ValidationError(`no note with id ${id}`);
    if (n.archived_at) {
      // Merging deletes the sources and creates a LIVE note: that would
      // permanently destroy an archived (forgotten, restorable) note.
      throw new ValidationError(`note ${id} is archived; restore it before consolidating`);
    }
    return n;
  });
  const namespace = notes[0].namespace;
  if (!notes.every((n) => n.namespace === namespace)) {
    throw new ValidationError("cannot consolidate notes from different namespaces");
  }
  return notes;
}

/** Score at or above which the background janitor considers auto-merging a pair. */
export const AUTO_MERGE_SCORE = 0.99;

/**
 * Auto-merge eligibility gate (blocker #6).
 *
 * tokenize() drops single-char tokens and stopwords, so two terse notes
 * that differ only in single-letter codes (or punctuation/stopwords)
 * collapse to the same token set and score a perfect cosine 1.0. The 0.99
 * score band alone would then DELETE genuinely distinct notes -- silent
 * data loss by the background janitor.
 *
 * The safer rule (chosen over a minimum-token-count floor): auto-merge only
 * when the two notes' title AND body are exactly equal as strings. A
 * token-count floor (e.g. >= 4 tokens) still has a blind spot -- two long
 * notes whose ONLY differences are single-char/stopword tokens also
 * collapse to an identical token set and would auto-merge. Exact string
 * equality has no such blind spot. Near-identical pairs that differ in any
 * way are left for human review via memory_consolidation_candidates, never
 * merged blindly.
 */
export function isAutoMergeSafe(a: NoteRecord, b: NoteRecord): boolean {
  return a.title === b.title && a.body === b.body;
}

export interface JanitorOptions {
  /**
   * Blocker #4 -- when set, the candidate pool is restricted to this
   * namespace. Mirrors the MCP memory_consolidate tool (and
   * memory_consolidation_candidates): reads-from grants confer read access,
   * never the right to restructure/delete another namespace's notes, so
   * writes always stay in the server's own namespace. Unset means the whole
   * store (legacy single-tenant behavior).
   */
  ownNamespace?: string;
  /** Candidate-detection threshold (default 0.95). */
  threshold?: number;
  /** Score at/above which a pair is considered for auto-merge (default 0.99). */
  autoMergeScore?: number;
}

export interface JanitorResult {
  /** All >= threshold candidate pairs found (for the human-review log line). */
  candidateCount: number;
  merged: Array<{ idA: number; idB: number; mergedId: number }>;
  /** Pairs the janitor attempted but failed to merge (with reasons). */
  skipped: Array<{ idA: number; idB: number; reason: string }>;
}

/**
 * One background auto-consolidation pass (blockers #4/#6 hardened):
 *
 * - Only pairs scoring >= autoMergeScore are eligible for automatic
 *   merging; weaker candidates are counted for human review, never merged.
 * - Even an eligible pair auto-merges only when isAutoMergeSafe() holds
 *   (exact title+body equality); token-collapse near-duplicates are left
 *   for review, never merged blindly.
 * - When ownNamespace is set, only that namespace's notes are scanned --
 *   the janitor can never merge/delete another namespace's notes.
 *
 * A single failing pair never aborts the pass: it is recorded in `skipped`.
 * Callers (start.ts) only log.
 */
export function autoConsolidate(
  store: Store,
  opts: JanitorOptions = {}
): JanitorResult {
  const pool = janitorPool(store, opts);
  const candidates = findCandidates(pool, {
    threshold: opts.threshold ?? 0.95,
    limit: 200,
  });
  return mergeJanitorCandidates(store, pool, candidates, opts);
}

/**
 * Cooperative variant of autoConsolidate for the server's background
 * janitor: the candidate scan uses findCandidatesCooperative
 * (byte-identical results), yielding to the event loop every
 * CANDIDATE_YIELD_EVERY pair checks so a large scan doesn't stall
 * concurrent API/MCP traffic. The merge loop itself is unchanged (merges
 * are rare and each is a short transaction).
 */
export async function autoConsolidateCooperative(
  store: Store,
  opts: JanitorOptions = {}
): Promise<JanitorResult> {
  const pool = janitorPool(store, opts);
  const candidates = await findCandidatesCooperative(pool, {
    threshold: opts.threshold ?? 0.95,
    limit: 200,
  });
  return mergeJanitorCandidates(store, pool, candidates, opts);
}

/** The candidate pool for one janitor pass (own-namespace when configured). */
function janitorPool(store: Store, opts: JanitorOptions): NoteRecord[] {
  // Live notes only: archived notes are "forgotten but restorable"; the
  // janitor must never merge-and-delete them (that resurrects the content as
  // a live note and destroys the archive entry).
  return opts.ownNamespace
    ? store.exportAll({ live: true }).filter((n) => n.namespace === opts.ownNamespace)
    : store.exportAll({ live: true });
}

/**
 * Merge the eligible candidate pairs (shared by the sync and cooperative
 * janitor passes): only pairs scoring >= autoMergeScore AND passing
 * isAutoMergeSafe (exact title+body equality) are merged; everything else
 * stays a human-review candidate.
 */
function mergeJanitorCandidates(
  store: Store,
  pool: NoteRecord[],
  candidates: CandidatePair[],
  opts: JanitorOptions
): JanitorResult {
  const byId = new Map(pool.map((n) => [n.id, n]));
  const autoMergeScore = opts.autoMergeScore ?? AUTO_MERGE_SCORE;

  const consumed = new Set<number>();
  const merged: JanitorResult["merged"] = [];
  const skipped: JanitorResult["skipped"] = [];
  for (const c of candidates) {
    if (c.score < autoMergeScore) continue;
    if (consumed.has(c.idA) || consumed.has(c.idB)) continue;
    // Blocker #6: a 0.99+ score is not enough -- token collapse can put a
    // perfect 1.0 on genuinely distinct notes. Auto-merge exact duplicates
    // only; anything else stays a human-review candidate.
    const na = byId.get(c.idA);
    const nb = byId.get(c.idB);
    if (!na || !nb || !isAutoMergeSafe(na, nb)) continue;
    try {
      const note = consolidateNotes(store, [c.idA, c.idB], {
        deleteSources: true,
      });
      // Sync context: fire-and-forget. maybeEmbed never throws (the write
      // already succeeded; the embedding is best-effort), so an un-awaited
      // call here cannot fail the janitor pass.
      void maybeEmbed(store, note);
      consumed.add(c.idA);
      consumed.add(c.idB);
      merged.push({ idA: c.idA, idB: c.idB, mergedId: note.id });
    } catch (e) {
      skipped.push({
        idA: c.idA,
        idB: c.idB,
        reason: (e as Error).message,
      });
    }
  }
  return { candidateCount: candidates.length, merged, skipped };
}

/**
 * Merge a set of duplicate notes into one. Creates the merged note, then
 * deletes the sources by default (the point is dedup) unless
 * `deleteSources: false` is passed. Throws ValidationError on bad input;
 * callers (MCP/CLI) map that to a clean error.
 *
 * The merged note inherits the OLDEST source's created_at (so time-scoped
 * search keeps working -- a merge must not time-travel notes to "now");
 * updated_at stays "now" because the merge really did just happen.
 *
 * Embeddings: store.create does not embed. Async callers should
 * `await maybeEmbed(store, merged)` afterwards (see search-service.ts) so
 * the merged note is visible to semantic search; the synchronous janitor
 * path fires it without awaiting (maybeEmbed never throws).
 *
 * Atomicity + TOCTOU (blockers #7/#8): the whole merge -- validation
 * re-read, create, and all guarded deletes -- runs inside ONE SQLite
 * transaction via Store.transaction(). Inside it, every source is re-read
 * and its rev compared against the pre-transaction read; any change or
 * vanish aborts the merge (ValidationError, full rollback). Deletes are
 * guarded (DELETE ... WHERE id = ? AND rev = ?), mirroring
 * Store.update()'s compare-and-swap, so a writer racing between the re-read
 * and the delete cannot be silently destroyed. No partial merge can survive
 * a crash: either the merged note plus all deletes commit together, or
 * nothing does.
 */
export function consolidateNotes(
  store: Store,
  ids: number[],
  opts: { deleteSources?: boolean; mergedTitle?: string } = {}
): NoteRecord {
  const notes = resolveConsolidationNotes(store, ids);
  const preview = buildConsolidationPreview(notes, opts.mergedTitle);
  const expectedRevs = new Map(notes.map((n) => [n.id, n.rev]));
  const deleteSources = opts.deleteSources !== false;
  const sourceIds = new Set(notes.map((n) => n.id));

  return store.transaction(() => {
    // Re-read every source inside the transaction: the ids were validated
    // against a pre-transaction read, and a concurrent writer may have
    // changed or deleted them since. Abort (full rollback) on any mismatch.
    for (const [id, expectedRev] of expectedRevs) {
      const current = store.read(id);
      if (!current) {
        throw new ValidationError(
          `note ${id} was deleted while preparing the merge; aborting`
        );
      }
      if (current.rev !== expectedRev) {
        throw new ValidationError(
          `note ${id} changed while preparing the merge ` +
            `(rev ${expectedRev} -> ${current.rev}); aborting`
        );
      }
    }

    // Score the merged note's edges under the write lock (a consistent
    // snapshot; cheap via the namespace's cached index). The sources are
    // excluded -- they are about to be deleted -- and scoring runs before
    // create() so the merged note can't score against itself.
    const edgePairs = store.planEdges(
      preview.namespace,
      preview.title,
      preview.body,
      store.getEdgeThreshold(),
      sourceIds
    ).pairs;

    const merged = store.create(
      {
        namespace: preview.namespace,
        title: preview.title,
        body: preview.body,
        tags: preview.tags,
        source: preview.source,
        // Oldest source's date: a merge must not time-travel notes to "now".
        created_at: notes.reduce(
          (oldest, n) => (n.created_at < oldest ? n.created_at : oldest),
          notes[0].created_at
        ),
      },
      // Edges were pre-scored above; apply them directly instead of
      // re-running the scan inside the transaction.
      {
        skipEdges: true,
        lint: "trusted",
        // Retention: the merged note keeps a TTL only when EVERY source had
        // one (then the latest deadline, so nothing is forgotten earlier than
        // intended). If any source was meant to be kept forever, so is the merge.
        ...(notes.every((n) => n.expires_at)
          ? { expiresAt: notes.map((n) => n.expires_at as string).sort().pop() }
          : {}),
      }
    );
    store.applyEdgePairs(merged.id, edgePairs);

    if (deleteSources) {
      for (const [id, rev] of expectedRevs) {
        // Guarded delete, mirroring update()'s compare-and-swap: a writer
        // racing between the re-read above and this delete would silently
        // lose its write otherwise. A miss here means the row changed or
        // vanished mid-transaction -- abort rather than half-merge.
        if (!store.deleteIfRev(id, rev)) {
          throw new ValidationError(
            `note ${id} changed during the merge; aborting`
          );
        }
      }
    }
    return merged;
  });
}

/**
 * Group candidate pairs into connected components (union-find) so an
 * A-B, B-C chain merges as one group instead of failing on the second
 * pair's already-deleted note.
 */
export function groupCandidateIds(pairs: CandidatePair[]): number[][] {
  const parent = new Map<number, number>();
  const find = (x: number): number => {
    if (!parent.has(x)) parent.set(x, x);
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    // Path compression.
    let c = x;
    while (parent.get(c) !== r) {
      const next = parent.get(c)!;
      parent.set(c, r);
      c = next;
    }
    return r;
  };
  for (const p of pairs) {
    const ra = find(p.idA);
    const rb = find(p.idB);
    if (ra !== rb) parent.set(ra, rb);
  }
  const groups = new Map<number, number[]>();
  for (const id of parent.keys()) {
    const r = find(id);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r)!.push(id);
  }
  return [...groups.values()].map((g) => g.sort((a, b) => a - b));
}
