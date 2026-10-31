// Automatic memory, part 1: turning a hook payload into one stored capture event.
//
// The agent's hooks (`onememory hook <event>`, see hook.ts) hand us Claude Code's JSON. Here it is normalized to one
// small CaptureEvent, checked against the capture settings (kill switch, excluded folders, skipped tools), REDACTED
// (<private> blocks and secrets, see redact.ts) and truncated, and only then written: to the capture_events table, or,
// when the database cannot be used right now, to a JSONL spool in the data directory that a later hook drains. The
// spool only ever holds redacted events.
//
// Nothing here throws to the hook: errors are the caller's to swallow (hook.ts never fails the agent).
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, chmodSync } from "node:fs";
import { join } from "node:path";
import type { Store } from "./store.js";
import { redact } from "./redact.js";
import { captureAad } from "./crypto.js";

export const HOOK_EVENTS = ["session-start", "user-prompt", "post-tool", "post-tool-failure", "stop", "subagent-stop", "session-end"] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

/** Longest stored field (input / output), after redaction. */
export const FIELD_MAX = 4096;
/** What is redacted at most per field: a 1 MiB tool output is cut to this BEFORE the (linear, but not free) secret scan. */
const REDACT_WINDOW = 64 * 1024;
/** The spool stops growing past this (events are then dropped; capture is best effort, the agent never waits). */
export const SPOOL_MAX_BYTES = 10 * 1024 * 1024;
export const SPOOL_FILE = "capture-spool.jsonl";

export interface CaptureEvent {
  session_id: string;
  cwd: string;
  event: HookEvent;
  tool: string;
  input: string;
  output: string;
  ok: boolean;
  /** Size of the raw input + output before truncation. */
  bytes: number;
  at: string;
}

export interface CaptureSettings {
  enabled: boolean;
  exclude: string[];
  skipTools: string[];
}

const list = (v: unknown): string[] =>
  (Array.isArray(v) ? v.map(String) : typeof v === "string" ? v.split(",") : []).map((s) => s.trim()).filter(Boolean);

/** Settings: ONEMEMORY_CAPTURE / _EXCLUDE / _SKIP_TOOLS, else <data dir>/capture.json ({capture, exclude, skip_tools}). Env wins. */
export function captureSettings(dataDir: string, env: NodeJS.ProcessEnv = process.env): CaptureSettings {
  let file: Record<string, unknown> = {};
  try {
    const p = join(dataDir, "capture.json");
    if (existsSync(p)) {
      const v = JSON.parse(readFileSync(p, "utf8")) as unknown;
      if (v && typeof v === "object" && !Array.isArray(v)) file = v as Record<string, unknown>;
    }
  } catch {
    /* unreadable settings file: defaults (env still applies) */
  }
  const sw = (env.ONEMEMORY_CAPTURE ?? (typeof file.capture === "string" ? file.capture : "")).trim().toLowerCase();
  return {
    enabled: !["off", "0", "false", "no"].includes(sw),
    exclude: env.ONEMEMORY_CAPTURE_EXCLUDE !== undefined ? list(env.ONEMEMORY_CAPTURE_EXCLUDE) : list(file.exclude),
    skipTools: env.ONEMEMORY_CAPTURE_SKIP_TOOLS !== undefined ? list(env.ONEMEMORY_CAPTURE_SKIP_TOOLS) : list(file.skip_tools),
  };
}

const slash = (p: string): string => p.replace(/\\/g, "/").replace(/\/+$/, "");

/** `*` = one path segment, `**` = any depth. Case-insensitive on Windows. Matches the whole path. */
export function globMatch(glob: string, path: string, platform: NodeJS.Platform = process.platform): boolean {
  const g = slash(glob);
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*" && g[i + 1] === "*") {
      re += ".*";
      i++;
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, platform === "win32" ? "i" : "").test(slash(path));
}

/** OneMemory's own tools are never recorded (reading memory is not work worth remembering, and it would loop). */
export function isOwnTool(tool: string): boolean {
  return /^mcp__onememory__/.test(tool);
}

