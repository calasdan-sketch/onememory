// "Runner offline, N commands waiting": a read-only signal for the gap between
// an admin approving a command task (from a phone) and the PC's runner picking
// it up. If the PC is asleep the task simply waits -- until now nothing said so.
//
// (This module is deliberately NOT named runner-*: package.json keeps every
// `dist/src/runner*` file out of the npm package, and the server needs this one.)
//
// Inputs, all already in the store (nothing new is written, nothing is signed):
//   - the runner's heartbeat note (namespace "runner", written by runner.ts);
//   - queued command tasks that carry an approval, classified by the SAME rule
//     the runner uses to pick tasks (tasks.ts classifyQueuedCommand).
//
// How far the heartbeat can be trusted. The store holds no runner secret, so
// the signature inside the heartbeat cannot be checked here. Instead:
//   - the TIME is the note's server-side updated_at (rewritten by the runner
//     on every beat), never the `alive_at` the body claims: the body can lie or
//     come from a clock that is off, the server's own timestamp cannot be set
//     by a client;
//   - only a note whose server-stamped written_by is "runner" (the command
//     runner process) counts. A token holder's write is stamped with the
//     token's label (a token named "runner" is stored as `token:runner`), so a
//     forged heartbeat is ignored. Heartbeats from a runner older than 1.3.4
//     carry no marker (written_by ""); those are accepted too, and a token
//     cannot produce "" either. Limit: anyone with write access to the database
//     FILE itself can still stamp any value;
//   - a time in the future (beyond a small allowance) is never believed.
//
// What it reveals: counts, ids, namespaces and ages. Never command text,
// params or targets -- task_get remains the only place those are read, under
// its own rules. Task counts honour the caller's readable namespaces exactly
// like task_list. The heartbeat is one store-wide liveness fact (one runner
// per store); only its age and online/stale verdict are exposed, not its host
// or pid.
import { Store } from "./store.js";
import { scanWaitingCommands, envRunnerId, envRunnerTaskNamespace, type RunnerIdentity } from "./tasks.js";

export const HEARTBEAT_NAMESPACE = "runner";
export const HEARTBEAT_TITLE = "runner heartbeat";
/** Approvals expiring within this window are flagged. */
export const EXPIRING_SOON_MS = 3_600_000;
/** A heartbeat stamped this far ahead of the server clock is not believed. */
export const FUTURE_ALLOWANCE_MS = 120_000;
/** The result is reused for this long unless the change log moved. */
export const STATUS_CACHE_MS = 5_000;

/**
 * Seconds without a heartbeat before the runner counts as stale. Base:
 * ONEMEMORY_RUNNER_STALE_SECONDS (default 600, 30 s - 7 d). Never below three
 * beat intervals: pass the runner's heartbeat interval (the heartbeat note
 * publishes it; ONEMEMORY_RUNNER_HEARTBEAT_MS is the fallback) so a slow beat
 * cannot make a healthy runner look permanently offline.
 */
export function staleAfterSeconds(heartbeatMs?: number): number {
  const raw = Number(process.env.ONEMEMORY_RUNNER_STALE_SECONDS);
  const base = Number.isFinite(raw) && raw > 0 ? Math.min(7 * 86_400, Math.max(30, Math.floor(raw))) : 600;
  let beat = Number(heartbeatMs);
  if (!Number.isFinite(beat) || beat <= 0) beat = Number(process.env.ONEMEMORY_RUNNER_HEARTBEAT_MS);
  const need = Number.isFinite(beat) && beat > 0 ? Math.ceil((3 * beat) / 1000) : 0;
  return Math.min(7 * 86_400, Math.max(base, need));
}

export interface RunnerNamespaceStatus {
  namespace: string;
  /** Approved, unexpired, not yet started by the runner. */
  waiting: number;
  /** Subset of `waiting` whose approval ends within an hour. */
  expiring_soon: number;
  /** Approvals that lapsed before the runner took the task (an admin must re-approve). */
  expired: number;
  /** Seconds since the oldest waiting task was approved; null when none wait. */
  oldest_waiting_seconds: number | null;
  oldest_waiting_task_id: number | null;
}

