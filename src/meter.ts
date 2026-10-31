// What OneMemory costs you: aggregate numbers only, never prompt or note text.
//
// One row per agent session: tokens the SessionStart hook injected, the tokens of captured work those stood in for
// ("saved", the same estimate as the savings footer), and tokens the optional local model used (llm.ts; 0 when it is
// off). Plus, read live: capture events recorded and the database size on disk. Tokens are estimates at ~4 characters
// a token. Writes are best-effort: a meter that cannot write never costs a session its context.
import type { Store } from "./store.js";

const SCHEMA = `CREATE TABLE IF NOT EXISTS meter_sessions (
  session_id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL DEFAULT '',
  injections INTEGER NOT NULL DEFAULT 0,
  injected_tokens INTEGER NOT NULL DEFAULT 0,
  saved_tokens INTEGER NOT NULL DEFAULT 0,
  llm_tokens INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
)`;

export interface MeterTotals {
  sessions: number;
  injections: number;
  injected_tokens: number;
  saved_tokens: number;
  llm_tokens: number;
}

export interface MeterStats {
  totals: MeterTotals;
  /** Newest first, at most 20. */
  recent: Array<Omit<MeterTotals, "sessions"> & { session_id: string; namespace: string; updated_at: string }>;
  capture_events: number;
  db_bytes: number;
  note: string;
}

/** Add to one session's counters (fail-silent). */
export function meterAdd(store: Store, sessionId: string, namespace: string, add: { injected?: number; saved?: number; llm?: number }): void {
  if (!sessionId) return;
  try {
    const db = store.captureDb();
    db.exec(SCHEMA);
    const inj = add.injected !== undefined ? 1 : 0;
    db.prepare(
      `INSERT INTO meter_sessions (session_id, namespace, injections, injected_tokens, saved_tokens, llm_tokens, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET injections = injections + excluded.injections, injected_tokens = injected_tokens + excluded.injected_tokens,
         saved_tokens = saved_tokens + excluded.saved_tokens, llm_tokens = llm_tokens + excluded.llm_tokens, updated_at = excluded.updated_at`
    ).run(sessionId, namespace, inj, Math.max(0, Math.round(add.injected ?? 0)), Math.max(0, Math.round(add.saved ?? 0)), Math.max(0, Math.round(add.llm ?? 0)), new Date().toISOString());
  } catch (e) {
    process.stderr.write(`onememory: meter not updated (${(e as Error).message})\n`);
  }
}

/** Per-session and total numbers, optionally limited to some namespaces. */
export function meterStats(store: Store, namespaces?: string[]): MeterStats {
  const db = store.captureDb();
  const where = namespaces ? ` WHERE namespace IN (${namespaces.map(() => "?").join(",") || "NULL"})` : "";
  const args = namespaces ?? [];
  const has = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meter_sessions'").get();
  const zero: MeterTotals = { sessions: 0, injections: 0, injected_tokens: 0, saved_tokens: 0, llm_tokens: 0 };
  const totals = has
    ? (db
        .prepare(
          `SELECT COUNT(*) AS sessions, COALESCE(SUM(injections),0) AS injections, COALESCE(SUM(injected_tokens),0) AS injected_tokens,
           COALESCE(SUM(saved_tokens),0) AS saved_tokens, COALESCE(SUM(llm_tokens),0) AS llm_tokens FROM meter_sessions${where}`
        )
        .get(...args) as unknown as MeterTotals)
    : zero;
  const recent = has
    ? (db
        .prepare(`SELECT session_id, namespace, injections, injected_tokens, saved_tokens, llm_tokens, updated_at FROM meter_sessions${where} ORDER BY updated_at DESC LIMIT 20`)
        .all(...args) as unknown as MeterStats["recent"])
    : [];
  const ev = db
    .prepare(`SELECT COUNT(*) AS c FROM capture_events e JOIN sessions s ON s.id = e.session_id${namespaces ? where.replace("namespace", "s.namespace") : ""}`)
    .get(...args) as { c: number };
  const pages = db.prepare("SELECT page_count * page_size AS b FROM pragma_page_count(), pragma_page_size()").get() as { b: number };
  return {
    totals: Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, Number(v)])) as unknown as MeterTotals,
    recent: recent.map((r) => ({ ...r })),
    capture_events: Number(ev.c),
    db_bytes: Number(pages.b),
    note: "Estimates at ~4 characters a token. llm_tokens counts only the optional local model (0 when ONEMEMORY_LLM_URL is unset); OneMemory makes no other model calls.",
  };
}

/** One line for `onememory doctor`. */
export function meterLine(m: MeterStats): string {
  const t = m.totals;
  return (
    `footprint: ${t.sessions} session(s), ~${t.injected_tokens} tokens injected (${t.injections} time(s)), ~${t.saved_tokens} tokens of captured work stood in for, ` +
    `${t.llm_tokens} local-model tokens, ${m.capture_events} capture event(s), database ${(m.db_bytes / 1048576).toFixed(1)} MB`
  );
}
