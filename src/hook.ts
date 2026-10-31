// `onememory hook <event>`: the agent's lifecycle hooks (Claude Code: SessionStart, UserPromptSubmit, PostToolUse,
// PostToolUseFailure, Stop, SubagentStop, SessionEnd).
//
// FAIL-OPEN, ALWAYS: whatever happens (garbage on stdin, no database, a database from another version, a locked file, a
// bug) the process exits 0 and prints either nothing or one valid hook JSON object on stdout. Capture is a bonus; it must
// never cost the agent a turn. The database is opened WITHOUT migrating (a one-way upgrade is never the hook's call) and
// with a short lock wait; when it cannot be used, the already-redacted event goes to a JSONL spool in the data directory
// (or, when ONEMEMORY_HOOK_URL and ONEMEMORY_HOOK_TOKEN are set, to POST <url>/capture first) and a later hook drains it.
//
// session-start also prints the start-of-session context (recall.ts / context-inject.ts), exactly like `onememory recall`.
// file-context (PreToolUse on Read) prints what memory knows about the file about to be read (file-context.ts); advisory only.
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { HOOK_EVENTS, type HookEvent, captureSettings, normalizeHookInput, shouldCapture, recordEvent, spoolEvent, drainSpool, type CaptureEvent } from "./capture.js";

/** stdin is read up to this much; the rest is ignored (a hook payload past 1 MiB is a tool output we only keep 4 KB of). */
export const STDIN_MAX = 1024 * 1024;
/** Give up on a stdin that never closes (a hook started by hand in a terminal) after this long. */
const STDIN_WAIT_MS = 2000;
/** Lock wait for the hook's database open: a busy database means "spool it", never "make the agent wait". */
const HOOK_BUSY_MS = 250;
const REST_TIMEOUT_MS = 2000;

export async function readStdin(stream: NodeJS.ReadableStream & { isTTY?: boolean } = process.stdin, max = STDIN_MAX): Promise<string> {
  if (stream.isTTY) return "";
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stream.removeAllListeners?.("data");
      resolve(Buffer.concat(chunks).toString("utf8"));
      (stream as { pause?: () => void }).pause?.();
    };
    const timer = setTimeout(finish, STDIN_WAIT_MS);
    (timer as unknown as { unref?: () => void }).unref?.();
    stream.on("data", (c: Buffer | string) => {
      const b = typeof c === "string" ? Buffer.from(c) : c;
      if (size < max) chunks.push(b.subarray(0, max - size));
      size += b.length;
      if (size >= max) finish();
    });
    stream.on("end", finish);
    stream.on("error", finish);
  });
}

export function parsePayload(text: string): Record<string, unknown> {
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export interface HookOptions {
  dbPath?: string;
  dataDir?: string;
  env?: NodeJS.ProcessEnv;
  /** Run the optional LLM summary in this process (tests) instead of a detached child (the CLI default). */
  llmInline?: boolean;
}

/**
 * Hand the LLM summary to a detached child: a local model can take a minute, and the host waits on session-end.
 * Fails open: if the child cannot start, the automatic summary stays.
 */
function spawnLlmSummary(sessionId: string, dbPath: string, env: NodeJS.ProcessEnv): void {
  try {
    const cli = fileURLToPath(new URL("./cli.js", import.meta.url));
    const child = spawn(process.execPath, [cli, "hook", "llm-summary", "--db", dbPath], { env: { ...process.env, ...env }, detached: true, stdio: ["pipe", "ignore", "ignore"], windowsHide: true });
    child.on("error", () => {});
    child.stdin?.end(JSON.stringify({ session_id: sessionId }));
    child.unref();
  } catch {
    /* fail open */
  }
}

async function postCapture(env: NodeJS.ProcessEnv, ev: CaptureEvent & { namespace: string }): Promise<boolean> {
  const url = (env.ONEMEMORY_HOOK_URL ?? "").trim().replace(/\/+$/, "");
  const token = (env.ONEMEMORY_HOOK_TOKEN ?? "").trim();
  if (!url || !token) return false;
  try {
    const r = await fetch(`${url}/capture`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(ev),
      signal: AbortSignal.timeout(REST_TIMEOUT_MS),
    });
    return r.ok;
  } catch {
    return false;
  }
}

/**
 * Record one hook event. Returns quietly in every case; what happened is reported for the tests (and on stderr only).
 */
