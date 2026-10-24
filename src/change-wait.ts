// Live wait on the change feed: "tell me the moment something changes".
//
// `GET /changes?...&wait=30` and MCP `memory_since { wait_seconds: 30 }` hold
// the request open until the feed has something new for the caller (inside
// the caller's namespace scope), then answer exactly like the normal feed.
// Nothing new within the wait -> the empty page comes back with
// `timedOut: true`. A phone writes; the PC session that is parked here hears
// about it within milliseconds.
//
// How a waiter wakes:
//   - writes made in THIS process call Store.onChange (immediate wake);
//   - writes made by another process (the CLI, a second server) are caught
//     by a cheap poll of MAX(change_log.seq) every WAIT_POLL_MS (default 1s).
// A wake only means "the head moved": the waiter re-runs the normal feed
// query, so scope (namespace / source) is enforced by the same code as an
// ordinary read, and a write in a namespace the caller can't read never
// returns anything (it just goes back to waiting).
//
// Bounds: wait is capped at WAIT_MAX_SECONDS (55) but the recommended value is
// WAIT_RECOMMENDED_SECONDS (25): many proxies and tunnels cut an idle HTTP
// response at 30s (a 55s wait reproducibly died at 30.0s behind one), and
// nothing is sent until the wait ends. Concurrent waiters are capped per
// token (16), per namespace scope (32) and per process (64). Every waiter
// releases its slot, timer, poll and Store listener in one place, whether it
// ends by a change, a timeout, the client leaving, or server shutdown
// (abortAllWaiters: they return timedOut cleanly instead of a reset socket).
// The 1s poll for other-process writes is jittered +-20% per waiter so a
// crowd of waiters does not hit SQLite in lockstep.
import { Store, ValidationError } from "./store.js";
import { runChanges, type ChangesRequest, type ChangesResponse } from "./changes.js";

export const WAIT_MAX_SECONDS = 55;
/** What docs and tool descriptions recommend: survives a 30s-idle proxy. */
export const WAIT_RECOMMENDED_SECONDS = 25;

/** Too many concurrent waiters: REST answers 429, MCP returns a tool error. */
export class WaitBusyError extends ValidationError {}

function envInt(name: string, def: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return def;
  const n = Number(raw);
  if (!Number.isInteger(n)) return def;
  return Math.min(max, Math.max(min, n));
}

/** Poll interval for writes from other processes (read lazily so tests can set it). */
export const waitPollMs = (): number => envInt("ONEMEMORY_WAIT_POLL_MS", 1000, 20, 60_000);
const maxPerKey = (): number => envInt("ONEMEMORY_WAIT_MAX_PER_TOKEN", 16, 1, 100);
const maxPerScope = (): number => envInt("ONEMEMORY_WAIT_MAX_PER_NAMESPACE", 32, 1, 500);
const maxTotal = (): number => envInt("ONEMEMORY_WAIT_MAX_TOTAL", 64, 1, 1000);

const active = new Map<string, number>();
const activeScopes = new Map<string, number>();
let activeTotal = 0;

/** Every live waiter's abort handle, so shutdown can end them all cleanly. */
const shutdownHandles = new Set<() => void>();

/** Wake every waiter now; each returns timedOut:true. Called on SIGTERM/SIGINT. */
export function abortAllWaiters(): void {
  for (const f of [...shutdownHandles]) f();
}

/** Live waiter count (for tests and diagnostics). */
export function activeWaiters(): number {
  return activeTotal;
}

function acquire(key: string, scopeKey: string): () => void {
  if (activeTotal >= maxTotal()) {
    throw new WaitBusyError(
      `too many live waits on this server (max ${maxTotal()}); retry shortly or poll without \`wait\`` +
        " (raise ONEMEMORY_WAIT_MAX_TOTAL if this is expected)"
    );
  }
  const n = active.get(key) ?? 0;
  if (n >= maxPerKey()) {
    throw new WaitBusyError(
      `429: too many concurrent waits for this token (max ${maxPerKey()}). Each wait holds one slot until it returns, ` +
        "times out or the client disconnects; close an idle wait, reuse one wait loop per consumer, or poll without `wait` " +
        "(raise ONEMEMORY_WAIT_MAX_PER_TOKEN if this is expected)"
    );
  }
  const sc = activeScopes.get(scopeKey) ?? 0;
  if (sc >= maxPerScope()) {
    throw new WaitBusyError(
      `429: too many concurrent waits on this namespace scope (max ${maxPerScope()}, shared by all tokens); ` +
        "retry shortly or poll without `wait` (raise ONEMEMORY_WAIT_MAX_PER_NAMESPACE if this is expected)"
    );
  }
  active.set(key, n + 1);
  activeScopes.set(scopeKey, sc + 1);
  activeTotal++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeTotal--;
    const left = (active.get(key) ?? 1) - 1;
    if (left <= 0) active.delete(key);
    else active.set(key, left);
    const sl = (activeScopes.get(scopeKey) ?? 1) - 1;
    if (sl <= 0) activeScopes.delete(scopeKey);
    else activeScopes.set(scopeKey, sl);
  };
}

