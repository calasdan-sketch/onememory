// "Runner offline, N commands waiting": a read-only signal for the gap between
// an admin approving a command task (from a phone) and the PC's runner picking
// it up. If the PC is asleep the task simply waits -- until now nothing said so.
//
// (This module is deliberately NOT named runner-*: package.json keeps every
// `dist/src/runner*` file out of the npm package, and the server needs this one.)
//
// Inputs, all already in the store (nothing new is written, nothing is signed):
//   - the runners' heartbeat notes (namespace "runner", written by runner.ts):
//     ONE PER RUNNER ("runner heartbeat: <runner id>"), so a dead PC is never
//     masked by another PC that is still beating;
//   - queued command tasks that carry an approval, classified by the SAME rule
//     the runner uses to pick tasks (task-core.ts classifyQueuedCommand), each
//     one judged against the runner it is addressed to (its `target`).
//
// How far a heartbeat can be trusted. The store holds no runner secret, so
// the signature inside the heartbeat cannot be checked here. Instead:
//   - the TIME is the note's server-side updated_at (rewritten by the runner
//     on every beat), never the `alive_at` the body claims: the body can lie or
//     come from a clock that is off, the server's own timestamp cannot be set
//     by a client;
//   - only a note whose server-stamped written_by is "runner" (the command
//     runner process) counts. A token holder's write is stamped with the
//     token's label (a token named "runner" is stored as `token:runner`), so a
//     forged heartbeat is ignored. Heartbeats from a runner older than 1.3.4
//     carry no marker (written_by ""): since 1.4.0 they are NOT accepted unless
//     ONEMEMORY_RUNNER_ACCEPT_LEGACY=1 (upgrade the runner instead: it needs no
//     other change). Limit: anyone with write access to the database FILE
//     itself can still stamp any value;
//   - a time in the future (beyond a small allowance) is never believed.
//
// What it reveals: counts, ids, namespaces, target names and ages. Never
// command text, params or the host: task_get remains the only place those are
// read, under its own rules. Task counts honour the caller's readable
// namespaces exactly like task_list. A heartbeat is store-wide liveness, so a
// target's online / stale / never_seen verdict is visible to every reader of
// this status (its age too), not its host or pid.
import { Store } from "./store.js";
import { scanQueuedCommands, envRunnerId, envRunnerTaskNamespace, TASK_TAG, TAG_APPROVAL, type RunnerIdentity } from "./task-core.js";

export const HEARTBEAT_NAMESPACE = "runner";
export const HEARTBEAT_TITLE = "runner heartbeat";
/** The per-runner heartbeat title: `runner heartbeat: <runner id>`. */
export function heartbeatTitle(runnerId: string): string {
  return `${HEARTBEAT_TITLE}: ${runnerId}`;
}
/** Approvals expiring within this window are flagged. */
export const EXPIRING_SOON_MS = 3_600_000;
/** A heartbeat stamped this far ahead of the server clock is not believed. */
export const FUTURE_ALLOWANCE_MS = 120_000;
/**
 * A runner's own `alive_at` (inside the heartbeat body, which only the runner
 * process can rewrite: a content edit restamps the note's writer) may lag the
 * server's timestamp by clock skew, not more. A beat whose server timestamp is
 * newer than its alive_at by more than this was TOUCHED (a tag or source edit
 * moves updated_at but not the body), so the alive_at is believed instead.
 * Runner and server clocks should agree to within about this much (NTP).
 */
export const ALIVE_SKEW_MS = 120_000;
/** The result is reused for this long unless the change log moved. */
export const STATUS_CACHE_MS = 5_000;
/** Most heartbeat notes read per writer (one per runner is expected). */
const HEARTBEAT_SCAN_LIMIT = 200;

/** ONEMEMORY_RUNNER_ACCEPT_LEGACY=1: also believe heartbeats with no writer marker (runners older than 1.3.4). */
export function acceptLegacyHeartbeats(): boolean {
  return ["1", "true", "yes"].includes((process.env.ONEMEMORY_RUNNER_ACCEPT_LEGACY ?? "").toLowerCase());
}

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

