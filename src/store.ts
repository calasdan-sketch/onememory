// SQLite-backed note store shared by the HTTP API and the MCP server.
//
// Uses Node's built-in node:sqlite (DatabaseSync) -- no native module build
// step, ships in the Node binary, and its bundled SQLite has FTS5 compiled
// in (verified at build time on this machine). Keeping the dependency
// footprint at zero for the storage layer is deliberate: fewer deps, fewer
// CVEs, one less thing to break on a different machine.
//
// FTS sync strategy: the notes_fts table is an external-content FTS5 index
// over `notes`, kept in lockstep by SQL triggers (AFTER INSERT/UPDATE/DELETE).
// This means search can never go stale after a write -- there is no
// app-level "remember to reindex" step to forget.

import { DatabaseSync } from "node:sqlite";
import { mkdirSync, statSync, readdirSync, renameSync } from "node:fs";
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { dirname, basename, join } from "node:path";
import { checkSizes, audit } from "./security.js";
import { chmodQuiet } from "./config.js";
import { lintContent, lintPolicy, describeFindings, type LintFinding, type LintAction } from "./lint.js";
// Reuses consolidate.ts's zero-dependency text similarity for the note
// similarity graph. This is a module cycle (consolidate.ts imports Store
// from here), but a safe one: both modules only touch the other's bindings
// inside function bodies at runtime, never during module evaluation.
import {
  precomputeTfMaps,
  computeDocFreqs,
  cosineTfIdf,
  idfFromCount,
  sharedTokenCount,
  termFreq,
  tokenize,
  MIN_SHARED_TOKENS_FOR_EDGE,
} from "./consolidate.js";
// No module cycle: staleness.ts imports config.ts at runtime and store.ts
// only as a type (erased at compile), so store -> staleness -> config is
// acyclic.
import { isStale, stalenessConfig, annotateStaleness } from "./staleness.js";
// At-rest encryption for note bodies. No module cycle: crypto.ts imports
// only node: builtins, never store.ts.
import { encrypt, decryptIfEncrypted, loadKey, keyPath, noteAad } from "./crypto.js";
import { currentActor } from "./actor.js";

/**
 * A caller-input error (bad/oversized/secret-bearing data, empty title, stale
 * write). The HTTP layer maps these to 400 with the message shown; anything
 * else is an unexpected fault mapped to a generic 500, so internals never leak.
 */
export class ValidationError extends Error {}

/**
 * A stored note body could not be decrypted (wrong key file, or the row was
 * tampered with / moved). NOT a ValidationError: it is the operator's problem,
 * so the REST layer answers 500 -- but with this clear, id-bearing message
 * instead of a bare "internal error", and never hangs a stream.
 */
export class NoteUnreadableError extends Error {
  constructor(
    public readonly noteId: number,
    detail: string
  ) {
    super(`note ${noteId} cannot be decrypted (wrong key file, or the stored data was altered): ${detail}`);
  }
}

/**
 * forget_after must be a finite number of days >= 0 (0 clears the TTL).
 * Anything else used to silently mean "no TTL", so the caller believed a note
 * would expire when it never would.
 */
export function validateForgetAfter(v: unknown): void {
  if (v === undefined || v === null) return;
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
    throw new ValidationError("forget_after must be a finite number of days >= 0 (0 = no expiry)");
  }
}

/**
 * REST clients commonly send numbers as strings ("5"). Turn a plain numeric
 * string into a number; anything else is returned untouched so the strict
 * validator still rejects it (400) with its clear message.
 */
export function coerceNumeric(v: unknown): unknown {
  if (typeof v === "string" && /^\s*[+-]?(\d+\.?\d*|\.\d+)\s*$/.test(v)) return Number(v);
  return v;
}

/**
 * A rebuild was requested while another one is already running in this
 * process (single-flight). A ValidationError subclass so every surface maps
 * it to a clean caller-facing error; the REST layer answers 409.
 */
export class RebuildBusyError extends ValidationError {
  constructor() {
    super("a similarity-edge rebuild is already running; retry when it finishes");
  }
}

/**
 * A guarded duplicate-candidate scan (consolidate.ts findCandidatesGuarded)
 * was refused (one already running), cancelled, or ran out of time.
 */
export class CandidateScanError extends ValidationError {}

/**
 * A write held for admin review by the write-time linter (ONEMEMORY_LINT
 * quarantine policy). A ValidationError subclass so an unaware caller still
 * maps it to a clean caller-facing error; the REST and MCP write paths catch
 * it and report `{ quarantined: { id, reasons } }` instead.
 */
export class QuarantinedError extends ValidationError {
  constructor(
    readonly quarantineId: number,
    readonly findings: LintFinding[]
  ) {
    super(
      `held in quarantine #${quarantineId} pending admin review (${describeFindings(findings)})`
    );
  }
}

/** How much of the write-time linter a write path runs. */
export type LintMode =
  /** Default: secrets + injection, ONEMEMORY_LINT policy. */
  | "full"
  /** Internal re-writes of already-stored content (consolidation): injection
   *  is skipped and a secret can only block or warn, never quarantine. */
  | "trusted"
  /** Quarantine approval: an admin already reviewed it; sizes still apply. */
  | "none";

export interface LintOpts {
  lint?: LintMode;
  /** Filled with findings the policy let through (action "warn"). */
  lintWarnings?: LintFinding[];
}

/** Reject oversized input. */
function validateSizes(input: { title?: string; body?: string; tags?: string[] }): void {
  const sizeErr = checkSizes(input);
  if (sizeErr) throw new ValidationError(sizeErr);
}

/**
 * Decide what the lint policy says about `findings`: throw for block, return
 * "quarantine" when the write must be held, else record warnings and return
 * null. Block beats quarantine beats warn.
 */
function applyLintPolicy(findings: LintFinding[], opts: LintOpts): "quarantine" | null {
  if (findings.length === 0) return null;
  const policy = lintPolicy();
  const mode = opts.lint ?? "full";
  const actionFor = (f: LintFinding): LintAction => {
    const a = policy[f.category];
    return mode === "trusted" && a === "quarantine" ? "block" : a;
  };
  const blocked = findings.filter((f) => actionFor(f) === "block");
  if (blocked.length > 0) {
    const secret = blocked.find((f) => f.category === "secret");
    // Keep the 1.0 wording for secrets: callers and docs match on it.
    if (secret) {
      throw new ValidationError(
        `refusing to store what looks like a ${secret.label}; remove the secret or store a reference to it instead`
      );
    }
    throw new ValidationError(
      `refusing to store what looks like a prompt-injection instruction (${describeFindings(blocked)}); rephrase it as plain data`
    );
  }
  if (findings.some((f) => actionFor(f) === "quarantine")) return "quarantine";
  opts.lintWarnings?.push(...findings);
  return null;
}

/** Findings to lint for a write, honoring the lint mode. */
function lintFor(
  fields: { title?: string; body?: string; tags?: string[]; source?: string },
  mode: LintMode
): LintFinding[] {
  if (mode === "none") return [];
  const all = lintContent(fields);
  return mode === "trusted" ? all.filter((f) => f.category === "secret") : all;
}

export interface NoteInput {
  namespace?: string;
  title: string;
  body?: string;
  tags?: string[];
  source?: string;
  /**
   * Optional backdate for created_at (ISO-8601 string). Used internally by
   * consolidation so a merged note keeps its oldest source's date, and by
   * /import so a backup restore preserves original dates. Unparsable values
   * are ignored (created_at falls back to now).
   */
  created_at?: string;
  /**
   * Retention: forget this note N days after this write (0 = no TTL).
   * Stored as an absolute `expires_at`; archived, not hard-deleted, when it
   * passes (see sweepExpired).
   */
  forget_after?: number;
}

/**
 * One note of a backup being restored: a NoteInput plus its updated_at and
 * rev. Both are restore-fidelity fields -- they exist so a backup taken
 * after months of edits restores with its history intact (original dates,
 * revision counter) instead of looking brand new.
 */
export type ImportNote = NoteInput & {
  updated_at?: string;
  rev?: number;
  /** Retention state carried by an export; kept on restore (ISO-8601). */
  expires_at?: string | null;
  archived_at?: string | null;
};

/** Per-note outcome of importNotes() for writes that did not become notes. */
export interface ImportReport {
  quarantined: Array<{ title: string; quarantineId: number }>;
  rejected: Array<{ title: string; error: string }>;
  /** Set by importNotes({ dedupe: true }): notes skipped as already present. */
  skipped?: number;
}

/** One entry of the change feed (Store.changes). No bodies: titles only. */
export interface ChangeEntry {
  kind: "created" | "updated" | "deleted";
  id: number;
  namespace: string;
  title: string;
  source: string;
  /** When it happened: updated_at for created/updated, deleted_at for deleted. */
  at: string;
  /** Current revision (absent for deletes). */
  rev?: number;
}

export interface ChangeCounts {
  created: number;
  updated: number;
  deleted: number;
}

export interface ChangesPage {
  /** Window start (exclusive of nothing: changes at or after it). */
  since: string;
  /** Window end (exclusive), fixed when the first page was requested. */
  until: string;
  changes: ChangeEntry[];
  /** Totals over the whole window, not just this page. */
  counts: ChangeCounts & { total: number };
  /** Totals grouped by provenance source ("" = unattributed). */
  bySource: Record<string, ChangeCounts>;
  /** Linter-held writes queued in the window (not notes; see quarantine). */
  quarantined: number;
  /** Opaque cursor for the next page; null when this was the last page. */
  nextCursor: string | null;
  /** Internal: the "last"-marker consumer carried by this read (changes.ts strips it). */
  consumer: string | null;
  /** Internal: the window's last change seq -- where the "last" marker advances to. */
  seq: number;
}

/** A write held by the linter, as listed for admin review. */
export interface QuarantineEntry {
  id: number;
  op: "create" | "update";
  /** For op=update: the note the write targets. */
  target_id: number | null;
  namespace: string;
  title: string | null;
  body: string | null;
  tags: string[] | null;
  source: string | null;
  reasons: LintFinding[];
  created_at: string;
}

/** How long change-log rows (incl. deletes) are kept for the change feed. */
export const CHANGE_LOG_RETENTION_DAYS = 90;

/** Current schema version (PRAGMA user_version). See Store.migrate. */
export const SCHEMA_VERSION = 12;

/**
 * Notes fetched per page by exportBatch(), which both streaming export
 * paths (HTTP /export and `onememory export --format json`) use so peak
 * memory stays one page regardless of store size.
 */
export const EXPORT_PAGE_SIZE = 500;

/** SQLite expression for "now" as an ISO-8601 string (same shape as Date#toISOString). */
const SQL_NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

/**
 * Absolute TTL deadline for `days` from `from`, or null for "no TTL".
 *
 * Guarded to a sane ceiling (100 years) so a garbage value like 1e15 days
 * cannot produce an Infinity/Invalid Date that SQLite would store as a
 * non-comparable string and the sweep would never match.
 */
const RETENTION_MAX_DAYS = 36_500;
export function retentionDeadline(
  days: number | undefined,
  from: string = new Date().toISOString()
): string | null {
  if (days === undefined || days === null) return null;
  const n = Number(days);
  if (!Number.isFinite(n) || n <= 0) return null; // 0 / negative / NaN = no TTL
  const capped = Math.min(n, RETENTION_MAX_DAYS);
  const base = Date.parse(from);
  if (!Number.isFinite(base)) return null;
  return new Date(base + capped * 86_400_000).toISOString();
}

/** Change-feed page size bounds. */
export const CHANGES_DEFAULT_LIMIT = 100;
export const CHANGES_MAX_LIMIT = 500;

export interface NotePatch {
  namespace?: string;
  title?: string;
  body?: string;
  tags?: string[];
  source?: string;
  /** Retention: reset/extend the TTL (days from now; 0 clears it). */
  forget_after?: number;
}

export interface NoteRecord {
  /** Set only by a tolerant export for a row whose body could not be decrypted. */
  unreadable?: true;
  id: number;
  namespace: string;
  title: string;
  body: string;
  tags: string[];
  rev: number;
  source: string;
  created_at: string;
  updated_at: string;
  /** Read-importance tracking: total user-facing reads of this note. */
  access_count: number;
  /** ISO-8601 timestamp of the most recent read; null = never read. */
  last_accessed: string | null;
  /**
   * Retention: when this note is due to be forgotten (ISO-8601), set from
   * `forget_after` days at write time. Absent when the note has no TTL.
   * Exposed only when non-null so existing deepEqual assertions keep their
   * byte-identical shape (same convention as `neighbors`).
   */
  expires_at?: string;
  /**
   * Retention: when this note was archived (ISO-8601). Archived notes are
   * excluded from list/search/recall by default and restorable. Absent when live.
   */
  archived_at?: string;
  /**
   * True when this note's body was stored encrypted at rest and decrypted on
   * read (see crypto.ts). Title/tags/timestamps remain plaintext because
   * search and namespace isolation need them -- documented, not hidden.
   */
  encrypted?: boolean;
}

interface NoteRow {
  id: number;
  namespace: string;
  title: string;
  body: string;
  tags: string;
  rev: number;
  source: string;
  created_at: string;
  updated_at: string;
  access_count: number;
  last_accessed: string | null;
  /** Ciphertext of the body when at-rest encryption is on; NULL otherwise. */
  body_enc: string | null;
  expires_at: string | null;
  archived_at: string | null;
}

export const DEFAULT_NAMESPACE = "default";

/** AAD binding a sealed quarantine column to its column name and namespace. */
function quarantineAad(col: string, namespace: string): string {
  return `quarantine|${col}|${namespace}`;
}

function rowToRecord(row: NoteRow): NoteRecord {
  return {
    id: row.id,
    namespace: row.namespace,
    title: row.title,
    // body is the FTS-indexed plaintext column. For an encrypted note the
    // row's body is '' (see crypto.ts) and Store.rec() swaps in the
    // decrypted text, so callers always see real content.
    body: row.body,
    tags: parseTags(row.tags),
    rev: row.rev ?? 1,
    source: row.source ?? "",
    created_at: row.created_at,
    updated_at: row.updated_at,
    access_count: row.access_count ?? 0,
    last_accessed: row.last_accessed ?? null,
  };
}

/**
 * Attach retention + encryption fields only when meaningful, so a note
 * without a TTL, not archived, and unencrypted keeps exactly the old shape
 * (existing deepEqual assertions stay green).
 */
function annotateRetention(row: NoteRow, rec: NoteRecord): NoteRecord {
  const out: NoteRecord = rec;
  if (row.expires_at) out.expires_at = row.expires_at;
  if (row.archived_at) out.archived_at = row.archived_at;
  if (row.body_enc) out.encrypted = true;
  return out;
}

function tagsToStorage(tags: string[] | undefined): string {
  if (!tags || tags.length === 0) return "";
  // Store as a JSON array so tags can contain commas/spaces; dedupe + trim.
  const cleaned = Array.from(new Set(tags.map((t) => t.trim()).filter(Boolean)));
  return cleaned.length ? JSON.stringify(cleaned) : "";
}

function parseTags(raw: string): string[] {
  if (!raw) return [];
  if (raw[0] === "[") {
    try {
      const a = JSON.parse(raw);
      if (Array.isArray(a)) return a.filter((x) => typeof x === "string");
    } catch {
      /* fall through to legacy comma parse */
    }
  }
  return raw.split(",").map((t) => t.trim()).filter(Boolean); // legacy rows
}

/** Build an FTS5 MATCH expression: AND of prefix-matched, quote-escaped tokens. */
function buildMatchQuery(q: string): string {
  const tokens = q
    .trim()
    .split(/\s+/)
    .filter((t) => /[\p{L}\p{N}]/u.test(t)) // keep only tokens with a letter/number
    .map((t) => `"${t.replace(/"/g, '""')}"*`);
  return tokens.join(" AND "); // "" when nothing usable; caller returns []
}

/**
 * Normalize a caller-supplied timestamp to canonical ISO-8601 (UTC, ms), or
 * null when it is missing, not a string, or doesn't parse. Canonical form
 * matters: created_at/updated_at are compared and sorted as strings.
 */