export interface RunnerStatus {
  runner: {
    state: "online" | "stale" | "never_seen";
    /** ISO time of the last heartbeat (the server's own timestamp of it), or null. */
    last_seen: string | null;
    age_seconds: number | null;
    stale_after_seconds: number;
  };
  waiting_total: number;
  expiring_soon_total: number;
  expired_total: number;
  namespaces: RunnerNamespaceStatus[];
  /**
   * True when more than the scan limit of queued approved tasks exist, so the
   * totals are "at least". Absent otherwise.
   */
  truncated?: boolean;
  /** False when the runner reports no command-task namespace (the feature is off): nothing can be counted as waiting. */
  command_tasks_enabled: boolean;
  /** One plain sentence; present when approved commands wait on a runner that is not online, or approvals expired. */
  notice?: string;
}

interface Beat {
  /** Server time of the last beat, ms, or null. */
  at: number | null;
  /** Machine name and task namespace the runner says it serves (from its own heartbeat body). */
  runner?: string;
  taskNamespace?: string;
  heartbeatMs?: number;
}

function readBeat(store: Store, now: number): Beat {
  try {
    // Filter on the trusted writer IN SQL, so a pile of forged notes can never
    // push the real heartbeat out of a window.
    const pick = (writtenBy: string) =>
      store.list({ namespace: HEARTBEAT_NAMESPACE, limit: 20, withTags: ["heartbeat"], writtenBy }).notes.filter((n) => n.title === HEARTBEAT_TITLE);
    const cands = [...pick("runner"), ...pick("")];
    let best: { at: number; body: string } | null = null;
    for (const n of cands) {
      const t = Date.parse(n.updated_at);
      if (!Number.isFinite(t) || t > now + FUTURE_ALLOWANCE_MS) continue; // never believe the future
      if (!best || t > best.at) best = { at: Math.min(t, now), body: n.body };
    }
    if (!best) return { at: null };
    const out: Beat = { at: best.at };
    try {
      const p = JSON.parse(best.body) as { runner?: unknown; task_namespace?: unknown; heartbeat_ms?: unknown };
      if (typeof p.runner === "string" && p.runner) out.runner = p.runner;
      if (typeof p.task_namespace === "string") out.taskNamespace = p.task_namespace;
      if (typeof p.heartbeat_ms === "number" && p.heartbeat_ms > 0) out.heartbeatMs = p.heartbeat_ms;
    } catch {
      /* a body that is not JSON just carries no claims */
    }
    return out;
  } catch {
    return { at: null };
  }
}

/** "45s", "12 min", "3 h", "2 d". */
export function ago(sec: number): string {
  if (sec < 90) return `${sec}s`;
  if (sec < 5400) return `${Math.round(sec / 60)} min`;
  if (sec < 172_800) return `${Math.round(sec / 3600)} h`;
  return `${Math.round(sec / 86_400)} d`;
}

const cache = new WeakMap<Store, Map<string, { seq: number; at: number; value: RunnerStatus }>>();

/** Drop cached results (tests, and callers that just changed the heartbeat or a task outside the change log). */
export function clearRunnerStatusCache(store?: Store): void {
  if (store) cache.delete(store);
}

function changeSeq(store: Store): number {
  try {
    return store.maxChangeSeq();
  } catch {
    return -1;
  }
}

/**
 * namespaces: undefined = whole store, [] = nothing readable. A call without
 * an explicit `now` is cached for STATUS_CACHE_MS, and only while the change
 * log has not moved, so repeated catch_up / recall calls do not rescan.
 */
export function runnerStatus(store: Store, namespaces?: string[], explicitNow?: number): RunnerStatus {
  const useCache = explicitNow === undefined;
  const now = explicitNow ?? Date.now();
  const key = JSON.stringify([namespaces ? [...namespaces].sort() : null, staleAfterSeconds()]);
  let seq = -1;
  if (useCache) {
    seq = changeSeq(store);
    const hit = cache.get(store)?.get(key);
    if (hit && hit.seq === seq && seq >= 0 && now - hit.at < STATUS_CACHE_MS) return hit.value;
  }
  const value = compute(store, namespaces, now);
  if (useCache && seq >= 0) {
    let m = cache.get(store);
    if (!m) cache.set(store, (m = new Map()));
    if (m.size > 32) m.clear();
    m.set(key, { seq, at: now, value });
  }
  return value;
}