export type RunnerState = "online" | "stale" | "never_seen";

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

/** One runner (target): its own heartbeat verdict and the commands waiting for it. */
export interface RunnerTargetStatus {
  /** The runner's name: the `target` of the commands addressed to it. */
  target: string;
  state: RunnerState;
  /** ISO time of this runner's last heartbeat (the server's own timestamp of it), or null. */
  last_seen: string | null;
  age_seconds: number | null;
  stale_after_seconds: number;
  /** The command-task namespace this runner says it serves ("" = unknown / command tasks off). */
  task_namespace: string;
  /** True when this runner never said which namespace it serves: its commands are counted under their own namespace. */
  namespace_unconfirmed?: true;
  waiting: number;
  expiring_soon: number;
  expired: number;
  oldest_waiting_seconds: number | null;
  oldest_waiting_task_id: number | null;
  /** One sentence about THIS runner; present when its approved commands wait while it is not online, or approvals expired. */
  notice?: string;
}

export interface RunnerStatus {
  /**
   * The one-runner view older clients read. With several runners it is the
   * most worrying one that has commands waiting (a stale or never-seen runner
   * beats an online one), else the freshest heartbeat. See `targets` for each.
   */
  runner: {
    state: RunnerState;
    /** ISO time of the last heartbeat (the server's own timestamp of it), or null. */
    last_seen: string | null;
    age_seconds: number | null;
    stale_after_seconds: number;
    /** Which runner this summary describes (additive; absent when none is known). */
    target?: string;
  };
  /** Totals over all runners. */
  waiting_total: number;
  expiring_soon_total: number;
  expired_total: number;
  namespaces: RunnerNamespaceStatus[];
  /** Per runner: online / stale / never_seen and the commands waiting for exactly that runner. */
  targets: RunnerTargetStatus[];
  /**
   * True when more than the scan limit of queued approved tasks exist, so the
   * totals are "at least". Absent otherwise.
   */
  truncated?: boolean;
  /** False when no runner reports a command-task namespace and none is configured (the feature is off): nothing can be counted as waiting. */
  command_tasks_enabled: boolean;
  /** One plain sentence; present when approved commands wait on a runner that is not online, or approvals expired. */
  notice?: string;
}

interface Beat {
  /** Server time of the last beat, ms. */
  at: number;
  taskNamespace?: string;
  heartbeatMs?: number;
}

/** Fresh, trusted heartbeats by runner id. The newest beat of a runner wins. */
function readBeats(store: Store, now: number): Map<string, Beat> {
  const out = new Map<string, Beat>();
  try {
    // Filter on the trusted writer IN SQL, so a pile of forged notes can never
    // push a real heartbeat out of a window.
    const pick = (writtenBy: string) =>
      store
        .list({ namespace: HEARTBEAT_NAMESPACE, limit: HEARTBEAT_SCAN_LIMIT, withTags: ["heartbeat"], writtenBy, includeDistrusted: true })
        .notes.filter((n) => n.title === HEARTBEAT_TITLE || n.title.startsWith(`${HEARTBEAT_TITLE}: `));
    const cands = [...pick("runner").map((n) => ({ n, authentic: true })), ...(acceptLegacyHeartbeats() ? pick("").map((n) => ({ n, authentic: false })) : [])];
    for (const { n, authentic } of cands) {
      const t = Date.parse(n.updated_at);
      if (!Number.isFinite(t) || t > now + FUTURE_ALLOWANCE_MS) continue; // never believe the future
      let runner = n.title.startsWith(`${HEARTBEAT_TITLE}: `) ? n.title.slice(HEARTBEAT_TITLE.length + 2) : "";
      const beat: Beat = { at: Math.min(t, now) };
      try {
        const p = JSON.parse(n.body) as { runner?: unknown; task_namespace?: unknown; heartbeat_ms?: unknown; alive_at?: unknown };
        if (typeof p.runner === "string" && p.runner) runner = p.runner; // the runner process wrote this body
        if (typeof p.task_namespace === "string") beat.taskNamespace = p.task_namespace;
        if (typeof p.heartbeat_ms === "number" && p.heartbeat_ms > 0) beat.heartbeatMs = p.heartbeat_ms;
        if (typeof p.alive_at === "string") {
          const a = Date.parse(p.alive_at);
          if (Number.isFinite(a)) {
            // Liveness comes from the runner's own clock reading, not from "the note was touched".
            if (t - a > ALIVE_SKEW_MS) beat.at = Math.min(a, now);
          } else if (authentic) continue;
        } else if (authentic) {
          continue; // a runner-written body always carries alive_at; without it the note is not a beat
        }
      } catch {
        if (authentic) continue; // not the runner's JSON body: not a beat
      }
      if (!runner) runner = envRunnerId();
      const have = out.get(runner);
      if (!have || beat.at > have.at) out.set(runner, beat);
    }
  } catch {
    /* no heartbeats readable: nothing is online */
  }
  return out;
}

