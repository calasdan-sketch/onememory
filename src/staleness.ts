// Staleness detection: time-aware memory.
//
// A note is stale when its most recent write (updated_at) is older than the
// configured thresholds (see stalenessConfig() in config.ts). Notes carrying
// a "fast-expiring" tag (default #status) expire sooner. Stale notes are
// still returned and searchable -- they are only flagged on reads
// (stale/ageDays/staleWarning) and ranked lower in search (graded
// stalePenaltyFactor(): 0.95 per 90-day age band), so agents verify before
// acting on outdated facts instead of silently discarding them.
//
// Namespace-agnostic by design: staleness is a per-note property and never
// crosses (or needs to know about) namespace isolation boundaries.

import { stalenessConfig, type StalenessConfig } from "./config.js";
import type { NoteRecord } from "./store.js";

// Re-export the config surface so callers can import the whole staleness
// vocabulary (isStale, stalenessConfig, StalenessConfig, STALE_SCORE_PENALTY)
// from this one module.
export { stalenessConfig, type StalenessConfig } from "./config.js";

export const MS_PER_DAY = 86_400_000;

/**
 * Multiplicative score penalty applied to stale notes in runSearch. Stale
 * notes stay findable -- they just rank slightly lower than fresh notes with
 * comparable relevance.
 *
 * LEGACY flat penalty (0.9), kept exported for API compatibility. It is no
 * longer used by the search path: I-HIGH-2 showed it was arithmetically dead
 * at >= 10 accesses -- the access boost (1 + 0.1*log10(11) = 1.104) erased
 * it (1.104 * 0.9 = 0.994 ~= a fresh note's 1.0), and at 100+ accesses a
 * stale note outright outranked a fresh one. The search path now uses
 * stalePenaltyFactor() below.
 */
export const STALE_SCORE_PENALTY = 0.9;

/**
 * Per-band penalty multiplier for the graded staleness penalty: each
 * STALE_PENALTY_BAND_DAYS of age multiplies the note's score by another
 * 0.95. A just-stale note keeps 0.95 (close to the old flat 0.9); a
 * year-stale note drops to ~0.81; three years to ~0.57. The penalty now
 * deepens with age instead of being a constant the access boost could
 * erase.
 */
export const STALE_PENALTY_PER_BAND = 0.95;
/** Age band, in days, for one STALE_PENALTY_PER_BAND multiplication. */
export const STALE_PENALTY_BAND_DAYS = 90;

/**
 * Graded staleness penalty factor for search ranking (I-HIGH-2): 1.0 for
 * fresh notes, 0.95^bands for stale ones, where bands counts 90-day age
 * bands (minimum 1 -- a stale note is always at least one band in).
 * Combined with the recency-decayed access boost, a stale note whose reads
 * are old can no longer outrank an equally-relevant fresh note, while a
 * stale note someone re-read *today* still ranks on its merits (recency is
 * a genuine relevance signal).
 */
export function stalePenaltyFactor(
  note: NoteRecord,
  cfg: StalenessConfig = stalenessConfig()
): number {
  const info = isStale(note, cfg);
  if (!info.stale) return 1;
  const bands = Math.max(1, Math.floor(info.ageDays / STALE_PENALTY_BAND_DAYS));
  return Math.pow(STALE_PENALTY_PER_BAND, bands);
}

export interface StaleInfo {
  stale: boolean;
  /** Whole days since updated_at (floored; never negative). */
  ageDays: number;
  reason?: string;
  /** The configured fast-expiry tag that matched, when that is why it's stale. */
  staleTag?: string;
  /** The tag-expiry threshold in days, when a tag match made it stale. */
  staleTagDays?: number;
}

/** A note annotated for state_read / state_search responses. */
export type StalenessNote = NoteRecord & {
  stale: boolean;
  ageDays: number;
  staleWarning?: string;
};

/** Normalize a tag for comparison: strip leading "#"s, trim, lowercase. */
function normTag(t: string): string {
  return t.trim().replace(/^#+/, "").toLowerCase();
}

/**
 * Decide whether a note is stale. Age is computed from updated_at (the most
 * recent write wins). Tag-expiry wins over the general threshold: if the
 * note carries any configured stale tag and is older than staleTagDays, it
 * is stale for that reason even if it is younger than staleDays.
 */
export function isStale(note: NoteRecord, cfg: StalenessConfig): StaleInfo {
  const updated = Date.parse(note.updated_at);
  const ageMs = Number.isFinite(updated) ? Date.now() - updated : 0;
  // A future updated_at (clock skew) is "0 days old", never negative.
  const ageDays = Math.max(0, Math.floor(ageMs / MS_PER_DAY));

  const cfgTags = cfg.staleTags.map(normTag).filter(Boolean);
  const noteTags = new Set((note.tags ?? []).map(normTag));
  const hitIdx = cfgTags.findIndex((t) => noteTags.has(t));
  if (hitIdx >= 0 && ageDays > cfg.staleTagDays) {
    // Report the tag as the operator configured it (e.g. "#status"), so the
    // reason reads naturally even when the note's own tag lacked the "#".
    return {
      stale: true,
      ageDays,
      reason: `${cfg.staleTags[hitIdx]} older than ${cfg.staleTagDays} days`,
      staleTag: cfg.staleTags[hitIdx],
      staleTagDays: cfg.staleTagDays,
    };
  }
  if (ageDays > cfg.staleDays) {
    return { stale: true, ageDays, reason: `older than ${cfg.staleDays} days` };
  }
  return { stale: false, ageDays };
}

/**
 * Human-readable warning for a stale note, or undefined when the note is
 * fresh. Example: "This note is 45 days old (tagged #status, expires after
 * 30 days). Verify against current state before acting on it."
 */
export function staleWarning(
  note: NoteRecord,
  cfg: StalenessConfig = stalenessConfig(),
  info: StaleInfo = isStale(note, cfg)
): string | undefined {
  if (!info.stale) return undefined;
  const days = info.ageDays === 1 ? "1 day" : `${info.ageDays} days`;
  if (info.staleTag !== undefined && info.staleTagDays !== undefined) {
    return (
      `This note is ${days} old (tagged ${info.staleTag}, ` +
      `expires after ${info.staleTagDays} days). ` +
      `Verify against current state before acting on it.`
    );
  }
  return `This note is ${days} old. Verify against current state before acting on it.`;
}

/**
 * Copy a note and attach its staleness fields for API/MCP responses. The
 * input record is never mutated (callers may reuse it for export/backup).
 * Reads the live config by default so operators can retune without restart.
 */
export function annotateStaleness(
  note: NoteRecord,
  cfg: StalenessConfig = stalenessConfig()
): StalenessNote {
  const info = isStale(note, cfg);
  const warning = staleWarning(note, cfg, info);
  return warning === undefined
    ? { ...note, stale: info.stale, ageDays: info.ageDays }
    : { ...note, stale: info.stale, ageDays: info.ageDays, staleWarning: warning };
}