function isoOrNull(v: unknown): string | null {
  if (typeof v !== "string" || !v.trim()) return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/** Coerce a possibly-NaN/undefined value to a bounded integer with a default. */
export function clampInt(v: number | undefined, def: number, min: number, max: number): number {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : def;
  return Math.min(Math.max(n, min), max);
}

// --- Similarity edge graph (v4) -------------------------------------------

/**
 * Default cosine-similarity floor for creating a similarity edge.
 *
 * Was 0.35, cargo-culted from llmem's BM25-based metric (a different scale).
 * Re-tuned 2026-10-16 (I-HIGH-1) by sweeping 0.15–0.60 on 150 hand-labeled
 * note pairs (75 similar / 75 not, incl. shared-token traps) scored with
 * TF-IDF cosine + a minimum-support floor of MIN_SHARED_TOKENS_FOR_EDGE
 * shared content tokens: F1 peaks at 0.851 on the 0.15–0.25 plateau
 * (P 0.863, R 0.840); 0.25 is the top of the plateau, chosen to favor
 * precision (a junk edge pollutes the neighbor list; a missed edge is just
 * one less suggestion — FTS still finds the note). Dataset + script:
 * reviews/tier2-threshold-sweep/. 12/75 positives are unreachable by any
 * token metric (no shared content tokens) — the documented recall ceiling.
 *
 * This is the *default*: the active threshold is persisted per-database in
 * the _meta table (see getEdgeThreshold/setEdgeThreshold) so operators can
 * retune without a code change, and every write path reads it — no
 * mixed-threshold graphs.
 */
export const EDGE_SIMILARITY_THRESHOLD = 0.25;

/** Max neighbors attached to a single note read (state_read neighbors:true). */
export const EDGE_NEIGHBOR_LIMIT = 10;

/**
 * Cooperative rebuild cadence: rebuildEdgesCooperative yields to the event
 * loop this often (pair checks) so a large rebuild never freezes concurrent
 * API/MCP traffic. Mirrors CANDIDATE_YIELD_EVERY in consolidate.ts.
 */
export const REBUILD_YIELD_EVERY = 8192;

/**
 * Rebuild chunk size: outer-loop notes per committed chunk transaction.
 * Each chunk = score this band's pairs (no lock held, yields every
 * REBUILD_YIELD_EVERY pairs), then commit that band's edge inserts in one
 * short transaction. Chunk boundaries are the resume points: progress is
 * recorded in the _meta table per chunk, so an interrupted rebuild resumes
 * instead of restarting from scratch.
 */
export const REBUILD_BAND_NOTES = 256;

/**
 * MCP memory_rebuild_edges confirmation gate: above this many notes in
 * scope the tool refuses unless the caller passes confirm: true (the
 * rebuild is O(n^2) CPU even though it no longer freezes the server).
 */
export const REBUILD_CONFIRM_NOTE_COUNT = 2000;

/**
 * CLI rebuild-edges confirmation gate: above this many pairs the CLI asks
 * for confirmation (or requires --yes) before scoring.
 */
export const REBUILD_CONFIRM_PAIR_COUNT = 500_000;

/** Resume-progress row for an interrupted rebuildEdgesCooperative run. */
const REBUILD_PROGRESS_KEY = "rebuild_edges_progress";

/**
 * importNotes links imported notes into the graph in batches of this many
 * notes: each batch is scored and applied in one short write transaction,
 * then the import yields to the event loop.
 */
export const IMPORT_LINK_BATCH = 32;

/**
 * Notes per write transaction while RESTORING a backup (importNotes).
 *
 * Without a surrounding transaction, create() opens and commits its own
 * BEGIN IMMEDIATE per note -- one WAL fsync each, measured at ~0.7ms apiece
 * (8000-note restore: 3.6s of inserts, ~5s of which is per-note fsync).
 * Batching amortizes that to one commit per chunk. Kept small enough that
 * the synchronous insert loop blocks the event loop for well under a second
 * and the write lock is held for only ~100ms at a time, so concurrent
 * API/MCP requests and other processes only wait briefly.
 */
export const IMPORT_INSERT_BATCH = 500;

/**
 * In-process edge-scoring index for one namespace: each note's cached
 * term-frequency map plus an inverted index (token -> note ids). Lets
 * planEdges() score a note against only the notes it shares tokens with,
 * instead of re-selecting and re-tokenizing the whole namespace on every
 * write. Kept in sync lazily against the database (see Store.edgeIndex), so
 * writes from other connections/processes are picked up.
 */
interface NsEdgeIndex {
  /** dataVersion() when the index was last synced with the database. */
  ver: number;
  /** Last use (ms epoch), for idle release. */
  used: number;
  /** id -> rev the cached TF map was built from. */
  revs: Map<number, number>;
  tf: Map<number, Map<string, number>>;
  /** id -> sqrt(sum tf^2): an IDF-free norm, used only to rank candidates. */
  tfNorm: Map<number, number>;
  /** token -> (note id -> that note's term frequency). */
  postings: Map<string, Map<number, number>>;
}

/**
 * planEdges scores at most this many candidates per write (those with the
 * highest TF-cosine proxy among notes sharing >= MIN_SHARED_TOKENS_FOR_EDGE
 * tokens), bounding write latency on large, homogeneous namespaces. Below
 * the cap -- the normal case -- results equal the exhaustive scan; above it
 * only the weakest-overlap candidates go unscored (and a full
 * rebuild-edges still scores every pair).
 */
export const EDGE_CANDIDATE_LIMIT = 256;

/**
 * Edge-index cache bounds (env-tunable, read per use): a namespace's index
 * is released after ONEMEMORY_EDGE_INDEX_IDLE_MS without use (default 10
 * min), and least-recently-used namespaces are released while more than
 * ONEMEMORY_EDGE_INDEX_MAX_NOTES notes are cached (default 50,000).
 */
/** Most distinct notes with buffered (unflushed) reads; extra reads are dropped. */
const ACCESS_PENDING_MAX = 100_000;

/** ONEMEMORY_ACCESS_FLUSH_MS: how often buffered read counts are written (default 5000; 0 = immediately). */
export function accessFlushMs(): number {
  const v = process.env.ONEMEMORY_ACCESS_FLUSH_MS;
  const n = Number(v);
  return v !== undefined && v.trim() !== "" && Number.isFinite(n) && n >= 0 ? n : 5000;
}

export function edgeIndexLimits(): { idleMs: number; maxNotes: number } {
  const num = (v: string | undefined, def: number): number => {
    const n = Number(v);
    return v !== undefined && v.trim() !== "" && Number.isFinite(n) && n >= 0 ? n : def;
  };
  return {
    idleMs: num(process.env.ONEMEMORY_EDGE_INDEX_IDLE_MS, 600_000),
    maxNotes: num(process.env.ONEMEMORY_EDGE_INDEX_MAX_NOTES, 50_000),
  };
}

/** One directed similarity edge endpoint: a similar note + the pair's score. */
export interface NeighborEntry {
  id: number;
  title: string;
  score: number;
  /** Staleness of the neighbor, annotated at read time (I-LOW-1): a stale
   * neighbor is still a valid suggestion, but the caller should verify it
   * before acting on it. Optional because listNeighbors() returns the raw
   * graph shape; read() attaches these via annotatedNeighbors(). */
  stale?: boolean;
  /** Whole days since the neighbor's updated_at (floored; never negative). */
  ageDays?: number;
  /** Human-readable warning, present only when the neighbor is stale. */
  staleWarning?: string;
}

export interface ReadOpts {
  /**
   * Marks a *user-facing* read (HTTP GET /notes/:id, MCP state_read):
   * bumps access_count / last_accessed. Internal reads leave counters
   * alone so system churn never inflates importance.
   */
  trackAccess?: boolean;
  /** When true, attach up to EDGE_NEIGHBOR_LIMIT same-namespace neighbors. */
  withNeighbors?: boolean;
}

export interface RebuildEdgesResult {
  /** Directed edge rows inserted by the rebuild. */
  created: number;
  /** Directed edge rows deleted by the rebuild. */
  removed: number;
}

/** One namespace's share of a rebuild: note count + pair count (n·(n−1)/2). */
export interface RebuildPlanEntry {
  namespace: string;
  notes: number;
  pairs: number;
}

export interface RebuildEdgesOptions {
  threshold?: number;
  namespace?: string;
  /**
   * Progress callback, fired every REBUILD_YIELD_EVERY pair checks, at each
   * chunk boundary, and on completion: (pairsDone, pairsTotal).
   */
  onProgress?: (done: number, total: number) => void;
}

/**
 * Validate a caller-supplied edge similarity threshold. Undefined means the
 * default; anything outside (0, 1] (or non-numeric) is a caller error, not
 * something to silently clamp -- a rewritten threshold changes which edges
 * exist, so the caller should know its value was wrong.
 */
export function resolveEdgeThreshold(v: number | undefined): number {
  const t = v === undefined ? EDGE_SIMILARITY_THRESHOLD : v;
  if (typeof t !== "number" || !Number.isFinite(t) || t <= 0 || t > 1) {
    throw new ValidationError(`threshold must be a number in (0, 1] (got ${v})`);
  }
  return t;
}

/** Pack a Float32Array into bytes for a SQLite BLOB. */
function vecToBlob(vec: Float32Array): Uint8Array {
  return new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength);
}

/** Rebuild a Float32Array from BLOB bytes, copying to a fresh, aligned buffer. */
function blobToVec(blob: Uint8Array): Float32Array {
  const copy = new Uint8Array(blob.length);
  copy.set(blob);
  return new Float32Array(copy.buffer, 0, Math.floor(copy.length / 4));
}