/** Parse a caller-supplied wait (seconds). undefined/"" = no wait. */
export function parseWait(raw: unknown): number {
  if (raw === undefined || raw === null || raw === "") return 0;
  const n = typeof raw === "number" ? raw : /^\d{1,4}$/.test(String(raw)) ? Number(raw) : NaN;
  if (!Number.isInteger(n) || n < 0 || n > WAIT_MAX_SECONDS) {
    throw new ValidationError(`wait must be a whole number of seconds from 0 to ${WAIT_MAX_SECONDS}`);
  }
  return n;
}

/** Resolve when something may have changed, the time is up, or `signal` aborts. */
function sleepUntilWake(store: Store, head: number, ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    let off: () => void = () => {};
    const timer = setTimeout(done, ms);
    // Self-rescheduling poll with +-20% jitter, so waiters drift apart.
    let poll: NodeJS.Timeout;
    const schedule = (): void => {
      poll = setTimeout(() => {
        try {
          if (store.changeHeadSeq() !== head) return done();
        } catch {
          return done(); // store closed or busy: let the caller re-check / give up
        }
        schedule();
      }, Math.max(10, Math.round(waitPollMs() * (0.8 + Math.random() * 0.4))));
      poll.unref();
    };
    schedule();
    timer.unref();
    function done(): void {
      clearTimeout(timer);
      clearTimeout(poll);
      off();
      signal?.removeEventListener("abort", done);
      resolve();
    }
    off = store.onChange(done);
    signal?.addEventListener("abort", done, { once: true });
    if (signal?.aborted) done();
  });
}

export interface WaitOpts {
  /** Seconds to wait (0 = behave exactly like runChanges). */
  waitSeconds: number;
  /** Fires when the client goes away; the wait ends and frees its slot. */
  signal?: AbortSignal;
  /** Identity for the per-token waiter cap (never the raw token). */
  key: string;
  /** Namespace scope the wait reads (for the per-namespace cap); default "*". */
  scopeKey?: string;
}

/**
 * runChanges, but if the feed has nothing for the caller yet, wait up to
 * `waitSeconds` for the first change. Needs a time window (`since`), not a
 * `cursor`: a cursor's window is frozen, so nothing new can ever appear in it.
 */
export async function waitForChanges(
  store: Store,
  req: ChangesRequest,
  opts: WaitOpts
): Promise<ChangesResponse> {
  if (!opts.waitSeconds) return runChanges(store, req);
  if (req.cursor) {
    throw new ValidationError(
      "wait cannot be combined with cursor (a cursor's window is frozen); use since, e.g. since=last"
    );
  }
  const release = acquire(opts.key, opts.scopeKey ?? "*");
  // Server shutdown ends this wait like a client-side abort, but cleanly.
  const stop = new AbortController();
  const shutdown = (): void => stop.abort();
  shutdownHandles.add(shutdown);
  const signal = opts.signal ? AbortSignal.any([opts.signal, stop.signal]) : stop.signal;
  try {
    let head = store.changeHeadSeq(); // read BEFORE the query: a write in between re-triggers below
    let out = runChanges(store, req);
    if (out.changes.length > 0) return out;
    const markerReset = out.markerReset;
    const deadline = Date.now() + opts.waitSeconds * 1000;
    while (!signal.aborted) {
      const left = deadline - Date.now();
      if (left <= 0) break;
      await sleepUntilWake(store, head, left, signal);
      if (signal.aborted) break;
      const now = store.changeHeadSeq();
      if (now === head) continue; // spurious wake or the timer; the loop condition decides
      head = now;
      out = runChanges(store, req);
      if (out.changes.length > 0) {
        return markerReset ? { ...out, markerReset } : out;
      }
    }
    return { ...out, timedOut: true as const };
  } finally {
    shutdownHandles.delete(shutdown);
    release();
  }
}
