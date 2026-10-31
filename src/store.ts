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
import { mkdirSync, statSync, statfsSync, readdirSync, renameSync, existsSync, copyFileSync, unlinkSync } from "node:fs";
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
import { currentActor, currentWriter, cleanWriter } from "./actor.js";
import {
  ALL_NAMESPACES,
  MAX_DISTRUST_RULES,
  MAX_DISTRUST_RULES_PER_NAMESPACE,
  MAX_TRUST_LOG_ROWS,
  MAX_TRUST_LOG_ROWS_GLOBAL,
  MAX_TAINT_NAMES,
  capTaint,
  canonicalRuleWriter,
  NOTE_COLUMNS,
  distrustSql,
  makeWriterId,
  matchesDistrust,
  mergedToStorage,
  parseMerged,
  parseWriterRef,
  writerFilterSql,
  writerTaintFilterSql,
  type DistrustRule,
  type WriterFacts,
} from "./trust.js";
import {
  contentHash,
  ephemeralKey,
  isPublicKey,
  keyIdOf,
  isIso,
  attestMinVersion,
  keyFileStamp,
  replaceSigningKey,
  copyKeyFileExclusive,
  isServerId,
  loadOrCreateSigningKey,
  parseTrustedAttestersEnvDetailed,
  peekSigningKey,
  tightenKeyFile,
  attestKeyPath,
  signRecord,
  verifyRecord,
  type Attestation,
  type SigningKey,
  type TrustedAttester,
  type VerifyContext,
  type VerifyReason,
} from "./attest.js";

/**
 * A caller-input error (bad/oversized/secret-bearing data, empty title, stale
 * write). The HTTP layer maps these to 400 with the message shown; anything
 * else is an unexpected fault mapped to a generic 500, so internals never leak.
 */
export class ValidationError extends Error {}

/** v16: a no-migrate open (the capture hooks) found a database at another schema version than this build's. */
export class SchemaMismatchError extends Error {
  constructor(readonly found: number) {
    super(`onememory: the database is at schema v${found}, this build uses v${SCHEMA_VERSION}; not opening it without a migration`);
  }
}

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
 * A confidence claim must be a finite number from 0 to 1 (null clears it on an update). Anything else used to be dropped
 * silently, so the writer believed a value was kept that never was.
 */
export function validateConfidence(v: unknown): void {
  if (v === undefined || v === null) return;
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1) {
    throw new ValidationError("confidence must be a number from 0 to 1 (0 = not sure at all, 1 = certain); it is only a claim");
  }
}

/** Note-history limits (see Store.pruneHistory). Read each time, so an operator can retune without a restart. */
export const HISTORY_DEFAULT_VERSIONS = 20;
export const HISTORY_MAX_VERSIONS = 500;
export const HISTORY_DEFAULT_BYTES = 2_000_000;
export function historyLimits(): { versions: number; bytes: number } {
  const num = (name: string, def: number, min: number, max: number): number => {
    const raw = (process.env[name] ?? "").trim();
    if (raw === "") return def;
    const n = Number(raw);
    return Number.isFinite(n) ? Math.min(Math.max(Math.floor(n), min), max) : def;
  };
  return {
    // 0 turns note history off (nothing is kept from then on; what is already stored stays until purged).
    versions: num("ONEMEMORY_HISTORY_VERSIONS", HISTORY_DEFAULT_VERSIONS, 0, HISTORY_MAX_VERSIONS),
    bytes: num("ONEMEMORY_HISTORY_MAX_BYTES", HISTORY_DEFAULT_BYTES, 10_000, 50_000_000),
  };
}

/** One earlier version of a note, as the history API returns it. */
export interface HistoryEntry {
  /** The note's revision while this text was current. */
  version: number;
  title: string;
  body: string;
  tags: string[];
  /** The server-stamped writer of this text ("" = unknown, or the entry arrived by import: see claimed_writer). */
  written_by: string;
  /** Imported entries only: the writer the file CLAIMED (unverified). */
  claimed_writer?: string;
  /** True when the entry came in by import (its provenance is a claim). */
  imported?: true;
  /** Every other hand this text had passed through when it was current (the note's taint at that moment). Empty for imported entries. */
  merged_from: string[];
  source: string;
  confidence?: number;
  /** When this text stopped being the current one. */
  saved_at: string;
  /** Who replaced it. */
  saved_by: string;
  reason: string;
  bytes: number;
}

/** AAD binding a sealed history body to its row. */
function historyAad(hid: number): string {
  return `history|${hid}`;
}

/**
 * A compare-and-swap update was refused because the note moved on since the caller read it
 * (`ifRev` no longer matches). A ValidationError subclass so every surface keeps its message;
 * the REST layer answers 409 so a client can tell "re-read and retry" from "bad request".
 */
export class StaleWriteError extends ValidationError {}

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
  /**
   * Optional CLAIM (0 to 1) of how sure the writer is. Advisory only: it is stored with the name of the writer who claimed it,
   * shown next to the note, and never used to rank, to override the trust policy or to decide who wins a replacement.
   */
  confidence?: number;
}

/**
 * One note of a backup being restored: a NoteInput plus its updated_at and
 * rev. Both are restore-fidelity fields -- they exist so a backup taken
 * after months of edits restores with its history intact (original dates,
 * revision counter) instead of looking brand new.
 */
export type ImportNote = NoteInput & {
  /** The note's id on the exporting server (part of what its attestation signs). */
  id?: number;
  updated_at?: string;
  rev?: number;
  /** Retention state carried by an export; kept on restore (ISO-8601). */
  expires_at?: string | null;
  archived_at?: string | null;
  /**
   * Provenance fields an export carries. On import they are NEVER trusted:
   * the importing caller becomes written_by / created_by, and the payload's
   * claim is kept only as `imported_written_by`.
   */
  written_by?: string;
  created_by?: string;
  imported_written_by?: string;
  imported_created_by?: string;
  /** What a previous hop attested / merged (carried through an export; signed). */
  attested_writer?: string;
  attested_by?: string;
  merged_from_writers?: string[];
  /** Detached signature of the exporting server over this note (see attest.ts). Verified, never trusted. */
  attestation?: Attestation;
  /** Carried by an export (1.6.0): the note's earlier versions. Every entry is an unverified claim on import. */
  history?: unknown;
  /** Carried by an export (1.6.0): who claimed the confidence value (a claim; the importer is recorded instead). */
  confidence_claimed_by?: string;
  /** Carried by an export (1.6.0): this note was retired and replaced by the note with this id IN THE SAME FILE. */
  superseded_by?: number;
  superseded_at?: string;
};

/** What an import made of the attestations it met. */
export interface AttestationReport {
  /** Notes whose attestation verified against a trusted key: the original writer is kept in `attested_writer`. */
  verified: number;
  /** Notes imported WITHOUT attestation credit (none, tampered, or an untrusted key): stamped with the importer. */
  unverified: number;
  /** Why notes were unverified, with counts. */
  reasons: Record<string, number>;
  /** Attester keys seen but not trusted: a person decides whether to add one (`onememory trust attester-add`). */
  untrusted_keys: Array<{ key_id: string; server_id: string; notes: number }>;
}

/**
 * Should an import response mention attestations? Only when some note carried
 * one: an import of a plain (pre-1.4.0 or hand-made) backup keeps its old,
 * unchanged result shape.
 */
export function attestationsToShow(a: AttestationReport | undefined): AttestationReport | undefined {
  if (!a) return undefined;
  return a.verified > 0 || a.unverified > (a.reasons["no attestation"] ?? 0) ? a : undefined;
}

/** Per-note outcome of importNotes() for writes that did not become notes. */
export interface ImportReport {
  quarantined: Array<{ title: string; quarantineId: number }>;
  rejected: Array<{ title: string; error: string }>;
  /** Set by importNotes({ dedupe: true }): notes skipped as already present. */
  skipped?: number;
  /** Set by importNotes: how many notes carried a verifiable attestation. */
  attestations?: AttestationReport;
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
  /**
   * Server-stamped identity of whoever made this change (token label, or
   * stdio / cli / server); "" = unknown (old rows, foreign writers).
   * `source` above is only what the writer claimed. For a create/update this
   * is the note's writer as of that event (a metadata-only edit does not
   * change it); for a delete it is whoever deleted. The written_by /
   * not_written_by feed filters match THIS (event) value.
   */
  written_by: string;
  /** `<server_id>/<written_by>`: the event writer's stable id ("" = unknown). */
  writer_id: string;
  /**
   * The note's CURRENT last content writer (what state_list / state_read
   * show), which can differ from `written_by` when the note changed after
   * this event. For a deleted note: its last content writer at deletion.
   */
  note_written_by?: string;
  /** `<server_id>/<note_written_by>`. */
  note_writer_id?: string;
  /**
   * Set (true) only when `include_distrusted` let a note through whose writer
   * is on the namespace's distrust list. Absent otherwise.
   */
  distrusted?: true;
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
export const SCHEMA_VERSION = 16;

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
  /** A claim of how sure the writer is (0 to 1); null removes it. */
  confidence?: number | null;
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
  /**
   * Client-asserted provenance: whatever string the writer sent. ADVISORY ONLY
   * (any writer can claim any value); use `written_by` for who actually wrote.
   */
  source: string;
  /**
   * Server-stamped identity of whoever last changed the note's CONTENT (its
   * title or body): the authenticated token's label, or `stdio` / `cli` /
   * `server` / `runner` for writers with no token. A metadata-only change
   * (tags, task claim / lease / approve, archive, restore) does not change it.
   * Set by the server from the connection, never from the request body, so a
   * client cannot forge it. "" = unknown (rows written before schema v13, or a
   * library caller with no identity).
   */
  written_by: string;
  /** Server-stamped identity of the FIRST writer; never changes on update. "" = unknown. */
  created_by: string;
  /**
   * Stable id of the last content writer: `<server_id>/<written_by>`. The
   * server id is random, minted once per database and never changes, so this
   * stays unambiguous when notes move between servers. "" = unknown writer.
   * Always set on records the store returns (optional in the type only so
   * hand-built records, such as test fixtures, stay valid).
   */
  writer_id?: string;
  /**
   * Set only on a note restored via import: the writer the import payload
   * CLAIMED (unverified). written_by / created_by are the importing admin.
   */
  imported_written_by?: string;
  /** Set only on a restored note: the first writer the payload claimed (unverified). */
  imported_created_by?: string;
  /**
   * Present (true) on a note an import brought in WITHOUT a verified attestation: whatever writer labels its file
   * carried (or no longer carried) are claims, not proof of who wrote it. A default export is not signed, so
   * every note restored from one has this flag. Never cleared by later edits.
   */
  imported_unverified?: true;
  /**
   * Set only on a note imported with a VERIFIED attestation: the writer the
   * attesting server vouches for (its own `written_by` for the note). The
   * importing admin is still `written_by`. Cleared when the content is edited.
   */
  attested_writer?: string;
  /** server_id of the server that signed `attested_writer`. */
  attested_by?: string;
  /** `<attested_by>/<attested_writer>` (set with the two above). */
  attested_writer_id?: string;
  /**
   * Set on a note made by merging others (consolidate): the writers of the
   * source notes, kept for good. `not_written_by` and the distrust list treat
   * the merged note as touched by every one of them. The merged note itself is
   * stamped with whoever ran the merge.
   */
  merged_from_writers?: string[];
  /**
   * Present (true) only when a read opted in with include_distrusted and the
   * note's writer is on the distrust list. Never stored.
   */
  distrusted?: true;
  /**
   * A CLAIM (0 to 1) by the writer named in `confidence_claimed_by` of how sure they were. Optional, advisory, never trusted:
   * the server stores it and shows it, and it never changes ranking or the trust policy.
   */
  confidence?: number;
  /** The writer who made the `confidence` claim (stamped by the server). */
  confidence_claimed_by?: string;
  /**
   * Present only on a note that was replaced by another (1.6.0): `status` is "superseded" and `superseded_by` is the id of the
   * replacing note. A superseded note is kept whole (nothing is deleted) and is left out of search and lists unless asked for.
   */
  status?: "superseded";
  superseded_by?: number;
  superseded_at?: string;
  /** The writer who confirmed the replacement. */
  superseded_by_writer?: string;
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
  /** v16: set only on captured rows ('observation' | 'summary'); an ordinary note has no kind field. */
  kind?: NoteKind;
  /** v16: the capture session that produced this row. */
  session_id?: string;
  /** v16: observation type (bugfix, feature, refactor, change, discovery, decision, security_alert, security_note). */
  obs_type?: string;
}

interface NoteRow {
  id: number;
  namespace: string;
  title: string;
  body: string;
  tags: string;
  rev: number;
  source: string;
  written_by: string | null;
  created_by: string | null;
  imported_written_by: string | null;
  imported_created_by: string | null;
  imported_unverified?: number | null;
  attested_writer: string | null;
  attested_by: string | null;
  merged_from_writers: string | null;
  created_at: string;
  updated_at: string;
  access_count: number;
  last_accessed: string | null;
  /** Ciphertext of the body when at-rest encryption is on; NULL otherwise. */
  body_enc: string | null;
  expires_at: string | null;
  archived_at: string | null;
  confidence?: number | null;
  confidence_by?: string | null;
  superseded_by?: number | null;
  superseded_at?: string | null;
  superseded_by_writer?: string | null;
  kind?: string | null;
  session_id?: string | null;
  obs_type?: string | null;
}

export const DEFAULT_NAMESPACE = "default";

/** A pre-upgrade copy (`-backup`, a dated `-backup-YYYYMMDD-HHMMSS` kept copy) or an unfinished/killed one (`.<id>.partial` and its sidecars). */
const PREMIGRATION_FILE_RE = /-backup(-\d{8}-\d{6}(-\d+)?)?(\.[0-9a-f]+\.partial(-journal|-wal|-shm)?)?$/;
const PREMIGRATION_PARTIAL_RE = /\.[0-9a-f]+\.partial(-journal|-wal|-shm)?$/;

/** AAD binding a sealed quarantine column to its column name and namespace. */
function quarantineAad(col: string, namespace: string): string {
  return `quarantine|${col}|${namespace}`;
}

/** Who is making this write: an internal override, else the connection's server-stamped writer. */
function writerNow(opts: { writtenBy?: string }): string {
  return opts.writtenBy !== undefined ? cleanWriter(opts.writtenBy) : currentWriter();
}

function rowToRecord(row: NoteRow, serverId = ""): NoteRecord {
  const attW = row.attested_writer ?? "";
  const attBy = row.attested_by ?? "";
  const merged = parseMerged(row.merged_from_writers);
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
    written_by: row.written_by ?? "",
    created_by: row.created_by ?? "",
    writer_id: makeWriterId(serverId, row.written_by ?? ""),
    ...(row.imported_written_by ? { imported_written_by: row.imported_written_by } : {}),
    ...(row.imported_created_by ? { imported_created_by: row.imported_created_by } : {}),
    ...(Number(row.imported_unverified ?? 0) === 1 ? { imported_unverified: true as const } : {}),
    ...(attW && attBy ? { attested_writer: attW, attested_by: attBy, attested_writer_id: `${attBy}/${attW}` } : {}),
    ...(merged.length ? { merged_from_writers: merged } : {}),
    ...(typeof row.confidence === "number" ? { confidence: row.confidence, confidence_claimed_by: row.confidence_by ?? "" } : {}),
    ...(row.superseded_by !== null && row.superseded_by !== undefined
      ? {
          status: "superseded" as const,
          superseded_by: Number(row.superseded_by),
          ...(row.superseded_at ? { superseded_at: row.superseded_at } : {}),
          ...(row.superseded_by_writer ? { superseded_by_writer: row.superseded_by_writer } : {}),
        }
      : {}),
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
  // v16: only captured rows carry these, so an ordinary note keeps its exact old shape.
  if (row.kind && row.kind !== "note") {
    out.kind = row.kind as NoteKind;
    if (row.session_id) out.session_id = row.session_id;
    if (row.obs_type) out.obs_type = row.obs_type;
  }
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
  /** Neighbors from distrusted writers are left out unless this is set. */
  includeDistrusted?: boolean;
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
  /** Only notes whose LAST writer (server-stamped written_by) is exactly this. */
  writtenBy?: string;
  /** Only notes whose last writer is NOT this (e.g. skip my own writes, or distrust a client). */
  notWrittenBy?: string;
  /**
   * Show notes whose writer is on the namespace's distrust list. Default
   * (false): they are left out of every read. See trust.ts and docs/trust.md.
   */
  includeDistrusted?: boolean;
  /**
   * Also return notes that a confirmed replacement retired (1.6.0). Default (false): they are left out of every read. They are
   * always labelled (`status: "superseded"`, `superseded_by`) and the caller decides who may ask.
   */
  includeSuperseded?: boolean;
  /**
   * v16: which kinds of row to return ('note' | 'observation' | 'summary'). Default ['note'], so captured work never shows
   * up in a read that did not ask for it (list, search, recall behave exactly as before).
   */
  kinds?: readonly NoteKind[];
  /** v16: only observations of these types (bugfix, feature, ...). */
  obsTypes?: readonly string[];
  /** v16: only rows captured in this session. */
  sessionId?: string;
  /** v16: only rows linked to this file path (note_files). */
  filePath?: string;
}

/** v16: what a notes row is. Ordinary notes are 'note'; the capture writer adds 'observation' and 'summary' rows. */
export type NoteKind = "note" | "observation" | "summary";
export const NOTE_KINDS: readonly NoteKind[] = ["note", "observation", "summary"];

/**
 * SQL fragment filtering by archive state.
 *
 * Default (neither flag): only live notes (`archived_at IS NULL`), so a
 * forgotten note never leaks back into list/search/recall. includeArchived
 * shows everything; archivedOnly shows just the archive (restore flow).
 */
function archivedClause(includeArchived?: boolean, archivedOnly?: boolean, includeSuperseded?: boolean, supersededOnly?: boolean): string {
  if (includeArchived) return "";
  if (supersededOnly) return " AND superseded_by IS NOT NULL";
  // A replaced note is archived too, but it has its own view (supersededOnly) and its own way back (supersede undo).
  if (archivedOnly) return " AND archived_at IS NOT NULL AND superseded_by IS NULL";
  if (includeSuperseded) return " AND (archived_at IS NULL OR superseded_by IS NOT NULL)";
  return " AND archived_at IS NULL";
}