/** Cosine similarity of two equal-length vectors; 0 if degenerate. */
export function cosineSim(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export interface SemanticHit {
  note: NoteRecord;
  score: number;
}

/** Aggregate access-tracking numbers for the memory_stats surface. */
export interface AccessStats {
  /** Notes counted (within the requested namespaces, if any). */
  totalNotes: number;
  /** Sum of access_count over those notes. */
  totalAccesses: number;
  /** Up to 10 hottest notes: id, title, access_count (no bodies leaked). */
  mostAccessed: Array<{ id: number; title: string; access_count: number }>;
  /** Notes with last_accessed NULL -- never read; the dead-memory candidates. */
  neverAccessed: number;
  /** Notes older than the staleness thresholds (see staleness.ts). */
  staleCount: number;
}

/** One keyword hit with its FTS5 bm25 rank exposed as a positive score. */
export interface RankedHit {
  note: NoteRecord;
  /** Higher = better match. FTS5's `rank` is negative (lower = better), so
   *  this is -rank: identical documents score identically, which is exactly
   *  the tie the access-count boost is meant to break. */
  score: number;
}

interface VectorRow {
  note_id: number;
  dim: number;
  model: string;
  vec: Uint8Array;
}

export interface RangeOpts {
  /**
   * ISO-8601 bounds scoping results to notes created in [startISO, endISO).
   * Scopes on created_at ("when it was written"), not updated_at: an edit
   * tomorrow doesn't move a note out of "yesterday". End is exclusive so
   * adjacent day ranges tile without overlap.
   */
  startISO?: string;
  endISO?: string;
}

/**
 * SQL fragment filtering by archive state.
 *
 * Default (neither flag): only live notes (`archived_at IS NULL`), so a
 * forgotten note never leaks back into list/search/recall. includeArchived
 * shows everything; archivedOnly shows just the archive (restore flow).
 */
function archivedClause(includeArchived?: boolean, archivedOnly?: boolean): string {
  if (includeArchived) return "";
  if (archivedOnly) return " AND archived_at IS NOT NULL";
  return " AND archived_at IS NULL";
}

/**
 * SQL filter for exact-tag filters over the JSON-array tags column.
 * instr() is CASE-SENSITIVE (LIKE is not), so "Task" never matches "task" and
 * LIMIT/total are computed over the right rows. The needle is the tag's JSON
 * encoding including its quotes, so a tag never matches inside another value;
 * tagsMatch() re-checks exactly as a belt-and-braces guard.
 */
function tagClause(withTags?: string[], withoutTags?: string[], tagPrefix?: string): { sql: string; params: string[] } {
  let sql = "";
  const params: string[] = [];
  if (tagPrefix) {
    // JSON encoding without the closing quote: matches a tag that STARTS with the prefix.
    sql += " AND instr(tags, ?) > 0";
    params.push(JSON.stringify(tagPrefix).slice(0, -1));
  }
  for (const t of withTags ?? []) {
    sql += " AND instr(tags, ?) > 0";
    params.push(JSON.stringify(t));
  }
  for (const t of withoutTags ?? []) {
    sql += " AND instr(tags, ?) = 0";
    params.push(JSON.stringify(t));
  }
  return { sql, params };
}

function tagsMatch(rawTags: string, withTags?: string[], withoutTags?: string[], tagPrefix?: string): boolean {
  if (!withTags?.length && !withoutTags?.length && !tagPrefix) return true;
  const have = parseTags(rawTags);
  if (tagPrefix && !have.some((t) => t.startsWith(tagPrefix))) return false;
  return (withTags ?? []).every((t) => have.includes(t)) && !(withoutTags ?? []).some((t) => have.includes(t));
}

function rangeClause(opts: RangeOpts): { sql: string; params: string[] } {
  const clauses: string[] = [];
  const params: string[] = [];
  if (opts.startISO) {
    clauses.push("notes.created_at >= ?");
    params.push(opts.startISO);
  }
  if (opts.endISO) {
    clauses.push("notes.created_at < ?");
    params.push(opts.endISO);
  }
  return { sql: clauses.length ? " AND " + clauses.join(" AND ") : "", params };
}

function addToIndex(idx: NsEdgeIndex, id: number, rev: number, tf: Map<string, number>): void {
  idx.tf.set(id, tf);
  idx.revs.set(id, rev);
  let sq = 0;
  for (const [t, n] of tf) {
    sq += n * n;
    const posting = idx.postings.get(t);
    if (posting) posting.set(id, n);
    else idx.postings.set(t, new Map([[id, n]]));
  }
  idx.tfNorm.set(id, Math.sqrt(sq));
}

function dropFromIndex(idx: NsEdgeIndex, id: number): void {
  const tf = idx.tf.get(id);
  if (tf) {
    for (const t of tf.keys()) {
      const posting = idx.postings.get(t);
      posting?.delete(id);
      if (posting && posting.size === 0) idx.postings.delete(t);
    }
  }
  idx.tf.delete(id);
  idx.revs.delete(id);
  idx.tfNorm.delete(id);
}

export class Store {
  private db: DatabaseSync;
  private readonly dbPath: string;
  /** Per-namespace edge-scoring index (see NsEdgeIndex). */
  private edgeIndexes = new Map<string, NsEdgeIndex>();
  /** Single-flight guard: at most one rebuildEdgesCooperative per Store. */
  private rebuildRunning = false;
  /**
   * At-rest encryption key (32B), loaded once at open. Null when no key file
   * exists, which means the store is plaintext and every code path below
   * behaves exactly as before. See crypto.ts for the body_enc design.
   */
  private lastKey: Buffer | null;
  /** Fingerprint of the key file `keyCache` was loaded from. */
  private keyStamp = "";
  /** "" = no-key state not yet verified against the rows (reset whenever a key is seen). */
  private keyChecked = "";
  /** Directory the key file resolves against (single resolver: beside the DB). */
  private readonly keyDir: string;

  /**
   * How long a statement waits on a contended SQLite lock before giving up
   * with SQLITE_BUSY. Access-counter flushes (flushAccess) run best-effort with a zero
   * timeout instead (see bestEffortWrite): a lost read-count is acceptable,
   * a failed or stalled read is not.
   */
  private static readonly BUSY_TIMEOUT_MS = 5000;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    if (dbPath !== ":memory:") {
      mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
    }
    this.db = new DatabaseSync(dbPath);
    // busy_timeout FIRST: switching to WAL and migrating both need a lock
    // another process may be holding at the same moment.
    this.db.exec(`PRAGMA busy_timeout = ${Store.BUSY_TIMEOUT_MS};`);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    // Load the at-rest key before migrations so a v10 upgrade on an encrypted
    // store can read existing rows. loadKey throws on a corrupt key file
    // rather than silently degrading -- see crypto.ts.
    this.keyDir = dirname(dbPath);
    this.lastKey = loadKey(this.keyDir);
    if (!this.lastKey) this.recoverStrandedKey();
    this.keyStamp = this.stampOf();
    this.init();
    this.installActorStamp();
    this.upgradeV1Envelopes();
    // Notes are private: owner-only db + WAL/SHM (POSIX; no-op on Windows).
    if (dbPath !== ":memory:") for (const ext of ["", "-wal", "-shm"]) chmodQuiet(dbPath + ext, 0o600);
  }

  /**
   * Schema setup + migrations, versioned via PRAGMA user_version.
   *
   * Concurrency: several processes (stdio MCP per agent, the HTTP server,
   * the CLI) may open the same pre-upgrade database at the same moment.
   * The whole upgrade runs in ONE BEGIN IMMEDIATE transaction and re-reads
   * user_version under the write lock, so the first process migrates and
   * the rest wait (busy_timeout) and then find nothing to do. Every step is
   * idempotent anyway (IF NOT EXISTS, column-existence checks).
   */
  private init(): void {
    const version = (): number =>
      Number((this.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
    const found = version();
    if (found > SCHEMA_VERSION) {
      // A newer onememory migrated this file. Opening it with older code
      // would silently misread/corrupt data it does not know about (for
      // example plaintext writes next to ciphertext), so refuse.
      try {
        this.db.close();
      } catch {
        /* nothing to close */
      }
      throw new Error(
        `onememory: this database is at schema version ${found}, newer than this build supports ` +
          `(${SCHEMA_VERSION}). Upgrade onememory (npm i -g onememory@latest) instead of opening it with an older version.`
      );
    }
    if (found >= SCHEMA_VERSION) return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const v = version();
      if (v < SCHEMA_VERSION) {
        this.migrate(v);
        this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      }
      this.db.exec("COMMIT");
    } catch (e) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* nothing to roll back */
      }
      throw e;
    }
  }

  private hasColumn(table: string, column: string): boolean {
    return (this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some(
      (c) => c.name === column
    );
  }

  private addColumn(table: string, column: string, decl: string): void {
    if (!this.hasColumn(table, column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  }

  /** Bring a schema at version `v` up to SCHEMA_VERSION. Caller holds the write lock. */
  private migrate(v: number): void {
    if (v < 1) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS notes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          namespace TEXT NOT NULL DEFAULT '${DEFAULT_NAMESPACE}',
          title TEXT NOT NULL,
          body TEXT NOT NULL DEFAULT '',
          tags TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_notes_namespace ON notes(namespace);
        CREATE INDEX IF NOT EXISTS idx_notes_ns_created ON notes(namespace, created_at);
        CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
          title, body, tags,
          content='notes', content_rowid='id'
        );
        CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN
          INSERT INTO notes_fts(rowid, title, body, tags)
          VALUES (new.id, new.title, new.body, new.tags);
        END;
        CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON notes BEGIN
          INSERT INTO notes_fts(notes_fts, rowid, title, body, tags)
          VALUES('delete', old.id, old.title, old.body, old.tags);
        END;
      `);
      // v1: note revision (compare-and-swap) + provenance source.
      this.addColumn("notes", "rev", "INTEGER NOT NULL DEFAULT 1");
      this.addColumn("notes", "source", "TEXT NOT NULL DEFAULT ''");
    }
    if (v < 2) {
      // v2: optional semantic search. One embedding per note (raw Float32
      // BLOB); ON DELETE CASCADE retires it with the note.
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS note_vectors (
          note_id INTEGER PRIMARY KEY REFERENCES notes(id) ON DELETE CASCADE,
          dim INTEGER NOT NULL,
          model TEXT NOT NULL DEFAULT '',
          vec BLOB NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
    }
    if (v < 3) {
      // v3: access tracking. access_count counts user-facing reads;
      // last_accessed is the latest read (NULL = never read). Writes leave
      // both alone.
      this.addColumn("notes", "access_count", "INTEGER NOT NULL DEFAULT 0");
      this.addColumn("notes", "last_accessed", "TEXT");
    }
    if (v < 4) {
      // v4: similarity edge graph, both directions stored, same-namespace only.
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS note_edges (
          note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
          neighbor_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
          score REAL NOT NULL,
          PRIMARY KEY (note_id, neighbor_id)
        );
        CREATE INDEX IF NOT EXISTS idx_note_edges_note_id ON note_edges(note_id);
      `);
    }
    if (v < 5) {
      // v5: _meta key/value table + an FTS update trigger gated on content
      // columns (access-counter bumps must not re-index FTS).
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS _meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        DROP TRIGGER IF EXISTS notes_au;
        CREATE TRIGGER notes_au AFTER UPDATE ON notes
        WHEN (old.title IS NOT new.title OR old.body IS NOT new.body OR old.tags IS NOT new.tags)
        BEGIN
          INSERT INTO notes_fts(notes_fts, rowid, title, body, tags)
          VALUES('delete', old.id, old.title, old.body, old.tags);
          INSERT INTO notes_fts(rowid, title, body, tags)
          VALUES (new.id, new.title, new.body, new.tags);
        END;
      `);
    }
    if (v < 6) {
      // v6: neighbor-direction + (note_id, score) edge indexes.
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_note_edges_neighbor ON note_edges(neighbor_id);
        CREATE INDEX IF NOT EXISTS idx_note_edges_note_score ON note_edges(note_id, score DESC);
      `);
    }
    if (v < 7) {
      // v7: linter quarantine (held writes, never rows in `notes`) and
      // plain-file sync identity (sync_map) + merge base (sync_base).
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS quarantine (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          op TEXT NOT NULL,
          target_id INTEGER,
          if_rev INTEGER,
          namespace TEXT NOT NULL,
          title TEXT,
          body TEXT,
          tags TEXT,
          source TEXT,
          created_at_override TEXT,
          reasons TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS sync_map (
          origin TEXT NOT NULL,
          origin_id INTEGER NOT NULL,
          local_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
          PRIMARY KEY (origin, origin_id)
        );
        CREATE INDEX IF NOT EXISTS idx_sync_map_local ON sync_map(local_id);
        CREATE TABLE IF NOT EXISTS sync_base (
          local_id INTEGER PRIMARY KEY REFERENCES notes(id) ON DELETE CASCADE,
          hash TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_notes_updated ON notes(updated_at, id);
      `);
    }
    if (v < 8) {
      // v8: change log for the change feed. One row per note create /
      // content update / delete, written by TRIGGERS inside the writing
      // transaction: `seq` is a local, monotonic commit-order sequence and
      // `changed_at` a local stamp taken under the write lock -- never the
      // writer-supplied updated_at (imports and sync keep old updated_at).
      // Triggers also capture writes made by an older binary on the same
      // file. Access-counter bumps are not changes (rev/content unchanged).
      // Pruned to CHANGE_LOG_RETENTION_DAYS periodically (purgeChangeLog).
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS change_log (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          note_id INTEGER NOT NULL,
          kind TEXT NOT NULL,
          namespace TEXT NOT NULL,
          title TEXT NOT NULL DEFAULT '',
          source TEXT NOT NULL DEFAULT '',
          rev INTEGER,
          changed_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_change_log_at ON change_log(changed_at);
        CREATE TRIGGER IF NOT EXISTS notes_log_ai AFTER INSERT ON notes BEGIN
          INSERT INTO change_log (note_id, kind, namespace, title, source, rev, changed_at)
          VALUES (new.id, 'created', new.namespace, new.title, new.source, new.rev, ${SQL_NOW});
        END;
        CREATE TRIGGER IF NOT EXISTS notes_log_au AFTER UPDATE ON notes
        WHEN (old.rev IS NOT new.rev OR old.title IS NOT new.title OR old.body IS NOT new.body
              OR old.tags IS NOT new.tags OR old.namespace IS NOT new.namespace
              OR old.source IS NOT new.source)
        BEGIN
          INSERT INTO change_log (note_id, kind, namespace, title, source, rev, changed_at)
          VALUES (new.id, 'updated', new.namespace, new.title, new.source, new.rev, ${SQL_NOW});
        END;
        CREATE TRIGGER IF NOT EXISTS notes_log_ad AFTER DELETE ON notes BEGIN
          INSERT INTO change_log (note_id, kind, namespace, title, source, rev, changed_at)
          VALUES (old.id, 'deleted', old.namespace, old.title, old.source, NULL, ${SQL_NOW});
        END;
      `);
      // Seed the log from recent history so the first feed read after the
      // upgrade is not empty: notes changed within retention (by their
      // updated_at) and the 1.1.0-rc tombstone table, oldest first.
      const cutoff = new Date(Date.now() - CHANGE_LOG_RETENTION_DAYS * 86_400_000).toISOString();
      const hasTombstones = Boolean(
        this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'note_tombstones'").get()
      );
      this.db
        .prepare(
          `INSERT INTO change_log (note_id, kind, namespace, title, source, rev, changed_at)
           SELECT id, kind, namespace, title, source, rev, at FROM (
             SELECT id, CASE WHEN rev = 1 THEN 'created' ELSE 'updated' END AS kind,
                    namespace, title, source, rev, updated_at AS at
               FROM notes WHERE updated_at >= ?
             ${hasTombstones
               ? `UNION ALL SELECT note_id, 'deleted', namespace, title, source, NULL, deleted_at
                    FROM note_tombstones WHERE deleted_at >= ?`
               : ""}
           ) ORDER BY at, id`
        )
        .run(...(hasTombstones ? [cutoff, cutoff] : [cutoff]));
      this.db.exec("DROP TABLE IF EXISTS note_tombstones");
      // 1.1.0-rc "last" markers used another key/value format.
      this.db.exec("DELETE FROM _meta WHERE key LIKE 'changes_seen:%'");
      // Quarantined updates remember whether the original patch moved the
      // note; approval re-applies the namespace only then.
      this.addColumn("quarantine", "set_namespace", "INTEGER NOT NULL DEFAULT 0");
    }
    if (v < 9) {
      // v9 (a) sync_deleted: deleting a note that came from another machine
      // must not resurrect it on the next import. sync_map/sync_base cascade
      // away with the note, so a BEFORE DELETE trigger keeps its identity +
      // merge base here; import skips the file unless it changed since.
      // (b) change_log privacy: a deleted note's titles are blanked, and a
      // rename keeps only the latest title, so /changes doesn't hold old
      // titles for the whole retention window.
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS sync_deleted (
          origin TEXT NOT NULL,
          origin_id INTEGER NOT NULL,
          hash TEXT,
          PRIMARY KEY (origin, origin_id)
        );
        CREATE TRIGGER IF NOT EXISTS notes_sync_bd BEFORE DELETE ON notes BEGIN
          INSERT OR REPLACE INTO sync_deleted (origin, origin_id, hash)
          SELECT m.origin, m.origin_id, (SELECT b.hash FROM sync_base b WHERE b.local_id = old.id)
            FROM sync_map m WHERE m.local_id = old.id;
        END;
        CREATE INDEX IF NOT EXISTS idx_change_log_note ON change_log(note_id);
        DROP TRIGGER IF EXISTS notes_log_ad;
        CREATE TRIGGER notes_log_ad AFTER DELETE ON notes BEGIN
          UPDATE change_log SET title = '' WHERE note_id = old.id AND title <> '';
          INSERT INTO change_log (note_id, kind, namespace, title, source, rev, changed_at)
          VALUES (old.id, 'deleted', old.namespace, '', old.source, NULL, ${SQL_NOW});
        END;
        DROP TRIGGER IF EXISTS notes_log_au;
        CREATE TRIGGER notes_log_au AFTER UPDATE ON notes
        WHEN (old.rev IS NOT new.rev OR old.title IS NOT new.title OR old.body IS NOT new.body
              OR old.tags IS NOT new.tags OR old.namespace IS NOT new.namespace
              OR old.source IS NOT new.source)
        BEGIN
          INSERT INTO change_log (note_id, kind, namespace, title, source, rev, changed_at)
          VALUES (new.id, 'updated', new.namespace, new.title, new.source, new.rev, ${SQL_NOW});
          UPDATE change_log SET title = ''
           WHERE old.title IS NOT new.title AND note_id = new.id AND title <> ''
             AND seq < (SELECT max(seq) FROM change_log WHERE note_id = new.id);
        END;
      `);
      this.db.exec("UPDATE change_log SET title = '' WHERE kind = 'deleted' OR note_id NOT IN (SELECT id FROM notes)");
    }
    if (v < 10) {
      // v10 (a) at-rest encryption: body_enc holds the AES-256-GCM envelope.
      //     When encryption is enabled the plaintext `body` column is left
      //     EMPTY for encrypted notes so the external-content FTS5 index
      //     never ingests ciphertext (it would match base64 noise). Search
      //     therefore covers title+tags for encrypted notes; that tradeoff is
      //     documented, not hidden. `body` stays the FTS source, unchanged.
      // (b) retention: expires_at (TTL deadline) + archived_at (soft delete).
      this.addColumn("notes", "body_enc", "TEXT");
      this.addColumn("notes", "expires_at", "TEXT");
      this.addColumn("notes", "archived_at", "TEXT");
      // Archived notes drop out of the default list/search paths; this index
      // keeps the archive view cheap without touching the live-note indexes.
      this.db.exec(
        "CREATE INDEX IF NOT EXISTS idx_notes_archived ON notes(archived_at, id)"
      );
    }
    if (v < 11) {
      // v11 (a) archive/restore are changes: add archived_at to the update
      //     trigger's WHEN clause so the change feed (and sync consumers)
      //     see a note being archived or restored. (b) quarantine.sealed:
      //     1 when title/body/tags are stored as encrypted envelopes.
      this.addColumn("quarantine", "sealed", "INTEGER NOT NULL DEFAULT 0");
      this.db.exec(`
        DROP TRIGGER IF EXISTS notes_log_au;
        CREATE TRIGGER notes_log_au AFTER UPDATE ON notes
        WHEN (old.rev IS NOT new.rev OR old.title IS NOT new.title OR old.body IS NOT new.body
              OR old.tags IS NOT new.tags OR old.namespace IS NOT new.namespace
              OR old.source IS NOT new.source OR old.archived_at IS NOT new.archived_at)
        BEGIN
          INSERT INTO change_log (note_id, kind, namespace, title, source, rev, changed_at)
          VALUES (new.id, 'updated', new.namespace, new.title, new.source, new.rev, ${SQL_NOW});
          UPDATE change_log SET title = ''
           WHERE old.title IS NOT new.title AND note_id = new.id AND title <> ''
             AND seq < (SELECT max(seq) FROM change_log WHERE note_id = new.id);
        END;
      `);
    }
    if (v < 12) {
      // v12: change_log.actor = the label of the token / connection that made
      //     the write (NOT the note's free-form `source`), so exclude_self
      //     hides a consumer's own writes and nothing else. Rows written
      //     before this version, by the CLI, by scripts or by any other tool
      //     carry '' and fall back to `source` when filtered. The stamping is
      //     done per connection by a TEMP trigger (see installActorStamp), so
      //     the stored triggers are unchanged and foreign writers still work.
      this.addColumn("change_log", "actor", "TEXT NOT NULL DEFAULT ''");
    }
  }

  /**
   * Stamp the writer's label on every change_log row this connection causes.
   * A TEMP trigger lives only on this connection (nothing persists in the
   * file, so other tools and older code are unaffected) and calls a function
   * registered on this connection only. No actor in scope (CLI, scripts) =
   * the trigger does nothing and the row keeps actor ''.
   */
  private installActorStamp(): void {
    this.db.function("om_actor", { deterministic: false }, () => currentActor());
    this.db.exec(`
      DROP TRIGGER IF EXISTS temp.om_actor_stamp;
      CREATE TEMP TRIGGER om_actor_stamp AFTER INSERT ON main.change_log
      WHEN om_actor() <> ''
      BEGIN
        UPDATE change_log SET actor = om_actor() WHERE seq = new.seq;
      END;
    `);
  }

  /**
   * `opts.updatedAt` is the restore path's (importNotes) way to keep a
   * backup's updated_at; like created_at it is honored only when it parses
   * as a date. It is deliberately not a NoteInput field, so the REST create
   * route can't forge "last changed" times.
   *
   * `opts.startRev` is the restore path's way to keep a backup's rev, so a
   * note edited 25 times before the backup still counts from 25 afterwards
   * (CAS guards and the change feed stay meaningful across a restore).
   * Same reasoning as updatedAt: opts, not NoteInput -- REST POST /notes
   * cannot forge a revision counter. Garbage in a hand-edited backup
   * (0, -3, "x") falls back to 1.
   */
  create(
    input: NoteInput,
    opts: {
      skipEdges?: boolean;
      updatedAt?: string;
      startRev?: number;
      /** Restore path: absolute TTL deadline (ISO-8601) kept from a backup. */
      expiresAt?: string;
      /** Restore path: keep the note archived (ISO-8601 archive time). */
      archivedAt?: string;
    } & LintOpts = {}
  ): NoteRecord {
    if (!input.title || !input.title.trim()) {
      throw new ValidationError("title is required");
    }
    validateSizes(input);
    validateForgetAfter(input.forget_after);
    const findings = lintFor(input, opts.lint ?? "full");
    if (applyLintPolicy(findings, opts) === "quarantine") {
      const qid = this.quarantineWrite({
        op: "create",
        namespace: input.namespace?.trim() || DEFAULT_NAMESPACE,
        title: input.title,
        body: input.body ?? "",
        tags: input.tags,
        source: input.source,
        createdAt: input.created_at,
        findings,
      });
      throw new QuarantinedError(qid, findings);
    }
    const now = new Date().toISOString();
    // Backdate support (consolidation + import/restore): honor an explicit
    // created_at when it parses, otherwise the note was just written.
    const createdAt = isoOrNull(input.created_at) ?? now;
    const updatedAt = isoOrNull(opts.updatedAt) ?? now;
    const startRev =
      Number.isInteger(opts.startRev) && (opts.startRev as number) >= 1
        ? (opts.startRev as number)
        : 1;
    const namespace = input.namespace?.trim() || DEFAULT_NAMESPACE;
    const body = input.body ?? "";
    const tags = tagsToStorage(input.tags);
    const source = (input.source ?? "").slice(0, 200);
    // At-rest encryption: seal the body for storage. `body` (plaintext) stays
    // the value used below for embedding/edge scoring and audit byte counts
    // -- those need the real text. Only the SQL INSERT gets sealed values.
    // Retention: compute the TTL deadline from forget_after days, relative
    // to this write. Null = no TTL (the default, byte-identical to 1.1.0).
    let expiresAt = retentionDeadline(input.forget_after, updatedAt);
    if (opts.expiresAt !== undefined && opts.expiresAt !== null) {
      const e = isoOrNull(opts.expiresAt);
      if (!e) throw new ValidationError("expires_at must be an ISO-8601 timestamp");
      expiresAt = e;
    }
    let archivedAt: string | null = null;
    if (opts.archivedAt !== undefined && opts.archivedAt !== null) {
      archivedAt = isoOrNull(opts.archivedAt);
      if (!archivedAt) throw new ValidationError("archived_at must be an ISO-8601 timestamp");
    }

    // One write transaction for INSERT + edges (BLOCKER: a SAVEPOINT opened
    // outside a transaction is a DEFERRED txn -- its first read takes a
    // snapshot, and the later edge write's lock upgrade fails at once with
    // SQLITE_BUSY under multi-process writes, after the note was saved).
    // BEGIN IMMEDIATE takes the write lock up front (busy_timeout applies);
    // nested inside a caller's transaction (consolidateNotes) a SAVEPOINT
    // keeps the note + edges all-or-nothing without touching the outer txn.
    const nested = this.db.isTransaction;
    this.db.exec(nested ? "SAVEPOINT onememory_create" : "BEGIN IMMEDIATE");
    let id: number;
    try {
      // Key state is read INSIDE the write transaction (see writeKey): the
      // row is inserted with an empty body, then sealed against its own id.
      const encrypting = this.writeKey() !== null;
      const result = this.db
        .prepare(
          `INSERT INTO notes (namespace, title, body, tags, source, created_at, updated_at, rev, body_enc, expires_at, archived_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`
        )
        .run(
          namespace,
          input.title,
          encrypting ? "" : body,
          tags,
          source,
          createdAt,
          updatedAt,
          startRev,
          expiresAt,
          archivedAt
        );
      id = Number(result.lastInsertRowid);
      if (encrypting) {
        const sealed = this.sealBody(body, noteAad(id, namespace));
        this.db.prepare("UPDATE notes SET body = ?, body_enc = ? WHERE id = ?").run(sealed.body, sealed.bodyEnc, id);
      }
      // An archived (restored-as-forgotten) note stays out of the edge graph.
      if (!archivedAt) this.noteWritten(namespace, id, { rev: startRev, title: input.title, body });
      // Link the new note into the similarity graph (same namespace only).
      // skipEdges lets a caller that pre-scored the edges apply them itself.
      if (!opts.skipEdges && !archivedAt) {
        this.recomputeEdgesFor(id, namespace, input.title, body, this.getEdgeThreshold());
      }
      this.db.exec(nested ? "RELEASE onememory_create" : "COMMIT");
    } catch (e) {
      this.edgeIndexes.clear(); // may hold rolled-back state; resync lazily
      try {
        this.db.exec(nested ? "ROLLBACK TO onememory_create" : "ROLLBACK");
        if (nested) this.db.exec("RELEASE onememory_create");
      } catch {
        /* already rolled back -- rethrow the original */
      }
      throw e;
    }
    if (!nested) this.announceChange();
    audit({ op: "create", id, namespace, bytes: body.length });
    return this.read(id)!;
  }

  read(id: number, opts: ReadOpts = {}): (NoteRecord & { neighbors?: NeighborEntry[] }) | null {
    // trackAccess marks a *user-facing* read (HTTP GET /notes/:id, MCP
    // state_read). Internal reads (update()'s re-read, consolidation, export)
    // pass nothing and leave the counters alone, so system churn never
    // inflates importance. Touch first so the returned record already
    // reflects the bumped count.
    if (opts.trackAccess) this.touch(id);
    const row = this.db
      .prepare("SELECT * FROM notes WHERE id = ?")
      .get(id) as NoteRow | undefined;
    if (!row) return null;
    const record = this.rec(row);
    if (!opts.withNeighbors) return record;
    // The `neighbors` key is only present when requested: existing callers
    // (and their deepEqual assertions) see a byte-identical shape otherwise.
    return { ...record, neighbors: this.annotatedNeighbors(id) };
  }

  /**
   * This note's similar neighbors with staleness fields attached (I-LOW-1).
   * The neighbor records are read untracked (internal reads never bump
   * access counters); only the staleness annotation is kept, so the payload
   * stays the small NeighborEntry shape.
   */
  private annotatedNeighbors(id: number): NeighborEntry[] {
    return this.listNeighbors(id, EDGE_NEIGHBOR_LIMIT).map((n) => {
      const full = this.read(n.id);
      const ann = full ? annotateStaleness(full) : null;
      return {
        ...n,
        stale: ann?.stale ?? false,
        ageDays: ann?.ageDays ?? 0,
        ...(ann?.staleWarning ? { staleWarning: ann.staleWarning } : {}),
      };
    });
  }

  /**
   * Run an access-tracking write best-effort (BLOCKER 3): with a zero busy
   * timeout so lock contention fails fast instead of stalling the caller
   * for BUSY_TIMEOUT_MS, and swallowing any error. Access counters are
   * telemetry, not data -- a lost read-count is acceptable, a failed or
   * stalled read is not. Never call this inside a write transaction: it is
   * only for fire-and-forget autocommit counter bumps.
   */
  private bestEffortWrite(fn: () => void): void {
    try {
      this.db.exec("PRAGMA busy_timeout = 0;");
      try {
        fn();
      } finally {
        this.db.exec(`PRAGMA busy_timeout = ${Store.BUSY_TIMEOUT_MS};`);
      }
    } catch {
      /* best-effort: skip silently */
    }
  }

  /**
   * Record one user-facing read of a note: access_count + 1, last_accessed =
   * now. Buffered in memory and flushed in one transaction every
   * ONEMEMORY_ACCESS_FLUSH_MS (see bufferAccess), so reads never write
   * synchronously. A missing id is a silent no-op, never an error.
   * updated_at is deliberately left alone -- a read is not a change.
   */
  touch(id: number): void {
    this.bufferAccess([id]);
  }

  /** Batched touch(): every id counts one read. */
  touchMany(ids: number[]): void {
    this.bufferAccess([...new Set(ids)]);
  }

  /** Reads not yet flushed: id -> count + latest read time. */
  private pendingAccess = new Map<number, { n: number; at: string }>();
  private accessTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Access counters are telemetry, not data. Writing them per read made
   * every search an autocommit write -- an fsync, and (worse) a
   * data_version bump that invalidated every OTHER process's edge-index
   * fast path. Reads now accumulate here and are flushed in one short,
   * best-effort transaction per interval (on close too). Records this
   * Store returns already include pending counts (see rec()).
   */
  private bufferAccess(ids: number[]): void {
    const at = new Date().toISOString();
    for (const id of ids) {
      if (!Number.isInteger(id)) continue;
      const p = this.pendingAccess.get(id);
      if (p) {
        p.n++;
        p.at = at;
      } else if (this.pendingAccess.size < ACCESS_PENDING_MAX) {
        this.pendingAccess.set(id, { n: 1, at });
      }
    }
    if (this.pendingAccess.size === 0) return;
    const ms = accessFlushMs();
    if (ms === 0) this.flushAccess();
    else if (!this.accessTimer) {
      this.accessTimer = setTimeout(() => {
        this.accessTimer = null;
        this.flushAccess();
        if (this.pendingAccess.size) this.bufferAccess([]); // contended: retry next tick
      }, ms);
      this.accessTimer.unref?.();
    }
  }

  /**
   * Write buffered access counts now, in one transaction. Best-effort: on
   * lock contention (zero busy timeout) the counts stay buffered for the
   * next attempt. Never call inside a write transaction.
   */
  flushAccess(): void {
    // Inside a caller's transaction: leave it alone, retry on the next tick.
    if (this.pendingAccess.size === 0 || this.db.isTransaction) return;
    const batch = this.pendingAccess;
    this.pendingAccess = new Map();
    let ok = false;
    this.bestEffortWrite(() => {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const up = this.db.prepare(
          `UPDATE notes SET access_count = access_count + ?,
                  last_accessed = CASE WHEN last_accessed IS NULL OR last_accessed < ? THEN ? ELSE last_accessed END
            WHERE id = ?`
        );
        for (const [id, p] of batch) up.run(p.n, p.at, p.at, id);
        this.db.exec("COMMIT");
        ok = true;
      } catch (e) {
        try {
          this.db.exec("ROLLBACK");
        } catch {
          /* not in a transaction */
        }
        throw e;
      }
    });
    if (!ok) {
      for (const [id, p] of batch) {
        const cur = this.pendingAccess.get(id);
        if (cur) {
          cur.n += p.n;
          if (p.at > cur.at) cur.at = p.at;
        } else if (this.pendingAccess.size < ACCESS_PENDING_MAX) this.pendingAccess.set(id, p);
      }
    }
  }

  /**
   * A row as a record, with not-yet-flushed reads applied.
   *
   * This is the ONE decryption chokepoint: every read (read/list/search/
   * export/neighbors) funnels through here, so callers never see ciphertext
   * and never need to know encryption is on.
   */
  private rec(row: NoteRow): NoteRecord {
    const r = rowToRecord(row);
    if (row.body_enc) {
      // DecryptIfEncrypted throws on auth failure (wrong/tampered key) --
      // deliberately not swallowed: handing an agent corrupted memory is
      // worse than erroring, and it is the tell that the key file was swapped.
      try {
        r.body = decryptIfEncrypted(row.body_enc, this.readKey(), noteAad(row.id, row.namespace));
      } catch (e) {
        throw new NoteUnreadableError(row.id, (e as Error).message);
      }
    }
    const p = this.pendingAccess.get(r.id);
    if (p) {
      r.access_count += p.n;
      if (!r.last_accessed || p.at > r.last_accessed) r.last_accessed = p.at;
    }
    return annotateRetention(row, r);
  }

  /**
   * Pre-1.2.1 ciphertext (v1:) has no row binding, so it can be replayed
   * across notes/namespaces. When a key is present, rewrite v1 envelopes as
   * v2 (row-bound) once, in one transaction (rows are re-read under the lock
   * so a concurrent opener finds nothing to do). Failure never blocks open.
   */
  private upgradeV1Envelopes(): void {
    const key = this.lastKey;
    if (!key) return;
    try {
      const probe = this.db.prepare("SELECT 1 FROM notes WHERE body_enc LIKE 'v1:%' LIMIT 1").get();
      if (!probe) return;
      this.transaction(() => {
        const rows = this.db
          .prepare("SELECT id, namespace, body_enc FROM notes WHERE body_enc LIKE 'v1:%'")
          .all() as unknown as Array<{ id: number; namespace: string; body_enc: string }>;
        const upd = this.db.prepare("UPDATE notes SET body_enc = ? WHERE id = ?");
        for (const r of rows) {
          upd.run(encrypt(decryptIfEncrypted(r.body_enc, key), key, noteAad(r.id, r.namespace)), r.id);
        }
      });
    } catch (e) {
      process.stderr.write(`onememory: could not upgrade v1 ciphertext to v2 (${(e as Error).message}); run \`onememory encrypt enable\` to retry.\n`);
    }
  }

  /** `.key.disabling-<pid>` files beside the key: [path, pid] (crash leftovers of `encrypt disable`). */
  private asideKeys(): Array<{ path: string; pid: number }> {
    const kp = keyPath(this.keyDir);
    const prefix = `${basename(kp)}.disabling-`;
    const out: Array<{ path: string; pid: number }> = [];
    try {
      for (const f of readdirSync(dirname(kp))) {
        if (!f.startsWith(prefix)) continue;
        const pid = Number(f.slice(prefix.length));
        if (Number.isInteger(pid) && pid > 0) out.push({ path: join(dirname(kp), f), pid });
      }
    } catch {
      /* directory unreadable: nothing to recover */
    }
    return out;
  }

  private hasEncryptedRows(): boolean {
    try {
      return !!this.db.prepare("SELECT 1 FROM notes WHERE body_enc IS NOT NULL LIMIT 1").get();
    } catch {
      return false; // fresh DB / pre-v10 schema: no such column or table yet
    }
  }

  /**
   * `encrypt disable` moves .key aside BEFORE its COMMIT. A crash in between
   * leaves an encrypted DB with no key. When the key is missing, encrypted
   * rows exist and a leftover from a DEAD process is beside it, put it back.
   * Returns "live" when a still-running disable owns an aside file (leave it).
   */
  private recoverStrandedKey(): "none" | "restored" | "live" {
    if (!this.hasEncryptedRows()) return "none";
    const asides = this.asideKeys();
    if (asides.length === 0) return "none";
    let live = false;
    for (const a of asides) {
      let alive = false;
      try {
        process.kill(a.pid, 0);
        alive = true;
      } catch (e) {
        alive = (e as NodeJS.ErrnoException).code === "EPERM";
      }
      if (alive && a.pid !== process.pid) {
        live = true;
        continue;
      }
      try {
        renameSync(a.path, keyPath(this.keyDir));
        this.lastKey = loadKey(this.keyDir);
        process.stderr.write(`onememory: restored the encryption key from ${a.path} (an interrupted \`encrypt disable\`).\n`);
        return "restored";
      } catch {
        /* try the next one */
      }
    }
    return live ? "live" : "none";
  }

  /** Cheap fingerprint of the key file (size+mtime+inode), "" when absent. */
  private stampOf(): string {
    try {
      const st = statSync(keyPath(this.keyDir));
      return `${st.size}:${st.mtimeMs}:${st.ino}`;
    } catch {
      return "";
    }
  }

  /**
   * The key that must be used for a WRITE right now. Checked on every write
   * (one stat) and, by callers, INSIDE the write transaction: `encrypt
   * enable` / `disable` run from another process while this one holds the DB
   * open, and a key loaded once at startup would keep sealing bodies with a
   * deleted key (unrecoverable) or keep writing plaintext after enable.
   * Null = encryption is off (no key file).
   */
  private writeKey(): Buffer | null {
    const stamp = this.stampOf();
    if (stamp === "") {
      // No key. Fine for a plaintext store; but if encrypted rows exist the key
      // went missing (crashed `encrypt disable`, deleted file): refuse to write
      // plaintext rows next to ciphertext.
      if (this.keyChecked === "") {
        if (!this.hasEncryptedRows()) {
          this.keyChecked = "x";
        } else {
          const r = this.recoverStrandedKey();
          if (r === "restored") {
            this.keyStamp = this.stampOf();
            return this.lastKey;
          }
          if (r !== "live") {
            const aside = this.asideKeys().map((a) => a.path).join(", ");
            throw new Error(
              `onememory: this database holds encrypted notes but the key file ${keyPath(this.keyDir)} is missing; ` +
                `refusing to write plaintext next to ciphertext.` +
                (aside ? ` A key copy exists at ${aside} -- rename it back to ${keyPath(this.keyDir)}.` : ` Restore the key from a backup.`)
            );
          }
        }
      }
      return null;
    }
    this.keyChecked = "";
    if (stamp !== this.keyStamp || !this.lastKey) {
      this.lastKey = loadKey(this.keyDir);
      this.keyStamp = this.stampOf();
    }
    return this.lastKey;
  }

  /**
   * Key for DECRYPTING. Prefers the last key seen so a reader racing a
   * concurrent `encrypt disable` (key file already gone, its snapshot still
   * encrypted) keeps working; falls back to a fresh load when this process
   * started before `encrypt enable`.
   */
  private readKey(): Buffer | null {
    return this.lastKey ?? this.writeKey();
  }

  /**
   * Split a caller-supplied body into the (plaintext) `body` column value and
   * the optional `body_enc` ciphertext, per the current encryption state.
   *
   * When encryption is ON: body goes EMPTY into the FTS-indexed column (so no
   * ciphertext is ever indexed) and the ciphertext lands in body_enc, bound to
   * `aad` (id|namespace) so it cannot be replayed onto another row. When
   * OFF: body is stored normally and body_enc is NULL, byte-identical to 1.1.0.
   */
  private sealBody(plain: string, aad?: string): { body: string; bodyEnc: string | null } {
    const key = this.writeKey();
    if (!key) return { body: plain, bodyEnc: null };
    return { body: "", bodyEnc: encrypt(plain, key, aad) };
  }

  /**
   * Access-tracking aggregates for the memory_stats surface. When
   * `namespaces` is given, only those namespaces are counted (namespace
   * resolution passes the readable set; an MCP hint passes one). Omit it to
   * count the whole store (legacy no-resolution mode).
   */
  accessStats(namespaces?: string[]): AccessStats {
    this.flushAccess(); // aggregates read the table
    // Archived notes are forgotten: they must not show up in totals or tops.
    const where =
      namespaces && namespaces.length > 0
        ? `WHERE archived_at IS NULL AND namespace IN (${namespaces.map(() => "?").join(",")})`
        : "WHERE archived_at IS NULL";
    const params: string[] = namespaces && namespaces.length > 0 ? [...namespaces] : [];
    const totals = this.db
      .prepare(
        `SELECT COUNT(*) AS n,
                COALESCE(SUM(access_count), 0) AS accesses,
                COALESCE(SUM(CASE WHEN last_accessed IS NULL THEN 1 ELSE 0 END), 0) AS never
         FROM notes ${where}`
      )
      .get(...params) as { n: number; accesses: number; never: number };
    const top = this.db
      .prepare(
        `SELECT id, title, access_count FROM notes ${where}
         ORDER BY access_count DESC, id ASC LIMIT 10`
      )
      .all(...params) as Array<{ id: number; title: string; access_count: number }>;
    return {
      totalNotes: Number(totals.n),
      totalAccesses: Number(totals.accesses),
      mostAccessed: top.map((r) => ({
        id: Number(r.id),
        title: r.title,
        access_count: Number(r.access_count),
      })),
      neverAccessed: Number(totals.never),
      staleCount: this.staleCount(namespaces),
    };
  }

  /**
   * How many notes are stale under the current staleness config (see
   * staleness.ts). Staleness needs only tags + updated_at, so this scans a
   * narrow projection rather than full records; bodies never leave the DB.
   */
  staleCount(namespaces?: string[]): number {
    const where =
      namespaces && namespaces.length > 0
        ? `WHERE archived_at IS NULL AND namespace IN (${namespaces.map(() => "?").join(",")})`
        : "WHERE archived_at IS NULL";
    const params: string[] = namespaces && namespaces.length > 0 ? [...namespaces] : [];
    const rows = this.db
      .prepare(`SELECT tags, updated_at FROM notes ${where}`)
      .all(...params) as Array<{ tags: string; updated_at: string }>;
    const cfg = stalenessConfig();
    let n = 0;
    for (const r of rows) {
      // isStale only reads tags and updated_at; the rest is filler.
      const probe: NoteRecord = {
        id: 0,
        namespace: "",
        title: "",
        body: "",
        tags: parseTags(r.tags),
        rev: 1,
        source: "",
        created_at: r.updated_at,
        updated_at: r.updated_at,
        access_count: 0,
        last_accessed: null,
      };
      if (isStale(probe, cfg).stale) n++;
    }
    return n;
  }

  update(
    id: number,
    patch: NotePatch,
    opts: { ifRev?: number } & LintOpts = {}
  ): NoteRecord | null {
    validateForgetAfter(patch.forget_after);
    const existing = this.read(id);
    if (!existing) return null;

    if (patch.title !== undefined && !patch.title.trim()) {
      throw new ValidationError("title cannot be empty");
    }
    // Lint only what this write changes: an already-stored (or approved)
    // note must not be re-quarantined because someone edited its tags.
    const changed: { title?: string; body?: string; tags?: string[]; source?: string } = {};
    if (patch.title !== undefined && patch.title !== existing.title) changed.title = patch.title;
    if (patch.body !== undefined && patch.body !== existing.body) changed.body = patch.body;
    if (patch.tags !== undefined) {
      const fresh = patch.tags.filter((t) => !existing.tags.includes(t.trim()));
      if (fresh.length) changed.tags = fresh;
    }
    if (patch.source !== undefined && patch.source !== existing.source) changed.source = patch.source;
    const findings = lintFor(changed, opts.lint ?? "full");
    if (applyLintPolicy(findings, opts) === "quarantine") {
      const nsTrimQ = patch.namespace?.trim();
      const qid = this.quarantineWrite({
        op: "update",
        targetId: id,
        // Always pin the rev the write was judged against: approving it
        // later must not silently overwrite an edit made in between.
        ifRev: opts.ifRev ?? existing.rev,
        namespace: nsTrimQ ? nsTrimQ : existing.namespace,
        setNamespace: Boolean(nsTrimQ),
        title: patch.title,
        body: patch.body,
        tags: patch.tags,
        source: patch.source,
        findings,
      });
      throw new QuarantinedError(qid, findings);
    }

    const nsTrim = patch.namespace?.trim();
    const namespace = nsTrim ? nsTrim : existing.namespace;
    const title = patch.title ?? existing.title;
    const body = patch.body ?? existing.body;
    const tags = patch.tags !== undefined ? tagsToStorage(patch.tags) : tagsToStorage(existing.tags);
    const source = patch.source !== undefined ? patch.source.slice(0, 200) : existing.source;
    const rev = existing.rev + 1;
    validateSizes({ title, body, tags: patch.tags ?? existing.tags });
    const now = new Date().toISOString();
    // Re-seal: existing.body is already decrypted plaintext, so an update
    // that leaves the body alone still produces fresh ciphertext (new IV).
    // Retention: an explicit forget_after resets the deadline relative to
    // THIS write; forget_after: 0 clears the TTL; omitting it preserves the
    // note's existing deadline instead of silently dropping it.
    const expiresAt =
      patch.forget_after !== undefined
        ? retentionDeadline(patch.forget_after, now)
        : existing.expires_at ?? null;

    const touched = [...new Set([existing.namespace, namespace])];
    // Compare-and-swap as a single atomic statement. The `ifRev` guard lives in
    // the WHERE clause (not a separate read-then-check) so two writers on
    // different connections/processes -- the exact cross-surface case this
    // feature exists for (phone + desktop sharing one state.db) -- can't both
    // pass the check and then clobber each other. `ifRev = null` means "force".
    // The vector-invalidation runs in the same transaction so a note's text and
    // its (now dropped) stale embedding never diverge.
    const want = opts.ifRev ?? null;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      // Sealed under the write lock so the key state cannot change between
      // the check and the write (see writeKey), bound to this id+namespace.
      const sealed = this.sealBody(body, noteAad(id, namespace));
      const res = this.db
        .prepare(
          `UPDATE notes SET namespace = ?, title = ?, body = ?, tags = ?, source = ?, rev = ?, updated_at = ?,
                            body_enc = ?, expires_at = ?
           WHERE id = ? AND (? IS NULL OR rev = ?)`
        )
        .run(namespace, title, sealed.body, tags, source, rev, now, sealed.bodyEnc, expiresAt, id, want, want);

      if (Number(res.changes) === 0) {
        // The row either vanished or its rev moved since we read it.
        this.db.exec("ROLLBACK");
        const current = this.read(id);
        if (!current) return null; // deleted concurrently -> not found
        throw new ValidationError(
          `stale write: note ${id} is at rev ${current.rev} (you have ${opts.ifRev}); re-read and retry`
        );
      }

      // Invalidate the embedding: the note's text just changed, so the stored
      // vector is now stale. Drop it rather than keep a vector that no longer
      // matches the content -- the note falls back to keyword search, and the
      // write path (maybeEmbed) or `reindex` recomputes it. Without this, a
      // failed re-embed would leave a permanently wrong vector that semantic
      // search would happily return.
      touched.forEach((ns) => this.noteWritten(ns, id, ns === namespace ? { rev, title, body } : null));
      this.db.prepare("DELETE FROM note_vectors WHERE note_id = ?").run(id);
      // Rebuild this note's similarity edges against its (possibly new)
      // namespace: the text changed, so old edges may be wrong, and a
      // namespace change strands edges against the old namespace's notes.
      // Same transaction, so text and graph never diverge. Scored under the
      // write lock against the namespace's cached index: a few ms, and
      // readers never wait on it (WAL readers don't block; access counters
      // are buffered, see bufferAccess).
      this.applyEdgePairs(
        id,
        this.planEdges(namespace, title, body, this.getEdgeThreshold(), new Set([id])).pairs
      );
      this.db.exec("COMMIT");
    } catch (e) {
      this.edgeIndexes.clear(); // may hold rolled-back state; resync lazily
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* already rolled back or no active transaction */
      }
      throw e;
    }

    this.announceChange();
    audit({ op: "update", id, namespace, bytes: body.length });
    return this.read(id);
  }

  delete(id: number): boolean {
    return this.deleteWhere(id, null);
  }

  /**
   * Soft-archive every note whose TTL has passed (retention).
   *
   * Sets archived_at (only when not already archived) so the note drops out
   * of list/search/recall but stays on disk, restorable. Returns the number
   * archived. Runs in one UPDATE -- the note count here is small and a sweep
   * must not race itself into double-archiving.
   */
  sweepExpired(now: number = Date.now(), namespaces?: string[]): number {
    const iso = new Date(now).toISOString();
    // A namespace-pinned caller may only retire its own notes.
    if (namespaces && namespaces.length === 0) return 0;
    const nsSql = namespaces ? ` AND namespace IN (${namespaces.map(() => "?").join(",")})` : "";
    const res = this.db
      .prepare(
        `UPDATE notes SET archived_at = ?
         WHERE expires_at IS NOT NULL AND expires_at <= ? AND archived_at IS NULL${nsSql}`
      )
      .run(iso, iso, ...(namespaces ?? []));
    const n = Number(res.changes ?? 0);
    if (n > 0) {
      this.edgeIndexes.clear(); // archived notes leave the similarity index
      this.announceChange();
    }
    return n;
  }

  /** Soft-archive one note (retention action from an API/client). */
  archive(id: number): NoteRecord | null {
    const iso = new Date().toISOString();
    this.db
      .prepare("UPDATE notes SET archived_at = ? WHERE id = ? AND archived_at IS NULL")
      .run(iso, id);
    this.edgeIndexes.clear();
    this.announceChange();
    return this.read(id);
  }

  /**
   * Restore an archived note to live. Clears archived_at AND the old TTL
   * (otherwise an expired note would be re-archived by the very next sweep);
   * pass `forget_after` (days) to give it a fresh deadline instead.
   */
  restore(id: number, opts: { forget_after?: number } = {}): NoteRecord | null {
    validateForgetAfter(opts.forget_after);
    this.db
      .prepare("UPDATE notes SET archived_at = NULL, expires_at = ? WHERE id = ? AND archived_at IS NOT NULL")
      .run(opts.forget_after === undefined ? null : retentionDeadline(opts.forget_after), id);
    this.edgeIndexes.clear(); // restored note rejoins the similarity index lazily
    this.announceChange();
    return this.read(id);
  }

  /**
   * Encrypt every plaintext body in place (`onememory encrypt enable`).
   *
   * Moves body -> encrypted body_enc and empties body, so the FTS index
   * (which reads the body column via triggers) is rebuilt over title+tags
   * only. Idempotent: already-encrypted notes are skipped, so re-running is
   * safe. Legacy v1 envelopes (no row binding) are upgraded to v2 in the same
   * pass. Rows are read INSIDE the write transaction (in id-ordered pages, so
   * memory stays bounded on big stores): reading first and locking later
   * would encrypt a stale body and silently overwrite a concurrent edit.
   * Returns the number of notes newly encrypted.
   *
   * Afterwards the plaintext words are scrubbed from the FTS segments and
   * free pages (see scrubPlaintext).
   */
  encryptAll(key: Buffer): number {
    // Overwrite freed pages so dropped plaintext is not left in the file.
    this.db.exec("PRAGMA secure_delete = ON");
    const sel = this.db.prepare(
      "SELECT id, namespace, body, body_enc FROM notes WHERE id > ? ORDER BY id LIMIT 500"
    );
    const updPlain = this.db.prepare("UPDATE notes SET body_enc = ?, body = '' WHERE id = ?");
    const updEnc = this.db.prepare("UPDATE notes SET body_enc = ? WHERE id = ?");
    let count = 0;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      let after = 0;
      for (;;) {
        const rows = sel.all(after) as unknown as Array<{
          id: number;
          namespace: string;
          body: string;
          body_enc: string | null;
        }>;
        if (rows.length === 0) break;
        for (const r of rows) {
          const aad = noteAad(r.id, r.namespace);
          if (r.body_enc === null) {
            if (r.body === "") continue;
            updPlain.run(encrypt(r.body, key, aad), r.id);
            count++;
          } else if (r.body_enc.startsWith("v1:")) {
            updEnc.run(encrypt(decryptIfEncrypted(r.body_enc, key), key, aad), r.id);
          }
        }
        after = rows[rows.length - 1].id;
      }
      this.sealQuarantine(key);
      this.db.exec("COMMIT");
    } catch (e) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* already rolled back */
      }
      throw e;
    }
    this.scrubPlaintext();
    return count;
  }

  /** Seal every still-plaintext quarantine row (caller holds the write lock). */
  private sealQuarantine(key: Buffer): void {
    const rows = this.db.prepare("SELECT id, namespace, title, body, tags FROM quarantine WHERE sealed = 0").all() as Array<{
      id: number;
      namespace: string;
      title: string | null;
      body: string | null;
      tags: string | null;
    }>;
    const upd = this.db.prepare("UPDATE quarantine SET title = ?, body = ?, tags = ?, sealed = 1 WHERE id = ?");
    for (const r of rows) {
      const seal = (col: string, v: string | null): string | null =>
        v === null ? null : encrypt(v, key, quarantineAad(col, r.namespace));
      upd.run(seal("title", r.title), seal("body", r.body), seal("tags", r.tags), r.id);
    }
  }

  /** Inverse of sealQuarantine (caller holds the write lock). */
  private unsealQuarantine(key: Buffer): void {
    const rows = this.db.prepare("SELECT id, namespace, title, body, tags FROM quarantine WHERE sealed = 1").all() as Array<{
      id: number;
      namespace: string;
      title: string | null;
      body: string | null;
      tags: string | null;
    }>;
    const upd = this.db.prepare("UPDATE quarantine SET title = ?, body = ?, tags = ?, sealed = 0 WHERE id = ?");
    for (const r of rows) {
      const open = (col: string, v: string | null): string | null =>
        v === null ? null : decryptIfEncrypted(v, key, quarantineAad(col, r.namespace));
      upd.run(open("title", r.title), open("body", r.body), open("tags", r.tags), r.id);
    }
  }

  /**
   * Remove leftover plaintext after `encrypt enable`: the FTS index still
   * holds the old body words in its segments (an external-content 'delete'
   * only writes tombstones), and freed pages / the WAL hold old row images.
   * Rebuilds the FTS index from the (now body-less) rows, truncates the WAL
   * and, unless the database is large, VACUUMs. Best effort: a busy
   * database skips a step instead of failing the enable. Returns whether the
   * file was vacuumed.
   */
  scrubPlaintext(opts: { maxVacuumBytes?: number } = {}): { vacuumed: boolean } {
    const limit = opts.maxVacuumBytes ?? 512 * 1024 * 1024;
    this.db.exec("PRAGMA secure_delete = ON");
    try {
      this.db.exec("INSERT INTO notes_fts(notes_fts) VALUES('rebuild')");
      this.db.exec("INSERT INTO notes_fts(notes_fts) VALUES('optimize')");
    } catch {
      /* FTS maintenance is best effort */
    }
    let vacuumed = false;
    try {
      const big = this.dbPath !== ":memory:" && statSync(this.dbPath).size > limit;
      if (this.dbPath !== ":memory:" && !big) {
        this.db.exec("VACUUM");
        vacuumed = true;
      }
    } catch {
      /* VACUUM needs the lock and free disk; skip when busy */
    }
    try {
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {
      /* best effort */
    }
    return { vacuumed };
  }

  /**
   * Decrypt every encrypted body back to plaintext (`onememory encrypt disable`).
   *
   * The inverse of encryptAll: body_enc -> body, body_enc NULL. Rows are read
   * inside the write transaction (see encryptAll). Throws if a body cannot be
   * decrypted (wrong key) -- it must not leave a half-decrypted store: the
   * whole transaction rolls back. `beforeCommit` runs under the write lock
   * just before COMMIT; the CLI uses it to move the key file aside so no
   * concurrent server can seal a new body with a key that is about to vanish.
   * Returns the number of notes decrypted.
   */
  decryptAll(key: Buffer, hooks: { beforeCommit?: () => void } = {}): number {
    const sel = this.db.prepare(
      "SELECT id, namespace, body_enc FROM notes WHERE body_enc IS NOT NULL AND id > ? ORDER BY id LIMIT 500"
    );
    const upd = this.db.prepare("UPDATE notes SET body = ?, body_enc = NULL WHERE id = ?");
    let count = 0;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      let after = 0;
      for (;;) {
        const rows = sel.all(after) as unknown as Array<{ id: number; namespace: string; body_enc: string }>;
        if (rows.length === 0) break;
        for (const r of rows) {
          upd.run(decryptIfEncrypted(r.body_enc, key, noteAad(r.id, r.namespace)), r.id);
          count++;
        }
        after = rows[rows.length - 1].id;
      }
      this.unsealQuarantine(key);
      hooks.beforeCommit?.();
      this.db.exec("COMMIT");
    } catch (e) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* already rolled back */
      }
      throw e;
    }
    return count;
  }

  /** Count of notes whose body is stored encrypted at rest. */
  encryptedCount(): number {
    const r = this.db.prepare("SELECT COUNT(*) AS c FROM notes WHERE body_enc IS NOT NULL").get() as {
      c: number;
    };
    return Number(r.c);
  }

  /** DELETE one note (optionally rev-guarded), keeping the edge index in step. */
  private deleteWhere(id: number, rev: number | null): boolean {
    const row = this.db
      .prepare("SELECT namespace FROM notes WHERE id = ?")
      .get(id) as { namespace: string } | undefined;
    if (!row) return false;
    const result = this.db
      .prepare("DELETE FROM notes WHERE id = ? AND (? IS NULL OR rev = ?)")
      .run(id, rev, rev);
    const ok = Number(result.changes) > 0;
    if (ok) {
      this.noteWritten(row.namespace, id, null);
      if (!this.db.isTransaction) this.announceChange();
      audit({ op: "delete", id });
    }
    return ok;
  }

  /**
   * Guarded delete: only deletes when the note's rev still matches what the
   * caller last read (the delete-side twin of update()'s compare-and-swap).
   * Returns true if a row was deleted. Use it inside a transaction, after a
   * fresh re-read, so a concurrent writer racing the delete can't be
   * silently destroyed.
   */
  deleteIfRev(id: number, rev: number): boolean {
    return this.deleteWhere(id, rev);
  }

  /**
   * Run fn inside a single SQLite transaction (BEGIN IMMEDIATE / COMMIT;
   * ROLLBACK on any throw, then the error rethrows). This is the
   * multi-statement atomicity primitive: use it whenever a group of writes
   * must land together or not at all (e.g. consolidation's create + N
   * deletes), instead of relying on SQLite's per-statement implicit
   * transactions -- a crash between statements would leave a half-applied
   * operation with no record of the in-flight work.
   *
   * Note: Store.update() predates this helper and manages its own
   * BEGIN/COMMIT inline because it needs to distinguish a stale rev from a
   * vanished row after a failed compare-and-swap; the outcome is identical.
   */
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      this.announceChange();
      return out;
    } catch (e) {
      // The edge index may have synced uncommitted rows (a rolled-back
      // insert can even hand its id to the next note): drop it, resync lazily.
      this.edgeIndexes.clear();
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* already rolled back or no active transaction -- rethrow the original */
      }
      throw e;
    }
  }

  /**
   * True when another connection currently holds the SQLite write lock
   * (e.g. a running server mid-write). Probes with a throwaway connection
   * and a zero busy-timeout, so the probe itself never blocks: a held lock
   * means an in-flight write transaction, not just an open database. The
   * CLI rebuild-edges refuses in that case (unless --force) rather than
   * contending with the server. Best-effort: any probe failure reports
   * false, never throws.
   */
  writeLockHeld(): boolean {
    if (this.dbPath === ":memory:") return false;
    let probe: DatabaseSync | undefined;
    try {
      probe = new DatabaseSync(this.dbPath);
      probe.exec("PRAGMA busy_timeout = 0;");
      try {
        probe.exec("BEGIN IMMEDIATE;");
      } catch (e) {
        // node:sqlite surfaces a contended lock as message "database is
        // locked" (code ERR_SQLITE_ERROR); match that and SQLITE_BUSY.
        return (
          e instanceof Error &&
          /database is locked|SQLITE_BUSY/i.test(e.message)
        );
      }
      try {
        probe.exec("ROLLBACK;");
      } catch {
        /* no transaction was started */
      }
      return false;
    } catch {
      return false;
    } finally {
      try {
        probe?.close();
      } catch {
        /* ignore close errors on a broken probe */
      }
    }
  }

  /**
   * Newest-first page of notes. `namespace` restricts to one namespace;
   * `namespaces` (used by server-side namespace resolution to list every
   * readable namespace) restricts to a set, paged in SQL so `total` and
   * deep offsets are exact. An empty `namespaces` set matches nothing.
   */
  list(
    opts: {
      namespace?: string;
      namespaces?: string[];
      limit?: number;
      offset?: number;
      /** Include soft-archived notes (default false: only live notes). */
      includeArchived?: boolean;
      /** Only archived notes -- backs the archive view / restore flow. */
      archivedOnly?: boolean;
      /** Only notes carrying ALL of these exact tags. */
      withTags?: string[];
      /** Only notes carrying NONE of these exact tags. */
      withoutTags?: string[];
      /** Only notes with at least one tag starting with this prefix. */
      withTagPrefix?: string;
    } & RangeOpts = {}
  ): {
    notes: NoteRecord[];
    total: number;
  } {
    const limit = clampInt(opts.limit, 50, 1, 500);
    const offset = clampInt(opts.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    const range = rangeClause(opts);
    const tagF = tagClause(opts.withTags, opts.withoutTags, opts.withTagPrefix);
    // Archived filter: default hides archived; archivedOnly inverts it.
    const archSql = archivedClause(opts.includeArchived, opts.archivedOnly);
    const extra = [...range.params, ...tagF.params];
    // SQL LIKE is only a prefilter (tags are a JSON array string); the exact
    // match is re-checked below so a tag never matches inside another value.
    const exact = (r: NoteRow): boolean => tagsMatch(r.tags, opts.withTags, opts.withoutTags, opts.withTagPrefix);

    let rows: NoteRow[];
    let total: number;

    if (opts.namespaces) {
      if (opts.namespaces.length === 0) return { notes: [], total: 0 };
      const inList = `namespace IN (${opts.namespaces.map(() => "?").join(",")})`;
      rows = this.db
        .prepare(
          `SELECT * FROM notes WHERE ${inList}${archSql}${range.sql}${tagF.sql} ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?`
        )
        .all(...opts.namespaces, ...extra, limit, offset) as unknown as NoteRow[];
      total = (
        this.db
          .prepare(`SELECT COUNT(*) as c FROM notes WHERE ${inList}${archSql}${range.sql}${tagF.sql}`)
          .get(...opts.namespaces, ...extra) as { c: number }
      ).c;
    } else if (opts.namespace) {
      rows = this.db
        .prepare(
          `SELECT * FROM notes WHERE namespace = ?${archSql}${range.sql}${tagF.sql} ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?`
        )
        .all(opts.namespace, ...extra, limit, offset) as unknown as NoteRow[];
      total = (
        this.db
          .prepare(`SELECT COUNT(*) as c FROM notes WHERE namespace = ?${archSql}${range.sql}${tagF.sql}`)
          .get(opts.namespace, ...extra) as { c: number }
      ).c;
    } else {
      rows = this.db
        .prepare(
          `SELECT * FROM notes WHERE 1 = 1${archSql}${range.sql}${tagF.sql} ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?`
        )
        .all(...extra, limit, offset) as unknown as NoteRow[];
      total = (
        this.db.prepare(`SELECT COUNT(*) as c FROM notes WHERE 1 = 1${archSql}${range.sql}${tagF.sql}`).get(...extra) as { c: number }
      ).c;
    }

    return { notes: rows.filter(exact).map((r) => this.rec(r)), total };
  }

  search(
    query: string,
    opts: { namespace?: string; limit?: number } & RangeOpts = {}
  ): NoteRecord[] {
    return this.searchRanked(query, opts).map((h) => h.note);
  }

  /**
   * Like search(), but returns each hit's FTS5 bm25 rank as a positive score
   * (higher = better match) alongside the note. The search-service uses these
   * scores as the base for ranking adjustments (e.g. the stale-note
   * penalty and access-count importance weighting); identical documents
   * score identically.
   */
  searchRanked(
    query: string,
    opts: { namespace?: string; limit?: number } & RangeOpts = {}
  ): RankedHit[] {
    if (!query || !query.trim()) return [];
    const limit = clampInt(opts.limit, 20, 1, 200);
    const matchQuery = buildMatchQuery(query);
    if (!matchQuery) return []; // query was all punctuation/stopwords
    const range = rangeClause(opts);

    try {
      let rows: Array<NoteRow & { score: number }>;
      if (opts.namespace) {
        rows = this.db
          .prepare(
            `SELECT notes.*, -rank AS score FROM notes_fts
             JOIN notes ON notes.id = notes_fts.rowid
             WHERE notes_fts MATCH ? AND notes.namespace = ? AND notes.archived_at IS NULL${range.sql}
             ORDER BY rank
             LIMIT ?`
          )
          .all(matchQuery, opts.namespace, ...range.params, limit) as unknown as Array<
          NoteRow & { score: number }
        >;
      } else {
        rows = this.db
          .prepare(
            `SELECT notes.*, -rank AS score FROM notes_fts
             JOIN notes ON notes.id = notes_fts.rowid
             WHERE notes_fts MATCH ? AND notes.archived_at IS NULL${range.sql}
             ORDER BY rank
             LIMIT ?`
          )
          .all(matchQuery, ...range.params, limit) as unknown as Array<
          NoteRow & { score: number }
        >;
      }
      // FTS5's rank is negative (lower = better), so -rank is a positive
      // higher-is-better score.
      return rows.map((row) => ({ note: this.rec(row), score: row.score ?? 0 }));
    } catch {
      // A malformed FTS expression should never 500 the caller.
      return [];
    }
  }

  /** Every note, oldest first — for backup / export / migration. */
  exportAll(opts: { live?: boolean } = {}): NoteRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM notes${opts.live ? " WHERE archived_at IS NULL" : ""} ORDER BY id ASC`)
      .all() as unknown as NoteRow[];
    return rows.map((r) => this.rec(r));
  }

  /**
   * One page of the export, for STREAMING a large backup.
   *
   * exportAll() materializes every row, then every record, then (in the
   * caller) the whole JSON string — roughly 3x the backup's size in memory
   * at once. That is fine for hundreds of notes and unpleasant for tens of
   * thousands. This is the bounded-memory alternative: keyset pagination on
   * the primary key (`id > afterId`), which is O(page) per call on the PK
   * index rather than the O(offset) scan OFFSET would do at depth.
   *
   * A short page (< limit) means the export is done. `afterId` is the last
   * id returned; callers must pass it back verbatim.
   */
  exportBatch(
    afterId: number,
    limit: number,
    opts: {
      /** Only these namespaces, filtered in SQL so other rows are never decrypted. */
      namespaces?: string[];
      /** A row that cannot be decrypted is emitted body-less with `unreadable: true` instead of throwing. */
      skipUnreadable?: boolean;
    } = {}
  ): NoteRecord[] {
    const lim = clampInt(limit, 500, 1, 5_000);
    const ns = opts.namespaces;
    if (ns && ns.length === 0) return [];
    const nsSql = ns ? ` AND namespace IN (${ns.map(() => "?").join(",")})` : "";
    const rows = this.db
      .prepare(`SELECT * FROM notes WHERE id > ?${nsSql} ORDER BY id ASC LIMIT ?`)
      .all(afterId, ...(ns ?? []), lim) as unknown as NoteRow[];
    return rows.map((r) => {
      if (!opts.skipUnreadable) return this.rec(r);
      try {
        return this.rec(r);
      } catch (e) {
        if (!(e instanceof NoteUnreadableError)) throw e;
        const marker = { ...annotateRetention(r, rowToRecord(r)), unreadable: true as const } as Partial<NoteRecord>;
        delete marker.body; // never emit a body for an unreadable row
        return marker as NoteRecord;
      }
    });
  }

  /** Total notes in the store (drives the export progress/size estimate). */
  countAll(): number {
    const r = this.db.prepare("SELECT COUNT(*) AS c FROM notes").get() as { c: number };
    return Number(r.c);
  }

  /**
   * Insert notes from a backup/export. Each is validated like a normal write.
   * Returns the created records so the caller can (best-effort) embed them --
   * without this, re-imported notes would be invisible to semantic/hybrid
   * search until a manual `reindex`.
   *
   * created_at / updated_at are restored when they parse as dates, so a
   * restored backup keeps its history instead of looking brand new. The rev
   * counter is restored too (when sane), so a note with 25 revisions behind
   * it doesn't restart at 1 -- CAS guards and the change feed stay accurate
   * across a restore.
   *
   * Edges: creates skip per-note scoring; once every note is in, only the
   * IMPORTED notes are scored against their (final) namespace -- never a
   * whole-store rebuild, so a 1-note import into a big store stays cheap.
   * Because every imported note is scored against the final namespace
   * snapshot, a fresh-store import yields exactly the graph a full rebuild
   * would.
   */
  async importNotes(
    notes: ImportNote[],
    opts: {
      report?: ImportReport;
      deferEdges?: boolean;
      /**
       * Idempotent restore: skip a note when the store already holds one with
       * the same namespace + title + created_at + body (re-running an import
       * after an interruption, or importing your own export twice). Off by
       * default, so existing callers behave exactly as before.
       */
      dedupe?: boolean;
    } = {}
  ): Promise<NoteRecord[]> {
    const created: NoteRecord[] = [];
    // Batched inserts: one write transaction per IMPORT_INSERT_BATCH notes
    // instead of one per note. Inside the batch create() nests as a
    // SAVEPOINT (see create), so each note stays individually all-or-nothing
    // and a rejected/quarantined note -- thrown BEFORE any of its SQL --
    // leaves the batch transaction healthy; only an unexpected fault rolls
    // its batch back and propagates (batches committed earlier stay, same
    // partial-restore-on-hard-failure behavior as the old per-note path).
    // We yield to the event loop BETWEEN batches (never inside one), so a
    // big restore can't stall concurrent API/MCP traffic.
    for (let start = 0; start < notes.length; start += IMPORT_INSERT_BATCH) {
      const batch = notes.slice(start, start + IMPORT_INSERT_BATCH);
      const insertBatch = (): void => {
        for (const note of batch) {
          if (!note || !note.title || !note.title.trim()) continue;
          // A tolerant export marks bodies it could not decrypt; restoring one
          // would silently replace a recoverable note with an empty one.
          if ((note as { unreadable?: unknown }).unreadable === true) {
            opts.report?.rejected.push({
              title: note.title,
              error: "unreadable marker from an export (its body could not be decrypted); not imported",
            });
            continue;
          }
          if (opts.dedupe && this.hasImportTwin(note)) {
            if (opts.report) opts.report.skipped = (opts.report.skipped ?? 0) + 1;
            continue;
          }
          try {
            created.push(
              this.create(
                {
                  namespace: note.namespace,
                  title: note.title,
                  body: note.body,
                  tags: note.tags,
                  source: note.source, // preserve provenance across export -> import
                  created_at: note.created_at,
                },
                {
                  skipEdges: true,
                  updatedAt: note.updated_at,
                  startRev: note.rev,
                  // Retention state survives a backup/restore: an archived
                  // note stays archived, a TTL note keeps its deadline.
                  // Garbage values are rejected (ValidationError), never
                  // silently turned into "live, no TTL".
                  ...(note.expires_at ? { expiresAt: note.expires_at } : {}),
                  ...(note.archived_at ? { archivedAt: note.archived_at } : {}),
                }
              )
            );
          } catch (e) {
            // Skip a note that fails validation (oversized / looks like a secret)
            // rather than aborting the whole restore and leaving earlier notes
            // committed-but-unembedded. Unexpected faults (e.g. DB errors) still
            // propagate so a real failure isn't silently swallowed.
            if (e instanceof QuarantinedError) {
              opts.report?.quarantined.push({ title: note.title, quarantineId: e.quarantineId });
              continue;
            }
            if (e instanceof ValidationError) {
              opts.report?.rejected.push({ title: note.title, error: e.message });
              continue;
            }
            throw e;
          }
        }
      };
      if (this.db.isTransaction) insertBatch();
      else this.transaction(insertBatch);
      if (start + IMPORT_INSERT_BATCH < notes.length) {
        await new Promise<void>((r) => setImmediate(r));
      }
    }
    // Similarity-graph linking is O(n^2): every imported note is scored
    // against the whole namespace. On a bulk restore that is 88-97% of the
    // total time (measured: 8000 notes = 3.6s of inserts, 34.9s of linking).
    // `deferEdges` skips it so a restore lands in seconds; the caller is
    // responsible for telling the operator to run `onememory rebuild-edges`
    // afterwards. Small/one-at-a-time imports keep inline linking so the
    // graph is never silently missing for the common case.
    if (!opts.deferEdges) await this.linkNotes(created);
    return created;
  }

  /** True when an identical note (namespace, title, created_at, body) already exists. */
  private hasImportTwin(note: ImportNote): boolean {
    const created = isoOrNull(note.created_at);
    if (!created || typeof note.title !== "string") return false;
    const ns = note.namespace?.trim() || DEFAULT_NAMESPACE;
    const rows = this.db
      .prepare("SELECT * FROM notes WHERE namespace = ? AND created_at = ? AND title = ?")
      .all(ns, created, note.title) as unknown as NoteRow[];
    const body = note.body ?? "";
    return rows.some((r) => {
      try {
        return this.rec(r).body === body;
      } catch {
        return false;
      }
    });
  }

  /**
   * Score just these notes against their own namespaces and store their
   * edges. Batched: each IMPORT_LINK_BATCH slice is scored and applied in
   * one short write transaction (scoring under the lock keeps the neighbor
   * set consistent with what is applied), then yields to the event loop.
   */
  private async linkNotes(notes: NoteRecord[]): Promise<void> {
    const threshold = this.getEdgeThreshold();
    const byNs = new Map<string, number[]>();
    for (const n of notes) {
      const g = byNs.get(n.namespace);
      if (g) g.push(n.id);
      else byNs.set(n.namespace, [n.id]);
    }
    for (const [ns, ids] of byNs) {
      for (let i = 0; i < ids.length; i += IMPORT_LINK_BATCH) {
        const batch = ids.slice(i, i + IMPORT_LINK_BATCH);
        this.transaction(() => {
          const idx = this.edgeIndex(ns);
          for (const id of batch) {
            const tf = idx.tf.get(id);
            if (!tf) continue; // deleted (or moved) since it was imported
            this.applyEdgePairs(id, this.scoreAgainstIndex(idx, tf, new Set([id]), threshold));
          }
        });
        await new Promise<void>((r) => setImmediate(r));
      }
    }
  }

  // --- Semantic search (optional; only used when embeddings are enabled) ---

  /** Store or replace a note's embedding. Best-effort: caller guards errors. */
  setVector(noteId: number, vec: Float32Array, model = ""): void {
    this.db
      .prepare(
        `INSERT INTO note_vectors (note_id, dim, model, vec, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(note_id) DO UPDATE SET
           dim = excluded.dim, model = excluded.model,
           vec = excluded.vec, updated_at = excluded.updated_at`
      )
      .run(noteId, vec.length, model, vecToBlob(vec), new Date().toISOString());
  }

  /** How many notes have an embedding stored. */
  vectorCount(): number {
    return (this.db.prepare("SELECT COUNT(*) AS c FROM note_vectors").get() as { c: number }).c;
  }

  /** Note ids that have no embedding yet (for reindex/backfill). */
  noteIdsMissingVectors(): number[] {
    const rows = this.db
      .prepare(
        `SELECT n.id AS id FROM notes n
         LEFT JOIN note_vectors v ON v.note_id = n.id
         WHERE v.note_id IS NULL AND n.archived_at IS NULL ORDER BY n.id ASC`
      )
      .all() as unknown as { id: number }[];
    return rows.map((r) => r.id);
  }

  /**
   * Rank notes by cosine similarity of their embedding to `queryVec`.
   * Pure + synchronous: no network -- the embedding is produced by the
   * caller. Brute-force over stored vectors, which is plenty for a personal
   * note store (hundreds–thousands of notes). Vectors whose dimension does
   * not match the query are skipped rather than mis-scored.
   *
   * When `startISO`/`endISO` are given, the window is pushed into the
   * vector SQL (`notes.created_at >= ? AND notes.created_at < ?`), so the
   * top-`limit` ranking is computed *within* the window -- not globally and
   * post-filtered. Post-filtering a global top-200 is what made
   * time-scoped semantic search silently return nothing: 200 out-of-window
   * notes would crowd the real in-window hits out before the filter ran.
   */
  semanticSearch(
    queryVec: Float32Array,
    opts: { namespace?: string; limit?: number } & RangeOpts = {}
  ): SemanticHit[] {
    if (!queryVec || queryVec.length === 0) return [];
    const limit = clampInt(opts.limit, 20, 1, 200);
    const range = rangeClause(opts);

    const rows = (
      opts.namespace
        ? this.db
            .prepare(
              `SELECT v.note_id, v.dim, v.model, v.vec FROM note_vectors v
               JOIN notes ON notes.id = v.note_id
               WHERE notes.namespace = ? AND notes.archived_at IS NULL${range.sql}`
            )
            .all(opts.namespace, ...range.params)
        : this.db
            .prepare(
              `SELECT v.note_id, v.dim, v.model, v.vec FROM note_vectors v
               JOIN notes ON notes.id = v.note_id
               WHERE notes.archived_at IS NULL${range.sql}`
            )
            .all(...range.params)
    ) as unknown as VectorRow[];

    const scored: { id: number; score: number }[] = [];
    for (const r of rows) {
      if (r.dim !== queryVec.length) continue;
      const score = cosineSim(queryVec, blobToVec(r.vec));
      if (score > 0) scored.push({ id: r.note_id, score });
    }
    scored.sort((a, b) => b.score - a.score);

    const hits: SemanticHit[] = [];
    for (const s of scored.slice(0, limit)) {
      const note = this.read(s.id);
      if (note) hits.push({ note, score: s.score });
    }
    return hits;
  }

  // --- Similarity edge graph (v4) ------------------------------------------

  /**
   * Score one note's text against a same-namespace snapshot: TF-IDF-weighted
   * cosine over title + body (same tokenizer as consolidation) against every
   * other note in the namespace, returning the pairs at/above `threshold`.
   *
   * I-HIGH-1: raw-TF cosine let a single common token clear the old 0.35
   * floor (llmem's threshold was tuned on an IDF-weighted BM25 scale, a
   * different metric). TF-IDF downweights boilerplate; pairs sharing fewer
   * than MIN_SHARED_TOKENS_FOR_EDGE content tokens never earn an edge at
   * all. Both the metric and the 0.25 default were chosen by the sweep in
   * reviews/tier2-threshold-sweep/.
   *
   * Cost: scores only notes sharing tokens with the target, via the
   * namespace's cached edge index (see edgeIndex) -- no longer a
   * re-select + re-tokenize of the whole namespace per write. This is the
   * CPU half of edge recomputation, and it performs NO note writes (it may
   * refresh the in-memory index) -- call it BEFORE opening a write transaction
   * (BLOCKER 3: update()/consolidateNotes used to hold BEGIN IMMEDIATE
   * through the whole scoring loop, starving concurrent readers and
   * writers). Scoring now runs under the write lock (consistent snapshot,
   * no re-validation dance); it is cheap because only notes sharing tokens
   * with the target are scored.
   *
   * `excludeIds` keeps about-to-vanish notes out of the snapshot (the
   * note's own id on update; the deleted sources on consolidation).
   */
  planEdges(
    namespace: string,
    title: string,
    body: string,
    threshold: number,
    excludeIds: ReadonlySet<number> = new Set()
  ): { pairs: Array<{ neighborId: number; score: number }> } {
    // Tokenize the target once; the namespace side comes from the cached
    // edge index. Same TF construction as precomputeTfMaps, so scores are
    // bit-identical to the brute-force scan.
    const mine = termFreq(tokenize(`${title} ${body}`));
    return { pairs: this.scoreAgainstIndex(this.edgeIndex(namespace), mine, excludeIds, threshold) };
  }

  /** SQLite's data_version: moves whenever ANOTHER connection commits. O(1). */
  private dataVersion(): number {
    return Number((this.db.prepare("PRAGMA data_version").get() as { data_version: number }).data_version);
  }

  /**
   * Record this Store's own write to note `id` in `namespace` (`doc` null =
   * the note left it). If the cached index is current (no foreign commit
   * since it was synced) the change is applied incrementally, keeping the
   * next write on the O(1) fast path; otherwise the next edgeIndex() call
   * diffs it against the database anyway.
   */
  private noteWritten(
    namespace: string,
    id: number,
    doc: { rev: number; title: string; body: string } | null
  ): void {
    const idx = this.edgeIndexes.get(namespace);
    if (!idx || idx.ver !== this.dataVersion()) return;
    dropFromIndex(idx, id);
    if (doc) addToIndex(idx, id, doc.rev, termFreq(tokenize(`${doc.title} ${doc.body}`)));
  }

  /**
   * The namespace's edge index, current with the database. Fast path: no
   * foreign commit since the last sync (O(1)). Otherwise diff (id, rev)
   * against the cache and re-tokenize only notes that are new or changed --
   * this picks up commits from other connections/processes. The first use
   * of a namespace tokenizes it once. Indexes are released when idle or
   * when the cache is over its note budget (see evictEdgeIndexes).
   */
  private edgeIndex(namespace: string): NsEdgeIndex {
    const ver = this.dataVersion();
    let idx = this.edgeIndexes.get(namespace);
    if (idx) this.edgeIndexes.delete(namespace); // re-inserted below: Map order = LRU order
    idx ??= { ver: -1, used: 0, revs: new Map(), tf: new Map(), tfNorm: new Map(), postings: new Map() };
    this.edgeIndexes.set(namespace, idx);
    idx.used = Date.now();
    this.evictEdgeIndexes(namespace);
    if (idx.ver === ver) return idx;
    const live = new Map(
      (
        this.db.prepare("SELECT id, rev FROM notes WHERE namespace = ? AND archived_at IS NULL").all(namespace) as Array<{
          id: number;
          rev: number;
        }>
      ).map((r) => [Number(r.id), Number(r.rev)])
    );
    for (const id of [...idx.revs.keys()]) if (!live.has(id)) dropFromIndex(idx, id);
    const changed = [...live].filter(([id, rev]) => idx!.revs.get(id) !== rev).map(([id]) => id);
    const fetch = this.db.prepare("SELECT id, rev, title, body FROM notes WHERE id = ?");
    for (const id of changed) {
      const r = fetch.get(id) as { rev: number; title: string; body: string } | undefined;
      dropFromIndex(idx, id);
      if (r) addToIndex(idx, id, Number(r.rev), termFreq(tokenize(`${r.title} ${r.body}`)));
    }
    idx.ver = ver;
    this.evictEdgeIndexes(namespace);
    return idx;
  }

  /**
   * Bound the edge-index cache: drop namespaces idle longer than
   * ONEMEMORY_EDGE_INDEX_IDLE_MS, then least-recently-used ones while the
   * cached note count exceeds ONEMEMORY_EDGE_INDEX_MAX_NOTES. `keep` (the
   * namespace in use) is never dropped. A dropped index is rebuilt on next
   * use (one tokenize pass over that namespace).
   */
  private evictEdgeIndexes(keep: string): void {
    const now = Date.now();
    const { idleMs, maxNotes } = edgeIndexLimits();
    let total = 0;
    for (const [ns, idx] of this.edgeIndexes) {
      if (ns !== keep && now - idx.used >= idleMs) this.edgeIndexes.delete(ns);
      else total += idx.tf.size;
    }
    for (const [ns, idx] of this.edgeIndexes) {
      if (total <= maxNotes) break;
      if (ns === keep) continue;
      total -= idx.tf.size;
      this.edgeIndexes.delete(ns);
    }
  }

  /** Namespaces whose edge index is currently cached (diagnostics/tests). */
  cachedEdgeIndexes(): string[] {
    return [...this.edgeIndexes.keys()];
  }

  /**
   * Score one TF map against a namespace's edge index. Equivalent to the
   * brute-force scan over [target, ...namespace minus excludeIds] -- the
   * same TF-IDF cosine, same doc frequencies, same floating-point operation
   * order -- but only notes sharing at least MIN_SHARED_TOKENS_FOR_EDGE
   * tokens with the target (found via the inverted index) are considered;
   * every other note fails the minimum-support floor anyway. At most
   * EDGE_CANDIDATE_LIMIT candidates are scored. Pairs come back in
   * ascending id order.
   */
  private scoreAgainstIndex(
    idx: NsEdgeIndex,
    mine: Map<string, number>,
    excludeIds: ReadonlySet<number>,
    threshold: number
  ): Array<{ neighborId: number; score: number }> {
    // Notes with no content tokens carry no similarity signal
    // (cosineTfIdf scores them 0, never 1): skip the scan.
    if (mine.size === 0) return [];
    // Corpus = the namespace minus excluded notes, plus the target itself.
    // IDF weights are memoized per term for this call (same formula as
    // idf(), same doc frequencies as computeDocFreqs over that corpus).
    const excluded = [...excludeIds].filter((id) => idx.tf.has(id));
    const docCount = idx.tf.size - excluded.length + 1;
    const weights = new Map<string, number>();
    const weight = (t: string): number => {
      let w = weights.get(t);
      if (w === undefined) {
        let df = (idx.postings.get(t)?.size ?? 0) + (mine.has(t) ? 1 : 0);
        for (const id of excluded) if (idx.tf.get(id)!.has(t)) df--;
        w = idfFromCount(df, docCount);
        weights.set(t, w);
      }
      return w;
    };

    // One pass over the target's postings: shared-token count and the
    // TF-IDF dot product per co-occurring note. Accumulated in the target's
    // term order with cosineTfIdf's expression, so the dot is bit-identical.
    const shared = new Map<number, { n: number; dot: number; tfDot: number }>();
    for (const [t, ta] of mine) {
      const posting = idx.postings.get(t);
      if (!posting) continue;
      const w = weight(t);
      for (const [id, tb] of posting) {
        if (excludeIds.has(id)) continue;
        const acc = shared.get(id);
        if (acc) {
          acc.n++;
          acc.dot += ta * w * tb * w;
          acc.tfDot += ta * tb;
        } else {
          shared.set(id, { n: 1, dot: ta * w * tb * w, tfDot: ta * tb });
        }
      }
    }
    let candidates = [...shared].filter(([, a]) => a.n >= MIN_SHARED_TOKENS_FOR_EDGE);
    if (candidates.length > EDGE_CANDIDATE_LIMIT) {
      const proxy = (id: number, a: { tfDot: number }): number => a.tfDot / idx.tfNorm.get(id)!;
      candidates = candidates
        .sort(([ia, a], [ib, b]) => proxy(ib, b) - proxy(ia, a) || ia - ib)
        .slice(0, EDGE_CANDIDATE_LIMIT);
    }
    candidates.sort(([a], [b]) => a - b);

    let na = 0;
    for (const [t, ta] of mine) {
      const w = ta * weight(t);
      na += w * w;
    }
    const pairs: Array<{ neighborId: number; score: number }> = [];
    for (const [id, acc] of candidates) {
      let nb = 0;
      for (const [t, tb] of idx.tf.get(id)!) {
        const w = tb * weight(t);
        nb += w * w;
      }
      if (na === 0 || nb === 0) continue;
      // Same clamp as cosineTfIdf.
      const score = Math.min(1, Math.max(0, acc.dot / (Math.sqrt(na) * Math.sqrt(nb))));
      // 1e-9 epsilon mirrors consolidate.ts: a true-at-threshold score must
      // not be dropped by floating-point rounding.
      if (score + 1e-9 >= threshold) pairs.push({ neighborId: id, score });
    }
    return pairs;
  }

  /**
   * Apply pre-scored edge pairs for one note: delete its existing edges in
   * both directions, then store a bidirectional edge per pair. The caller
   * MUST hold a write transaction -- this is the short write half that
   * pairs with planEdges()'s lock-free scoring half.
   */
  applyEdgePairs(id: number, pairs: Array<{ neighborId: number; score: number }>): void {
    // A namespace change strands edges against the old namespace's notes,
    // so wipe both directions unconditionally before recomputing.
    this.db
      .prepare("DELETE FROM note_edges WHERE note_id = ? OR neighbor_id = ?")
      .run(id, id);
    const insert = this.db.prepare(
      "INSERT INTO note_edges (note_id, neighbor_id, score) VALUES (?, ?, ?)"
    );
    for (const p of pairs) {
      insert.run(id, p.neighborId, p.score);
      insert.run(p.neighborId, id, p.score);
    }
  }

  /**
   * Rebuild one note's edges: delete its existing edges in both directions,
   * then score it (cosine over title + body, same tokenizer as
   * consolidation) against every other note in the SAME namespace and
   * store a bidirectional edge for each pair at/above `threshold`.
   *
   * Same-namespace-only is a hard rule, not an optimization: namespaces
   * are an isolation boundary, and an edge is a navigable link between
   * notes. Called on every create; cost is that of planEdges().
   */
  private recomputeEdgesFor(
    id: number,
    namespace: string,
    title: string,
    body: string,
    threshold: number
  ): void {
    const { pairs } = this.planEdges(namespace, title, body, threshold, new Set([id]));
    this.applyEdgePairs(id, pairs);
  }

  /**
   * This note's similar neighbors, top `limit` by score. Same-namespace
   * only: edges are never created across namespaces, and the join
   * re-checks the neighbor's namespace as defense-in-depth (so a note
   * moved between namespaces by a concurrent writer can't leak through a
   * stale edge).
   */
  listNeighbors(id: number, limit = EDGE_NEIGHBOR_LIMIT): NeighborEntry[] {
    const rows = this.db
      .prepare(
        `SELECT e.neighbor_id AS id, n.title AS title, e.score AS score
         FROM note_edges e
         JOIN notes n ON n.id = e.neighbor_id
         WHERE e.note_id = ?
           AND n.archived_at IS NULL
           AND n.namespace = (SELECT namespace FROM notes WHERE id = ?)
         ORDER BY e.score DESC, e.neighbor_id ASC
         LIMIT ?`
      )
      .all(id, id, clampInt(limit, EDGE_NEIGHBOR_LIMIT, 1, 100)) as Array<{
      id: number;
      title: string;
      score: number;
    }>;
    return rows.map((r) => ({ id: r.id, title: r.title, score: r.score }));
  }

  /** Directed edge rows in the similarity graph (doctor's health check). */
  edgeCount(): number {
    return Number(
      (this.db.prepare("SELECT COUNT(*) AS c FROM note_edges").get() as { c: number }).c
    );
  }

  /**
   * The active edge-similarity threshold (D-MEDIUM-4). Persisted in the
   * _meta table (created by migration v5); every write path -- create(),
   * update(), consolidateNotes(), rebuildEdgesCooperative() -- reads it,
   * so a custom rebuild threshold can't be silently reverted by the next
   * write into a mixed-threshold graph. Falls back to
   * EDGE_SIMILARITY_THRESHOLD when unset (fresh database) or corrupt
   * (hand-edited _meta) rather than failing the write.
   */
  getEdgeThreshold(): number {
    try {
      const row = this.db
        .prepare("SELECT value FROM _meta WHERE key = 'edge_threshold'")
        .get() as { value: string } | undefined;
      if (row) {
        const n = Number(row.value);
        if (Number.isFinite(n) && n > 0 && n <= 1) return n;
      }
    } catch {
      /* _meta unreadable: fall back to the default, never fail the write */
    }
    return EDGE_SIMILARITY_THRESHOLD;
  }

  /**
   * Persist the active edge-similarity threshold for all write paths.
   * Validated like any caller-supplied threshold: resolveEdgeThreshold
   * throws on garbage rather than silently clamping, because a rewritten
   * threshold changes which edges exist. rebuildEdgesCooperative() calls
   * this when invoked with an explicit threshold, so the store's write
   * paths follow the rebuild instead of drifting back to the default.
   */
  setEdgeThreshold(v: number): void {
    const t = resolveEdgeThreshold(v);
    this.db
      .prepare(
        "INSERT INTO _meta (key, value) VALUES ('edge_threshold', ?) " +
          "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
      )
      .run(String(t));
  }

  /**
   * Per-namespace rebuild workload estimate: note and pair counts for the
   * similarity-edge rebuild. The MCP confirm gate and the CLI confirmation
   * prompt both read this before running, so the caller sees the O(n^2)
   * cost up front instead of discovering it mid-run.
   */
  rebuildPlan(opts: { namespace?: string } = {}): RebuildPlanEntry[] {
    const ns = opts.namespace?.trim() || undefined;
    const rows = (
      ns
        ? this.db
            .prepare(
              "SELECT namespace, COUNT(*) AS n FROM notes WHERE namespace = ? AND archived_at IS NULL GROUP BY namespace"
            )
            .all(ns)
        : this.db
            .prepare("SELECT namespace, COUNT(*) AS n FROM notes WHERE archived_at IS NULL GROUP BY namespace")
            .all()
    ) as Array<{ namespace: string; n: number }>;
    return rows
      .map((r) => {
        const notes = Number(r.n);
        return {
          namespace: r.namespace,
          notes,
          pairs: (notes * (notes - 1)) / 2,
        };
      })
      .sort((a, b) =>
        a.namespace < b.namespace ? -1 : a.namespace > b.namespace ? 1 : 0
      );
  }

  /**
   * Recalculate every similarity edge from scratch: delete all edges in
   * scope, then re-score every pair within each namespace. Pass `namespace`
   * to rebuild one namespace only. Reports directed edge rows created vs
   * removed (a no-op rebuild reports equal counts).
   *
   * BLOCKER 1 redesign of the old synchronous rebuildEdges() (which scored
   * every pair with per-pair re-tokenization inside one giant BEGIN
   * IMMEDIATE/COMMIT, freezing the server and failing CLI second-process
   * writes with SQLITE_BUSY):
   * - Term-frequency maps are precomputed ONCE per note before the pair
   *   loop (the old code re-tokenized both texts of every pair --
   *   O(pairs x avg_tokens) tokenizer work; also fixes D-MEDIUM-2).
   *   Scoring is TF-IDF-weighted cosine over those maps with per-namespace
   *   doc frequencies, plus a minimum-support floor of
   *   MIN_SHARED_TOKENS_FOR_EDGE shared content tokens (I-HIGH-1: raw-TF
   *   cosine let a single common token clear the old 0.35 floor; both the
   *   metric and the 0.25 default were chosen by the sweep in
   *   reviews/tier2-threshold-sweep/).
   * - Cooperative: yields to the event loop every REBUILD_YIELD_EVERY pair
   *   checks via setImmediate, so a large rebuild never freezes concurrent
   *   API/MCP traffic. Scoring holds NO lock; the write lock is held only
   *   for each chunk's short insert transaction.
   * - Chunked commits: each REBUILD_BAND_NOTES slice of a namespace group
   *   commits its edge inserts in its own transaction. Chunk boundaries
   *   are the resume points -- progress is recorded in the _meta table per
   *   chunk, so an interrupted run (SIGINT, crash) resumes where it left
   *   off instead of restarting from scratch or rolling back a
   *   mega-transaction to zero.
   * - Mid-rebuild mutations (Y-HIGH-3): each chunk re-reads the live id
   *   set under its write lock and skips vanished notes, and inserts are
   *   INSERT OR IGNORE, so a note deleted mid-rebuild can neither abort
   *   the run via an FK violation nor leave dangling edges. Notes created
   *   mid-rebuild get their edges from the normal create() path (they are
   *   not in this run's snapshot, so there is no conflict), and edges of a
   *   note whose rev moved since the snapshot are skipped -- update()
   *   already wrote its fresh edges.
   * - Single-flight: a second call while one runs throws RebuildBusyError.
   *
   * O(n^2) cosine comparisons -- run as maintenance (CLI / MCP tool), not
   * on the write path.
   */
  async rebuildEdgesCooperative(
    opts: RebuildEdgesOptions = {}
  ): Promise<RebuildEdgesResult> {
    // Single-flight: two interleaved rebuilds would wipe and re-insert each
    // other's groups. A second caller gets a clean "already running" error.
    if (this.rebuildRunning) throw new RebuildBusyError();
    this.rebuildRunning = true;
    try {
      return await this.runRebuild(opts);
    } finally {
      this.rebuildRunning = false;
    }
  }

  /** True while rebuildEdgesCooperative is running on this Store. */
  get rebuildInProgress(): boolean {
    return this.rebuildRunning;
  }

  private async runRebuild(opts: RebuildEdgesOptions): Promise<RebuildEdgesResult> {
    // D-MEDIUM-4: an explicit threshold becomes the store's active threshold
    // (persisted in _meta via setEdgeThreshold), so later create()/update()
    // calls don't silently revert this rebuild's edges to the default --
    // no mixed-threshold graphs. Omit threshold to reuse the stored one.
    const threshold =
      opts.threshold === undefined ? this.getEdgeThreshold() : resolveEdgeThreshold(opts.threshold);
    if (opts.threshold !== undefined) this.setEdgeThreshold(threshold);
    const ns = opts.namespace?.trim() || undefined;
    const onProgress = opts.onProgress;
    const scopeKey = ns ?? "*";

    // The namespace groups in scope, in a deterministic order (resume must
    // revisit groups in the same order). Each group's notes are loaded
    // only when the rebuild reaches it -- in the same synchronous step as
    // its edge wipe -- so a write that lands while earlier groups are being
    // scored is never wiped without being rescored.
    const plan = this.rebuildPlan(ns ? { namespace: ns } : {});
    const totalPairs = plan.reduce((s, g) => s + g.pairs, 0);
    interface EdgeDoc {
      id: number;
      rev: number;
      freq: Map<string, number>;
    }
    const loadGroup = (nsName: string): EdgeDoc[] => {
      const rows = this.db
        .prepare("SELECT id, rev, title, body FROM notes WHERE namespace = ? AND archived_at IS NULL ORDER BY id ASC")
        .all(nsName) as Array<{ id: number; rev: number; title: string; body: string }>;
      // Tokenize once per note via the shared helper (D-MEDIUM-2): one pass
      // over the snapshot, then every pair scores against the maps.
      const tfs = precomputeTfMaps(rows.map((r) => ({ ...r, id: Number(r.id) })));
      return rows.map((r) => ({
        id: Number(r.id),
        rev: Number(r.rev),
        freq: tfs.get(Number(r.id))!,
      }));
    };
    // A group's identity for resume validation: note count + first/last id
    // of the id-ordered snapshot. Any create/delete in the group changes it.
    const groupSig = (g: EdgeDoc[]): string =>
      `${g.length}:${g.length > 0 ? g[0].id : 0}:${g.length > 0 ? g[g.length - 1].id : 0}`;

    // Resume: an interrupted run left a progress marker in _meta. It is only
    // honored when threshold + scope match; the marked group is resumed
    // mid-way only if its snapshot is unchanged, otherwise that group is
    // redone from scratch (groups before it were completed by the
    // interrupted run and have been maintained by normal writes since).
    interface RebuildMarker {
      threshold: number;
      scope: string;
      ns: string;
      band: number;
      sig: string;
    }
    const clearMarker = (): void => {
      this.db.prepare("DELETE FROM _meta WHERE key = ?").run(REBUILD_PROGRESS_KEY);
    };
    let resume: { groupIdx: number; band: number; sig: string } | null = null;
    try {
      const mrow = this.db
        .prepare("SELECT value FROM _meta WHERE key = ?")
        .get(REBUILD_PROGRESS_KEY) as { value: string } | undefined;
      if (mrow) {
        const m = JSON.parse(mrow.value) as Partial<RebuildMarker>;
        const gi = plan.findIndex((g) => g.namespace === m.ns);
        if (
          m.threshold === threshold &&
          m.scope === scopeKey &&
          typeof m.band === "number" &&
          typeof m.sig === "string" &&
          gi >= 0
        ) {
          resume = { groupIdx: gi, band: m.band, sig: m.sig };
        } else {
          clearMarker(); // stale marker: different params or vanished group
        }
      }
    } catch {
      resume = null; // _meta unreadable: treat as no marker, rebuild fresh
    }

    const insertEdge = this.db.prepare(
      "INSERT OR IGNORE INTO note_edges (note_id, neighbor_id, score) VALUES (?, ?, ?)"
    );
    const writeMarker = this.db.prepare(
      "INSERT INTO _meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    );
    const liveRevsStmt = this.db.prepare("SELECT id, rev FROM notes WHERE namespace = ? AND archived_at IS NULL");
    const deleteGroupEdges = this.db.prepare(
      `DELETE FROM note_edges
       WHERE note_id IN (SELECT id FROM notes WHERE namespace = ?)
          OR neighbor_id IN (SELECT id FROM notes WHERE namespace = ?)`
    );
    // Every edge's endpoints share one namespace (same-namespace-only is a
    // write-time invariant), so deleting per group covers the whole scope
    // even for a whole-store rebuild.

    let created = 0;
    let removed = 0;
    let pairsDone = 0;
    for (let gi = 0; gi < plan.length; gi++) {
      const nsName = plan[gi].namespace;
      if (resume && gi < resume.groupIdx) {
        pairsDone += plan[gi].pairs; // already rebuilt by the interrupted run
        continue;
      }
      const group = loadGroup(nsName);
      const sig = groupSig(group);
      const startBand =
        resume && gi === resume.groupIdx && resume.sig === sig ? resume.band + 1 : 0;
      if (startBand === 0) {
        // Fresh group: wipe its edges before the first band, synchronously
        // with loadGroup above. (On resume the wipe already happened --
        // never repeat it, or completed bands' edges would be lost.)
        removed += Number(deleteGroupEdges.run(nsName, nsName).changes);
      }
      // I-HIGH-1: doc frequencies for this namespace group's own snapshot,
      // so the IDF weights reflect the corpus actually being scored.
      const groupDf = computeDocFreqs(group.map((d) => d.freq));
      const groupDocCount = group.length;
      const snapRev = new Map(group.map((d) => [d.id, d.rev]));
      for (
        let b = startBand * REBUILD_BAND_NOTES;
        b < group.length;
        b += REBUILD_BAND_NOTES
      ) {
        const bandIdx = Math.floor(b / REBUILD_BAND_NOTES);
        const end = Math.min(b + REBUILD_BAND_NOTES, group.length);
        // Score this band's pairs with NO lock held, yielding
        // cooperatively so concurrent traffic keeps flowing.
        const edges: Array<{ a: number; b: number; score: number }> = [];
        for (let i = b; i < end; i++) {
          const fi = group[i].freq;
          const aId = group[i].id;
          for (let j = i + 1; j < group.length; j++) {
            pairsDone++;
            if (fi.size !== 0) {
              const fj = group[j].freq;
              // Minimum-support floor (I-HIGH-1): fewer than
              // MIN_SHARED_TOKENS_FOR_EDGE shared content tokens never
              // earns an edge, whatever the cosine says.
              if (
                fj.size !== 0 &&
                sharedTokenCount(fi, fj) >= MIN_SHARED_TOKENS_FOR_EDGE
              ) {
                const score = cosineTfIdf(fi, fj, groupDf, groupDocCount);
                // 1e-9 epsilon mirrors the old rebuild: a true-at-threshold
                // score must not be dropped by floating-point rounding.
                if (score + 1e-9 >= threshold) {
                  edges.push({ a: aId, b: group[j].id, score });
                }
              }
            }
            if (pairsDone % REBUILD_YIELD_EVERY === 0) {
              onProgress?.(pairsDone, totalPairs);
              await new Promise<void>((r) => setImmediate(r));
            }
          }
        }
        onProgress?.(pairsDone, totalPairs);
        // Commit the chunk: one short write transaction. Re-read the live
        // (id, rev) set under the lock and skip any edge whose endpoint
        // vanished (Y-HIGH-3) or changed since the snapshot: update() has
        // already written that note's fresh edges, and re-inserting the
        // snapshot's would resurrect stale ones. INSERT OR IGNORE keeps
        // resume-redo and edges a concurrent create() already wrote from
        // aborting the transaction on PK conflicts.
        this.db.exec("BEGIN IMMEDIATE");
        try {
          const live = new Map(
            (liveRevsStmt.all(nsName) as Array<{ id: number; rev: number }>).map((r) => [
              Number(r.id),
              Number(r.rev),
            ])
          );
          const current = (id: number): boolean => live.get(id) === snapRev.get(id);
          for (const e of edges) {
            if (!current(e.a) || !current(e.b)) continue;
            created += Number(insertEdge.run(e.a, e.b, e.score).changes);
            created += Number(insertEdge.run(e.b, e.a, e.score).changes);
          }
          writeMarker.run(
            REBUILD_PROGRESS_KEY,
            JSON.stringify({ threshold, scope: scopeKey, ns: nsName, band: bandIdx, sig })
          );
          this.db.exec("COMMIT");
        } catch (err) {
          try {
            this.db.exec("ROLLBACK");
          } catch {
            /* already rolled back -- rethrow the original */
          }
          throw err;
        }
      }
    }
    clearMarker();
    onProgress?.(pairsDone, totalPairs);
    return { created, removed };
  }

  // --- Change feed (v8: change_log) ---------------------------------------

  /** In-process listeners told "something was written" (live wait; see change-wait.ts). */
  private changeListeners = new Set<() => void>();

  /**
   * Subscribe to "a write committed in this process". Listeners must be
   * cheap and must not throw; they only wake a waiter, which then re-reads
   * the feed itself. Writes from OTHER processes (the CLI) do not call this;
   * waiters cover those with a slow poll of changeHeadSeq(). Returns the
   * unsubscribe function.
   */
  onChange(fn: () => void): () => void {
    this.changeListeners.add(fn);
    return () => {
      this.changeListeners.delete(fn);
    };
  }

  private announceChange(): void {
    for (const fn of [...this.changeListeners]) {
      try {
        fn();
      } catch {
        /* a broken listener must never fail a write */
      }
    }
  }

  /** Highest change_log seq (0 when empty): a cheap "did anything change?" probe. */
  changeHeadSeq(): number {
    return Number(
      (this.db.prepare("SELECT COALESCE(MAX(seq), 0) AS m FROM change_log").get() as { m: number }).m
    );
  }

  /** When purgeChangeLog last ran (ms epoch); the feed purges at most hourly. */
  private lastChangeLogPurge = 0;
  /** Cached HMAC key for feed cursors (see feedKey). */
  private feedKeyCache: Buffer | null = null;

  /**
   * Drop change-log rows older than CHANGE_LOG_RETENTION_DAYS. Periodic
   * (the feed calls it at most once an hour), never per write, and
   * best-effort: a contended lock just skips this round.
   */
  purgeChangeLog(now = Date.now()): void {
    this.lastChangeLogPurge = now;
    const cutoff = new Date(now - CHANGE_LOG_RETENTION_DAYS * 86_400_000).toISOString();
    this.bestEffortWrite(() => {
      // Remember how far the purge reached, so a consumer whose marker is
      // older than that learns it missed events (markerReset) instead of
      // silently skipping them.
      const top = this.db.prepare("SELECT MAX(seq) AS m FROM change_log WHERE changed_at < ?").get(cutoff) as { m: number | null };
      if (top.m === null) return;
      this.transaction(() => {
        this.db.prepare("DELETE FROM change_log WHERE changed_at < ?").run(cutoff);
        const prev = Number(this.getMeta("change_log_purged_to") ?? 0) || 0;
        this.setMeta("change_log_purged_to", String(Math.max(prev, Number(top.m))));
      });
    });
  }

  /** Highest change_log seq ever purged by retention (0 = none): events at or below it are gone. */
  changeLogPurgedTo(): number {
    return Number(this.getMeta("change_log_purged_to") ?? 0) || 0;
  }

  /**
   * Per-store random key that signs feed cursors, so a cursor can't be
   * forged or edited (it carries the window bounds and the "last"-marker
   * consumer). Minted once, race-safe across processes (INSERT OR IGNORE).
   */
  private feedKey(): Buffer {
    if (this.feedKeyCache) return this.feedKeyCache;
    let hex = this.getMeta("feed_key");
    if (!hex) {
      this.db
        .prepare("INSERT OR IGNORE INTO _meta (key, value) VALUES ('feed_key', ?)")
        .run(randomBytes(32).toString("hex"));
      hex = this.getMeta("feed_key")!;
    }
    this.feedKeyCache = Buffer.from(hex, "hex");
    return this.feedKeyCache;
  }

  /**
   * Mint / open a short signed token (change-feed ack tokens). HMAC with the
   * per-store feed key, domain-separated from cursors, so a token for one
   * purpose can never be replayed as another. Opaque to callers.
   */
  mintToken(domain: string, payload: Record<string, unknown>): string {
    const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    const mac = createHmac("sha256", this.feedKey()).update(`${domain}.${body}`).digest().subarray(0, 16);
    return `${body}.${mac.toString("base64url")}`;
  }

  openToken(domain: string, token: string): Record<string, unknown> | null {
    const [body, mac, extra] = String(token).split(".");
    if (!body || !mac || extra !== undefined) return null;
    const want = createHmac("sha256", this.feedKey()).update(`${domain}.${body}`).digest().subarray(0, 16);
    const got = Buffer.from(mac, "base64url");
    if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
    try {
      const v = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
      return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }

  private approvalKeyCache: Buffer | null = null;

  /**
   * MAC for command-task approvals. Keyed by a random per-store secret that
   * lives only in _meta (never in a note, never exposed through any API), so
   * an approval can be produced only by code that holds this Store: the
   * admin-scope approve path. Callers bind namespace, note id, nonce and the
   * command hash into `parts`.
   */
  approvalMac(parts: string[], mint?: true): string;
  approvalMac(parts: string[], mint: boolean): string | null;
  approvalMac(parts: string[], mint = true): string | null {
    if (!this.approvalKeyCache) {
      let hex = this.getMeta("approval_key");
      // Verifying never writes: with no key there cannot be a valid approval.
      if (!hex && !mint) return null;
      if (!hex) {
        this.db
          .prepare("INSERT OR IGNORE INTO _meta (key, value) VALUES ('approval_key', ?)")
          .run(randomBytes(32).toString("hex"));
        hex = this.getMeta("approval_key")!;
      }
      this.approvalKeyCache = Buffer.from(hex, "hex");
    }
    return createHmac("sha256", this.approvalKeyCache)
      .update("onememory-task-approval-v1\n" + JSON.stringify(parts))
      .digest("hex")
      .slice(0, 32);
  }

  /**
   * Consistent hot backup of the database into a NEW file (VACUUM INTO):
   * safe while the server is running and writing; includes everything
   * committed up to the call. Refuses to overwrite. The at-rest key file
   * (.key) is NOT part of the database -- the CLI copies it separately.
   */
  backupTo(dest: string): void {
    this.db.prepare("VACUUM INTO ?").run(dest);
  }

  private encodeCursor(c: FeedCursor): string {
    const body = Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
    const mac = createHmac("sha256", this.feedKey()).update(body).digest().subarray(0, 16);
    return `${body}.${mac.toString("base64url")}`;
  }

  private decodeCursor(raw: string): FeedCursor {
    const [body, mac, extra] = String(raw).split(".");
    if (body && mac && extra === undefined) {
      const want = createHmac("sha256", this.feedKey()).update(body).digest().subarray(0, 16);
      const got = Buffer.from(mac, "base64url");
      if (got.length === want.length && timingSafeEqual(got, want)) {
        try {
          const c = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as FeedCursor;
          if (c && typeof c === "object") return c;
        } catch {
          /* fall through */
        }
      }
    }
    throw new ValidationError("invalid cursor");
  }

  /**
   * "What changed while I was away": notes created, updated, or deleted in
   * a window of the change log, oldest first, paged by an opaque signed
   * cursor. Titles only, never bodies -- read a note to see its content.
   *
   * The window is a range of the local change sequence (seq), not of
   * writer-supplied timestamps: it starts after `fromSeq` (the "last"
   * marker) or at the first change stamped at/after `since`, and ends at
   * the newest change when the first page was requested (later writes
   * belong to the next window). A note created and then edited in the
   * window reports once, as "created", with its latest title; one created
   * and deleted reports only the delete. `namespaces` restricts the feed
   * (undefined = whole store, [] = nothing); `source` restricts to one
   * provenance label. Counts and bySource cover the whole window.
   */
  changes(opts: {
    since?: string;
    fromSeq?: number;
    cursor?: string;
    namespaces?: string[];
    source?: string;
    limit?: number;
    /** "last"-marker consumer, carried (signed) through the cursor. */
    consumer?: string;
    /** Hide changes whose provenance `source` equals this label (exclude_self). */
    excludeSource?: string;
    /** Newest N changes of the window only, oldest first, no paging (see changes.ts). */
    tail?: number;
    /** Clock-skew overlap for a time-based `since` (default FEED_SINCE_GRACE_MS). */
    graceMs?: number;
  }): ChangesPage {
    if (Date.now() - this.lastChangeLogPurge > 3_600_000) this.purgeChangeLog();
    const limit = clampInt(opts.limit, CHANGES_DEFAULT_LIMIT, 1, CHANGES_MAX_LIMIT);
    const scope = feedScopeKey(opts.namespaces, opts.source);
    let c: FeedCursor;
    if (opts.cursor) {
      c = this.decodeCursor(opts.cursor);
      if (c.k !== scope) {
        throw new ValidationError("cursor was issued for a different namespace/source filter");
      }
    } else {
      const s = isoOrNull(opts.since);
      if (!s) throw new ValidationError("since must be an ISO-8601 timestamp");
      const to = Number(
        (this.db.prepare("SELECT COALESCE(MAX(seq), 0) AS m FROM change_log").get() as { m: number }).m
      );
      let from = opts.fromSeq;
      if (from === undefined) {
        const first = (
          // Overlap by FEED_SINCE_GRACE_MS: changed_at comes from SQLite's
          // clock and `since` from the caller's, which can disagree by a
          // timer tick (Windows) or more (another machine). A time-based poll
          // may repeat a change; it must never miss one. Gap-free polling is
          // what `last` markers and cursors are for.
          this.db
            .prepare("SELECT MIN(seq) AS m FROM change_log WHERE changed_at >= ?")
            .get(new Date(Date.parse(s) - Math.max(0, opts.graceMs ?? FEED_SINCE_GRACE_MS)).toISOString()) as {
            m: number | null;
          }
        ).m;
        from = first === null ? to : Number(first) - 1;
      }
      c = { s, u: new Date().toISOString(), f: from, t: to, a: from, k: scope };
      if (opts.consumer) c.c = opts.consumer;
      if (opts.excludeSource) c.x = opts.excludeSource;
    }
    const empty = (): ChangesPage => ({
      since: c.s,
      until: c.u,
      changes: [],
      counts: { created: 0, updated: 0, deleted: 0, total: 0 },
      bySource: {},
      quarantined: 0,
      nextCursor: null,
      consumer: c.c ?? null,
      seq: c.t,
    });
    if (opts.namespaces && opts.namespaces.length === 0) return empty();

    const nsSql = opts.namespaces ? ` AND namespace IN (${opts.namespaces.map(() => "?").join(",")})` : "";
    const nsParams = opts.namespaces ?? [];
    const srcSql = opts.source !== undefined ? " AND source = ?" : "";
    const srcParams = opts.source !== undefined ? [opts.source] : [];
    const exSql = c.x ? " AND (CASE WHEN actor <> '' THEN actor ELSE source END) <> ?" : "";
    const exParams = c.x ? [c.x] : [];
    // One entry per note: its LAST event in the window, kind "deleted" if
    // that event is the delete, else "created" if the note was born in the
    // window, else "updated".
    const eventsSql = `
      WITH ev AS (SELECT seq, note_id, kind FROM change_log
                   WHERE seq > ? AND seq <= ?${nsSql}${srcSql}${exSql}),
           g AS (SELECT note_id, MAX(seq) AS last, MAX(kind = 'created') AS born FROM ev GROUP BY note_id)
      SELECT e.seq AS seq,
             CASE WHEN e.kind = 'deleted' THEN 'deleted' WHEN g.born THEN 'created' ELSE 'updated' END AS kind,
             e.note_id AS id, e.namespace AS namespace, e.title AS title, e.source AS source,
             e.changed_at AS at, e.rev AS rev
        FROM g JOIN change_log e ON e.seq = g.last`;
    const eventParams = [c.f, c.t, ...nsParams, ...srcParams, ...exParams];

    const tail = opts.tail !== undefined ? clampInt(opts.tail, 30, 1, CHANGES_MAX_LIMIT) : 0;
    const rowsRaw = this.db
      .prepare(
        tail
          ? `SELECT * FROM (${eventsSql}) WHERE seq > ? ORDER BY seq DESC LIMIT ?`
          : `SELECT * FROM (${eventsSql}) WHERE seq > ? ORDER BY seq ASC LIMIT ?`
      )
      .all(...eventParams, c.a, (tail || limit) + 1) as Array<{
      seq: number;
      kind: ChangeEntry["kind"];
      id: number;
      namespace: string;
      title: string;
      source: string;
      at: string;
      rev: number | null;
    }>;
    const rows = tail ? rowsRaw.slice(0, tail).reverse() : rowsRaw;
    const more = tail ? false : rows.length > limit;
    const pageRows = rows.slice(0, tail || limit);
    const page = pageRows.map((r): ChangeEntry => ({
      kind: r.kind,
      id: Number(r.id),
      namespace: r.namespace,
      title: r.title,
      source: r.source ?? "",
      at: r.at,
      ...(r.rev === null || r.rev === undefined || r.kind === "deleted" ? {} : { rev: Number(r.rev) }),
    }));

    const grouped = this.db
      .prepare(`SELECT source, kind, COUNT(*) AS n FROM (${eventsSql}) GROUP BY source, kind`)
      .all(...eventParams) as Array<{ source: string; kind: ChangeEntry["kind"]; n: number }>;
    const counts = { created: 0, updated: 0, deleted: 0, total: 0 };
    const bySource: Record<string, ChangeCounts> = {};
    for (const g of grouped) {
      const n = Number(g.n);
      const key = g.source ?? "";
      bySource[key] ??= { created: 0, updated: 0, deleted: 0 };
      bySource[key][g.kind] += n;
      counts[g.kind] += n;
      counts.total += n;
    }
    const quarantined = Number(
      (
        this.db
          .prepare(
            `SELECT COUNT(*) AS c FROM quarantine WHERE created_at >= ? AND created_at < ?${nsSql}${srcSql}`
          )
          .get(c.s, c.u, ...nsParams, ...srcParams) as { c: number }
      ).c
    );
    const last = pageRows[pageRows.length - 1];
    return {
      since: c.s,
      until: c.u,
      changes: page,
      counts,
      bySource,
      quarantined,
      nextCursor: more && last ? this.encodeCursor({ ...c, a: Number(last.seq) }) : null,
      consumer: c.c ?? null,
      seq: c.t,
    };
  }

  /**
   * The "last" marker of (consumer, scope): the change seq (and time) the
   * consumer last read the feed up to. Keys are computed here, never taken
   * from a caller, and always live under the `changes_seen:` prefix.
   */
  getFeedMarker(consumer: string, scope: string): { seq: number; at: string } | null {
    const raw = this.getMeta(feedMarkerKey(consumer, scope));
    if (!raw) return null;
    try {
      const m = JSON.parse(raw) as { seq: unknown; at: unknown };
      const at = isoOrNull(m.at);
      if (Number.isInteger(m.seq) && at) return { seq: m.seq as number, at };
    } catch {
      /* corrupt: treat as unset */
    }
    return null;
  }

  /**
   * Advance a "last" marker. At most MAX_FEED_MARKERS markers exist: a new
   * one beyond the cap evicts the least recently read marker untouched for
   * FEED_MARKER_MIN_AGE_MS (its `at` is the time it was last read), so
   * arbitrary consumer labels can't grow _meta without bound -- nor flush
   * out markers that are in active use. If every marker is recent, the new
   * one is not stored (its next read reports markerReset).
   */
  setFeedMarker(consumer: string, scope: string, m: { seq: number; at: string }): void {
    const key = feedMarkerKey(consumer, scope);
    this.transaction(() => {
      const exists = this.db.prepare("SELECT 1 FROM _meta WHERE key = ?").get(key);
      if (!exists) {
        const all = this.db
          .prepare("SELECT key, value FROM _meta WHERE key LIKE 'changes\\_seen:%' ESCAPE '\\'")
          .all() as Array<{ key: string; value: string }>;
        if (all.length >= MAX_FEED_MARKERS) {
          const atOf = (v: string): number => {
            try {
              return Date.parse((JSON.parse(v) as { at: string }).at) || 0;
            } catch {
              return 0;
            }
          };
          const cutoff = Date.now() - FEED_MARKER_MIN_AGE_MS;
          const evictable = all
            .map((r) => ({ key: r.key, at: atOf(r.value) }))
            .filter((r) => r.at < cutoff)
            .sort((a, b) => a.at - b.at)
            .slice(0, all.length - MAX_FEED_MARKERS + 1);
          if (all.length - evictable.length >= MAX_FEED_MARKERS) return; // all in use: don't store
          const del = this.db.prepare("DELETE FROM _meta WHERE key = ?");
          for (const r of evictable) del.run(r.key);
        }
      }
      this.setMeta(key, JSON.stringify({ seq: m.seq, at: m.at }));
    });
  }

  /** Admin: empty the change log (the feed restarts; "last" readers get markerReset). */
  purgeChangeLogAll(): number {
    return this.transaction(() => {
      const n = Number(this.db.prepare("DELETE FROM change_log").run().changes);
      this.db.exec("DELETE FROM _meta WHERE key LIKE 'changes\\_seen:%' ESCAPE '\\'");
      return n;
    });
  }

  /** Read a _meta value (null when unset or unreadable). */
  private getMeta(key: string): string | null {
    try {
      const row = this.db.prepare("SELECT value FROM _meta WHERE key = ?").get(key) as
        | { value: string }
        | undefined;
      return row ? row.value : null;
    } catch {
      return null;
    }
  }

  /** Upsert a _meta value. Internal keys only -- never caller-chosen. */
  private setMeta(key: string, value: string): void {
    this.db
      .prepare(
        "INSERT INTO _meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
      )
      .run(key, value);
  }

  // --- Quarantine (v7) -----------------------------------------------------

  /** Hold a linter-flagged write for admin review; returns its quarantine id. */
  private quarantineWrite(q: {
    op: "create" | "update";
    targetId?: number;
    ifRev?: number;
    namespace: string;
    title?: string;
    body?: string;
    tags?: string[];
    source?: string;
    createdAt?: string;
    /** op=update: the original patch moved the note to `namespace`. */
    setNamespace?: boolean;
    findings: LintFinding[];
  }): number {
    // Held writes are the flagged ones (secrets, injections): when at-rest
    // encryption is on they are sealed too. The key state is read under the
    // write lock (see writeKey) so a concurrent `encrypt disable` cannot
    // strand a sealed row.
    const nested = this.db.isTransaction;
    if (!nested) this.db.exec("BEGIN IMMEDIATE");
    let id: number;
    try {
      const key = this.writeKey();
      const sealCol = (col: string, v: string | null): string | null =>
        v === null || !key ? v : encrypt(v, key, quarantineAad(col, q.namespace));
      const res = this.db
        .prepare(
          `INSERT INTO quarantine (op, target_id, if_rev, namespace, title, body, tags, source,
                                   created_at_override, reasons, created_at, set_namespace, sealed)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          q.op,
          q.targetId ?? null,
          q.ifRev ?? null,
          q.namespace,
          sealCol("title", q.title ?? null),
          sealCol("body", q.body ?? null),
          sealCol("tags", q.tags === undefined ? null : JSON.stringify(q.tags)),
          q.source ?? null,
          isoOrNull(q.createdAt),
          JSON.stringify(q.findings),
          new Date().toISOString(),
          q.setNamespace ? 1 : 0,
          key ? 1 : 0
        );
      id = Number(res.lastInsertRowid);
      if (!nested) this.db.exec("COMMIT");
    } catch (e) {
      if (!nested) {
        try {
          this.db.exec("ROLLBACK");
        } catch {
          /* already rolled back */
        }
      }
      throw e;
    }
    // Audit records the decision, never the content.
    audit({ op: "quarantine", id, namespace: q.namespace, bytes: (q.body ?? "").length });
    return id;
  }

  private quarantineRow(row: Record<string, unknown>): QuarantineEntry {
    if (Number(row.sealed) === 1) {
      const key = this.readKey();
      const ns = String(row.namespace);
      for (const col of ["title", "body", "tags"]) {
        if (typeof row[col] === "string") row[col] = decryptIfEncrypted(row[col] as string, key, quarantineAad(col, ns));
      }
    }
    let reasons: LintFinding[] = [];
    try {
      reasons = JSON.parse(String(row.reasons)) as LintFinding[];
    } catch {
      /* corrupt row: show it with no reasons rather than hide it */
    }
    return {
      id: Number(row.id),
      op: row.op === "update" ? "update" : "create",
      target_id: row.target_id === null ? null : Number(row.target_id),
      namespace: String(row.namespace),
      title: (row.title as string | null) ?? null,
      body: (row.body as string | null) ?? null,
      tags: row.tags === null ? null : parseTags(String(row.tags)),
      source: (row.source as string | null) ?? null,
      reasons,
      created_at: String(row.created_at),
    };
  }

  /** Pending quarantined writes, oldest first (optionally per namespace set). */
  listQuarantine(opts: { namespaces?: string[]; limit?: number } = {}): QuarantineEntry[] {
    if (opts.namespaces && opts.namespaces.length === 0) return [];
    const limit = clampInt(opts.limit, 50, 1, 500);
    const where = opts.namespaces
      ? `WHERE namespace IN (${opts.namespaces.map(() => "?").join(",")})`
      : "";
    const rows = this.db
      .prepare(`SELECT * FROM quarantine ${where} ORDER BY id ASC LIMIT ?`)
      .all(...(opts.namespaces ?? []), limit) as Array<Record<string, unknown>>;
    return rows.map((r) => this.quarantineRow(r));
  }

  getQuarantine(id: number): QuarantineEntry | null {
    const row = this.db.prepare("SELECT * FROM quarantine WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? this.quarantineRow(row) : null;
  }

  /**
   * Approve a quarantined write: apply it as originally requested (the
   * linter is skipped -- an admin reviewed it -- but size caps still apply)
   * and drop it from the queue. A held update is pinned to the note's rev
   * when it was held: if the note vanished or was edited since, approval
   * fails with a ValidationError (a conflict) and the write stays queued so
   * the admin can reject it. It moves the note only if the original patch
   * named a namespace.
   */
  approveQuarantine(id: number): NoteRecord {
    const q = this.getQuarantine(id);
    if (!q) throw new ValidationError(`no quarantined write with id ${id}`);
    const drop = this.db.prepare("DELETE FROM quarantine WHERE id = ?");
    let note: NoteRecord;
    if (q.op === "create") {
      const row = this.db
        .prepare("SELECT created_at_override FROM quarantine WHERE id = ?")
        .get(id) as { created_at_override: string | null };
      note = this.transaction(() => {
        const n = this.create(
          {
            namespace: q.namespace,
            title: q.title ?? "",
            body: q.body ?? "",
            tags: q.tags ?? undefined,
            source: q.source ?? undefined,
            created_at: row.created_at_override ?? undefined,
          },
          { lint: "none" }
        );
        drop.run(id);
        return n;
      });
    } else {
      const held = this.db
        .prepare("SELECT if_rev, set_namespace FROM quarantine WHERE id = ?")
        .get(id) as { if_rev: number | null; set_namespace: number };
      const ifRev = held.if_rev;
      // Rows from before 1.1.0 may lack the rev the update was based on;
      // applying them unguarded could overwrite later edits.
      if (ifRev === null) {
        throw new ValidationError(
          `quarantined update #${id} predates rev tracking, so it can't be applied safely; reject it and re-submit the change`
        );
      }
      // A stale if_rev makes update() throw "stale write" -- a conflict the
      // admin resolves (reject, or re-submit), never a silent overwrite.
      const updated = this.update(
        q.target_id ?? -1,
        {
          ...(held.set_namespace ? { namespace: q.namespace } : {}),
          ...(q.title !== null ? { title: q.title } : {}),
          ...(q.body !== null ? { body: q.body } : {}),
          ...(q.tags !== null ? { tags: q.tags } : {}),
          ...(q.source !== null ? { source: q.source } : {}),
        },
        { ifRev, lint: "none" }
      );
      if (!updated) {
        throw new ValidationError(
          `quarantined update #${id} targets note ${q.target_id}, which no longer exists; reject it instead`
        );
      }
      drop.run(id);
      note = updated;
    }
    audit({ op: "quarantine-approve", id, namespace: q.namespace });
    return note;
  }

  /** Discard a quarantined write. Returns false when no such entry. */
  rejectQuarantine(id: number): boolean {
    const q = this.getQuarantine(id);
    if (!q) return false;
    this.db.prepare("DELETE FROM quarantine WHERE id = ?").run(id);
    audit({ op: "quarantine-reject", id, namespace: q.namespace });
    return true;
  }

  // --- Plain-file sync identity (v7) ---------------------------------------

  /** This database's stable identity (a UUID minted on first use). */
  storeId(): string {
    const existing = this.getMeta("store_uuid");
    if (existing) return existing;
    const id = randomUUID();
    this.setMeta("store_uuid", id);
    return id;
  }

  /** Local note id for a note first exported by another store, or null. */
  syncLookup(origin: string, originId: number): number | null {
    const row = this.db
      .prepare("SELECT local_id FROM sync_map WHERE origin = ? AND origin_id = ?")
      .get(origin, originId) as { local_id: number } | undefined;
    return row ? Number(row.local_id) : null;
  }

  /** Record that local note `localId` is (origin, originId) elsewhere. */
  syncLink(origin: string, originId: number, localId: number): void {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO sync_map (origin, origin_id, local_id) VALUES (?, ?, ?)"
      )
      .run(origin, originId, localId);
    this.db.prepare("DELETE FROM sync_deleted WHERE origin = ? AND origin_id = ?").run(origin, originId);
  }

  /**
   * Another machine's note that was imported here and then deleted here:
   * its merge base hash (null if never recorded), or undefined if it wasn't.
   */
  syncDeleted(origin: string, originId: number): string | null | undefined {
    const row = this.db
      .prepare("SELECT hash FROM sync_deleted WHERE origin = ? AND origin_id = ?")
      .get(origin, originId) as { hash: string | null } | undefined;
    return row ? row.hash : undefined;
  }

  /** Content hash this store last synced for a note (merge base), or null. */
  syncBase(localId: number): string | null {
    const row = this.db.prepare("SELECT hash FROM sync_base WHERE local_id = ?").get(localId) as
      | { hash: string }
      | undefined;
    return row ? row.hash : null;
  }

  setSyncBase(localId: number, hash: string): void {
    this.db
      .prepare(
        "INSERT INTO sync_base (local_id, hash) VALUES (?, ?) ON CONFLICT(local_id) DO UPDATE SET hash = excluded.hash"
      )
      .run(localId, hash);
  }

  /**
   * Id of a pending quarantined write holding exactly this content, or null.
   * Lets file-sync import skip re-queuing a file it already quarantined.
   */
  pendingQuarantineId(namespace: string, title: string, body: string, tags: string[]): number | null {
    // Sealed rows have random IVs, so compare decrypted content, not SQL equality.
    const rows = this.db
      .prepare("SELECT * FROM quarantine WHERE namespace = ? ORDER BY id")
      .all(namespace) as Array<Record<string, unknown>>;
    const want = JSON.stringify([...tags].sort());
    for (const r of rows) {
      let e: QuarantineEntry;
      try {
        e = this.quarantineRow(r);
      } catch {
        continue; // unreadable sealed row can't match
      }
      if (e.title === title && e.body === body && JSON.stringify([...(e.tags ?? [])].sort()) === want) {
        return e.id;
      }
    }
    return null;
  }

  /** Every (local id -> origin identity) link, for export. */
  syncOrigins(): Map<number, { origin: string; originId: number }> {
    const rows = this.db.prepare("SELECT origin, origin_id, local_id FROM sync_map").all() as Array<{
      origin: string;
      origin_id: number;
      local_id: number;
    }>;
    return new Map(
      rows.map((r) => [Number(r.local_id), { origin: r.origin, originId: Number(r.origin_id) }])
    );
  }

  close(): void {
    if (this.accessTimer) clearTimeout(this.accessTimer);
    this.accessTimer = null;
    this.flushAccess();
    this.db.close();
  }
}