export function shouldCapture(ev: CaptureEvent, s: CaptureSettings): boolean {
  if (!s.enabled || !ev.session_id) return false;
  if (ev.tool && (isOwnTool(ev.tool) || s.skipTools.includes(ev.tool))) return false;
  if (ev.cwd && s.exclude.some((g) => globMatch(g, ev.cwd))) return false;
  return true;
}

const str = (v: unknown): string => (typeof v === "string" ? v : v === undefined || v === null ? "" : JSON.stringify(v));

/** A tool result as text: a shell result's stdout + stderr, otherwise the JSON. */
function resultText(v: unknown): string {
  const o = v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  if (o && (typeof o.stdout === "string" || typeof o.stderr === "string")) return [o.stdout, o.stderr].filter((x) => typeof x === "string" && x).join("\n");
  return str(v);
}

/** Redact first (on a bounded window), then cut to FIELD_MAX. */
export function cleanField(raw: string): string {
  const r = redact(raw.length > REDACT_WINDOW ? raw.slice(0, REDACT_WINDOW) : raw).text;
  return r.length > FIELD_MAX ? r.slice(0, FIELD_MAX - 1) + "…" : r;
}

/** Claude Code's hook JSON -> one CaptureEvent (already redacted and truncated). */
export function normalizeHookInput(event: HookEvent, raw: unknown, now: Date = new Date()): CaptureEvent {
  const r = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const sid = typeof r.session_id === "string" ? r.session_id.slice(0, 200) : "";
  const cwd = typeof r.cwd === "string" ? r.cwd.slice(0, 1000) : process.cwd();
  let tool = "";
  let input = "";
  let output = "";
  let ok = true;
  if (event === "post-tool" || event === "post-tool-failure") {
    tool = typeof r.tool_name === "string" ? r.tool_name.slice(0, 200) : "";
    input = str(r.tool_input);
    if (event === "post-tool-failure") {
      ok = false;
      output = str(r.error) || resultText(r.tool_response);
    } else output = resultText(r.tool_response);
  } else if (event === "user-prompt") input = str(r.prompt);
  else if (event === "session-start") input = str(r.source);
  else input = str(r.last_assistant_message ?? r.prompt_response ?? r.reason); // prompt_response: Gemini CLI AfterAgent
  const bytes = input.length + output.length;
  return { session_id: sid, cwd, event, tool, input: cleanField(input), output: cleanField(output), ok, bytes, at: now.toISOString() };
}

/**
 * Store one event (caller holds no transaction). Creates the session row on first sight. Returns whether the session is
 * new, so the caller can run its once-per-session housekeeping (drain the spool, distill crashed sessions).
 */
export function recordEvent(store: Store, ev: CaptureEvent, namespace: string): { newSession: boolean; seq: number } {
  const db = store.captureDb();
  db.exec("BEGIN IMMEDIATE");
  try {
    const created = Number(
      db
        .prepare("INSERT OR IGNORE INTO sessions (id, namespace, cwd, started_at) VALUES (?, ?, ?, ?)")
        .run(ev.session_id, namespace, ev.cwd, ev.at).changes ?? 0
    );
    const res = db
      .prepare("INSERT INTO capture_events (session_id, at, event, tool, input, output, output_enc, ok, bytes) VALUES (?, ?, ?, ?, ?, '', NULL, ?, ?)")
      .run(ev.session_id, ev.at, ev.event, ev.tool, ev.input, ev.ok ? 1 : 0, ev.bytes);
    const seq = Number(res.lastInsertRowid);
    if (ev.output) {
      const sealed = store.sealCapture(ev.output, captureAad(seq, ev.session_id));
      db.prepare("UPDATE capture_events SET output = ?, output_enc = ? WHERE seq = ?").run(sealed.text, sealed.enc, seq);
    }
    db.prepare(
      `UPDATE sessions SET event_count = event_count + 1${ev.event === "user-prompt" ? ", prompt_count = prompt_count + 1" : ""}${
        ev.event === "session-end" ? ", ended_at = ?" : ""
      } WHERE id = ?`
    ).run(...(ev.event === "session-end" ? [ev.at] : []), ev.session_id);
    db.exec("COMMIT");
    return { newSession: created === 1, seq };
  } catch (e) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* nothing to roll back */
    }
    throw e;
  }
}