/** The "live note" condition for the search queries, which can also take replaced notes when the caller asks for them. */
function liveSql(includeSuperseded?: boolean): string {
  return includeSuperseded ? "(notes.archived_at IS NULL OR notes.superseded_by IS NOT NULL)" : "notes.archived_at IS NULL";
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

function rangeClause(opts: RangeOpts, localId: string): { sql: string; params: string[] } {
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
  if (opts.writtenBy !== undefined) {
    const f = writerFilterSql(NOTE_COLUMNS, opts.writtenBy, "is", localId);
    clauses.push(f.sql);
    params.push(...f.params);
  }
  if (opts.notWrittenBy !== undefined) {
    const f = writerFilterSql(NOTE_COLUMNS, opts.notWrittenBy, "not", localId);
    clauses.push(f.sql);
    params.push(...f.params);
  }
  const kinds = opts.kinds?.length ? opts.kinds : ["note"];
  clauses.push(`notes.kind IN (${kinds.map(() => "?").join(",")})`);
  params.push(...kinds);
  if (opts.obsTypes?.length) {
    clauses.push(`notes.obs_type IN (${opts.obsTypes.map(() => "?").join(",")})`);
    params.push(...opts.obsTypes);
  }
  if (opts.sessionId) {
    clauses.push("notes.session_id = ?");
    params.push(opts.sessionId);
  }
  if (opts.filePath) {
    clauses.push("notes.id IN (SELECT note_id FROM note_files WHERE path = ?)");
    params.push(opts.filePath);
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

let warnedEnvAttesters = "";

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
  /** This database's server_id (the `store_uuid` in _meta); filled in by the constructor. */
  private serverIdValue = "";
  /** The attestation signing key, loaded (or created) on first use. */
  private signingKey: SigningKey | null = null;

  /**
   * How long a statement waits on a contended SQLite lock before giving up
   * with SQLITE_BUSY. Access-counter flushes (flushAccess) run best-effort with a zero
   * timeout instead (see bestEffortWrite): a lost read-count is acceptable,
   * a failed or stalled read is not.
   */
  private static readonly BUSY_TIMEOUT_MS = 5000;
  /** See the constructor: refuse instead of migrating. */
  private readonly noMigrate: boolean;

  /**
   * `opts.noMigrate` (the capture hooks): never upgrade the file. A database at any other schema version than this build's
   * is refused with a SchemaMismatchError instead (the hook then spools the event). `opts.busyTimeoutMs` shortens the lock
   * wait for callers that would rather give up fast than block an agent.
   */
  constructor(dbPath: string, opts: { noMigrate?: boolean; busyTimeoutMs?: number } = {}) {
    this.dbPath = dbPath;
    this.noMigrate = opts.noMigrate === true;
    if (dbPath !== ":memory:") {
      try {
        mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
      } catch (e) {
        throw new Error(Store.explainOpenError(e, dbPath));
      }
    }
    try {
      this.db = new DatabaseSync(dbPath);
    } catch (e) {
      throw new Error(Store.explainOpenError(e, dbPath));
    }
    this.keyDir = dirname(dbPath);
    try {
      // busy_timeout FIRST: switching to WAL and migrating both need a lock
      // another process may be holding at the same moment. The pragmas are INSIDE the try: on a read-only mount the first
      // failure of an existing database is exactly here (the WAL switch), and it must get the readable message too.
      this.db.exec(`PRAGMA busy_timeout = ${Math.floor(opts.busyTimeoutMs ?? Store.BUSY_TIMEOUT_MS)};`);
      this.db.exec("PRAGMA journal_mode = WAL;");
      this.db.exec("PRAGMA foreign_keys = ON;");
      // Load the at-rest key before migrations so a v10 upgrade on an encrypted
      // store can read existing rows. loadKey throws on a corrupt key file
      // rather than silently degrading -- see crypto.ts.
      this.lastKey = loadKey(this.keyDir);
      if (!this.lastKey) this.recoverStrandedKey();
      this.keyStamp = this.stampOf();
      this.init();
      this.ensureLogTriggers();
      this.installActorStamp();
      this.serverIdValue = this.storeId();
      this.upgradeV1Envelopes();
    } catch (e) {
      // A constructor that throws never hands the caller a Store to close();
      // release the file handle here (Windows cannot delete an open database).
      try {
        this.db.close();
      } catch {
        /* already closed */
      }
      throw Store.isReadOnlyError(e) ? new Error(Store.explainOpenError(e, dbPath)) : e;
    }
    // Notes are private: owner-only db + WAL/SHM (POSIX; no-op on Windows).
    if (dbPath !== ":memory:") for (const ext of ["", "-wal", "-shm"]) chmodQuiet(dbPath + ext, 0o600);
  }

  private static isReadOnlyError(e: unknown): boolean {
    const m = e instanceof Error ? e.message : String(e);
    const code = (e as { code?: string }).code ?? "";
    return /readonly database|read-only|unable to open database file|attempt to write/i.test(m) || ["EROFS", "EACCES", "EPERM"].includes(code);
  }

  /** A one-line, actionable message for "the data directory cannot be written" (a `:ro` Docker volume, wrong owner), instead of SQLite's bare text. */
  private static explainOpenError(e: unknown, dbPath: string): string {
    const m = e instanceof Error ? e.message : String(e);
    if (!Store.isReadOnlyError(e)) return m;
    return (
      `onememory cannot write to its data directory ${dirname(dbPath)} (${m}). The directory is read-only, or not writable by this user ` +
      "(for example a Docker volume mounted :ro or created by root): mount it read-write or fix its owner and permissions. " +
      "SQLite needs to create files next to the database (state.db-wal, state.db-shm) even to read it."
    );
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
    if (this.noMigrate && found !== SCHEMA_VERSION) {
      throw new SchemaMismatchError(found);
    }
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
          `(${SCHEMA_VERSION}). Upgrade onememory (npm i -g onememory-mcp@latest) instead of opening it with an older version.`
      );
    }
    if (found >= SCHEMA_VERSION) {
      this.ensureV14Extras();
      this.cleanStoredLabels();
      Store.sweepStalePartials(this.dbPath); // an unfinished upgrade copy (a killed process) does not sit there forever
      return;
    }
    if (found >= 1) this.preMigrationBackup(found);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const v = version();
      if (v < SCHEMA_VERSION) {
        this.migrate(v);
        this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
        this.ensureV14Extras();
        this.cleanStoredLabels();
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

  /**
   * Columns added to v14 tables AFTER the first v14 builds shipped (1.4.1:
   * trust_attesters.not_after). Idempotent and cheap (one PRAGMA); a database
   * opened read-only simply goes without until a writer opens it.
   */
  private ensureV14Extras(): void {
    try {
      if (this.hasColumn("trust_attesters", "not_after") === false && this.hasColumn("trust_attesters", "key_id")) {
        this.addColumn("trust_attesters", "not_after", "TEXT NOT NULL DEFAULT ''");
      }
    } catch {
      /* read-only file: not_after stays unset */
    }
    try {
      // 1.4.2: notes imported WITHOUT a verified attestation are flagged (their writer labels are only claims).
      if (this.hasColumn("notes", "imported_unverified") === false && this.hasColumn("notes", "imported_written_by")) {
        this.addColumn("notes", "imported_unverified", "INTEGER NOT NULL DEFAULT 0");
      }
    } catch {
      /* read-only file: the flag stays unset until a writer opens the database */
    }
  }

  /**
   * 1.4.2: writer labels are compared in their cleaned form (NFKC, invisible format characters removed, see cleanWriter).
   * Rows written by 1.4.1 and earlier still hold the raw spelling, so a rule typed in the cleaned form would no longer
   * match them (a fail-open of the distrust list for labels such as an emoji with a zero-width joiner, or "Dan(tm) bot").
   * This one-time, idempotent pass re-writes every stored label whose cleaned form differs, merges rules that become
   * identical, and records `labels_clean_v1` in _meta. Only rows that actually change are touched; a read-only database
   * skips it and a writer does it at its next open.
   */
  private cleanStoredLabels(): void {
    if (this.getMeta("labels_clean_v1") === "1") return;
    const own = !this.db.isTransaction;
    try {
      if (own) this.db.exec("BEGIN IMMEDIATE");
      try {
        const plain: Array<[string, string]> = [
          ["notes", "written_by"],
          ["notes", "created_by"],
          ["notes", "attested_writer"],
          ["notes", "attested_by"],
          ["notes", "imported_written_by"],
          ["notes", "imported_created_by"],
          ["change_log", "written_by"],
          ["change_log", "note_written_by"],
          ["change_log", "note_attested_writer"],
          ["change_log", "note_attested_by"],
          ["quarantine", "written_by"],
        ];
        for (const [table, col] of plain) {
          if (!this.hasColumn(table, col)) continue;
          const vals = this.db.prepare(`SELECT DISTINCT ${col} AS v FROM ${table} WHERE ${col} <> ''`).all() as Array<{ v: string }>;
          const upd = this.db.prepare(`UPDATE ${table} SET ${col} = ? WHERE ${col} = ?`);
          for (const { v } of vals) {
            if (typeof v !== "string") continue;
            const c = cleanWriter(v);
            if (c !== v) upd.run(c, v);
          }
        }
        for (const [table, col] of [["notes", "merged_from_writers"], ["change_log", "note_merged_from"]] as Array<[string, string]>) {
          if (!this.hasColumn(table, col)) continue;
          const vals = this.db.prepare(`SELECT DISTINCT ${col} AS v FROM ${table} WHERE ${col} <> ''`).all() as Array<{ v: string }>;
          const upd = this.db.prepare(`UPDATE ${table} SET ${col} = ? WHERE ${col} = ?`);
          for (const { v } of vals) {
            const list = parseMerged(v);
            if (list.every((x) => cleanWriter(x) === x)) continue;
            upd.run(mergedToStorage(list), v);
          }
        }
        const rules = this.db.prepare("SELECT namespace, writer FROM trust_distrust").all() as Array<{ namespace: string; writer: string }>;
        for (const r of rules) {
          const canon = canonicalRuleWriter(r.writer);
          if (!canon.ok || canon.writer === r.writer) continue;
          this.db
            .prepare("INSERT OR IGNORE INTO trust_distrust (namespace, writer, added_at, added_by) SELECT namespace, ?, added_at, added_by FROM trust_distrust WHERE namespace = ? AND writer = ?")
            .run(canon.writer, r.namespace, r.writer);
          this.db.prepare("DELETE FROM trust_distrust WHERE namespace = ? AND writer = ?").run(r.namespace, r.writer);
        }
        this.setMeta("labels_clean_v1", "1");
        if (own) this.db.exec("COMMIT");
      } catch (e) {
        if (own) {
          try {
            this.db.exec("ROLLBACK");
          } catch {
            /* nothing to roll back */
          }
        }
        throw e;
      }
    } catch {
      /* read-only database or a lock held elsewhere: tried again at the next open */
    }
  }

  /**
   * Before the first upgrade of a non-empty file (any older version -> the current one), keep one
   * copy of the pre-upgrade database next to it: `<db>.pre-v16-backup`. It is a
   * consistent snapshot (VACUUM INTO) still at the OLD schema version, so an
   * older onememory can open it (rollback = stop everything, put this file
   * back as the database, delete the -wal and -shm files beside it, install the older version). Never overwrites an
   * existing copy, so a second attempt cannot replace the real original.
   * 1.3.x named its copy `.pre-v13-backup`; that file is left alone.
   * The copy is REQUIRED: when it cannot be made (no room on the disk, a failed or unverifiable copy) the upgrade does
   * not run and the error says how to proceed; ONEMEMORY_SKIP_PREMIGRATION_BACKUP=1 migrates without one (take your
   * own `onememory backup` first).
   */
  private preMigrationBackup(from: number): void {
    if (this.dbPath === ":memory:") return;
    const dest = this.dbPath + `.pre-v${SCHEMA_VERSION}-backup`;
    // A name of our own (pid plus random), so two processes opening the same old file at once never share (or delete)
    // a copy in progress, even two containers that are both pid 1 on a shared volume.
    const part = `${dest}.${process.pid}${randomBytes(3).toString("hex")}.partial`;
    const dropPartial = (): void => {
      for (const f of [part, part + "-journal", part + "-wal", part + "-shm"]) {
        try {
          unlinkSync(f);
        } catch {
          /* not there */
        }
      }
    };
    const skip = ["1", "true", "yes"].includes((process.env.ONEMEMORY_SKIP_PREMIGRATION_BACKUP ?? "").trim().toLowerCase());
    const refuse = (why: string): never => {
      throw Object.assign(new Error(
        `onememory: the database was not upgraded, because the safety copy made before the upgrade could not be completed (${why}). ` +
          `Free some disk space or fix the problem and start again, make your own copy first (onememory backup --out <dir>), ` +
          "or set ONEMEMORY_SKIP_PREMIGRATION_BACKUP=1 to upgrade without a copy (there is then no way back to the older version)."
      ), { preMigration: true });
    };
    try {
      if (!this.db.prepare("SELECT 1 FROM notes LIMIT 1").get()) return;
      if (skip) {
        console.error("[onememory] ONEMEMORY_SKIP_PREMIGRATION_BACKUP is set: upgrading WITHOUT a pre-upgrade copy.");
        return;
      }
      const have = Number((this.db.prepare("SELECT COUNT(*) AS c FROM notes").get() as { c: number }).c);
      if (existsSync(dest)) {
        // A copy from an earlier attempt: keep it only if it is a complete, readable
        // pre-upgrade snapshot. A zero-byte or truncated file (a crash or full disk
        // while the copy ran, or by an older build that wrote straight to this name)
        // would otherwise be trusted forever and "restore" an empty database.
        const check = Store.verifyBackupFile(dest);
        if (check.ok && check.notes === have) {
          console.error(`[onememory] keeping the existing pre-upgrade copy ${dest} (${check.notes} notes, schema v${check.version}); not replacing it.`);
          return;
        }
        if (check.ok) {
          // A complete copy, but of a DIFFERENT state: this database was upgraded before, rolled back to an older version,
          // used (notes added or removed) and is being upgraded again. Keep the old copy under a dated name, never lose it,
          // and write a fresh one: the printed rollback advice must restore THIS state, not an older one.
          const stamp = new Date(statSync(dest).mtimeMs).toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
          let kept = `${dest}-${stamp}`;
          for (let i = 2; existsSync(kept); i++) kept = `${dest}-${stamp}-${i}`;
          renameSync(dest, kept);
          console.error(`[onememory] the existing pre-upgrade copy held ${check.notes} notes but the database now holds ${have}; it was kept as ${kept} and a fresh copy is made.`);
        } else if ((check.kind === "empty" || check.kind === "garbage") && statSync(dest).isFile()) {
          // (A directory or other non-regular entry is never deleted here, whatever the platform says about opening it: it goes to the aside branch.)
          // Positively known to be worthless (zero bytes, not a database, no schema): the only case where a copy is deleted.
          console.error(`[onememory] the existing pre-upgrade copy ${dest} is not usable (${check.reason}); replacing it.`);
          unlinkSync(dest);
        } else {
          // It could not be judged (no permission to open it, busy, a failed integrity check): it may well be the real
          // original, so it is moved aside under a dated name, never deleted.
          const stamp = new Date(statSync(dest).mtimeMs).toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
          let kept = `${dest}-${stamp}`;
          for (let i = 2; existsSync(kept); i++) kept = `${dest}-${stamp}-${i}`;
          renameSync(dest, kept);
          console.error(`[onememory] the existing pre-upgrade copy could not be checked (${check.reason}); it was kept as ${kept} and a fresh copy is made.`);
        }
      }
      dropPartial();
      Store.sweepStalePartials(this.dbPath);
      // Room for the copy (about the size of the database) plus a margin.
      try {
        const dbSize = statSync(this.dbPath).size;
        const free = Store.freeBytes(dirname(this.dbPath));
        if (free < dbSize * 1.1 + 1_000_000) {
          refuse(`not enough free disk space: it needs about ${Math.ceil(dbSize / 1e6)} MB, ${Math.floor(free / 1e6)} MB is free`);
        }
      } catch (e) {
        if ((e as { preMigration?: boolean }).preMigration) throw e;
        /* statfs unavailable: try the copy anyway */
      }
      // VACUUM INTO is one consistent snapshot even while an older onememory is still writing to this file. The copy is checked
      // for integrity AND for its note count: it must hold the number of notes the database held when the copy started or
      // when it finished (a writer that is active in between is allowed for; a copy outside that range is a bad copy and is
      // retried, then refused). Written under a temporary name and renamed only when complete and verified (retried once; a rename that an
      // antivirus scanner briefly blocks, as on Windows, is retried too).
      let copyNotes = 0;
      let lastReason = "";
      let ok = false;
      for (let attempt = 1; attempt <= 2 && !ok; attempt++) {
        dropPartial();
        try {
          const countNotes = (): number => Number((this.db.prepare("SELECT COUNT(*) AS c FROM notes").get() as { c: number }).c);
          const before = countNotes();
          this.db.exec(`VACUUM INTO '${part.replace(/'/g, "''")}'`);
          chmodQuiet(part, 0o600);
          const done = Store.verifyBackupFile(part);
          const after = countNotes();
          if (done.ok && done.notes >= Math.min(before, after) && done.notes <= Math.max(before, after)) {
            ok = true;
            copyNotes = done.notes;
          } else if (done.ok) lastReason = `the copy holds ${done.notes} notes but the database held ${before === after ? before : `${before} to ${after}`}`;
          else lastReason = done.reason;
        } catch (e) {
          lastReason = (e as Error).message;
        }
      }
      if (!ok) throw new Error(`the copy did not verify (${lastReason})`);
      if (existsSync(dest)) {
        dropPartial(); // another process finished its copy first
        return;
      }
      let renamed = false;
      for (let i = 0; i < 3 && !renamed; i++) {
        try {
          renameSync(part, dest);
          renamed = true;
        } catch (e) {
          if (i === 2) throw e;
          const until = Date.now() + 100;
          while (Date.now() < until) {
            /* brief pause: a scanner or indexer may hold the new file for a moment */
          }
        }
      }
      dropPartial();
      const nowHave = Number((this.db.prepare("SELECT COUNT(*) AS c FROM notes").get() as { c: number }).c);
      console.error(
        `[onememory] upgrading the database from schema v${from} to v${SCHEMA_VERSION}; the original was copied to ${dest} ` +
          "(to roll back: stop every onememory process, MOVE that file over the database, DELETE the database's -wal and -shm files next to it, then install the older version). " +
          "It holds your notes as they were before the upgrade, including any you later delete or forget: remove it once you are happy " +
          "(`onememory backup --prune-premigration`)."
      );
      if (nowHave !== copyNotes) {
        console.error(
          `[onememory] note: the database was being written while it was copied (the copy holds ${copyNotes} notes, the database now ${nowHave}). ` +
            "The copy is a consistent snapshot, but stop every older onememory process before upgrading if you need a copy of the latest state."
        );
      }
    } catch (e) {
      dropPartial();
      if ((e as { preMigration?: boolean }).preMigration) throw e;
      refuse((e as Error).message);
    }
  }

  /** Free bytes on the volume holding `dir`. A static so a test can simulate a full disk. */
  static freeBytes: (dir: string) => number = (dir) => {
    const st = statfsSync(dir);
    return Number(st.bavail) * Number(st.bsize);
  };

  /** Leftovers of a pre-upgrade copy that was killed: `*.partial` files (and their journal/wal/shm sidecars) older than 10 minutes. */
  static sweepStalePartials(dbPath: string): void {
    if (dbPath === ":memory:") return;
    try {
      const dir = dirname(dbPath);
      for (const f of readdirSync(dir)) {
        if (!f.startsWith(basename(dbPath) + ".pre-v") || !PREMIGRATION_PARTIAL_RE.test(f)) continue;
        const full = join(dir, f);
        if (Date.now() - statSync(full).mtimeMs > 600_000) unlinkSync(full);
      }
    } catch {
      /* best effort */
    }
  }

  /**
   * Is this file a usable database snapshot? Opens it read-only, checks the
   * schema version, that `notes` is readable, optionally that it holds exactly
   * `expectNotes` rows, and runs SQLite's quick integrity check.
   */
  static verifyBackupFile(
    path: string,
    expectNotes?: number
  ): { ok: true; notes: number; version: number } | { ok: false; reason: string; kind: "empty" | "garbage" | "unreadable" } {
    // `kind` says whether a bad file is POSITIVELY worthless ("empty", "garbage": not a database / no schema) or merely could
    // not be judged ("unreadable": permissions, a busy file, a failed integrity check). Only the first two may be deleted.
    let db: DatabaseSync | null = null;
    try {
      const st = statSync(path);
      // A directory (Windows reports size 0 for one) or any other non-regular entry is never "empty": it cannot be judged.
      if (!st.isFile()) return { ok: false, reason: "it is not a regular file", kind: "unreadable" };
      if (st.size === 0) return { ok: false, reason: "the file is empty", kind: "empty" };
      db = new DatabaseSync(path, { readOnly: true });
      const version = Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
      if (version < 1) return { ok: false, reason: "no schema version (an incomplete copy)", kind: "garbage" };
      const notes = Number((db.prepare("SELECT COUNT(*) AS c FROM notes").get() as { c: number }).c);
      if (expectNotes !== undefined && notes !== expectNotes) return { ok: false, reason: `it holds ${notes} notes, expected ${expectNotes}`, kind: "unreadable" };
      const qc = db.prepare("PRAGMA quick_check(1)").get() as { quick_check?: string } | undefined;
      if (qc && qc.quick_check !== undefined && qc.quick_check !== "ok") return { ok: false, reason: `integrity check: ${String(qc.quick_check).slice(0, 80)}`, kind: "unreadable" };
      return { ok: true, notes, version };
    } catch (e) {
      const m = (e as Error).message;
      const code = (e as { code?: string }).code ?? "";
      const garbage = /file is not a database|no such table: notes|malformed database schema|disk image is malformed/i.test(m) && !["EACCES", "EPERM", "EBUSY"].includes(code);
      return { ok: false, reason: m.slice(0, 120), kind: garbage ? "garbage" : "unreadable" };
    } finally {
      try {
        db?.close();
      } catch {
        /* nothing to close */
      }
    }
  }

  /** The pre-upgrade copies next to a database file (`<db>.pre-v*-backup`): path, size, age. */
  static preMigrationBackups(dbPath: string): Array<{ path: string; bytes: number; age_days: number }> {
    if (dbPath === ":memory:") return [];
    const dir = dirname(dbPath);
    const base = basename(dbPath);
    const out: Array<{ path: string; bytes: number; age_days: number }> = [];
    try {
      for (const f of readdirSync(dir)) {
        if (!f.startsWith(base + ".pre-v") || !PREMIGRATION_FILE_RE.test(f)) continue;
        const full = join(dir, f);
        const st = statSync(full);
        out.push({ path: full, bytes: st.size, age_days: Math.floor((Date.now() - st.mtimeMs) / 86_400_000) });
      }
    } catch {
      /* directory unreadable */
    }
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  /** Highest change_log sequence number (0 when empty): a cheap "has anything changed?" stamp. */
  maxChangeSeq(): number {
    return Number((this.db.prepare("SELECT COALESCE(MAX(seq), 0) AS m FROM change_log").get() as { m: number }).m);
  }

  /** Schema version stored in a database file, or null when it is missing / unreadable. Opens read-only; never migrates. */
  static peekSchemaVersion(dbPath: string): number | null {
    if (dbPath === ":memory:" || !existsSync(dbPath)) return null;
    let db: DatabaseSync | null = null;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
      return Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
    } catch {
      return null;
    } finally {
      try {
        db?.close();
      } catch {
        /* nothing to close */
      }
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
    if (v < 13) {
      // v13: server-stamped writer identity ("Who wrote this?"). written_by =
      //     the last writer (token label, or the stdio / cli / server marker),
      //     created_by = the first writer, imported_written_by = what an import
      //     payload CLAIMED. Old rows get '' = unknown (never guessed from the
      //     client-asserted `source`). Plaintext like title/tags. change_log and
      //     quarantine carry the writer too, so the feed can filter on it and an
      //     approved quarantined write keeps its real author.
      this.addColumn("notes", "written_by", "TEXT NOT NULL DEFAULT ''");
      this.addColumn("notes", "created_by", "TEXT NOT NULL DEFAULT ''");
      this.addColumn("notes", "imported_written_by", "TEXT NOT NULL DEFAULT ''");
      this.addColumn("change_log", "written_by", "TEXT NOT NULL DEFAULT ''");
      this.addColumn("quarantine", "written_by", "TEXT NOT NULL DEFAULT ''");
      // The permanent change_log triggers copy the NOTE's writer, so the feed
      // can never disagree with the row (quarantine approval, imports, and
      // writers that never register a function all stay correct).
      this.createLogTriggers();
      // Composite index shaped like the list / search queries (namespace +
      // writer filter, newest first). A bare index on the writer column is
      // very low cardinality (most rows share one value) and made the planner
      // scan and sort nearly the whole table.
      this.db.exec("DROP INDEX IF EXISTS idx_notes_written_by");
      this.db.exec("CREATE INDEX IF NOT EXISTS idx_notes_ns_writer ON notes(namespace, written_by, updated_at DESC)");
    }
    if (v < 14) {
      // v14: the trust layer.
      //  - notes: imported_created_by (the payload's unverified first-writer
      //    claim), attested_writer / attested_by (a writer a TRUSTED server
      //    vouched for, see attest.ts) and merged_from_writers (a JSON array of
      //    the writers whose notes a consolidation merged: kept for good).
      //  - change_log: a delete row remembers who wrote the note it deleted
      //    (note_written_by, plus the attested / merged writers), so the feed can
      //    filter on a note's author even after the note is gone.
      //  - trust_distrust: the admin-managed per-namespace list of distrusted
      //    writers. trust_attesters: public keys whose export attestations the
      //    admin trusts. Both live in the database, never in a note, so a write
      //    token cannot touch them.
      //  - a stable per-database server_id (the existing `store_uuid` in _meta),
      //    minted here so it exists before anything asks for it.
      this.addColumn("notes", "imported_created_by", "TEXT NOT NULL DEFAULT ''");
      this.addColumn("notes", "attested_writer", "TEXT NOT NULL DEFAULT ''");
      this.addColumn("notes", "attested_by", "TEXT NOT NULL DEFAULT ''");
      this.addColumn("notes", "merged_from_writers", "TEXT NOT NULL DEFAULT ''");
      this.addColumn("change_log", "note_written_by", "TEXT NOT NULL DEFAULT ''");
      this.addColumn("change_log", "note_attested_writer", "TEXT NOT NULL DEFAULT ''");
      this.addColumn("change_log", "note_attested_by", "TEXT NOT NULL DEFAULT ''");
      this.addColumn("change_log", "note_merged_from", "TEXT NOT NULL DEFAULT ''");
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS trust_distrust (
          namespace TEXT NOT NULL,
          writer TEXT NOT NULL,
          added_at TEXT NOT NULL,
          added_by TEXT NOT NULL DEFAULT '',
          PRIMARY KEY (namespace, writer)
        );
        CREATE TABLE IF NOT EXISTS trust_attesters (
          key_id TEXT PRIMARY KEY,
          public_key TEXT NOT NULL,
          server_id TEXT NOT NULL DEFAULT '',
          label TEXT NOT NULL DEFAULT '',
          added_at TEXT NOT NULL,
          added_by TEXT NOT NULL DEFAULT '',
          not_after TEXT NOT NULL DEFAULT ''
        );
        CREATE TABLE IF NOT EXISTS trust_log (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          at TEXT NOT NULL,
          actor TEXT NOT NULL DEFAULT '',
          action TEXT NOT NULL,
          namespace TEXT NOT NULL DEFAULT '',
          subject TEXT NOT NULL DEFAULT ''
        );
        CREATE INDEX IF NOT EXISTS idx_change_log_writer ON change_log(written_by, seq);
      `);
      this.createDeleteTrigger();
      this.db.prepare("INSERT OR IGNORE INTO _meta (key, value) VALUES ('store_uuid', ?)").run(randomUUID());
    }
    if (v < 15) {
      // v15 (1.6.0): replacing a memory is never silent, never destructive, and never a one-way door.
      //  - notes.confidence / confidence_by: an optional CLAIM (0..1) and the writer who made it.
      //  - notes.superseded_by / superseded_at / superseded_by_writer: a note a confirmed replacement retired. The note is also
      //    archived (archived_at), so every existing read path already leaves it out; these columns say WHY and by what.
      //  - note_history: earlier titles and bodies of a note (bounded per note), so a bad overwrite can be undone. Bodies are
      //    sealed like note bodies when at-rest encryption is on. Gone with the note on a hard delete.
      //  - supersede_used: single-use marks for confirmation tokens (a token works once).
      //  - supersede_log: who retired / restored what, and when (kept; the notes themselves are never deleted).
      this.addColumn("notes", "confidence", "REAL");
      this.addColumn("notes", "confidence_by", "TEXT NOT NULL DEFAULT ''");
      this.addColumn("notes", "superseded_by", "INTEGER");
      this.addColumn("notes", "superseded_at", "TEXT");
      this.addColumn("notes", "superseded_by_writer", "TEXT NOT NULL DEFAULT ''");
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS note_history (
          hid INTEGER PRIMARY KEY AUTOINCREMENT,
          note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
          version INTEGER NOT NULL,
          title TEXT NOT NULL,
          body TEXT NOT NULL DEFAULT '',
          body_enc TEXT,
          tags TEXT NOT NULL DEFAULT '',
          source TEXT NOT NULL DEFAULT '',
          written_by TEXT NOT NULL DEFAULT '',
          claimed_writer TEXT NOT NULL DEFAULT '',
          imported INTEGER NOT NULL DEFAULT 0,
          merged_from TEXT NOT NULL DEFAULT '',
          confidence REAL,
          saved_at TEXT NOT NULL,
          saved_by TEXT NOT NULL DEFAULT '',
          reason TEXT NOT NULL DEFAULT 'update',
          bytes INTEGER NOT NULL DEFAULT 0,
          UNIQUE (note_id, version)
        );
        CREATE INDEX IF NOT EXISTS idx_note_history_note ON note_history(note_id, version);
        CREATE TABLE IF NOT EXISTS supersede_used (
          nonce TEXT PRIMARY KEY,
          used_at TEXT NOT NULL,
          expires_ms INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS supersede_log (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          at TEXT NOT NULL,
          actor TEXT NOT NULL DEFAULT '',
          action TEXT NOT NULL,
          namespace TEXT NOT NULL DEFAULT '',
          old_id INTEGER NOT NULL,
          new_id INTEGER,
          flags TEXT NOT NULL DEFAULT ''
        );
        CREATE INDEX IF NOT EXISTS idx_notes_superseded ON notes(superseded_by);
      `);
      // The confirmation-token key is made now (a preview must write nothing).
      this.feedKey();
    }
    if (v < 16) {
      // v16 (2.0.0): automatic memory. Captured observations and session summaries are ordinary notes rows with a kind, so
      // they inherit lint, quarantine, history, FTS and trust. Every existing read asks for kind 'note' only (RangeOpts.kinds).
      //  - sessions: one row per agent session (cwd, counts, how far the distiller got, its summary note).
      //  - capture_events: raw hook events, short-lived (ONEMEMORY_CAPTURE_RETENTION_DAYS, see sweepCaptureEvents), never
      //    synced. `output` is sealed into output_enc like a note body when at-rest encryption is on.
      //  - note_files: which files an observation read or changed (gone with the note).
      //  - file_context_seen: which files a session was already shown context for.
      this.addColumn("notes", "kind", "TEXT NOT NULL DEFAULT 'note'");
      this.addColumn("notes", "session_id", "TEXT NOT NULL DEFAULT ''");
      this.addColumn("notes", "obs_type", "TEXT NOT NULL DEFAULT ''");
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_notes_kind_session ON notes(namespace, kind, session_id, created_at);
        CREATE TABLE IF NOT EXISTS sessions (
          id TEXT PRIMARY KEY,
          namespace TEXT NOT NULL DEFAULT '',
          cwd TEXT NOT NULL DEFAULT '',
          agent TEXT NOT NULL DEFAULT 'claude-code',
          started_at TEXT NOT NULL,
          ended_at TEXT,
          prompt_count INTEGER NOT NULL DEFAULT 0,
          event_count INTEGER NOT NULL DEFAULT 0,
          distilled_seq INTEGER NOT NULL DEFAULT 0,
          summary_note_id INTEGER
        );
        CREATE TABLE IF NOT EXISTS capture_events (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          at TEXT NOT NULL,
          event TEXT NOT NULL,
          tool TEXT NOT NULL DEFAULT '',
          input TEXT NOT NULL DEFAULT '',
          output TEXT NOT NULL DEFAULT '',
          output_enc TEXT,
          ok INTEGER NOT NULL DEFAULT 1,
          bytes INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_capture_events_session ON capture_events(session_id, seq);
        CREATE TABLE IF NOT EXISTS note_files (
          note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
          path TEXT NOT NULL,
          action TEXT NOT NULL,
          PRIMARY KEY (note_id, path, action)
        );
        CREATE INDEX IF NOT EXISTS idx_note_files_path ON note_files(path);
        CREATE TABLE IF NOT EXISTS file_context_seen (
          session_id TEXT NOT NULL,
          path TEXT NOT NULL,
          PRIMARY KEY (session_id, path)
        );
      `);
    }
  }

  /** The delete log row also remembers the deleted note's writers (v14). Caller holds the write lock. */
  private createDeleteTrigger(): void {
    this.db.exec(`
      DROP TRIGGER IF EXISTS notes_log_ad;
      CREATE TRIGGER notes_log_ad AFTER DELETE ON notes BEGIN
        UPDATE change_log SET title = '' WHERE note_id = old.id AND title <> '';
        INSERT INTO change_log (note_id, kind, namespace, title, source, rev, changed_at,
                                note_written_by, note_attested_writer, note_attested_by, note_merged_from)
        VALUES (old.id, 'deleted', old.namespace, '', old.source, NULL, ${SQL_NOW},
                old.written_by, old.attested_writer, old.attested_by, old.merged_from_writers);
      END;
    `);
  }

  /** (Re)create the created / updated change_log triggers with the writer column. Caller holds the write lock. */
  private createLogTriggers(): void {
    this.db.exec(`
      DROP TRIGGER IF EXISTS notes_log_ai;
      CREATE TRIGGER notes_log_ai AFTER INSERT ON notes BEGIN
        INSERT INTO change_log (note_id, kind, namespace, title, source, rev, changed_at, written_by)
        VALUES (new.id, 'created', new.namespace, new.title, new.source, new.rev, ${SQL_NOW}, new.written_by);
      END;
      DROP TRIGGER IF EXISTS notes_log_au;
      CREATE TRIGGER notes_log_au AFTER UPDATE ON notes
      WHEN (old.rev IS NOT new.rev OR old.title IS NOT new.title OR old.body IS NOT new.body
            OR old.tags IS NOT new.tags OR old.namespace IS NOT new.namespace
            OR old.source IS NOT new.source OR old.archived_at IS NOT new.archived_at)
      BEGIN
        INSERT INTO change_log (note_id, kind, namespace, title, source, rev, changed_at, written_by)
        VALUES (new.id, 'updated', new.namespace, new.title, new.source, new.rev, ${SQL_NOW}, new.written_by);
        UPDATE change_log SET title = ''
         WHERE old.title IS NOT new.title AND note_id = new.id AND title <> ''
           AND seq < (SELECT max(seq) FROM change_log WHERE note_id = new.id);
      END;
    `);
  }

  /**
   * A v13 file created by 1.3.3 has log triggers that do not copy the writer
   * (a per-connection TEMP trigger stamped it instead, which got quarantine
   * approvals wrong) and the low-cardinality writer index. Bring both up to
   * date once, on first open.
   * No schema version bump: the columns are unchanged.
   */
  private ensureLogTriggers(): void {
    const stale = (): boolean => {
      const rows = this.db
        .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name IN ('notes_log_ai', 'notes_log_au')")
        .all() as Array<{ name: string; sql: string }>;
      const oldIdx = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_notes_written_by'").get();
      return rows.length < 2 || rows.some((r) => !r.sql.includes("written_by")) || Boolean(oldIdx);
    };
    if (!stale()) return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (stale()) {
        this.createLogTriggers();
        this.db.exec("DROP INDEX IF EXISTS idx_notes_written_by");
        this.db.exec("CREATE INDEX IF NOT EXISTS idx_notes_ns_writer ON notes(namespace, written_by, updated_at DESC)");
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

  /**
   * Stamp the ACTOR (token label) on every change_log row this connection
   * causes, and the DELETER's writer identity on delete rows (a delete has no
   * surviving note row to copy a writer from; created / updated rows get
   * theirs from the permanent triggers). A TEMP trigger lives only on this
   * connection (nothing persists in the file, so other tools and older code
   * are unaffected) and calls functions registered on this connection only.
   * No actor in scope (CLI, scripts) = the trigger does nothing and the row
   * keeps actor ''.
   */
  private installActorStamp(): void {
    this.db.function("om_actor", { deterministic: false }, () => currentActor());
    this.db.function("om_writer", { deterministic: false }, () => currentWriter());
    this.db.exec(`
      DROP TRIGGER IF EXISTS temp.om_actor_stamp;
      CREATE TEMP TRIGGER om_actor_stamp AFTER INSERT ON main.change_log
      WHEN om_actor() <> '' OR om_writer() <> ''
      BEGIN
        UPDATE change_log
           SET actor = om_actor(),
               written_by = CASE WHEN new.kind = 'deleted' THEN om_writer() ELSE written_by END
         WHERE seq = new.seq;
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
      /**
       * Internal override of the stamped writer (approving a quarantined write
       * keeps its real author). Like updatedAt it is an opt, never a NoteInput
       * field, so no request body can reach it.
       */
      writtenBy?: string;
      /** Restore path: the writer an import payload CLAIMED (unverified). */
      importedWrittenBy?: string;
      /** Restore path: the first writer an import payload CLAIMED (unverified). */
      importedCreatedBy?: string;
      /** Restore path: the note came in without a verified attestation (flagged `imported_unverified`). */
      importedUnverified?: boolean;
      /** Restore path, verified attestation only: the writer the attesting server vouches for ... */
      attestedWriter?: string;
      /** ... and that server's id. */
      attestedBy?: string;
      /** Consolidation / verified import: writers whose notes this one derives from (kept for good). */
      mergedFromWriters?: Iterable<string>;
      /** v16, capture writer only (an opt, never a NoteInput field, so no request body can forge it): the row's kind ... */
      kind?: NoteKind;
      /** ... the session it was captured in ... */
      sessionId?: string;
      /** ... and its observation type. */
      obsType?: string;
    } & LintOpts = {}
  ): NoteRecord {
    if (!input.title || !input.title.trim()) {
      throw new ValidationError("title is required");
    }
    validateSizes(input);
    validateForgetAfter(input.forget_after);
    validateConfidence(input.confidence);
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
        writtenBy: opts.writtenBy,
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
    // Server-stamped, never from the request: who is writing right now.
    const writer = opts.writtenBy !== undefined ? cleanWriter(opts.writtenBy) : currentWriter();
    const claim = cleanWriter(opts.importedWrittenBy);
    const claimCreator = cleanWriter(opts.importedCreatedBy);
    const attWriter = opts.attestedWriter && opts.attestedBy ? cleanWriter(opts.attestedWriter) : "";
    const attBy = attWriter ? cleanWriter(opts.attestedBy) : "";
    const merged = mergedToStorage(opts.mergedFromWriters ?? []);
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
          `INSERT INTO notes (namespace, title, body, tags, source, written_by, created_by, imported_written_by,
                              imported_created_by, attested_writer, attested_by, merged_from_writers,
                              created_at, updated_at, rev, body_enc, expires_at, archived_at, imported_unverified,
                              confidence, confidence_by, kind, session_id, obs_type)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          namespace,
          input.title,
          encrypting ? "" : body,
          tags,
          source,
          writer,
          writer,
          claim,
          claimCreator,
          attWriter,
          attBy,
          merged,
          createdAt,
          updatedAt,
          startRev,
          expiresAt,
          archivedAt,
          opts.importedUnverified ? 1 : 0,
          typeof input.confidence === "number" ? input.confidence : null,
          typeof input.confidence === "number" ? writer : "",
          opts.kind ?? "note",
          opts.sessionId ?? "",
          opts.obsType ?? ""
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
    return { ...record, neighbors: this.annotatedNeighbors(id, opts.includeDistrusted === true) };
  }

  /**
   * THE by-id read for anything that hands note content to a caller (REST,
   * MCP, tasks, handoffs, CLI): a note the distrust list names reads as
   * missing (null) unless `includeDistrusted`, and is then marked
   * `distrusted: true`. `read()` is the raw, internal read (no policy); a
   * guard test (test/trust-gate-guard.test.ts) fails when a new call site of
   * it appears in a surface that returns content.
   */
  readVisible(id: number, opts: ReadOpts = {}): (NoteRecord & { neighbors?: NeighborEntry[]; distrusted?: true }) | null {
    const probe = this.read(id);
    if (!probe) return null;
    const hidden = this.isDistrusted(probe);
    if (hidden && opts.includeDistrusted !== true) return null;
    const rec = opts.trackAccess || opts.withNeighbors ? this.read(id, opts) : probe;
    if (!rec) return null;
    return hidden ? { ...rec, distrusted: true as const } : rec;
  }

  /** The notes (or note-shaped rows) NOT touched by a distrusted writer. One rule load for the whole list. */
  filterVisible<T extends WriterFacts>(notes: readonly T[]): T[] {
    const rules = this.distrustRules();
    if (rules.length === 0) return [...notes];
    const id = this.serverId();
    return notes.filter((n) => !matchesDistrust(rules, n, id));
  }

  /**
   * This note's similar neighbors with staleness fields attached (I-LOW-1).
   * The neighbor records are read untracked (internal reads never bump
   * access counters); only the staleness annotation is kept, so the payload
   * stays the small NeighborEntry shape.
   */
  private annotatedNeighbors(id: number, includeDistrusted: boolean): NeighborEntry[] {
    return this.listNeighbors(id, EDGE_NEIGHBOR_LIMIT, includeDistrusted).map((n) => {
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
    const r = rowToRecord(row, this.serverIdValue);
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
  accessStats(namespaces?: string[], opts: { hideDistrusted?: boolean } = {}): AccessStats {
    this.flushAccess(); // aggregates read the table
    // Archived notes are forgotten: they must not show up in totals or tops.
    const where =
      namespaces && namespaces.length > 0
        ? `WHERE archived_at IS NULL AND namespace IN (${namespaces.map(() => "?").join(",")})`
        : "WHERE archived_at IS NULL";
    const params: string[] = namespaces && namespaces.length > 0 ? [...namespaces] : [];
    // Titles are note content: a distrusted writer's notes are never listed. The counts include them unless the
    // caller (any non-admin surface) asks for `hideDistrusted`, so a reader cannot learn that hidden notes exist.
    const dis = this.distrustFragment(NOTE_COLUMNS, namespaces && namespaces.length > 0 ? namespaces : undefined);
    const hideSql = opts.hideDistrusted ? dis.sql : "";
    const hideParams = opts.hideDistrusted ? dis.params : [];
    const totals = this.db
      .prepare(
        `SELECT COUNT(*) AS n,
                COALESCE(SUM(access_count), 0) AS accesses,
                COALESCE(SUM(CASE WHEN last_accessed IS NULL THEN 1 ELSE 0 END), 0) AS never
         FROM notes ${where}${hideSql}`
      )
      .get(...params, ...hideParams) as { n: number; accesses: number; never: number };
    const top = this.db
      .prepare(
        `SELECT id, title, access_count FROM notes ${where}${dis.sql}
         ORDER BY access_count DESC, id ASC LIMIT 10`
      )
      .all(...params, ...dis.params) as Array<{ id: number; title: string; access_count: number }>;
    return {
      totalNotes: Number(totals.n),
      totalAccesses: Number(totals.accesses),
      mostAccessed: top.map((r) => ({
        id: Number(r.id),
        title: r.title,
        access_count: Number(r.access_count),
      })),
      neverAccessed: Number(totals.never),
      staleCount: this.staleCount(namespaces, opts),
    };
  }

  /**
   * How many notes are stale under the current staleness config (see
   * staleness.ts). Staleness needs only tags + updated_at, so this scans a
   * narrow projection rather than full records; bodies never leave the DB.
   */
  staleCount(namespaces?: string[], opts: { hideDistrusted?: boolean } = {}): number {
    const where =
      namespaces && namespaces.length > 0
        ? `WHERE archived_at IS NULL AND namespace IN (${namespaces.map(() => "?").join(",")})`
        : "WHERE archived_at IS NULL";
    const params: string[] = namespaces && namespaces.length > 0 ? [...namespaces] : [];
    const dis = opts.hideDistrusted ? this.distrustFragment(NOTE_COLUMNS, namespaces && namespaces.length > 0 ? namespaces : undefined) : { sql: "", params: [] as string[] };
    const rows = this.db
      .prepare(`SELECT tags, updated_at FROM notes ${where}${dis.sql}`)
      .all(...params, ...dis.params) as Array<{ tags: string; updated_at: string }>;
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
        written_by: "",
        created_by: "",
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
    opts: {
      ifRev?: number;
      /** internal: quarantine approval keeps the real author */
      writtenBy?: string;
      /**
       * internal: a bookkeeping write (runner outcome, status) that must not
       * take over `written_by` even though it changes the body. The actor is
       * still recorded in change_log.actor.
       */
      keepWriter?: boolean;
      /** internal: names an unverified source (a vault file's origin_writer) says touched this text; they only ever ADD taint. */
      alsoTouchedBy?: string[];
      /** internal (restoring a version): the taint becomes exactly this set, because the text is again exactly what an earlier version held. */
      replaceTaint?: string[];
      /** internal: why the old text is kept in the note's history ("update" unless a version is being restored). */
      historyReason?: string;
    } & LintOpts = {}
  ): NoteRecord | null {
    validateForgetAfter(patch.forget_after);
    validateConfidence(patch.confidence);
    const existing = this.read(id);
    if (!existing) return null;
    if (existing.superseded_by !== undefined) {
      throw new ValidationError(
        `note ${id} was replaced by note ${existing.superseded_by} and is only kept as a record, so it cannot be edited. ` +
          `To bring it back first, undo the replacement (supersede undo).`
      );
    }

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
        writtenBy: opts.writtenBy,
      });
      throw new QuarantinedError(qid, findings);
    }

    const nsTrim = patch.namespace?.trim();
    const namespace = nsTrim ? nsTrim : existing.namespace;
    const title = patch.title ?? existing.title;
    const body = patch.body ?? existing.body;
    const tags = patch.tags !== undefined ? tagsToStorage(patch.tags) : tagsToStorage(existing.tags);
    const source = patch.source !== undefined ? patch.source.slice(0, 200) : existing.source;
    const confidenceSet = patch.confidence !== undefined;
    const rev = existing.rev + 1;
    // written_by = who last changed the CONTENT (title or body), server-stamped.
    // A metadata-only write (tags: task claim / lease / approve, archive, a
    // source edit) leaves it alone; who made that change is in change_log.actor.
    // created_by is not touched, and a client-sent written_by/created_by never
    // reaches here.
    const contentChanged = title !== existing.title || body !== existing.body;
    // A new author takes over the content, so a verified attestation (which
    // vouched for the OLD content) no longer applies. Taint carried in
    // merged_from_writers stays.
    const restamp = contentChanged && !opts.keepWriter;
    // A metadata-only edit (tags, source, namespace, TTL) leaves written_by alone, so on its own it would let a
    // writer an admin distrusts rewrite the `source` or tags of a TRUSTED note without any mark. Refuse it: the
    // writer would have to change the content (which hands the note over and taints it). Notes already hidden by
    // the policy are unaffected, and so are internal callers that act as no one (library, CLI).
    if (!contentChanged && !opts.keepWriter) {
      const actor = opts.writtenBy !== undefined ? cleanWriter(opts.writtenBy) : currentWriter();
      if (actor && actor !== existing.written_by) {
        const rules = this.distrustRules();
        if (rules.length) {
          const sid = this.serverId();
          const destNs = patch.namespace?.trim() || existing.namespace;
          const actorFacts = (ns: string): WriterFacts => ({ namespace: ns, written_by: actor });
          if ((matchesDistrust(rules, actorFacts(existing.namespace), sid) || matchesDistrust(rules, actorFacts(destNs), sid)) && !matchesDistrust(rules, existing, sid)) {
            throw new ValidationError(
              `writer ${JSON.stringify(actor)} is on the distrust list for namespace ${JSON.stringify(existing.namespace)}: it may not change the tags, source or namespace of note ${id}, which it did not write`
            );
          }
        }
      }
    }
    const writer =
      contentChanged && !opts.keepWriter
        ? opts.writtenBy !== undefined
          ? cleanWriter(opts.writtenBy)
          : currentWriter()
        : existing.written_by;
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
      // Taint is monotonic: when a content edit hands the note to a NEW writer,
      // everyone who touched it before (its previous writer, a verified
      // original author an import carried in, and the writers already merged
      // in) stays in merged_from_writers, so editing a distrusted writer's note
      // does not launder it. Read under the write lock so a concurrent
      // consolidation's list is not lost.
      let mergedAfter: string;
      {
        const cur = this.db
          .prepare("SELECT written_by, attested_writer, attested_by, merged_from_writers FROM notes WHERE id = ?")
          .get(id) as { written_by: string; attested_writer: string; attested_by: string; merged_from_writers: string } | undefined;
        mergedAfter = cur?.merged_from_writers ?? "";
        if (cur && restamp) {
          const set = new Set<string>(parseMerged(cur.merged_from_writers));
          const add = (x: string): void => {
            const c = cleanWriter(x);
            if (c && c !== writer) set.add(c);
          };
          add(cur.written_by);
          if (cur.attested_writer && cur.attested_by) {
            add(cur.attested_writer);
            add(`${cur.attested_by}/${cur.attested_writer}`);
          }
          const fresh = new Set<string>([cleanWriter(cur.written_by)]);
          if (cur.attested_writer && cur.attested_by) {
            fresh.add(cleanWriter(cur.attested_writer));
            fresh.add(`${cur.attested_by}/${cur.attested_writer}`);
          }
          // Bounded like an import's claims (MAX_TAINT_NAMES): names an active rule matches are never the ones dropped.
          mergedAfter = mergedToStorage(capTaint([...set], fresh, this.distrustRules(), namespace, this.serverId()));
        }
        if (cur && opts.alsoTouchedBy?.length) mergedAfter = mergedToStorage([...parseMerged(mergedAfter), ...opts.alsoTouchedBy]);
        if (cur && opts.replaceTaint) mergedAfter = mergedToStorage(opts.replaceTaint.map((x) => cleanWriter(x)).filter((x) => x && x !== writer));
      }
      // History: the text this write replaces is kept (bounded; see pruneHistory) BEFORE it is replaced, in the same transaction,
      // judged against the row as it is under the lock (not the copy read earlier). A bookkeeping write (keepWriter) is not kept.
      if (!opts.keepWriter) {
        const lockedRow = this.db.prepare("SELECT * FROM notes WHERE id = ?").get(id) as NoteRow | undefined;
        if (lockedRow && (want === null || lockedRow.rev === want)) {
          const lockedBody = lockedRow.body_enc ? this.rec(lockedRow).body : lockedRow.body;
          if (lockedRow.title !== title || lockedBody !== body) {
            this.recordHistory(lockedRow, lockedBody, writerNow(opts), opts.historyReason ?? "update", now);
          }
        }
      }
      const res = this.db
        .prepare(
          `UPDATE notes SET namespace = ?, title = ?, body = ?, tags = ?, source = ?, rev = ?, updated_at = ?,
                            body_enc = ?, expires_at = ?, written_by = ?,
                            attested_writer = CASE WHEN ? = 1 THEN '' ELSE attested_writer END,
                            attested_by = CASE WHEN ? = 1 THEN '' ELSE attested_by END,
                            merged_from_writers = ?,
                            confidence = CASE WHEN ? = 1 THEN ? ELSE confidence END,
                            confidence_by = CASE WHEN ? = 1 THEN ? ELSE confidence_by END
           WHERE id = ? AND (? IS NULL OR rev = ?)`
        )
        .run(
          namespace, title, sealed.body, tags, source, rev, now, sealed.bodyEnc, expiresAt, writer,
          restamp ? 1 : 0, restamp ? 1 : 0, mergedAfter,
          confidenceSet ? 1 : 0, confidenceSet && typeof patch.confidence === "number" ? patch.confidence : null,
          confidenceSet ? 1 : 0, confidenceSet && typeof patch.confidence === "number" ? writerNow(opts) : "",
          id, want, want
        );

      if (Number(res.changes) === 0) {
        // The row either vanished or its rev moved since we read it.
        this.db.exec("ROLLBACK");
        const current = this.read(id);
        if (!current) return null; // deleted concurrently -> not found
        throw new StaleWriteError(
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
    const ok = this.deleteWhere(id, null);
    if (ok) this.reviveAfterReplacementDeleted(id);
    return ok;
  }

  /**
   * An explicit hard delete of a note that REPLACED others must not leave those others hidden for good, pointing at nothing:
   * whatever it replaced comes back (and is logged). Consolidation deletes its sources through deleteIfRev and is not affected.
   */
  private reviveAfterReplacementDeleted(deletedId: number): void {
    const rows = this.db.prepare("SELECT id, namespace FROM notes WHERE superseded_by = ?").all(deletedId) as Array<{ id: number; namespace: string }>;
    if (rows.length === 0) return;
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const upd = this.db.prepare("UPDATE notes SET archived_at = NULL, superseded_by = NULL, superseded_at = NULL, superseded_by_writer = '', rev = rev + 1 WHERE id = ? AND superseded_by = ?");
      const log = this.db.prepare("INSERT INTO supersede_log (at, actor, action, namespace, old_id, new_id, flags) VALUES (?, ?, 'undo', ?, ?, ?, 'replacement-deleted')");
      for (const r of rows) {
        upd.run(r.id, deletedId);
        log.run(now, currentWriter(), r.namespace, r.id, deletedId);
      }
      this.db.exec("COMMIT");
    } catch (e) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* already rolled back */
      }
      throw e;
    }
    this.edgeIndexes.clear();
    this.announceChange();
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
    this.sweepCaptureEvents(now, namespaces);
    return n;
  }

  /**
   * v16: raw capture events are short-lived (the distilled observations are what is kept): delete those older than
   * ONEMEMORY_CAPTURE_RETENTION_DAYS (default 7). A namespace-pinned caller only clears its own sessions' events.
   */
  sweepCaptureEvents(now: number = Date.now(), namespaces?: string[]): number {
    const raw = Number(process.env.ONEMEMORY_CAPTURE_RETENTION_DAYS);
    const days = Number.isFinite(raw) && raw > 0 ? raw : 7;
    const cutoff = new Date(now - days * 86_400_000).toISOString();
    if (namespaces && namespaces.length === 0) return 0;
    const nsSql = namespaces ? ` AND session_id IN (SELECT id FROM sessions WHERE namespace IN (${namespaces.map(() => "?").join(",")}))` : "";
    return Number(this.db.prepare(`DELETE FROM capture_events WHERE at < ?${nsSql}`).run(cutoff, ...(namespaces ?? [])).changes ?? 0);
  }

  /**
   * v16: the capture side tables (sessions, capture_events, note_files, file_context_seen) are reached through this handle by
   * capture.ts / extract.ts. Notes rows are NOT: those always go through create/read so lint, sealing and history apply.
   */
  captureDb(): DatabaseSync {
    return this.db;
  }

  /** v16: seal / open a capture event's output exactly like a note body (null envelope = plaintext store). */
  sealCapture(plain: string, aad: string): { text: string; enc: string | null } {
    const s = this.sealBody(plain, aad);
    return { text: s.body, enc: s.bodyEnc };
  }

  openCapture(text: string, enc: string | null, aad: string): string {
    return enc ? decryptIfEncrypted(enc, this.readKey(), aad) : text;
  }

  // --- Note history (v15) ---------------------------------------------------

  /**
   * Keep the text of `row` (the note as it is right now, before a write replaces it). Caller holds the write lock, so the copy
   * and the replacement are one transaction. `plain` is the decrypted body. A version that is already kept is not kept twice.
   */
  private recordHistory(row: NoteRow, plain: string, savedBy: string, reason: string, now: string): void {
    const lim = historyLimits();
    if (lim.versions === 0) return;
    const bytes = Buffer.byteLength(row.title) + Buffer.byteLength(plain);
    const res = this.db
      .prepare(
        `INSERT OR IGNORE INTO note_history (note_id, version, title, body, body_enc, tags, source, written_by, merged_from, confidence, saved_at, saved_by, reason, bytes)
         VALUES (?, ?, ?, '', NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(row.id, row.rev ?? 1, row.title, row.tags ?? "", row.source ?? "", row.written_by ?? "", row.merged_from_writers ?? "", typeof row.confidence === "number" ? row.confidence : null, now, savedBy, reason, bytes);
    if (Number(res.changes) === 0) return;
    const hid = Number(res.lastInsertRowid);
    const sealed = this.sealBody(plain, historyAad(hid));
    this.db.prepare("UPDATE note_history SET body = ?, body_enc = ? WHERE hid = ?").run(sealed.body, sealed.bodyEnc, hid);
    this.pruneHistory(row.id, lim);
  }

  /**
   * Keep one note's history inside its limits (versions and bytes) so a flood of edits cannot grow the file without end, and
   * so a flood cannot push out the one version worth recovering. The rule, in order:
   *   1. the OLDEST version is never dropped (it is the original);
   *   2. a version is dropped first when the same writer also has a NEWER version kept (so the newest text of every writer stays);
   *   3. otherwise the oldest remaining version goes.
   * One writer repeating edits therefore only ever eats its own older copies.
   */
  private pruneHistory(noteId: number, lim = historyLimits()): void {
    const rows = this.db
      .prepare("SELECT hid, version, written_by, claimed_writer, bytes FROM note_history WHERE note_id = ? ORDER BY version ASC")
      .all(noteId) as Array<{ hid: number; version: number; written_by: string; claimed_writer: string; bytes: number }>;
    const del = this.db.prepare("DELETE FROM note_history WHERE hid = ?");
    const who = (r: { written_by: string; claimed_writer: string }): string => r.written_by || `claim:${r.claimed_writer}`;
    let total = rows.reduce((n, r) => n + r.bytes, 0);
    while (rows.length > 1 && (rows.length > lim.versions || total > lim.bytes)) {
      let victim = -1;
      for (let i = 1; i < rows.length && victim < 0; i++) {
        const w = who(rows[i]);
        for (let j = i + 1; j < rows.length; j++) {
          if (who(rows[j]) === w) {
            victim = i;
            break;
          }
        }
      }
      if (victim < 0) victim = 1;
      del.run(rows[victim].hid);
      total -= rows[victim].bytes;
      rows.splice(victim, 1);
    }
  }

  private historyRowToEntry(r: Record<string, unknown>): HistoryEntry {
    let body = String(r.body ?? "");
    if (typeof r.body_enc === "string" && r.body_enc) {
      try {
        body = decryptIfEncrypted(r.body_enc, this.readKey(), historyAad(Number(r.hid)));
      } catch (e) {
        throw new NoteUnreadableError(Number(r.note_id), `its saved version ${r.version}: ${(e as Error).message}`);
      }
    }
    return {
      version: Number(r.version),
      title: String(r.title),
      body,
      tags: parseTags(String(r.tags ?? "")),
      written_by: String(r.written_by ?? ""),
      ...(r.claimed_writer ? { claimed_writer: String(r.claimed_writer) } : {}),
      ...(Number(r.imported ?? 0) === 1 ? { imported: true as const } : {}),
      merged_from: parseMerged(String(r.merged_from ?? "")),
      source: String(r.source ?? ""),
      ...(typeof r.confidence === "number" ? { confidence: r.confidence } : {}),
      saved_at: String(r.saved_at),
      saved_by: String(r.saved_by ?? ""),
      reason: String(r.reason ?? "update"),
      bytes: Number(r.bytes ?? 0),
    };
  }

  /** Earlier versions of a note, newest first (the current text is the note itself). No policy: callers gate it. */
  historyOf(noteId: number): HistoryEntry[] {
    const rows = this.db.prepare("SELECT * FROM note_history WHERE note_id = ? ORDER BY version DESC").all(noteId) as Array<Record<string, unknown>>;
    return rows.map((r) => this.historyRowToEntry(r));
  }

  historyCount(noteId: number): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS c FROM note_history WHERE note_id = ?").get(noteId) as { c: number }).c);
  }

  /** One kept version, or null. */
  historyVersion(noteId: number, version: number): HistoryEntry | null {
    const r = this.db.prepare("SELECT * FROM note_history WHERE note_id = ? AND version = ?").get(noteId, version) as Record<string, unknown> | undefined;
    return r ? this.historyRowToEntry(r) : null;
  }

  /** Forget every kept version of a note (the note itself is untouched). Returns how many were removed. */
  purgeHistory(noteId: number): number {
    this.db.exec("PRAGMA secure_delete = ON");
    const res = this.db.prepare("DELETE FROM note_history WHERE note_id = ?").run(noteId);
    const n = Number(res.changes ?? 0);
    if (n > 0) audit({ op: "history-purge", id: noteId, bytes: n });
    return n;
  }

  /**
   * Put an earlier version's title and body back as a NEW version. Nothing is overwritten: the text being replaced is kept in
   * the history like any other edit, and the restoring writer becomes the note's writer. Names the entry's writers as touching
   * the text, so restoring something a distrusted writer wrote does not launder it.
   */
  restoreVersion(noteId: number, version: number, opts: { ifRev?: number; writtenBy?: string } = {}): NoteRecord | null {
    const entry = this.historyVersion(noteId, version);
    if (!entry) throw new ValidationError(`note ${noteId} has no saved version ${version}`);
    const touched = [entry.written_by, entry.claimed_writer ?? ""].filter((x) => x);
    // The provenance follows the text: a version this server saw being written carries the taint it had then, so putting it back
    // takes the taint of the OVERWRITE away (that is the point of restoring) but never adds trust. An imported entry is only a
    // claim, so it can only ever add names.
    const provenance = entry.imported ? { alsoTouchedBy: touched } : { replaceTaint: [...entry.merged_from, ...touched] };
    return this.update(
      noteId,
      { title: entry.title, body: entry.body },
      { ...(opts.ifRev !== undefined ? { ifRev: opts.ifRev } : {}), ...(opts.writtenBy !== undefined ? { writtenBy: opts.writtenBy } : {}), ...provenance, historyReason: "restore" }
    );
  }

  /**
   * Import path: earlier versions an export carried. Every entry is a CLAIM (the file's writer names are kept as
   * `claimed_writer`, never as `written_by`), size-checked, and bounded by the same limits as live history.
   */
  private importHistory(noteId: number, raw: unknown, savedBy: string): void {
    if (!Array.isArray(raw) || raw.length === 0) return;
    const lim = historyLimits();
    if (lim.versions === 0) return;
    const now = new Date().toISOString();
    const ins = this.db.prepare(
      `INSERT OR IGNORE INTO note_history (note_id, version, title, body, body_enc, tags, source, written_by, claimed_writer, imported, confidence, saved_at, saved_by, reason, bytes)
       VALUES (?, ?, ?, '', NULL, ?, ?, '', ?, 1, ?, ?, ?, 'import', ?)`
    );
    let kept = 0;
    for (const e of raw.slice(0, lim.versions)) {
      if (!e || typeof e !== "object") continue;
      const h = e as Record<string, unknown>;
      if (typeof h.title !== "string" || !h.title.trim() || typeof h.body !== "string") continue;
      const version = Number(h.version);
      if (!Number.isInteger(version) || version < 1) continue;
      const tagsArr = Array.isArray(h.tags) ? h.tags.filter((t): t is string => typeof t === "string") : [];
      if (checkSizes({ title: h.title, body: h.body, tags: tagsArr })) continue;
      // An old version from a file passes the same checker a new write would: what would be refused or held is left out.
      try {
        if (applyLintPolicy(lintFor({ title: h.title, body: h.body, tags: tagsArr }, "full"), { lintWarnings: [] }) === "quarantine") continue;
      } catch {
        continue;
      }
      const claimed = cleanWriter(h.claimed_writer) || cleanWriter(h.written_by);
      const when = isoOrNull(h.saved_at) ?? now;
      const conf = typeof h.confidence === "number" && h.confidence >= 0 && h.confidence <= 1 ? h.confidence : null;
      const bytes = Buffer.byteLength(h.title) + Buffer.byteLength(h.body);
      const res = ins.run(noteId, version, h.title, tagsToStorage(tagsArr), typeof h.source === "string" ? h.source.slice(0, 200) : "", claimed, conf, when, savedBy, bytes);
      if (Number(res.changes) === 0) continue;
      const hid = Number(res.lastInsertRowid);
      const sealed = this.sealBody(h.body, historyAad(hid));
      this.db.prepare("UPDATE note_history SET body = ?, body_enc = ? WHERE hid = ?").run(sealed.body, sealed.bodyEnc, hid);
      kept++;
    }
    if (kept > 0) this.pruneHistory(noteId, lim);
  }

  /** Seal every still-plaintext history body (caller holds the write lock; `encrypt enable`). */
  private sealHistory(key: Buffer): void {
    const rows = this.db.prepare("SELECT hid, body FROM note_history WHERE body_enc IS NULL AND body <> ''").all() as Array<{ hid: number; body: string }>;
    const upd = this.db.prepare("UPDATE note_history SET body = '', body_enc = ? WHERE hid = ?");
    for (const r of rows) upd.run(encrypt(r.body, key, historyAad(r.hid)), r.hid);
  }

  /** Inverse of sealHistory (caller holds the write lock; `encrypt disable`). */
  private unsealHistory(key: Buffer): void {
    const rows = this.db.prepare("SELECT hid, body_enc FROM note_history WHERE body_enc IS NOT NULL").all() as Array<{ hid: number; body_enc: string }>;
    const upd = this.db.prepare("UPDATE note_history SET body = ?, body_enc = NULL WHERE hid = ?");
    for (const r of rows) upd.run(decryptIfEncrypted(r.body_enc, key, historyAad(r.hid)), r.hid);
  }

  // --- Supersede (v15) ------------------------------------------------------

  /**
   * What the write-time linter would say about this text, without storing or holding anything: "ok", "held" (it would wait
   * for admin review) or a ValidationError (it would be refused). Lets a preview tell the truth before a token is issued.
   */
  lintDryRun(input: { title: string; body?: string; tags?: string[] }): { status: "ok" | "held"; findings: LintFinding[] } {
    const findings = lintFor(input, "full");
    const warnings: LintFinding[] = [];
    const verdict = applyLintPolicy(findings, { lintWarnings: warnings });
    return { status: verdict === "quarantine" ? "held" : "ok", findings };
  }

  /**
   * Retire `oldIds` in favour of note `newId`, atomically. THE only code path that sets `superseded_by`; it does no policy
   * (who may, whether a token was shown) -- supersede.ts does, and nothing else calls this. Re-checks every fact under the
   * write lock, so a note that changed between the preview and now makes the whole thing fail with nothing changed.
   */
  supersedeCommit(input: {
    oldIds: number[];
    oldRevs: number[];
    newId: number;
    newRev?: number;
    actor: string;
    nonce: string;
    expiresMs: number;
    flags?: string;
  }): { retired: number[] } {
    const now = new Date().toISOString();
    // Inside a caller's transaction (confirm creates the replacing note in the same one) a SAVEPOINT keeps this all-or-nothing.
    const nested = this.db.isTransaction;
    this.db.exec(nested ? "SAVEPOINT onememory_supersede" : "BEGIN IMMEDIATE");
    try {
      // Single use: a nonce that was already spent makes the whole call fail. Spent nonces are kept past their expiry.
      this.db.prepare("DELETE FROM supersede_used WHERE expires_ms < ?").run(Date.now() - 86_400_000);
      const spent = this.db.prepare("INSERT OR IGNORE INTO supersede_used (nonce, used_at, expires_ms) VALUES (?, ?, ?)").run(input.nonce, now, input.expiresMs);
      if (Number(spent.changes) === 0) throw new ValidationError("this confirmation was already used; start again with a new preview");
      const target = this.db.prepare("SELECT id, namespace, rev, archived_at, superseded_by FROM notes WHERE id = ?").get(input.newId) as
        | { id: number; namespace: string; rev: number; archived_at: string | null; superseded_by: number | null }
        | undefined;
      if (!target || target.archived_at !== null || target.superseded_by !== null) throw new ValidationError("the replacing note is no longer a live note; nothing was changed");
      if (input.newRev !== undefined && target.rev !== input.newRev) throw new StaleWriteError("the replacing note was edited after the preview; nothing was changed");
      const upd = this.db.prepare(
        `UPDATE notes SET archived_at = ?, superseded_by = ?, superseded_at = ?, superseded_by_writer = ?, rev = rev + 1
         WHERE id = ? AND rev = ? AND archived_at IS NULL AND superseded_by IS NULL AND namespace = ?`
      );
      const log = this.db.prepare("INSERT INTO supersede_log (at, actor, action, namespace, old_id, new_id, flags) VALUES (?, ?, 'supersede', ?, ?, ?, ?)");
      input.oldIds.forEach((oid, i) => {
        if (oid === input.newId) throw new ValidationError("a note cannot replace itself");
        const res = upd.run(now, input.newId, now, input.actor, oid, input.oldRevs[i], target.namespace);
        if (Number(res.changes) === 0) {
          throw new StaleWriteError(`note ${oid} changed (or was retired, moved or removed) after the preview; nothing was changed`);
        }
        log.run(now, input.actor, target.namespace, oid, input.newId, input.flags ?? "");
      });
      this.db.exec(nested ? "RELEASE onememory_supersede" : "COMMIT");
    } catch (e) {
      try {
        if (nested) {
          this.db.exec("ROLLBACK TO onememory_supersede");
          this.db.exec("RELEASE onememory_supersede");
        } else this.db.exec("ROLLBACK");
      } catch {
        /* already rolled back */
      }
      throw e;
    }
    this.edgeIndexes.clear();
    if (!nested) this.announceChange();
    audit({ op: "supersede", id: input.newId, namespace: "", bytes: input.oldIds.length });
    return { retired: input.oldIds };
  }

  /** Bring a retired note back (the replacement is NOT touched). Safe: it only restores, and it is logged. */
  supersedeUndo(id: number, actor: string): NoteRecord | null {
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare("SELECT namespace, superseded_by FROM notes WHERE id = ? AND superseded_by IS NOT NULL").get(id) as
        | { namespace: string; superseded_by: number }
        | undefined;
      if (!row) {
        this.db.exec("ROLLBACK");
        return null;
      }
      this.db
        .prepare("UPDATE notes SET archived_at = NULL, superseded_by = NULL, superseded_at = NULL, superseded_by_writer = '', rev = rev + 1 WHERE id = ?")
        .run(id);
      this.db
        .prepare("INSERT INTO supersede_log (at, actor, action, namespace, old_id, new_id, flags) VALUES (?, ?, 'undo', ?, ?, ?, '')")
        .run(now, actor, row.namespace, id, row.superseded_by);
      this.db.exec("COMMIT");
    } catch (e) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* already rolled back */
      }
      throw e;
    }
    this.edgeIndexes.clear();
    this.announceChange();
    audit({ op: "supersede-undo", id, namespace: "", bytes: 0 });
    return this.read(id);
  }

  /** Recent replacements and undos in the given namespaces (audit view; no note text). */
  supersedeLog(namespaces: string[] | undefined, limit = 50): Array<{ at: string; actor: string; action: string; namespace: string; old_id: number; new_id: number | null; flags: string }> {
    if (namespaces && namespaces.length === 0) return [];
    const where = namespaces ? `WHERE namespace IN (${namespaces.map(() => "?").join(",")})` : "";
    return this.db
      .prepare(`SELECT at, actor, action, namespace, old_id, new_id, flags FROM supersede_log ${where} ORDER BY seq DESC LIMIT ?`)
      .all(...(namespaces ?? []), clampInt(limit, 50, 1, 500)) as unknown as Array<{ at: string; actor: string; action: string; namespace: string; old_id: number; new_id: number | null; flags: string }>;
  }

  /** Ids of this note's close neighbours in the similarity graph (same namespace by construction). */
  neighbourIds(id: number): Set<number> {
    const rows = this.db.prepare("SELECT neighbor_id FROM note_edges WHERE note_id = ?").all(id) as Array<{ neighbor_id: number }>;
    return new Set(rows.map((r) => r.neighbor_id));
  }

  /** How many other notes are close neighbours of this one in the similarity graph (a rough "what points at it"). */
  neighbourCount(id: number): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS c FROM note_edges WHERE note_id = ?").get(id) as { c: number }).c);
  }

  /** Live notes that name this note as a task parent / blocker (by the reserved task tags). Cheap tag scan, namespace-bound. */
  taskDependents(id: number, namespace: string): number {
    const rows = this.db
      .prepare("SELECT COUNT(*) AS c FROM notes WHERE namespace = ? AND archived_at IS NULL AND (instr(tags, ?) > 0 OR instr(tags, ?) > 0)")
      .get(namespace, JSON.stringify(`task.parent:${id}`), JSON.stringify(`task.blocked_by:${id}`)) as { c: number };
    return Number(rows.c);
  }

  /** A confirmation token's spent state, for tests and the preview text. */
  tokenSpent(nonce: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM supersede_used WHERE nonce = ?").get(nonce));
  }

  /** Notes that were retired in favour of this one (labelled in listings). */
  supersededBy(id: number): number[] {
    return (this.db.prepare("SELECT id FROM notes WHERE superseded_by = ? ORDER BY id").all(id) as Array<{ id: number }>).map((r) => r.id);
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
    const cur = this.db.prepare("SELECT superseded_by FROM notes WHERE id = ?").get(id) as { superseded_by: number | null } | undefined;
    if (cur && cur.superseded_by !== null) {
      throw new ValidationError(`note ${id} was replaced by note ${cur.superseded_by}; use "supersede undo" to bring it back (a plain restore would hide that it was replaced)`);
    }
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
      this.sealHistory(key);
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
      this.unsealHistory(key);
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
      /** Also notes retired by a confirmed replacement (always labelled). */
      includeSuperseded?: boolean;
      /** Only the retired (superseded) notes. */
      supersededOnly?: boolean;
      /** Only notes carrying ALL of these exact tags. */
      withTags?: string[];
      /** Only notes carrying NONE of these exact tags. */
      withoutTags?: string[];
      /** Only notes with at least one tag starting with this prefix. */
      withTagPrefix?: string;
      /** v16: newest-created first or oldest-created first, instead of last-updated first (timelines). */
      order?: "created_desc" | "created_asc";
    } & RangeOpts = {}
  ): {
    notes: NoteRecord[];
    total: number;
  } {
    const limit = clampInt(opts.limit, 50, 1, 500);
    const offset = clampInt(opts.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    const range = this.rangeFor(opts, opts.namespaces ?? (opts.namespace ? [opts.namespace] : undefined));
    const tagF = tagClause(opts.withTags, opts.withoutTags, opts.withTagPrefix);
    // Archived filter: default hides archived; archivedOnly inverts it.
    const archSql = archivedClause(opts.includeArchived, opts.archivedOnly, opts.includeSuperseded, opts.supersededOnly);
    const extra = [...range.params, ...tagF.params];
    // SQL LIKE is only a prefilter (tags are a JSON array string); the exact
    // match is re-checked below so a tag never matches inside another value.
    const exact = (r: NoteRow): boolean => tagsMatch(r.tags, opts.withTags, opts.withoutTags, opts.withTagPrefix);
    const orderSql = opts.order === "created_asc" ? "created_at ASC, id ASC" : opts.order === "created_desc" ? "created_at DESC, id DESC" : "updated_at DESC, id DESC";

    let rows: NoteRow[];
    let total: number;

    if (opts.namespaces) {
      if (opts.namespaces.length === 0) return { notes: [], total: 0 };
      const inList = `namespace IN (${opts.namespaces.map(() => "?").join(",")})`;
      rows = this.db
        .prepare(
          `SELECT * FROM notes WHERE ${inList}${archSql}${range.sql}${tagF.sql} ORDER BY ${orderSql} LIMIT ? OFFSET ?`
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
          `SELECT * FROM notes WHERE namespace = ?${archSql}${range.sql}${tagF.sql} ORDER BY ${orderSql} LIMIT ? OFFSET ?`
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
          `SELECT * FROM notes WHERE 1 = 1${archSql}${range.sql}${tagF.sql} ORDER BY ${orderSql} LIMIT ? OFFSET ?`
        )
        .all(...extra, limit, offset) as unknown as NoteRow[];
      total = (
        this.db.prepare(`SELECT COUNT(*) as c FROM notes WHERE 1 = 1${archSql}${range.sql}${tagF.sql}`).get(...extra) as { c: number }
      ).c;
    }

    const out = rows.filter(exact).map((r) => this.rec(r));
    return { notes: opts.includeDistrusted ? this.markDistrusted(out) : out, total };
  }

  /**
   * Is there at least one live note carrying all `withTags` and a tag that
   * starts with `withTagPrefix`, in `namespaces` (undefined = every namespace,
   * [] = none)? One cheap LIMIT 1 probe: lets a caller skip a heavier scan when
   * the answer is "nothing". Notes from distrusted writers are not counted
   * unless `includeDistrusted`. (A true can still be a false alarm for an
   * unusual tag, never a false false.)
   */
  hasTagged(opts: { namespaces?: string[]; withTags?: string[]; withTagPrefix?: string; includeDistrusted?: boolean }): boolean {
    if (opts.namespaces && opts.namespaces.length === 0) return false;
    const tagF = tagClause(opts.withTags, undefined, opts.withTagPrefix);
    const range = this.rangeFor({ includeDistrusted: opts.includeDistrusted }, opts.namespaces);
    const nsSql = opts.namespaces ? ` AND namespace IN (${opts.namespaces.map(() => "?").join(",")})` : "";
    const row = this.db
      .prepare(`SELECT 1 AS x FROM notes WHERE archived_at IS NULL${nsSql}${range.sql}${tagF.sql} LIMIT 1`)
      .get(...(opts.namespaces ?? []), ...range.params, ...tagF.params);
    return row !== undefined;
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
    const range = this.rangeFor(opts, opts.namespace ? [opts.namespace] : undefined);

    try {
      let rows: Array<NoteRow & { score: number }>;
      if (opts.namespace) {
        rows = this.db
          .prepare(
            `SELECT notes.*, -rank AS score FROM notes_fts
             JOIN notes ON notes.id = notes_fts.rowid
             WHERE notes_fts MATCH ? AND notes.namespace = ? AND ${liveSql(opts.includeSuperseded)}${range.sql}
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
             WHERE notes_fts MATCH ? AND ${liveSql(opts.includeSuperseded)}${range.sql}
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
      /** Add each note's detached attestation (signed by this server's key; see attest.ts). */
      attest?: boolean;
      /** Add each note's kept earlier versions as `history` (a full backup wants them; not signed). */
      history?: boolean;
    } = {}
  ): Array<NoteRecord & { attestation?: Attestation; history?: HistoryEntry[] }> {
    const lim = clampInt(limit, 500, 1, 5_000);
    const ns = opts.namespaces;
    if (ns && ns.length === 0) return [];
    const nsSql = ns ? ` AND namespace IN (${ns.map(() => "?").join(",")})` : "";
    const rows = this.db
      .prepare(`SELECT * FROM notes WHERE id > ?${nsSql} ORDER BY id ASC LIMIT ?`)
      .all(afterId, ...(ns ?? []), lim) as unknown as NoteRow[];
    const key = opts.attest ? this.signing() : null;
    const sid = key ? this.serverId() : "";
    const exportedAt = new Date().toISOString();
    const sealed = (n: NoteRecord): NoteRecord & { attestation?: Attestation; history?: HistoryEntry[] } => {
      const signed = key ? { ...n, attestation: signRecord(key, sid, n, exportedAt) } : n;
      if (!opts.history) return signed;
      const h = this.historyOf(n.id);
      return h.length ? { ...signed, history: h } : signed;
    };
    return rows.map((r) => {
      if (!opts.skipUnreadable) return sealed(this.rec(r));
      try {
        return sealed(this.rec(r));
      } catch (e) {
        if (!(e instanceof NoteUnreadableError)) throw e;
        const marker = { ...annotateRetention(r, rowToRecord(r, this.serverIdValue)), unreadable: true as const } as Partial<NoteRecord>;
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
      /**
       * Reject every note that does not come with an attestation that verifies against a trusted key (default:
       * ONEMEMORY_IMPORT_REQUIRE_ATTESTATION=1, else off, so plain 1.3.x-style backups keep importing). Without it such
       * notes are imported, flagged `imported_unverified`.
       */
      requireAttestation?: boolean;
    } = {}
  ): Promise<NoteRecord[]> {
    const created: NoteRecord[] = [];
    // exporter id -> id here, for the notes of this file: a replaced note's link is re-pointed after the whole file is in.
    const idMap = new Map<number, number>();
    const retired: Array<{ exportId: number; target: number; at?: string }> = [];
    const importer = currentWriter();
    const requireAttestation = opts.requireAttestation ?? ["1", "true", "yes"].includes((process.env.ONEMEMORY_IMPORT_REQUIRE_ATTESTATION ?? "").trim().toLowerCase());
    // Attestations: checked against the keys the admin trusts (plus this
    // server's own key for its own server id). Counted into the report.
    const trusted = this.trustedAttesters();
    let ownCache: { keyId: string; publicKey: string; serverId: string } | null | undefined;
    const ownKey = (): { keyId: string; publicKey: string; serverId: string } | null => {
      // Verification needs only PUBLIC keys. This server's own key is looked up
      // (never created, never required): a corrupt .attest-key or an unwritable
      // data dir must not fail a restore; it just means our own old exports
      // cannot be recognised as ours (they import as unverified, claims kept).
      if (ownCache === undefined) {
        try {
          const k = this.dbPath === ":memory:" ? this.signingKey : peekSigningKey(this.keyDir); // the file, not a cached key: a rotation may have replaced it
          ownCache = k ? { keyId: k.keyId, publicKey: k.publicKey, serverId: this.serverId() } : null;
        } catch {
          ownCache = null;
        }
      }
      return ownCache;
    };
    const verifyCtx: VerifyContext = { serverId: this.serverId(), revoked: this.revokedKeys(), minVersion: attestMinVersion(), now: Date.now() };
    const att: AttestationReport = { verified: 0, unverified: 0, reasons: {}, untrusted_keys: [] };
    if (opts.report) opts.report.attestations = att;
    const untrustedSeen = new Map<string, { key_id: string; server_id: string; notes: number }>();
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
          if (!note || typeof note !== "object") continue;
          if (note.title !== undefined && note.title !== null && typeof note.title !== "string") {
            opts.report?.rejected.push({ title: String(typeof note.title).slice(0, 40), error: "title must be text" });
            continue;
          }
          if (!note.title || !note.title.trim()) continue;
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
            // A verified attestation lets the original writer be kept as
            // `attested_writer`; anything else is imported exactly as before.
            const verdict = this.verifyImported(note, trusted, ownKey, verifyCtx);
            if (requireAttestation && !verdict.ok) {
              att.unverified++;
              att.reasons[verdict.reason] = (att.reasons[verdict.reason] ?? 0) + 1;
              opts.report?.rejected.push({
                title: note.title,
                error: `no verified attestation (${verdict.reason}); import attestation is required (--require-attestation / ONEMEMORY_IMPORT_REQUIRE_ATTESTATION)`,
              });
              continue;
            }
            const carried = verdict.ok ? this.attestedProvenance(note, verdict.attester.server_id) : null;
            const madeNote = this.create(
                {
                  namespace: note.namespace,
                  title: note.title,
                  body: note.body,
                  tags: note.tags,
                  source: note.source, // preserve provenance across export -> import
                  created_at: note.created_at,
                  // A confidence value is a claim; an unusable one is dropped, it never fails the note.
                  ...(typeof note.confidence === "number" && note.confidence >= 0 && note.confidence <= 1 ? { confidence: note.confidence } : {}),
                },
                {
                  // written_by / created_by are the IMPORTING caller (a payload
                  // cannot forge them). What the payload said stays visible, in
                  // its own clearly-labelled field, as an unverified claim.
                  importedWrittenBy:
                    cleanWriter(note.imported_written_by) || cleanWriter(note.written_by) || undefined,
                  importedCreatedBy: cleanWriter(note.imported_created_by) || cleanWriter(note.created_by) || undefined,
                  ...(verdict.ok ? {} : { importedUnverified: true }),
                  ...(carried
                    ? { attestedWriter: carried.writer, attestedBy: carried.by, mergedFromWriters: carried.merged }
                    : { mergedFromWriters: this.claimedTaint(note) }),
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
              );
            created.push(madeNote);
            if (typeof note.id === "number") idMap.set(note.id, madeNote.id);
            if (typeof note.superseded_by === "number" && note.archived_at) {
              retired.push({ exportId: note.id as number, target: note.superseded_by, ...(typeof note.superseded_at === "string" ? { at: note.superseded_at } : {}) });
            }
            this.importHistory(madeNote.id, note.history, importer);
            if (verdict.ok) att.verified++;
            else {
              att.unverified++;
              att.reasons[verdict.reason] = (att.reasons[verdict.reason] ?? 0) + 1;
              if (verdict.reason === "attester key not trusted" && verdict.key_id) {
                const k = `${verdict.key_id}|${verdict.server_id ?? ""}`;
                const seen = untrustedSeen.get(k) ?? { key_id: verdict.key_id, server_id: verdict.server_id ?? "", notes: 0 };
                seen.notes++;
                untrustedSeen.set(k, seen);
              }
            }
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
    // Re-point replaced notes at the replacement NOW in this store. A link to a note that is not in this file is dropped
    // (the note stays archived, a plain restore brings it back): an id from another store means nothing here.
    if (retired.length > 0) {
      const link = this.db.prepare("UPDATE notes SET superseded_by = ?, superseded_at = ?, superseded_by_writer = ? WHERE id = ? AND archived_at IS NOT NULL AND superseded_by IS NULL");
      this.transaction(() => {
        for (const r of retired) {
          const mine = idMap.get(r.exportId);
          const target = idMap.get(r.target);
          if (mine === undefined || target === undefined || mine === target) continue;
          link.run(target, isoOrNull(r.at) ?? new Date().toISOString(), importer, mine);
        }
      });
      this.edgeIndexes.clear();
    }
    if (!opts.deferEdges) await this.linkNotes(created);
    att.untrusted_keys = [...untrustedSeen.values()];
    return created;
  }

  /** Check one imported note's attestation (against the payload as received). */
  private verifyImported(
    note: ImportNote,
    trusted: ReadonlyMap<string, TrustedAttester>,
    own: () => { keyId: string; publicKey: string; serverId: string } | null,
    ctx: VerifyContext
  ): ReturnType<typeof verifyRecord> {
    const tags = Array.isArray(note.tags) ? note.tags : [];
    if (note.attestation === undefined || note.attestation === null) return { ok: false, reason: "no attestation" };
    if (typeof note.id !== "number" || typeof note.title !== "string") return { ok: false, reason: "malformed attestation" };
    return verifyRecord(
      note.attestation,
      {
        id: note.id,
        namespace: typeof note.namespace === "string" ? note.namespace : "",
        title: note.title,
        body: typeof note.body === "string" ? note.body : "",
        tags,
        written_by: typeof note.written_by === "string" ? note.written_by : "",
        created_by: typeof note.created_by === "string" ? note.created_by : "",
        updated_at: typeof note.updated_at === "string" ? note.updated_at : "",
        attested_writer: typeof note.attested_writer === "string" ? note.attested_writer : "",
        attested_by: typeof note.attested_by === "string" ? note.attested_by : "",
        merged_from_writers: Array.isArray(note.merged_from_writers) ? note.merged_from_writers.filter((x) => typeof x === "string") : [],
        created_at: typeof note.created_at === "string" ? note.created_at : "",
        source: typeof note.source === "string" ? note.source : "",
        expires_at: typeof note.expires_at === "string" ? note.expires_at : null,
        archived_at: typeof note.archived_at === "string" ? note.archived_at : null,
        rev: typeof note.rev === "number" ? note.rev : 0,
      },
      trusted,
      own,
      ctx
    );
  }

  /**
   * Writers an UNVERIFIED import file names (its written_by / created_by, the
   * claims an earlier import kept, an attested writer and its merged list). A
   * claim cannot prove who wrote a note, but it can only ADD taint: these names
   * go into merged_from_writers, so stripping an attestation (or losing the key
   * that signed it) cannot launder a distrusted writer's text into a trusted
   * note. Capped, so a hostile file cannot bloat the column.
   */
  private claimedTaint(note: ImportNote): string[] {
    const out = new Set<string>();
    const add = (x: unknown): void => {
      const c = cleanWriter(x);
      if (c) out.add(c);
    };
    add(note.written_by);
    add(note.created_by);
    add(note.imported_written_by);
    add(note.imported_created_by);
    if (note.attested_writer) {
      add(note.attested_writer);
      if (note.attested_by) add(`${cleanWriter(note.attested_by)}/${cleanWriter(note.attested_writer)}`);
    }
    if (Array.isArray(note.merged_from_writers)) for (const w of note.merged_from_writers.slice(0, MAX_TAINT_NAMES)) add(w);
    return [...out].slice(0, MAX_TAINT_NAMES);
  }

  /**
   * What a verified attestation lets the import keep: the attester's own
   * `written_by` for the note becomes `attested_writer`, and everything the
   * attester said about earlier hops (its own attested writer, its merged
   * sources) is kept as merged_from_writers, so distrust still follows the
   * content through a chain of servers.
   */
  private attestedProvenance(note: ImportNote, attesterId: string): { writer: string; by: string; merged: string[] } | null {
    const writer = cleanWriter(note.written_by);
    const merged = new Set<string>(Array.isArray(note.merged_from_writers) ? note.merged_from_writers.map((x) => cleanWriter(x)) : []);
    const prevW = cleanWriter(note.attested_writer);
    const prevBy = cleanWriter(note.attested_by);
    if (prevW && prevBy) {
      merged.add(prevW);
      merged.add(`${prevBy}/${prevW}`);
    }
    merged.delete("");
    if (!writer) return merged.size ? { writer: "", by: "", merged: [...merged] } : null;
    return { writer, by: attesterId, merged: [...merged] };
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
    const range = this.rangeFor(opts, opts.namespace ? [opts.namespace] : undefined);

    const rows = (
      opts.namespace
        ? this.db
            .prepare(
              `SELECT v.note_id, v.dim, v.model, v.vec FROM note_vectors v
               JOIN notes ON notes.id = v.note_id
               WHERE notes.namespace = ? AND ${liveSql(opts.includeSuperseded)}${range.sql}`
            )
            .all(opts.namespace, ...range.params)
        : this.db
            .prepare(
              `SELECT v.note_id, v.dim, v.model, v.vec FROM note_vectors v
               JOIN notes ON notes.id = v.note_id
               WHERE ${liveSql(opts.includeSuperseded)}${range.sql}`
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
  listNeighbors(id: number, limit = EDGE_NEIGHBOR_LIMIT, includeDistrusted = false): NeighborEntry[] {
    // A neighbor is in the same namespace as the note, so only that namespace's rules matter.
    const ns = (this.db.prepare("SELECT namespace FROM notes WHERE id = ?").get(id) as { namespace: string } | undefined)?.namespace;
    const dis = includeDistrusted || ns === undefined
      ? { sql: "", params: [] as string[] }
      : this.distrustFragment(
          { ns: "n.namespace", writer: "n.written_by", attWriter: "n.attested_writer", attBy: "n.attested_by", merged: "n.merged_from_writers" },
          [ns]
        );
    const rows = this.db
      .prepare(
        `SELECT e.neighbor_id AS id, n.title AS title, e.score AS score
         FROM note_edges e
         JOIN notes n ON n.id = e.neighbor_id
         WHERE e.note_id = ?
           AND n.archived_at IS NULL
           AND n.namespace = (SELECT namespace FROM notes WHERE id = ?)${dis.sql}
         ORDER BY e.score DESC, e.neighbor_id ASC
         LIMIT ?`
      )
      .all(id, id, ...dis.params, clampInt(limit, EDGE_NEIGHBOR_LIMIT, 1, 100)) as Array<{
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
    /** EVENT semantics: only changes made by this server-stamped writer (matches each change's own writer). */
    writtenBy?: string;
    /** EVENT semantics: only changes NOT made by this server-stamped writer. */
    notWrittenBy?: string;
    /**
     * NOTE semantics: only notes whose CURRENT last content writer is this
     * (for a deleted note: the writer it had when it was deleted).
     */
    noteWrittenBy?: string;
    /** NOTE semantics: skip notes whose current writer is this. */
    notNoteWrittenBy?: string;
    /** Also show changes to notes whose writer is on the distrust list (marked `distrusted`). */
    includeDistrusted?: boolean;
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
    const scope = feedScopeKey(opts.namespaces, opts.source, opts);
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
    // EVENT filters: each change_log row carries the writer of that event. A
    // foreign writer_id never wrote a local event: "is" matches nothing, "not" nothing.
    const localId = this.serverId();
    let wbSql = "";
    const wbParams: string[] = [];
    if (opts.writtenBy !== undefined) {
      const r = parseWriterRef(opts.writtenBy);
      if (r.serverId && r.serverId !== localId.toLowerCase()) wbSql += " AND 0";
      else {
        wbSql += " AND written_by = ?";
        wbParams.push(r.label);
      }
    }
    if (opts.notWrittenBy !== undefined) {
      const r = parseWriterRef(opts.notWrittenBy);
      if (r.label && (!r.serverId || r.serverId === localId.toLowerCase())) {
        wbSql += " AND written_by <> ?";
        wbParams.push(r.label);
      }
    }
    const exSql = c.x ? " AND (CASE WHEN actor <> '' THEN actor ELSE source END) <> ?" : "";
    const exParams = c.x ? [c.x] : [];
    // One entry per note: its LAST event in the window, kind "deleted" if
    // that event is the delete, else "created" if the note was born in the
    // window, else "updated".
    // The note's CURRENT writer facts: the notes row while the note lives, the
    // delete log row's copy once it is gone. NOTE-semantics filters and the
    // distrust list read these, on the window's LAST event of each note.
    const cur = {
      writer: "COALESCE(n.written_by, e.note_written_by)",
      attWriter: "COALESCE(n.attested_writer, e.note_attested_writer)",
      attBy: "COALESCE(n.attested_by, e.note_attested_by)",
      merged: "COALESCE(n.merged_from_writers, e.note_merged_from)",
    };
    const curCols = { ns: "e.namespace", ...cur };
    const noteParts = [
      ...(opts.noteWrittenBy !== undefined ? [writerFilterSql(curCols, opts.noteWrittenBy, "is", this.serverId())] : []),
      ...(opts.notNoteWrittenBy !== undefined ? [writerFilterSql(curCols, opts.notNoteWrittenBy, "not", this.serverId())] : []),
      // not_written_by on the feed is an EVENT filter (below); a note that the
      // excluded writer merged into or had attested still counts as touched by them.
      ...(opts.notWrittenBy !== undefined ? [writerTaintFilterSql(curCols, opts.notWrittenBy, this.serverId())] : []),
    ];
    const noteSql = noteParts.map((p) => ` AND ${p.sql}`).join("");
    const noteParams = noteParts.flatMap((p) => p.params);
    const rules = this.distrustRules();
    const dis = opts.includeDistrusted
      ? { sql: "", params: [] as string[] }
      : distrustSql(rules, this.serverId(), { ns: "e.namespace", ...cur }, opts.namespaces);
    const eventsSql = `
      WITH ev AS (SELECT seq, note_id, kind FROM change_log
                   WHERE seq > ? AND seq <= ?${nsSql}${srcSql}${wbSql}${exSql}),
           g AS (SELECT note_id, MAX(seq) AS last, MAX(kind = 'created') AS born FROM ev GROUP BY note_id)
      SELECT e.seq AS seq,
             CASE WHEN e.kind = 'deleted' THEN 'deleted' WHEN g.born THEN 'created' ELSE 'updated' END AS kind,
             e.note_id AS id, e.namespace AS namespace, e.title AS title, e.source AS source,
             e.changed_at AS at, e.rev AS rev, e.written_by AS written_by,
             ${cur.writer} AS cur_writer, (n.id IS NOT NULL) AS live,
             ${cur.attWriter} AS cur_att_writer, ${cur.attBy} AS cur_att_by, ${cur.merged} AS cur_merged
        FROM g JOIN change_log e ON e.seq = g.last
        LEFT JOIN notes n ON n.id = e.note_id
       WHERE 1 = 1${noteSql}${dis.sql}`;
    const eventParams = [c.f, c.t, ...nsParams, ...srcParams, ...wbParams, ...exParams, ...noteParams, ...dis.params];

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
      written_by: string | null;
      cur_writer: string | null;
      live: number;
      cur_att_writer: string | null;
      cur_att_by: string | null;
      cur_merged: string | null;
    }>;
    const rows = tail ? rowsRaw.slice(0, tail).reverse() : rowsRaw;
    const more = tail ? false : rows.length > limit;
    const pageRows = rows.slice(0, tail || limit);
    const sid = this.serverId();
    const page = pageRows.map((r): ChangeEntry => {
      const live = Number(r.live) === 1;
      const noteWriter = r.cur_writer ?? "";
      const flagged =
        opts.includeDistrusted === true &&
        rules.length > 0 &&
        matchesDistrust(
          rules,
          { namespace: r.namespace, written_by: noteWriter, attested_writer: r.cur_att_writer ?? "", attested_by: r.cur_att_by ?? "", merged_from_writers: parseMerged(r.cur_merged) },
          sid
        );
      return {
        kind: r.kind,
        id: Number(r.id),
        namespace: r.namespace,
        title: r.title,
        source: r.source ?? "",
        written_by: r.written_by ?? "",
        writer_id: makeWriterId(sid, r.written_by ?? ""),
        // A live note always reports its writer ("" = unknown); a deleted note
        // reports the author recorded when it was deleted (absent for rows
        // deleted before schema v14, which did not record it).
        ...(live || noteWriter ? { note_written_by: noteWriter, note_writer_id: makeWriterId(sid, noteWriter) } : {}),
        ...(flagged ? { distrusted: true as const } : {}),
        at: r.at,
        ...(r.rev === null || r.rev === undefined || r.kind === "deleted" ? {} : { rev: Number(r.rev) }),
      };
    });

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

  // --- Trust layer (v14) -----------------------------------------------------

  /**
   * This database's stable random id: minted once (when the schema is created
   * or upgraded), stored in _meta, copied by a backup, never changed. It is in
   * every export header and in each attestation, and is the first half of a
   * `writer_id`.
   */
  serverId(): string {
    return this.serverIdValue || (this.serverIdValue = this.storeId());
  }

  /** `<server_id>/<label>`: the stable id of a writer on this server ("" for an unknown writer). */
  writerId(label: string): string {
    return makeWriterId(this.serverId(), label);
  }

  /** Who is changing the trust configuration right now, for the log. */
  private trustActor(): string {
    return currentWriter() || currentActor() || "unknown";
  }

  private logTrust(action: string, namespace: string, subject: string): void {
    const actor = this.trustActor();
    this.db
      .prepare("INSERT INTO trust_log (at, actor, action, namespace, subject) VALUES (?, ?, ?, ?, ?)")
      .run(new Date().toISOString(), actor, action, namespace, subject);
    this.pruneTrustLog(namespace);
    audit({ op: `trust.${action}`, namespace, label: actor, kind: "trust", detail: subject.slice(0, 200) });
  }

  /**
   * Bounded per namespace: each namespace keeps its own newest MAX_TRUST_LOG_ROWS rows (the server-wide lines, namespace `*`,
   * their own bucket of MAX_TRUST_LOG_ROWS_GLOBAL), so a pinned admin flooding its own namespace can only push out its own lines,
   * never another admin's or the attester / key-rotation lines. The audit log keeps the full trail.
   */
  private pruneTrustLog(namespace: string): void {
    const keep = namespace === ALL_NAMESPACES ? MAX_TRUST_LOG_ROWS_GLOBAL : MAX_TRUST_LOG_ROWS;
    this.db
      .prepare("DELETE FROM trust_log WHERE namespace = ? AND seq NOT IN (SELECT seq FROM trust_log WHERE namespace = ? ORDER BY seq DESC LIMIT ?)")
      .run(namespace, namespace, keep);
  }

  /** The distrust list (every namespace). Cheap: a tiny table read per query, so a change elsewhere is seen at once. */
  distrustRules(): DistrustRule[] {
    return this.db
      .prepare("SELECT namespace, writer, added_at, added_by FROM trust_distrust ORDER BY namespace, writer")
      .all() as unknown as DistrustRule[];
  }

  /**
   * Put a writer on a namespace's distrust list (`"*"` = every namespace). The
   * writer is a label (`alice`) or a writer_id (`<server_id>/alice`). Admin
   * scope is checked by the caller; the change is logged. Returns the rule.
   */
  distrustAdd(namespace: string, writer: string): DistrustRule {
    const ns = typeof namespace === "string" ? namespace.trim() : "";
    if (!ns) throw new ValidationError('namespace is required (use "*" for every namespace)');
    if (ns.length > 200) throw new ValidationError("namespace is too long");
    const parsed = canonicalRuleWriter(writer);
    if (!parsed.ok) throw new ValidationError(parsed.error);
    const canonical = parsed.writer;
    const addedBy = this.trustActor();
    const at = new Date().toISOString();
    this.transaction(() => {
      const have = this.db.prepare("SELECT 1 FROM trust_distrust WHERE namespace = ? AND writer = ?").get(ns, canonical);
      if (have) return;
      const perNs = Number((this.db.prepare("SELECT COUNT(*) AS c FROM trust_distrust WHERE namespace = ?").get(ns) as { c: number }).c);
      if (perNs >= MAX_DISTRUST_RULES_PER_NAMESPACE) {
        throw new ValidationError(`the distrust list for ${ns === "*" ? "the * bucket" : `namespace ${ns}`} is full (${MAX_DISTRUST_RULES_PER_NAMESPACE} entries); remove one first`);
      }
      const n = Number((this.db.prepare("SELECT COUNT(*) AS c FROM trust_distrust").get() as { c: number }).c);
      if (n >= MAX_DISTRUST_RULES) throw new ValidationError(`the distrust list is full (${MAX_DISTRUST_RULES} entries); remove one first`);
      // Namespace-specific rules may not use the room reserved for the `*` bucket, so ten namespaces
      // (or ten pinned admins) cannot lock the server-wide admin out of adding a `*` rule.
      if (ns !== ALL_NAMESPACES && n >= MAX_DISTRUST_RULES - MAX_DISTRUST_RULES_PER_NAMESPACE) {
        throw new ValidationError(`the distrust list is full for namespace-specific entries (${MAX_DISTRUST_RULES - MAX_DISTRUST_RULES_PER_NAMESPACE}; the rest is kept for "*" entries); remove one first`);
      }
      this.db.prepare("INSERT INTO trust_distrust (namespace, writer, added_at, added_by) VALUES (?, ?, ?, ?)").run(ns, canonical, at, addedBy);
      this.logTrust("distrust", ns, canonical);
    });
    return (this.db.prepare("SELECT namespace, writer, added_at, added_by FROM trust_distrust WHERE namespace = ? AND writer = ?").get(ns, canonical) as unknown) as DistrustRule;
  }

  /** How many stored notes the rule `(namespace, writer)` hides right now (0 usually means a misspelt label). */
  distrustMatchCount(namespace: string, writer: string): number {
    const parsed = canonicalRuleWriter(writer);
    if (!parsed.ok) return 0;
    const rule: DistrustRule = { namespace, writer: parsed.writer, added_at: "", added_by: "" };
    const d = distrustSql([rule], this.serverId(), NOTE_COLUMNS);
    if (!d.sql) return 0;
    const nsSql = namespace === ALL_NAMESPACES ? "" : " AND notes.namespace = ?";
    const nsParams = namespace === ALL_NAMESPACES ? [] : [namespace];
    const all = Number((this.db.prepare(`SELECT COUNT(*) AS c FROM notes WHERE 1 = 1${nsSql}`).get(...nsParams) as { c: number }).c);
    const visible = Number((this.db.prepare(`SELECT COUNT(*) AS c FROM notes WHERE 1 = 1${nsSql}${d.sql}`).get(...nsParams, ...d.params) as { c: number }).c);
    return all - visible;
  }

  /** Take a writer off the list. True if it was there. */
  distrustRemove(namespace: string, writer: string): boolean {
    const ns = typeof namespace === "string" ? namespace.trim() : "";
    const parsed = canonicalRuleWriter(writer);
    if (!ns || !parsed.ok) throw new ValidationError("namespace and writer are required");
    const canonical = parsed.writer;
    let removed = false;
    this.transaction(() => {
      removed = Number(this.db.prepare("DELETE FROM trust_distrust WHERE namespace = ? AND writer = ?").run(ns, canonical).changes) > 0;
      if (removed) this.logTrust("undistrust", ns, canonical);
    });
    return removed;
  }

  /**
   * Recent trust-configuration changes (who changed what), newest first.
   * `pinnedNamespace`: a namespace-pinned admin sees only rule changes for its
   * own namespace (and "*" rules, which apply to it), never attester changes
   * or other tenants' subjects.
   */
  trustLog(limit = 20, pinnedNamespace?: string): Array<{ at: string; actor: string; action: string; namespace: string; subject: string }> {
    const n = clampInt(limit, 20, 1, 200);
    return (
      pinnedNamespace === undefined
        ? this.db.prepare("SELECT at, actor, action, namespace, subject FROM trust_log ORDER BY seq DESC LIMIT ?").all(n)
        : this.db
            .prepare(
              `SELECT at, actor, action, namespace, subject FROM trust_log
               WHERE (namespace = ? OR namespace = '*') AND action NOT LIKE 'attester-%' AND action <> 'key-rotate' ORDER BY seq DESC LIMIT ?`
            )
            .all(pinnedNamespace, n)
    ) as unknown as Array<{ at: string; actor: string; action: string; namespace: string; subject: string }>;
  }

  /**
   * The trust configuration as one admin sees it. Unpinned: everything. Pinned
   * to a namespace: its own rules (plus the "*" rules that apply to it), its own
   * log lines, and NO attester list (that is server-wide).
   */
  trustView(pinnedNamespace?: string): {
    distrust: DistrustRule[];
    attesters: ReturnType<Store["attesterList"]>;
    revoked: ReturnType<Store["revocationList"]>;
    log: ReturnType<Store["trustLog"]>;
  } {
    const pinned = pinnedNamespace !== undefined;
    return {
      distrust: this.distrustRules().filter((r) => !pinned || r.namespace === pinnedNamespace || r.namespace === ALL_NAMESPACES),
      attesters: pinned ? [] : this.attesterList(),
      revoked: pinned ? [] : this.revocationList(),
      log: this.trustLog(20, pinnedNamespace),
    };
  }

  /** Does the distrust list name a writer that touched this note (current writer, attested original, merged sources)? */
  isDistrusted(n: WriterFacts): boolean {
    return matchesDistrust(this.distrustRules(), n, this.serverId());
  }

  /** isDistrusted against rules the caller already loaded (hot loops). */
  isDistrustedWith(rules: readonly DistrustRule[], serverId: string, n: WriterFacts): boolean {
    return matchesDistrust(rules, n, serverId);
  }

  /** Flag (distrusted: true) the notes whose writer is on the list. Used where a read opted in with include_distrusted. */
  markDistrusted<T extends NoteRecord>(notes: T[]): T[] {
    const rules = this.distrustRules();
    if (rules.length === 0) return notes;
    const id = this.serverId();
    return notes.map((n) => (matchesDistrust(rules, n, id) ? { ...n, distrusted: true as const } : n));
  }

  /** The query fragment hiding distrusted rows (empty when the list is empty). */
  private distrustFragment(cols = NOTE_COLUMNS, namespaces?: readonly string[]): { sql: string; params: string[] } {
    return distrustSql(this.distrustRules(), this.serverId(), cols, namespaces);
  }

  /** rangeClause + the distrust exclusion, unless the caller opted in. */
  private rangeFor(opts: RangeOpts, namespaces?: readonly string[]): { sql: string; params: string[] } {
    const r = rangeClause(opts, this.serverId());
    if (opts.includeDistrusted) return r;
    const d = this.distrustFragment(NOTE_COLUMNS, namespaces);
    return d.sql ? { sql: r.sql + d.sql, params: [...r.params, ...d.params] } : r;
  }

  /**
   * The attestation signing key of this database (created on first use; in memory only for `:memory:`).
   * The key file is re-checked (one stat) on every use, so a `trust rotate` run from the CLI takes effect
   * in an already-running server at its next export instead of only after a restart.
   */
  private signing(): SigningKey {
    if (this.dbPath === ":memory:") return (this.signingKey ??= ephemeralKey());
    const stamp = keyFileStamp(this.keyDir);
    if (this.signingKey && stamp !== "" && stamp === this.signingStamp) return this.signingKey;
    const existed = stamp !== "";
    const before = this.signingKey?.keyId;
    // The stamp is taken BEFORE the key is read and that stamp is what gets cached: a rotation landing between the read and
    // a later stat can then never leave the old key cached under the new file's stamp (the next call sees the mismatch and
    // reloads). If the file changed during the read, read again (a couple of times at most).
    let key: SigningKey = loadOrCreateSigningKey(this.keyDir);
    let seen = stamp;
    for (let i = 0; i < 3; i++) {
      const now = keyFileStamp(this.keyDir);
      if (seen === "" || now === seen) {
        seen = seen === "" ? now : seen;
        break;
      }
      seen = now;
      key = loadOrCreateSigningKey(this.keyDir);
    }
    this.signingKey = key;
    this.signingStamp = seen;
    if (before && before !== key.keyId) {
      console.error(`[onememory] the signing key file changed on disk (${before} -> ${key.keyId}); this process now signs with the new key.`);
    }
    this.rememberKey(key, !existed);
    return key;
  }
  private signingStamp = "";
  private signingKeyMintedFor = "";

  /**
   * Remember (in _meta) which key id this database signed with, so a LATER key-less restore can be recognised: the warning
   * "a NEW attestation key was created" fires only when a recorded key id differs from the one just minted, i.e. when a
   * key is provably lost. A database that never had a key (every 1.3.x -> 1.4 upgrade) has no marker and stays quiet.
   */
  private rememberKey(key: SigningKey, minted: boolean): void {
    let prior: string | null = null;
    try {
      prior = this.getMeta("attest_key_id");
    } catch {
      prior = null;
    }
    if (minted && prior && prior !== key.keyId && this.signingKeyMintedFor !== key.keyId) {
      this.signingKeyMintedFor = key.keyId;
      console.error(
        `[onememory] a NEW attestation key was created (${key.keyId}) for the existing server id ${this.serverId()}: this database earlier signed with key ${prior}, ` +
          "whose key file is missing (a restore without it?). Peers that trusted the old key must be given the new one (`onememory trust identity`); " +
          "exports signed by the old key will not verify here unless you add the old PUBLIC key (`onememory trust attester-add <old public key> --server-id " +
          `${this.serverId()}\`). See docs/trust.md.`
      );
    }
    if (prior !== key.keyId) {
      try {
        this.setMeta("attest_key_id", key.keyId);
      } catch {
        /* read-only database: the marker is recorded by the next writer */
      }
    }
  }

  /** server_id + public key + key id: what a peer needs to trust this server's attestations. Never the private key. Creates the key on first use. */
  identity(): { server_id: string; key_id: string; public_key: string; algorithm: "ed25519" } {
    const k = this.signing();
    return { server_id: this.serverId(), key_id: k.keyId, public_key: k.publicKey, algorithm: "ed25519" };
  }

  /** Like identity(), but read-only: the key fields appear only if a key already exists (a listing must not mint one). */
  peekIdentity(): { server_id: string; key_id?: string; public_key?: string; algorithm?: "ed25519" } {
    let k: SigningKey | null;
    if (this.dbPath === ":memory:") k = this.signingKey;
    else {
      const stamp = keyFileStamp(this.keyDir);
      k = this.signingKey && stamp !== "" && stamp === this.signingStamp ? this.signingKey : peekSigningKey(this.keyDir);
      if (k && stamp !== "" && !this.getMeta("attest_key_id")) this.rememberKey(k, false);
    }
    return k ? { server_id: this.serverId(), key_id: k.keyId, public_key: k.publicKey, algorithm: "ed25519" } : { server_id: this.serverId() };
  }

  /**
   * Replace the signing key with a new one (planned rotation, or after a leak). The OLD PUBLIC key is recorded as a
   * trusted key of THIS server (a "retired own key"), so this server keeps recognising the exports it signed before;
   * revoke it (`trust attester-revoke`) if it leaked. The old private key is not kept unless `keepOldPrivate` is set
   * (then it is copied to `<key file>.<old key id>.old`, mode 0600). Running servers pick the new key up at their
   * next signing (the key file is re-checked), so no restart is needed. Returns both ids.
   */
  rotateSigningKey(opts: { keepOldPrivate?: boolean } = {}): { old_key_id: string | null; new_key_id: string; public_key: string; old_key_file: string | null; old_public_key: string | null } {
    if (this.dbPath === ":memory:") throw new ValidationError("an in-memory database has no key file to rotate");
    const p = attestKeyPath(this.keyDir);
    const old = peekSigningKey(this.keyDir);
    if (existsSync(p) && !old) throw new ValidationError(`the attestation key ${p} is unreadable; restore it or move it aside before rotating`);
    const oldFile = old && opts.keepOldPrivate ? `${p}.${old.keyId}.old` : null;
    // Order matters, so no failure can lose the retired PUBLIC key (an attestation carries only the key id, so once the old
    // private key is gone this row is the only way earlier exports can ever be verified again):
    //  1. the retired key is recorded and COMMITTED on its own;
    //  2. only then is the key file swapped (if the swap fails, the old key stays in use and the row is taken back out);
    //  3. the audit line and the key-id marker are written last, in their own transaction; if that fails the rotation still
    //     stands (the key HAS changed) and a warning is printed, instead of an error that would hide it.
    let recordedNow = false;
    if (old) {
      this.transaction(() => {
        const r = this.db
          .prepare(
            `INSERT INTO trust_attesters (key_id, public_key, server_id, label, added_at, added_by, not_after) VALUES (?, ?, ?, ?, ?, ?, '')
             ON CONFLICT(key_id) DO NOTHING`
          )
          .run(old.keyId, old.publicKey, this.serverId(), "retired key of this server", new Date().toISOString(), this.trustActor());
        recordedNow = Number(r.changes) > 0;
      });
    }
    let k!: SigningKey;
    try {
      k = replaceSigningKey(this.keyDir, oldFile ?? undefined);
    } catch (e) {
      if (old && recordedNow) {
        try {
          this.db.prepare("DELETE FROM trust_attesters WHERE key_id = ? AND label = 'retired key of this server'").run(old.keyId);
        } catch {
          /* harmless: the current key listed as trusted */
        }
      }
      throw e;
    }
    this.signingKey = null; // the next use re-reads the file and its stamp
    this.signingStamp = "";
    try {
      this.transaction(() => {
        this.logTrust("key-rotate", "*", `${old?.keyId ?? "-"} -> ${k.keyId}`);
        this.setMeta("attest_key_id", k.keyId);
      });
    } catch (e) {
      console.error(
        `[onememory] the signing key WAS rotated (${old?.keyId ?? "-"} -> ${k.keyId}) and the old public key is recorded, but the audit line could not be written (${(e as Error).message}).`
      );
    }
    return { old_key_id: old?.keyId ?? null, new_key_id: k.keyId, public_key: k.publicKey, old_key_file: oldFile, old_public_key: old?.publicKey ?? null };
  }

  /** Copy the signing key file to `dest` (mode 0600), for moving a server's identity to a new machine. Never overwrites, never writes through a symlink. */
  exportSigningKey(dest: string): { key_id: string; path: string } {
    const k = this.signing(); // make sure it exists
    const src = attestKeyPath(this.keyDir);
    try {
      copyKeyFileExclusive(src, dest);
    } catch (e) {
      if (e instanceof ValidationError) throw e;
      if ((e as { code?: string }).code === "EEXIST_DEST" || (e as { code?: string }).code === "EEXIST") throw new ValidationError(`${dest} already exists; refusing to overwrite it`);
      throw e;
    }
    return { key_id: k.keyId, path: dest };
  }

  /** Header of an export: format, the exporting server and its public key. Throws if the key cannot be created. */
  exportHeader(): { format: "onememory-export"; format_version: 2; exported_at: string; server_id: string; key_id: string; public_key: string; algorithm: "ed25519" } {
    return { format: "onememory-export", format_version: 2, exported_at: new Date().toISOString(), ...this.identity() };
  }

  /** Public keys whose attestations an import will accept: the admin's list plus ONEMEMORY_TRUSTED_ATTESTERS. */
  trustedAttesters(): Map<string, TrustedAttester> {
    const out = new Map<string, TrustedAttester>();
    for (const t of this.envAttesters()) out.set(keyIdOf(t.public_key), t);
    const rows = this.db.prepare("SELECT key_id, public_key, server_id, label, not_after FROM trust_attesters").all() as unknown as Array<{
      key_id: string;
      public_key: string;
      server_id: string;
      label: string;
      not_after: string;
    }>;
    for (const r of rows) out.set(r.key_id, { public_key: r.public_key, server_id: r.server_id, label: r.label, ...(r.not_after ? { not_after: r.not_after } : {}) });
    return out;
  }

  /** ONEMEMORY_TRUSTED_ATTESTERS, parsed; unusable entries (or a variable that yields nothing) are reported loudly, once per value. */
  private envAttesters(): TrustedAttester[] {
    const raw = process.env.ONEMEMORY_TRUSTED_ATTESTERS;
    const r = parseTrustedAttestersEnvDetailed(raw);
    if (raw && raw.trim() && warnedEnvAttesters !== raw) {
      warnedEnvAttesters = raw;
      if (r.attesters.length === 0) {
        console.error(
          "[onememory] WARNING: ONEMEMORY_TRUSTED_ATTESTERS is set but no usable entry was found, so imports will treat every note as unverified. " +
            "Use <server id>=<public key> entries (or a JSON array of {public_key, server_id}); see docs/configuration.md."
        );
      }
      for (const i of r.issues) console.error(`[onememory] WARNING: ONEMEMORY_TRUSTED_ATTESTERS entry ${JSON.stringify(i.entry)} ignored: ${i.problem}`);
    }
    return r.attesters;
  }

  /** The admin-managed trusted attesters (plus the env ones, marked), for listing. */
  attesterList(): Array<{ key_id: string; public_key: string; server_id: string; label: string; source: "admin" | "env"; added_at?: string; added_by?: string; not_after?: string; unpinned?: true }> {
    type Row = { key_id: string; public_key: string; server_id: string; label: string; source: "admin" | "env"; added_at?: string; added_by?: string; not_after?: string; unpinned?: true };
    const rows = this.db
      .prepare("SELECT key_id, public_key, server_id, label, added_at, added_by, not_after FROM trust_attesters ORDER BY added_at")
      .all() as unknown as Array<{ key_id: string; public_key: string; server_id: string; label: string; added_at: string; added_by: string; not_after: string }>;
    const out: Row[] = rows.map((r) => ({
      key_id: r.key_id,
      public_key: r.public_key,
      server_id: r.server_id,
      label: r.label,
      source: "admin" as const,
      added_at: r.added_at,
      added_by: r.added_by,
      ...(r.not_after ? { not_after: r.not_after } : {}),
      ...(r.server_id ? {} : { unpinned: true as const }),
    }));
    const have = new Set(rows.map((r) => r.key_id));
    for (const t of this.envAttesters()) {
      const key_id = keyIdOf(t.public_key);
      if (!have.has(key_id)) out.push({ key_id, public_key: t.public_key, server_id: t.server_id, label: t.label, source: "env", ...(t.not_after ? { not_after: t.not_after } : {}) });
    }
    return out;
  }

  /**
   * Trust a peer's attestation key (EXPERIMENTAL, like all of attestations). A key is trusted for ONE server: `server_id`
   * is required, unless `any_server` is set (discouraged: the key's holder could
   * then claim to be any peer). `not_after` (ISO-8601) ends trust in the key at that time (judged when an import is
   * verified): an expiry, not a revocation; use revokeAttester for a leaked key. Adding a key that is already listed
   * replaces its pin/expiry, and the log line says what changed.
   */
  attesterAdd(input: { public_key: string; server_id?: string; label?: string; any_server?: boolean; not_after?: string }): {
    key_id: string;
    public_key: string;
    server_id: string;
    label: string;
    not_after?: string;
    replaced?: { server_id: string; not_after: string };
  } {
    const key = typeof input.public_key === "string" ? input.public_key.trim() : "";
    if (!isPublicKey(key)) throw new ValidationError("public_key must be the 43-character base64url key printed by `onememory trust identity` on the other server");
    const sid = (input.server_id ?? "").trim().toLowerCase();
    if (sid && !isServerId(sid)) throw new ValidationError("server_id must be a UUID");
    if (!sid && input.any_server !== true) {
      throw new ValidationError(
        "server_id is required: a trusted key speaks for ONE server (use the server_id printed by `onememory trust identity` on that server). " +
          "Pass --any-server (any_server: true over the API) only if you accept that this key's holder could claim to be any peer."
      );
    }
    // A key pinned to THIS server's own id is a "retired own key": the public key this server signed with before a rotation
    // or before a restore that lost its key file. It lets the server recognise its own earlier exports (the same meaning
    // as an ONEMEMORY_TRUSTED_ATTESTERS entry naming this server's id). Only an admin can add one; revoke it if it leaked.
    const notAfter = (input.not_after ?? "").trim();
    if (notAfter && !isIso(notAfter)) throw new ValidationError("not_after must be an ISO-8601 time such as 2027-01-31T00:00:00Z");
    const key_id = keyIdOf(key);
    if (key_id === this.identity().key_id) throw new ValidationError("that is this server's own current key: it is always trusted for this server's own exports");
    if (this.revokedKeys().has(key_id)) throw new ValidationError(`key ${key_id} is on the revocation list; run \`onememory trust attester-unrevoke ${key_id}\` first if you really want to trust it again`);
    const label = cleanWriter(input.label ?? "").slice(0, 100);
    let replaced: { server_id: string; not_after: string } | undefined;
    this.transaction(() => {
      const prev = this.db.prepare("SELECT server_id, not_after FROM trust_attesters WHERE key_id = ?").get(key_id) as { server_id: string; not_after: string } | undefined;
      if (prev && (prev.server_id !== sid || prev.not_after !== notAfter)) replaced = { server_id: prev.server_id, not_after: prev.not_after };
      this.db
        .prepare(
          `INSERT INTO trust_attesters (key_id, public_key, server_id, label, added_at, added_by, not_after) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(key_id) DO UPDATE SET server_id = excluded.server_id, label = excluded.label, not_after = excluded.not_after`
        )
        .run(key_id, key, sid, label, new Date().toISOString(), this.trustActor(), notAfter);
      this.logTrust(
        "attester-add",
        "*",
        `${key_id}${sid ? ` server=${sid}` : " ANY-SERVER"}${notAfter ? ` not_after=${notAfter}` : ""}${label ? ` label=${label}` : ""}` +
          (replaced ? ` (replaced pin=${replaced.server_id || "any"} not_after=${replaced.not_after || "none"})` : "")
      );
    });
    return { key_id, public_key: key, server_id: sid, label, ...(notAfter ? { not_after: notAfter } : {}), ...(replaced ? { replaced } : {}) };
  }

  /** Stop trusting a key (by key id). True if it was in the admin list. */
  attesterRemove(keyId: string): boolean {
    const id = typeof keyId === "string" ? keyId.trim().toLowerCase() : "";
    if (!/^[0-9a-f]{16}$/.test(id)) throw new ValidationError("key_id must be the 16-hex-digit key id");
    let removed = false;
    this.transaction(() => {
      removed = Number(this.db.prepare("DELETE FROM trust_attesters WHERE key_id = ?").run(id).changes) > 0;
      if (removed) this.logTrust("attester-remove", "*", id);
    });
    return removed;
  }

  /**
   * Key ids an admin revoked: nothing signed by them is believed from now on, whatever date the signature claims
   * (unlike `not_after`, which only expires trust). Kept in the database, so it survives restarts and backups.
   */
  revokedKeys(): Set<string> {
    return new Set(Object.keys(this.revocations()));
  }

  /** The revocation list with who/when/why, for listing. */
  revocationList(): Array<{ key_id: string; at: string; by: string; reason: string }> {
    return Object.entries(this.revocations()).map(([key_id, v]) => ({ key_id, at: v.at, by: v.by, reason: v.reason }));
  }

  private revocations(): Record<string, { at: string; by: string; reason: string }> {
    const raw = this.getMeta("revoked_attester_keys");
    if (!raw) return {};
    try {
      const v = JSON.parse(raw) as unknown;
      return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, { at: string; by: string; reason: string }>) : {};
    } catch {
      return {};
    }
  }

  /** Revoke a key (any attester's, or one of this server's retired keys). Refuses this server's CURRENT key (rotate first). */
  attesterRevoke(keyId: string, reason = ""): { key_id: string; already: boolean } {
    const id = typeof keyId === "string" ? keyId.trim().toLowerCase() : "";
    if (!/^[0-9a-f]{16}$/.test(id)) throw new ValidationError("key_id must be the 16-hex-digit key id");
    const cur = this.dbPath === ":memory:" ? this.signingKey : peekSigningKey(this.keyDir);
    if (cur && cur.keyId === id) throw new ValidationError("that is this server's CURRENT signing key: run `onememory trust rotate` first, then revoke the retired key");
    let already = false;
    this.transaction(() => {
      const all = this.revocations();
      if (all[id]) {
        already = true;
        return;
      }
      all[id] = { at: new Date().toISOString(), by: this.trustActor(), reason: cleanWriter(reason).slice(0, 200) };
      this.setMeta("revoked_attester_keys", JSON.stringify(all));
      this.logTrust("attester-revoke", "*", `${id}${all[id].reason ? ` (${all[id].reason})` : ""}`);
    });
    return { key_id: id, already };
  }

  /** Take a key off the revocation list. True if it was there. */
  attesterUnrevoke(keyId: string): boolean {
    const id = typeof keyId === "string" ? keyId.trim().toLowerCase() : "";
    if (!/^[0-9a-f]{16}$/.test(id)) throw new ValidationError("key_id must be the 16-hex-digit key id");
    let removed = false;
    this.transaction(() => {
      const all = this.revocations();
      if (!all[id]) return;
      delete all[id];
      this.setMeta("revoked_attester_keys", JSON.stringify(all));
      removed = true;
      this.logTrust("attester-unrevoke", "*", id);
    });
    return removed;
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
    /** Internal override of the stamped writer (default: the current writer). */
    writtenBy?: string;
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
                                   created_at_override, reasons, created_at, set_namespace, sealed, written_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
          key ? 1 : 0,
          q.writtenBy !== undefined ? cleanWriter(q.writtenBy) : currentWriter()
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
        .prepare("SELECT created_at_override, written_by FROM quarantine WHERE id = ?")
        .get(id) as { created_at_override: string | null; written_by: string | null };
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
          { lint: "none", writtenBy: row.written_by ?? "" }
        );
        drop.run(id);
        return n;
      });
    } else {
      const held = this.db
        .prepare("SELECT if_rev, set_namespace, written_by FROM quarantine WHERE id = ?")
        .get(id) as { if_rev: number | null; set_namespace: number; written_by: string | null };
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
        { ifRev, lint: "none", writtenBy: held.written_by ?? "" }
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
    // INSERT OR IGNORE then read back: two processes minting at once end up
    // with ONE id (the first writer's), and it never changes afterwards.
    this.db.prepare("INSERT OR IGNORE INTO _meta (key, value) VALUES ('store_uuid', ?)").run(randomUUID());
    return this.getMeta("store_uuid") ?? randomUUID();
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
export function feedScopeKey(
  namespaces: string[] | undefined,
  source: string | undefined,
  writer?: {
    writtenBy?: string;
    notWrittenBy?: string;
    noteWrittenBy?: string;
    notNoteWrittenBy?: string;
    includeDistrusted?: boolean;
  }
): string {
  // Each filter extends the key only when set, so every marker / cursor /
  // ack_token made without it keeps its exact scope key (pre-1.3.3 ones, and
  // 1.3.3 ones that used only the event writer filters).
  const base: unknown[] = [namespaces ? [...namespaces].sort() : null, source ?? null];
  if (writer?.writtenBy !== undefined || writer?.notWrittenBy !== undefined) {
    base.push([writer.writtenBy === undefined ? null : cleanWriter(writer.writtenBy), writer.notWrittenBy === undefined ? null : cleanWriter(writer.notWrittenBy)]);
  }
  if (writer?.noteWrittenBy !== undefined || writer?.notNoteWrittenBy !== undefined) {
    base.push([
      "note",
      writer.noteWrittenBy === undefined ? null : cleanWriter(writer.noteWrittenBy),
      writer.notNoteWrittenBy === undefined ? null : cleanWriter(writer.notNoteWrittenBy),
    ]);
  }
  if (writer?.includeDistrusted) base.push(["distrusted"]);
  return createHash("sha256")
    .update(JSON.stringify(base))
    .digest("hex")
    .slice(0, 16);
}

function feedMarkerKey(consumer: string, scope: string): string {
  if (!CONSUMER_RE.test(consumer) || !/^[0-9a-f]{16}$/.test(scope)) {
    throw new ValidationError("invalid change-feed consumer");
  }
  return `changes_seen:${consumer}|${scope}`;
}
