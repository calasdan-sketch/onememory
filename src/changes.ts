// Change feed service: "what changed while I was away".
//
// Shared by the MCP `memory_since` tool, REST `GET /changes`, the CLI
// `onememory changes` command and the dashboard. The Store does the SQL
// (Store.changes); this module turns the caller's `since` into a window
// and implements the "last" marker.
//
// `since` accepts:
//   - an ISO-8601 timestamp           2026-10-15T09:00:00Z
//   - a duration back from now        90s, 30m, 24h, 7d, 2w
//   - "last"                          everything since this consumer last
//                                     read the feed to the end
//
// "last" design: one marker per (consumer, filter scope), kept by the
// Store under a key it computes itself (`changes_seen:<consumer>|<scope
// hash>`); callers never name _meta keys. The consumer is a short label the
// caller picks (e.g. "phone", "claude-code"; default "default"). The marker
// holds the change seq the consumer has read up to and advances only when
// the FINAL page has been served, so a reader that stops half-way sees the
// rest next time. A consumer with no marker (first read, or evicted) gets
// the last 24 hours and `markerReset: true`. Markers untouched for 7+ days
// are evicted least-recently-read first once MAX_FEED_MARKERS exist.
// Cursors are HMAC-signed by the store and bound to the filter they were
// issued for, so a cursor can't be edited to move another marker. Tokens
// are not identities in OneMemory, so the marker is keyed by the label.

import { Store, ValidationError, feedScopeKey, type ChangesPage } from "./store.js";

/** Window used for "last" before a consumer has any marker. */
export const LAST_FALLBACK_MS = 24 * 3_600_000;

const DURATION = /^(\d+(?:\.\d+)?)\s*(s|m|h|d|w)$/i;
const UNIT_MS: Record<string, number> = {
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 7 * 86_400_000,
};

/**
 * Resolve an ISO timestamp or a duration ("24h") to an ISO start time.
 * Returns null for "last" (handled by the caller) and throws a
 * ValidationError for anything else.
 */
export function resolveSince(raw: string | undefined, now = Date.now()): string | null {
  const v = (raw ?? "").trim();
  if (!v) throw new ValidationError('since is required: an ISO time, a duration like "24h", or "last"');
  if (v.toLowerCase() === "last") return null;
  const d = DURATION.exec(v);
  if (d) return new Date(now - Number(d[1]) * UNIT_MS[d[2].toLowerCase()]).toISOString();
  // Only accept things that look like dates: Date.parse("5") is a valid year.
  if (/^\d{4}-\d{2}-\d{2}/.test(v)) {
    const t = Date.parse(v);
    if (!Number.isNaN(t)) return new Date(t).toISOString();
  }
  throw new ValidationError(
    `unrecognized since "${v}": use an ISO time (2026-10-15T09:00:00Z), a duration (90s, 30m, 24h, 7d, 2w), or "last"`
  );
}

/** Normalize a consumer label: 1-64 chars of [A-Za-z0-9._@-]. */
export function consumerKey(raw: string | undefined): string {
  const v = (raw ?? "").trim() || "default";
  if (!/^[A-Za-z0-9._@-]{1,64}$/.test(v)) {
    throw new ValidationError("consumer must be 1-64 characters of letters, digits, . _ @ -");
  }
  return v;
}

export interface ChangesRequest {
  since?: string;
  cursor?: string;
  /** undefined = whole store; [] = nothing readable. */
  namespaces?: string[];
  source?: string;
  limit?: number;
  consumer?: string;
}

export type ChangesResponse = Omit<ChangesPage, "consumer" | "seq"> & {
  /** Set when since="last": the consumer whose marker this read uses. */
  consumer?: string;
  /**
   * since="last" found no marker for this consumer (first read, or it was
   * evicted / purged): the window fell back to the last 24 hours, so
   * changes older than that may have been missed.
   */
  markerReset?: true;
};

/**
 * Run one change-feed page. Advances the "last" marker when the final page
 * of a since="last" window is served.
 */
export function runChanges(store: Store, req: ChangesRequest): ChangesResponse {
  const filter = { namespaces: req.namespaces, source: req.source, limit: req.limit };
  let page: ChangesPage;
  let markerReset = false;
  if (req.cursor) {
    page = store.changes({ cursor: req.cursor, ...filter });
  } else {
    const start = resolveSince(req.since);
    if (start !== null) {
      page = store.changes({ since: start, ...filter });
    } else {
      const consumer = consumerKey(req.consumer);
      const seen = store.getFeedMarker(consumer, feedScopeKey(req.namespaces, req.source));
      markerReset = seen === null;
      page = store.changes({
        since: seen?.at ?? new Date(Date.now() - LAST_FALLBACK_MS).toISOString(),
        fromSeq: seen?.seq,
        consumer,
        ...filter,
      });
    }
  }
  const { consumer, seq, ...out } = page;
  if (consumer === null) return out;
  if (page.nextCursor === null) {
    store.setFeedMarker(consumer, feedScopeKey(req.namespaces, req.source), { seq, at: page.until });
  }
  return { ...out, consumer, ...(markerReset ? { markerReset: true as const } : {}) };
}
