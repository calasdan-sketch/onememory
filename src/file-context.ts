// `onememory hook file-context`: Claude Code's PreToolUse hook on Read. Just before the agent reads a file, tell it what
// OneMemory already knows about that file: the newest observations, summaries and notes linked to the path (note_files),
// one compact index line each, so it can open the relevant ones with memory_get instead of re-learning them.
//
// ADVISORY ONLY: the output never carries a permissionDecision (no deny, no allow, no rewritten input), so the Read runs
// exactly as it would without us, permission prompt included. Each file is announced once per session (file_context_seen);
// the claim is taken only when there is something to say, so a file that gains memories later is still announced. The
// same rules as the session-start context apply: capture switched off or the folder excluded = silent, namespace resolved
// fail-closed, distrusted writers left out, the UNTRUSTED banner in front. Like every hook it fails open: any problem
// prints nothing.
import { existsSync } from "node:fs";
import type { HookOptions } from "./hook.js";

/** At most this many memories are listed for one file. */
const MAX_ROWS = 5;
/** Lock wait: a busy database means "say nothing", never "make the agent wait". */
const BUSY_MS = 150;

/** The hook text to print ("" = nothing). Never throws. */
export async function fileContextHook(payload: Record<string, unknown>, opts: HookOptions = {}): Promise<string> {
  try {
    return await fileContext(payload, opts);
  } catch (e) {
    process.stderr.write(`onememory hook file-context: ${(e as Error).message}\n`);
    return "";
  }
}

async function fileContext(payload: Record<string, unknown>, opts: HookOptions): Promise<string> {
  const input = payload.tool_input && typeof payload.tool_input === "object" ? (payload.tool_input as Record<string, unknown>) : {};
  const file = typeof input.file_path === "string" ? input.file_path.slice(0, 1000) : "";
  const sessionId = typeof payload.session_id === "string" ? payload.session_id.slice(0, 200) : "";
  if (payload.tool_name !== "Read" || !file || !sessionId) return "";
  const cwd = typeof payload.cwd === "string" ? payload.cwd.slice(0, 1000) : process.cwd();
  const env = opts.env ?? process.env;
  const { DATA_DIR, DB_PATH } = await import("./config.js");
  const { captureSettings, globMatch } = await import("./capture.js");
  const settings = captureSettings(opts.dataDir ?? DATA_DIR, env);
  if (!settings.enabled || settings.exclude.some((g) => globMatch(g, cwd))) return "";
  const dbPath = opts.dbPath ?? DB_PATH;
  if (!existsSync(dbPath)) return "";
  const { resolveRecallNamespace } = await import("./recall.js");
  const res = await resolveRecallNamespace(cwd);
  if (res.kind === "unresolvable") return "";
  const namespace = res.kind === "resolved" ? res.namespace : undefined;
  const { Store, NOTE_KINDS } = await import("./store.js");
  const { normPath } = await import("./extract.js");
  const store = new Store(dbPath, { noMigrate: true, busyTimeoutMs: BUSY_MS });
  try {
    // note_files holds the path relative to the session folder when it is inside it, otherwise forward-slashed as given.
    const rel = normPath(file, cwd);
    const paths = [...new Set([rel, file.replace(/\\/g, "/")])];
    const seen = new Set<number>();
    const notes = paths
      .flatMap((p) => store.list({ namespace, kinds: NOTE_KINDS, filePath: p, limit: MAX_ROWS, order: "created_desc" }).notes)
      .filter((n) => !seen.has(n.id) && seen.add(n.id))
      .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : b.id - a.id))
      .slice(0, MAX_ROWS);
    if (!notes.length) return "";
    const claimed = store.captureDb().prepare("INSERT OR IGNORE INTO file_context_seen (session_id, path) VALUES (?, ?)").run(sessionId, rel).changes;
    if (Number(claimed) !== 1) return "";
    const { indexLine } = await import("./context-inject.js");
    const { UNTRUSTED_BANNER } = await import("./security.js");
    const text =
      `OneMemory has earlier memory about ${rel} (advisory; read the file as usual):\n` +
      notes.map(indexLine).join("\n") +
      `\nOpen any with memory_get ids=[${notes.map((n) => n.id).join(",")}]`;
    return JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: UNTRUSTED_BANNER + text } });
  } finally {
    store.close();
  }
}