/** AAD binding a sealed event output to its row (crypto.ts, where every AAD lives). */
export { captureAad } from "./crypto.js";

// ---- spool ------------------------------------------------------------------------------------------------------------

export interface SpooledEvent extends CaptureEvent {
  namespace: string;
  /** Failed drains so far; past SPOOL_MAX_TRIES the event is dropped, so one bad line cannot cycle through the spool forever. */
  tries?: number;
}

export const SPOOL_MAX_TRIES = 5;
/** A `.draining` file this old was left by a hook that died mid-drain: the next drain adopts it. */
const STALE_DRAIN_MS = 10 * 60_000;

export function spoolEvent(dataDir: string, ev: SpooledEvent): boolean {
  try {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const p = join(dataDir, SPOOL_FILE);
    if (existsSync(p) && statSync(p).size > SPOOL_MAX_BYTES) return false;
    appendFileSync(p, JSON.stringify(ev) + "\n", { mode: 0o600 });
    try {
      chmodSync(p, 0o600);
    } catch {
      /* Windows: no POSIX modes */
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Move the spool aside (a rename is atomic, so two hooks never drain the same lines) and store every event in it.
 * A line that cannot be stored is put back into the spool. Returns how many were stored.
 */
export function drainSpool(store: Store, dataDir: string, now = Date.now()): number {
  const p = join(dataDir, SPOOL_FILE);
  const files: string[] = [];
  const take = (from: string, n: number): void => {
    const to = `${p}.${process.pid}-${n}.draining`;
    try {
      renameSync(from, to);
      files.push(to);
    } catch {
      /* another hook is draining it */
    }
  };
  if (existsSync(p)) take(p, 0);
  // Adopt what a killed hook left behind, so it is stored (or dropped) instead of lying there forever.
  try {
    for (const f of readdirSync(dataDir)) {
      const full = join(dataDir, f);
      if (f.startsWith(SPOOL_FILE + ".") && f.endsWith(".draining") && !files.includes(full) && now - statSync(full).mtimeMs > STALE_DRAIN_MS) take(full, files.length + 1);
    }
  } catch {
    /* no data dir */
  }
  let stored = 0;
  for (const taken of files) {
    try {
      for (const line of readFileSync(taken, "utf8").split("\n")) {
        if (!line.trim()) continue;
        let ev: SpooledEvent;
        try {
          ev = JSON.parse(line) as SpooledEvent;
        } catch {
          continue; // a torn line (a hook killed mid-write) is dropped
        }
        if (!ev || typeof ev.session_id !== "string" || !(HOOK_EVENTS as readonly string[]).includes(ev.event)) continue;
        try {
          recordEvent(store, ev, typeof ev.namespace === "string" ? ev.namespace : "");
          stored++;
        } catch {
          const tries = (Number(ev.tries) || 0) + 1;
          if (tries < SPOOL_MAX_TRIES) spoolEvent(dataDir, { ...ev, tries });
        }
      }
    } finally {
      try {
        unlinkSync(taken);
      } catch {
        /* best effort */
      }
    }
  }
  return stored;
}

/** Spool bytes, including `.draining` files a drain is working on (or a killed one left). */
export function spoolSize(dataDir: string): number {
  try {
    return readdirSync(dataDir)
      .filter((f) => f === SPOOL_FILE || (f.startsWith(SPOOL_FILE + ".") && f.endsWith(".draining")))
      .reduce((n, f) => n + statSync(join(dataDir, f)).size, 0);
  } catch {
    return 0;
  }
}

/** Captured events no session summary has taken in yet (doctor): a growing number means session hooks are failing. */
export function captureBacklog(store: Store): number {
  const r = store.captureDb().prepare("SELECT COUNT(*) AS n FROM capture_events e JOIN sessions s ON s.id = e.session_id WHERE e.seq > s.distilled_seq").get() as { n: number };
  return Number(r.n);
}

/** Most recent capture time (doctor), or null. */
export function lastCaptureAt(store: Store): string | null {
  const r = store.captureDb().prepare("SELECT MAX(at) AS at FROM capture_events").get() as { at: string | null } | undefined;
  return r?.at ?? null;
}