/** Signed change-feed cursor payload (see Store.encodeCursor). */
interface FeedCursor {
  /** since (ISO, for display + quarantine count) */
  s: string;
  /** until (ISO, fixed at the first page) */
  u: string;
  /** window: seq > f ... */
  f: number;
  /** ... and seq <= t */
  t: number;
  /** last entry served (seq) */
  a: number;
  /** feedScopeKey of the namespace/source filter the cursor was issued for */
  k: string;
  /** "last"-marker consumer, if any */
  c?: string;
  /** exclude_self: hide changes whose source equals this label */
  x?: string;
}

/** Most "last" markers a store keeps (see Store.setFeedMarker). */
/** How far a time-based `since` reaches back to absorb clock skew (see changes()). */
export const FEED_SINCE_GRACE_MS = 2000;
export const MAX_FEED_MARKERS = 256;
/** A "last" marker read within this window is never evicted (see Store.setFeedMarker). */
export const FEED_MARKER_MIN_AGE_MS = 7 * 86_400_000;

const CONSUMER_RE = /^[A-Za-z0-9._@-]{1,64}$/;

/** Stable short key for a change-feed filter (namespace set + source). */
export function feedScopeKey(namespaces: string[] | undefined, source: string | undefined): string {
  return createHash("sha256")
    .update(JSON.stringify([namespaces ? [...namespaces].sort() : null, source ?? null]))
    .digest("hex")
    .slice(0, 16);
}

function feedMarkerKey(consumer: string, scope: string): string {
  if (!CONSUMER_RE.test(consumer) || !/^[0-9a-f]{16}$/.test(scope)) {
    throw new ValidationError("invalid change-feed consumer");
  }
  return `changes_seen:${consumer}|${scope}`;
}
