// "Runner offline, N commands waiting": a read-only signal for the gap between
// an admin approving a command task (from a phone) and the PC's runner picking
// it up. If the PC is asleep the task simply waits -- until now nothing said so.
//
// Inputs, all already in the store (nothing new is written, nothing is signed):
//   - the runner's heartbeat note (namespace "runner", written by runner.ts);
//   - queued command tasks that carry an approval (tasks.ts waitingCommandTasks).
//
// What it reveals: counts, ids, namespaces and ages. Never command text,
// params or targets -- task_get remains the only place those are read, under
// its own rules. Task counts honour the caller's readable namespaces exactly
// like task_list. The heartbeat is one store-wide liveness fact (one runner
// per store); only its age and online/stale verdict are exposed, not its host,
// pid or body. The store holds no runner secret, so the heartbeat time is a
// HINT: a token holder could forge it. To check it, use the sign page's
// "Check a result" (docs/RUNNER.md).
import { Store } from "./store.js";
import { waitingCommandTasks } from "./tasks.js";

export const HEARTBEAT_NAMESPACE = "runner";
export const HEARTBEAT_TITLE = "runner heartbeat";
/** Approvals expiring within this window are flagged. */
export const EXPIRING_SOON_MS = 3_600_000;

/** Seconds without a heartbeat before the runner counts as stale (ONEMEMORY_RUNNER_STALE_SECONDS, default 600, 30 s - 7 d). */
export function staleAfterSeconds(): number {
  const raw = Number(process.env.ONEMEMORY_RUNNER_STALE_SECONDS);
  return Number.isFinite(raw) && raw > 0 ? Math.min(7 * 86_400, Math.max(30, Math.floor(raw))) : 600;
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
    /** ISO time of the last heartbeat, or null. */
    last_seen: string | null;
    age_seconds: number | null;
    stale_after_seconds: number;
  };
  waiting_total: number;
  expiring_soon_total: number;
  expired_total: number;
  namespaces: RunnerNamespaceStatus[];
  /** One plain sentence; present only when approved commands wait and the runner is not online. */
  notice?: string;
}

function heartbeatTime(store: Store): number | null {
  try {
    const notes = store.list({ namespace: HEARTBEAT_NAMESPACE, limit: 50, withTags: ["heartbeat"] }).notes;
    const hb = notes.find((n) => n.title === HEARTBEAT_TITLE);
    if (!hb) return null;
    let t = NaN;
    try {
      const p = JSON.parse(hb.body) as { alive_at?: unknown };
      if (typeof p.alive_at === "string") t = Date.parse(p.alive_at);
    } catch {
      /* fall back to the note's own timestamp */
    }
    if (!Number.isFinite(t)) t = Date.parse(hb.updated_at);
    return Number.isFinite(t) ? t : null;
  } catch {
    return null;
  }
}

function ago(sec: number): string {
  if (sec < 90) return `${sec}s`;
  if (sec < 5400) return `${Math.round(sec / 60)} min`;
  if (sec < 172_800) return `${Math.round(sec / 3600)} h`;
  return `${Math.round(sec / 86_400)} d`;
}

/** namespaces: undefined = whole store, [] = nothing readable. */
export function runnerStatus(store: Store, namespaces?: string[], now = Date.now()): RunnerStatus {
  const staleAfter = staleAfterSeconds();
  const hb = heartbeatTime(store);
  const age = hb === null ? null : Math.max(0, Math.round((now - hb) / 1000));
  const state: RunnerStatus["runner"]["state"] = age === null ? "never_seen" : age <= staleAfter ? "online" : "stale";

  const by = new Map<string, RunnerNamespaceStatus>();
  const oldest = new Map<string, number>();
  for (const w of waitingCommandTasks(store, namespaces, now)) {
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
    runner: { state, last_seen: hb === null ? null : new Date(hb).toISOString(), age_seconds: age, stale_after_seconds: staleAfter },
    waiting_total: sum((r) => r.waiting),
    expiring_soon_total: sum((r) => r.expiring_soon),
    expired_total: sum((r) => r.expired),
    namespaces: rows,
  };
  const notice = noticeFor(out);
  if (notice) out.notice = notice;
  return out;
}

function noticeFor(s: RunnerStatus): string | null {
  if (s.waiting_total === 0 || s.runner.state === "online") return null;
  const seen = s.runner.age_seconds === null ? "no heartbeat seen" : `last seen ${ago(s.runner.age_seconds)} ago`;
  const n = s.waiting_total;
  let line = `Runner offline (${seen}): ${n} approved command${n === 1 ? "" : "s"} waiting`;
  if (s.expiring_soon_total) line += `, ${s.expiring_soon_total} expiring within 1 h`;
  if (s.expired_total) line += `; ${s.expired_total} approval${s.expired_total === 1 ? "" : "s"} already expired (re-approve)`;
  return line + ".";
}

/** The one-line notice for catch_up / the recall hook, or null. Never throws. */
export function runnerNotice(store: Store, namespaces?: string[]): string | null {
  try {
    return runnerStatus(store, namespaces).notice ?? null;
  } catch {
    return null;
  }
}