/** Heartbeat notes untouched for this many days are removed by the runner / server housekeeping (0 = never). */
export function heartbeatPruneDays(): number {
  const raw = (process.env.ONEMEMORY_RUNNER_HEARTBEAT_PRUNE_DAYS ?? "").trim();
  if (raw === "") return 30; // unset or empty: the default (an empty string used to read as 0 = never prune)
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 30;
}

/**
 * Delete heartbeat notes of runner ids that have not beaten for `days` days
 * (renamed hosts, containers, CI): one note per runner id would otherwise stay
 * forever. A live runner re-creates its note on its next beat. Returns how many were removed.
 */
export function pruneStaleHeartbeats(store: Store, days: number = heartbeatPruneDays(), now = Date.now()): number {
  if (!days || days <= 0) return 0;
  const cutoff = now - days * 86_400_000;
  let removed = 0;
  try {
    const { notes } = store.list({ namespace: HEARTBEAT_NAMESPACE, limit: 500, withTags: ["heartbeat"], includeDistrusted: true });
    for (const n of notes) {
      if (!(n.title === HEARTBEAT_TITLE || n.title.startsWith(`${HEARTBEAT_TITLE}: `))) continue;
      const t = Date.parse(n.updated_at);
      if (Number.isFinite(t) && t < cutoff && store.delete(n.id)) removed++;
    }
  } catch {
    /* housekeeping only */
  }
  return removed;
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
export function runnerStatus(store: Store, namespaces?: string[], explicitNow?: number, opts: { pinned?: boolean } = {}): RunnerStatus {
  const useCache = explicitNow === undefined;
  const now = explicitNow ?? Date.now();
  const pinned = opts.pinned === true;
  const key = JSON.stringify([namespaces ? [...namespaces].sort() : null, staleAfterSeconds(), acceptLegacyHeartbeats(), pinned]);
  let seq = -1;
  if (useCache) {
    seq = changeSeq(store);
    const hit = cache.get(store)?.get(key);
    if (hit && hit.seq === seq && seq >= 0 && now - hit.at < STATUS_CACHE_MS) return hit.value;
  }
  const value = compute(store, namespaces, now, pinned);
  if (useCache && seq >= 0) {
    let m = cache.get(store);
    if (!m) cache.set(store, (m = new Map()));
    if (m.size > 32) m.clear();
    m.set(key, { seq, at: now, value });
  }
  return value;
}

const SEVERITY: Record<RunnerState, number> = { online: 0, stale: 1, never_seen: 2 };

function compute(store: Store, namespaces: string[] | undefined, now: number, pinned = false): RunnerStatus {
  const beats = readBeats(store, now);
  const envNs = envRunnerTaskNamespace();

  // Which tasks would each runner run? What a runner says it serves (its own
  // heartbeat) wins; the server's environment is the fallback.
  //   - a runner that SAID which namespace it serves (even "" = command tasks off) is believed;
  //   - the server's environment is the fallback;
  //   - with neither (a runner that never sent a heartbeat, or an older one that
  //     does not name its namespace) the commands addressed to it are counted
  //     under their own namespace and flagged "unconfirmed", so the
  //     "runner not listening" notice can fire for the very case it exists for.
  const resolve = (target: string): RunnerIdentity => {
    const said = beats.get(target)?.taskNamespace;
    if (said !== undefined) return { me: target, namespace: said };
    if (envNs) return { me: target, namespace: envNs };
    return { me: target, namespace: "", unconfirmed: true };
  };
  const scan = scanQueuedCommands(store, resolve, namespaces, now);

  const by = new Map<string, RunnerNamespaceStatus>();
  const oldestNs = new Map<string, number>();
  const per = new Map<string, RunnerTargetStatus>();
  const oldestT = new Map<string, number>();
  const targetStatus = (target: string): RunnerTargetStatus => {
    let t = per.get(target);
    if (!t) {
      const b = beats.get(target);
      const staleAfter = staleAfterSeconds(b?.heartbeatMs);
      const age = b ? Math.max(0, Math.round((now - b.at) / 1000)) : null;
      t = {
        target,
        state: age === null ? "never_seen" : age <= staleAfter ? "online" : "stale",
        last_seen: b ? new Date(b.at).toISOString() : null,
        age_seconds: age,
        stale_after_seconds: staleAfter,
        // A namespace-pinned caller learns a runner's task namespace only if it is one of its own.
        task_namespace: pinned && namespaces && !namespaces.includes(b?.taskNamespace ?? envNs) ? "" : b?.taskNamespace ?? envNs,
        ...(b?.taskNamespace === undefined && !envNs ? { namespace_unconfirmed: true as const } : {}),
        waiting: 0,
        expiring_soon: 0,
        expired: 0,
        oldest_waiting_seconds: null,
        oldest_waiting_task_id: null,
      };
      per.set(target, t);
    }
    return t;
  };
  // A pinned caller sees only runners that have commands waiting in its own namespaces (host names are not its business).
  if (!pinned) for (const target of beats.keys()) targetStatus(target);

  for (const w of scan.items) {
    let s = by.get(w.namespace);
    if (!s) {
      s = { namespace: w.namespace, waiting: 0, expiring_soon: 0, expired: 0, oldest_waiting_seconds: null, oldest_waiting_task_id: null };
      by.set(w.namespace, s);
    }
    const t = targetStatus(w.target);
    if (w.state === "expired") {
      s.expired++;
      t.expired++;
      continue;
    }
    s.waiting++;
    t.waiting++;
    if (w.expires_ms - now <= EXPIRING_SOON_MS) {
      s.expiring_soon++;
      t.expiring_soon++;
    }
    const since = Date.parse(w.since);
    if (Number.isFinite(since)) {
      if (!oldestNs.has(w.namespace) || since < oldestNs.get(w.namespace)!) {
        oldestNs.set(w.namespace, since);
        s.oldest_waiting_task_id = w.id;
        s.oldest_waiting_seconds = Math.max(0, Math.round((now - since) / 1000));
      }
      if (!oldestT.has(w.target) || since < oldestT.get(w.target)!) {
        oldestT.set(w.target, since);
        t.oldest_waiting_task_id = w.id;
        t.oldest_waiting_seconds = Math.max(0, Math.round((now - since) / 1000));
      }
    }
  }
  const rows = [...by.values()].sort((a, b) => a.namespace.localeCompare(b.namespace));
  const targets = [...per.values()].sort((a, b) => a.target.localeCompare(b.target));
  const sum = (f: (r: RunnerNamespaceStatus) => number) => rows.reduce((n, r) => n + f(r), 0);
  const named = targets.length > 1;
  for (const t of targets) {
    const n = noticeFor(t.waiting, t.expiring_soon, t.expired, t.state, t.age_seconds, scan.truncated === true, named ? t.target : null);
    if (n) t.notice = n;
  }

  // The one-runner summary older clients read: the worst runner that has
  // commands waiting, else the freshest heartbeat, else "never seen".
  const waitingTargets = targets.filter((t) => t.waiting > 0 || t.expired > 0);
  let lead: RunnerTargetStatus | undefined;
  if (waitingTargets.length) {
    lead = [...waitingTargets].sort((a, b) => SEVERITY[b.state] - SEVERITY[a.state] || b.waiting - a.waiting || a.target.localeCompare(b.target))[0];
  } else {
    lead = [...targets].filter((t) => t.last_seen !== null).sort((a, b) => (a.age_seconds ?? 0) - (b.age_seconds ?? 0) || a.target.localeCompare(b.target))[0] ?? targets[0];
  }
  const out: RunnerStatus = {
    runner: lead
      ? { state: lead.state, last_seen: lead.last_seen, age_seconds: lead.age_seconds, stale_after_seconds: lead.stale_after_seconds, ...(named || waitingTargets.length ? { target: lead.target } : {}) }
      : { state: "never_seen", last_seen: null, age_seconds: null, stale_after_seconds: staleAfterSeconds() },
    waiting_total: sum((r) => r.waiting),
    expiring_soon_total: sum((r) => r.expiring_soon),
    expired_total: sum((r) => r.expired),
    namespaces: rows,
    targets,
    ...(scan.truncated ? { truncated: true } : {}),
    command_tasks_enabled: pinned ? scan.items.length > 0 : Boolean(envNs) || [...beats.values()].some((b) => Boolean(b.taskNamespace)) || scan.items.some((w) => per.get(w.target)?.namespace_unconfirmed === true),
  };
  const parts = targets.map((t) => t.notice).filter((x): x is string => Boolean(x));
  if (parts.length) out.notice = parts.map((p) => p.replace(/\.$/, "")).join("; ") + ".";
  return out;
}

function noticeFor(
  waiting: number,
  expiringSoon: number,
  expired: number,
  state: RunnerState,
  ageSeconds: number | null,
  truncated: boolean,
  name: string | null
): string | null {
  const parts: string[] = [];
  const atLeast = truncated ? "at least " : "";
  const who = name ? `Runner ${JSON.stringify(name)}` : "Runner";
  if (waiting > 0 && state !== "online") {
    const seen = ageSeconds === null ? "no heartbeat seen" : `last seen ${ago(ageSeconds)} ago`;
    let line = `${who} offline (${seen}): ${atLeast}${waiting} approved command${waiting === 1 ? "" : "s"} waiting`;
    if (expiringSoon) line += `, ${expiringSoon} expiring within 1 h`;
    parts.push(line);
  }
  if (expired > 0) {
    const lead = name && !parts.length ? `${who}: ` : "";
    parts.push(`${lead}${atLeast}${expired} command approval${expired === 1 ? "" : "s"} expired before the runner took ${expired === 1 ? "it" : "them"} (re-approve)`);
  }
  if (!parts.length) return null;
  return parts.join("; ") + ".";
}

/**
 * The one-line notice for catch_up / the recall hook, or null. Never throws.
 * Returns at once when no approved command is queued in the caller's
 * namespaces: then nothing can be waiting or expired whatever the runner is
 * doing, so the heartbeats and the classifier are never touched.
 */
export function runnerNotice(store: Store, namespaces?: string[]): string | null {
  try {
    if (namespaces && namespaces.length === 0) return null;
    if (!store.hasTagged({ namespaces, withTags: [TASK_TAG, "status:queued"], withTagPrefix: TAG_APPROVAL })) return null;
    return runnerStatus(store, namespaces).notice ?? null;
  } catch {
    return null;
  }
}