export async function captureHook(event: HookEvent, payload: Record<string, unknown>, opts: HookOptions = {}): Promise<"stored" | "spooled" | "posted" | "skipped" | "dropped"> {
  const env = opts.env ?? process.env;
  const { DATA_DIR, DB_PATH } = await import("./config.js");
  const dataDir = opts.dataDir ?? DATA_DIR;
  const dbPath = opts.dbPath ?? DB_PATH;
  const settings = captureSettings(dataDir, env);
  const ev = normalizeHookInput(event, payload);
  if (!shouldCapture(ev, settings)) return "skipped";
  const { resolveRecallNamespace } = await import("./recall.js");
  const res = await resolveRecallNamespace(ev.cwd);
  // Fail closed like recall: a configured-but-unresolvable namespace records nothing rather than guessing one.
  if (res.kind === "unresolvable") return "skipped";
  const { DEFAULT_NAMESPACE, Store } = await import("./store.js");
  const namespace = res.kind === "resolved" ? res.namespace : DEFAULT_NAMESPACE;
  let store: InstanceType<typeof Store> | null = null;
  try {
    if (!existsSync(dbPath)) throw new Error("no database yet");
    store = new Store(dbPath, { noMigrate: true, busyTimeoutMs: HOOK_BUSY_MS });
    const { newSession } = recordEvent(store, ev, namespace);
    const { distillSession, distillStaleSessions } = await import("./extract.js");
    if (newSession || event === "session-start") {
      drainSpool(store, dataDir);
      distillStaleSessions(store, ev.session_id);
    }
    if (event === "stop" || event === "session-end") distillSession(store, ev.session_id);
    if (event === "session-end") {
      // Optional local model (llm.ts, off unless configured): one call per session; on any failure the summary above stays.
      const { llmConfig, llmSummarize } = await import("./llm.js");
      if (opts.llmInline) await llmSummarize(store, ev.session_id, env);
      else if (llmConfig(env)) spawnLlmSummary(ev.session_id, dbPath, env);
      store.sweepCaptureEvents();
    }
    return "stored";
  } catch (e) {
    process.stderr.write(`onememory hook ${event}: ${(e as Error).message}; keeping the event for later\n`);
    if (await postCapture(env, { ...ev, namespace })) return "posted";
    return spoolEvent(dataDir, { ...ev, namespace }) ? "spooled" : "dropped";
  } finally {
    try {
      store?.close();
    } catch {
      /* nothing to close */
    }
  }
}

/**
 * The whole hook: returns the text to print on stdout ("" = print nothing). Never throws.
 */
export async function runHook(eventArg: string, stdinText: string, opts: HookOptions = {}): Promise<string> {
  // PreToolUse(Read): advisory file context, not a capture event (the Read itself is recorded by post-tool).
  if (eventArg === "file-context") {
    try {
      const { fileContextHook } = await import("./file-context.js");
      return await fileContextHook(parsePayload(stdinText), opts);
    } catch {
      return "";
    }
  }
  // The detached child spawnLlmSummary starts: rewrite one session's summary with the local model.
  if (eventArg === "llm-summary") {
    try {
      const sid = parsePayload(stdinText).session_id;
      const { DB_PATH } = await import("./config.js");
      const dbPath = opts.dbPath ?? DB_PATH;
      if (typeof sid !== "string" || !sid || !existsSync(dbPath)) return "";
      const { Store } = await import("./store.js");
      const { llmSummarize } = await import("./llm.js");
      const store = new Store(dbPath, { noMigrate: true });
      try {
        await llmSummarize(store, sid, opts.env ?? process.env);
      } finally {
        store.close();
      }
    } catch (e) {
      process.stderr.write(`onememory hook llm-summary: ${(e as Error).message}
`);
    }
    return "";
  }
  const event = (HOOK_EVENTS as readonly string[]).includes(eventArg) ? (eventArg as HookEvent) : null;
  if (!event) {
    process.stderr.write(`onememory hook: unknown event "${eventArg}" (one of ${HOOK_EVENTS.join(", ")}); ignored\n`);
    return "";
  }
  const payload = parsePayload(stdinText);
  try {
    await captureHook(event, payload, opts);
  } catch (e) {
    process.stderr.write(`onememory hook ${event}: ${(e as Error).message}\n`);
  }
  if (event !== "session-start") return "";
  try {
    const { runRecall } = await import("./recall.js");
    const cwd = typeof payload.cwd === "string" ? payload.cwd : undefined;
    return await runRecall({ ...(opts.dbPath ? { dbPath: opts.dbPath } : {}), ...(cwd ? { cwd } : {}) });
  } catch {
    return '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":""}}';
  }
}