function compute(store: Store, namespaces: string[] | undefined, now: number): RunnerStatus {
  const beat = readBeat(store, now);
  const staleAfter = staleAfterSeconds(beat.heartbeatMs);
  const age = beat.at === null ? null : Math.max(0, Math.round((now - beat.at) / 1000));
  const state: RunnerStatus["runner"]["state"] = age === null ? "never_seen" : age <= staleAfter ? "online" : "stale";

  // Which tasks would THIS runner run? What the runner says it serves (its
  // heartbeat) wins; the server's own environment is the fallback.
  const who: RunnerIdentity = {
    me: beat.runner ?? envRunnerId(),
    namespace: beat.taskNamespace ?? envRunnerTaskNamespace(),
  };

  const by = new Map<string, RunnerNamespaceStatus>();
  const oldest = new Map<string, number>();
  const scan = scanWaitingCommands(store, who, namespaces, now);
  for (const w of scan.items) {
    let s = by.get(w.namespace);
    if (!s) {
      s = { namespace: w.namespace, waiting: 0, expiring_soon: 0, expired: 0, oldest_waiting_seconds: null, oldest_waiting_task_id: null };
      by.set(w.namespace, s);
    }
    if (w.state === "expired") {
      s.expired++;
      continue;
    }
    s.waiting++;
    if (w.expires_ms - now <= EXPIRING_SOON_MS) s.expiring_soon++;
    const since = Date.parse(w.since);
    if (Number.isFinite(since) && (!oldest.has(w.namespace) || since < oldest.get(w.namespace)!)) {
      oldest.set(w.namespace, since);
      s.oldest_waiting_task_id = w.id;
      s.oldest_waiting_seconds = Math.max(0, Math.round((now - since) / 1000));
    }
  }
  const rows = [...by.values()].sort((a, b) => a.namespace.localeCompare(b.namespace));
  const sum = (f: (r: RunnerNamespaceStatus) => number) => rows.reduce((n, r) => n + f(r), 0);
  const out: RunnerStatus = {
    runner: { state, last_seen: beat.at === null ? null : new Date(beat.at).toISOString(), age_seconds: age, stale_after_seconds: staleAfter },
    waiting_total: sum((r) => r.waiting),
    expiring_soon_total: sum((r) => r.expiring_soon),
    expired_total: sum((r) => r.expired),
    namespaces: rows,
    ...(scan.truncated ? { truncated: true } : {}),
    command_tasks_enabled: Boolean(who.namespace),
  };
  const notice = noticeFor(out);
  if (notice) out.notice = notice;
  return out;
}

function noticeFor(s: RunnerStatus): string | null {
  const parts: string[] = [];
  const atLeast = s.truncated ? "at least " : "";
  if (s.waiting_total > 0 && s.runner.state !== "online") {
    const seen = s.runner.age_seconds === null ? "no heartbeat seen" : `last seen ${ago(s.runner.age_seconds)} ago`;
    const n = s.waiting_total;
    let line = `Runner offline (${seen}): ${atLeast}${n} approved command${n === 1 ? "" : "s"} waiting`;
    if (s.expiring_soon_total) line += `, ${s.expiring_soon_total} expiring within 1 h`;
    parts.push(line);
  }
  if (s.expired_total > 0) {
    const n = s.expired_total;
    parts.push(`${atLeast}${n} command approval${n === 1 ? "" : "s"} expired before the runner took ${n === 1 ? "it" : "them"} (re-approve)`);
  }
  if (!parts.length) return null;
  return parts.join("; ") + ".";
}

/** The one-line notice for catch_up / the recall hook, or null. Never throws. */
export function runnerNotice(store: Store, namespaces?: string[]): string | null {
  try {
    return runnerStatus(store, namespaces).notice ?? null;
  } catch {
    return null;
  }
}
