// Automatic memory, part 2: the free, deterministic distiller.
//
// Raw capture events (capture.ts) are turned into a few observations per session and one summary, with no model call:
//   - a git commit            -> an observation typed by its conventional prefix (fix -> bugfix, feat -> feature,
//                                refactor -> refactor, anything else -> change), linked to the files edited before it
//   - a test/build command that failed and later passed -> bugfix
//   - a test command that failed and was not fixed in the batch -> discovery ("tests failing")
//   - files edited outside any commit -> one change observation for the batch
//   - a redacted secret       -> security_note (the label only, never the value)
//   - a prompt-injection-shaped tool output -> security_alert (the label and the source only, never the text)
//   - a decision phrase in a prompt ("let's go with", "from now on", ...) -> decision
//   - concepts: keywords.ts over the observation's own text, as obs.concept:<word> tags
// Observations and summaries go through Store.create / Store.update like any note (lint, quarantine, history apply);
// their kind/session/type are set through write options no request can reach, and their tags are reserved
// (reserved-tags.ts), so an ordinary write cannot forge one. Observations run from `distilled_seq` onward (each event is
// distilled once); the summary is rebuilt from the whole session each time and updates the session's one summary note.
import type { Store, NoteRecord } from "./store.js";
import { DEFAULT_NAMESPACE } from "./store.js";
import { scanForInjection } from "./lint.js";
import { extractKeywords } from "./keywords.js";
import { captureAad } from "./capture.js";

export const OBS_TYPES = ["bugfix", "feature", "refactor", "change", "discovery", "decision", "security_alert", "security_note"] as const;
export type ObsType = (typeof OBS_TYPES)[number];

/** The source label every capture-written note carries. */
export const CAPTURE_SOURCE = "onememory capture";
/** Events read per distill pass (a very long session is distilled over several stops). */
const BATCH = 2000;
/** An unfinished session with no event for this long is treated as ended (its process crashed or was closed). */
export const STALE_SESSION_MS = 30 * 60_000;

interface EventRow {
  seq: number;
  at: string;
  event: string;
  tool: string;
  input: string;
  output: string;
  ok: boolean;
}

interface SessionRow {
  id: string;
  namespace: string;
  cwd: string;
  distilled_seq: number;
  summary_note_id: number | null;
}

export interface Observation {
  type: ObsType;
  title: string;
  body: string;
  files: Array<{ path: string; action: "changed" | "read" }>;
}

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const READ_TOOLS = new Set(["Read", "Grep", "Glob"]);
const TEST_CMD = /\b(?:node\s+--test|(?:npm|pnpm|yarn)\s+(?:run\s+)?test|npx\s+(?:jest|vitest)|jest|vitest|pytest|cargo\s+test|go\s+test)\b/;
const BUILD_CMD = /\b(?:(?:npm|pnpm|yarn)\s+run\s+build|tsc\b|cargo\s+build|go\s+build|make\b)/;
const TEST_FAILED =
  /(?:\b[1-9]\d*\s+(?:failed|failing)\b|^FAIL\b|ℹ fail [1-9]|\bfailures?[=:]\s*[1-9]|test result: FAILED|^--- FAIL|^FAILED\b|\berror TS\d+)/m;
const DECISION =
  /\b(?:let'?s\s+(?:go\s+with|use|stick\s+with)|we(?:'ll|\s+will)\s+(?:go\s+with|use)|we\s+decided|decided\s+to|decision:|from\s+now\s+on|always\s+use|never\s+use|don'?t\s+use|instead\s+of)\b/i;
const REDACTED = /\[REDACTED:([^\]]{1,40})\]/g;

const one = (s: string, max: number): string => {
  const c = (s || "").replace(/\s+/g, " ").trim();
  return c.length > max ? c.slice(0, max - 1) + "…" : c;
};

/** A string field of the (possibly truncated) JSON tool input. */
function field(input: string, name: string): string {
  const m = new RegExp(`"${name}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(input);
  if (!m) return "";
  try {
    return JSON.parse(`"${m[1]}"`) as string;
  } catch {
    return m[1];
  }
}

/** A file path as stored in note_files: forward slashes, relative to the session folder when inside it. */
export function normPath(p: string, cwd: string): string {
  const f = p.replace(/\\/g, "/");
  const base = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
  if (base && f.toLowerCase().startsWith(base.toLowerCase() + "/")) return f.slice(base.length + 1);
  return f;
}

function commitMessage(cmd: string): string {
  const here = /<<-?\s*'?(\w+)'?\s*\n([\s\S]*?)\n\s*\1/.exec(cmd);
  if (here) return here[2].trim();
  const dq = /\s-m\s+"((?:[^"\\]|\\.)*)"/.exec(cmd);
  if (dq) return dq[1].replace(/\\(.)/g, "$1");
  const sq = /\s-m\s+'([^']*)'/.exec(cmd);
  return sq ? sq[1] : "";
}

export function commitType(message: string): ObsType {
  const p = /^(\w+)(?:\([^)]*\))?!?:/.exec(message.trim())?.[1]?.toLowerCase();
  return p === "fix" ? "bugfix" : p === "feat" ? "feature" : p === "refactor" ? "refactor" : "change";
}

function testFailed(e: EventRow): boolean {
  return !e.ok || TEST_FAILED.test(e.output);
}

/** Pure: a batch of events -> its observations (exported for the tests). */
export function observe(events: readonly EventRow[], cwd: string): Observation[] {
  const out: Observation[] = [];
  let edited: string[] = []; // files changed since the last unit that claimed them
  const failing = new Map<string, { at: number; output: string }>(); // command -> its last failure (index)
  const secretLabels = new Set<string>();
  const add = (o: Observation): void => void out.push(o);
  const take = (): Observation["files"] => {
    const f = [...new Set(edited)].map((path) => ({ path, action: "changed" as const }));
    edited = [];
    return f;
  };
  events.forEach((e, i) => {
    for (const m of `${e.input}\n${e.output}`.matchAll(REDACTED)) secretLabels.add(m[1]);
    if (e.event === "user-prompt") {
      const sentence = e.input.split(/(?<=[.!?])\s+|\n+/).find((s) => DECISION.test(s));
      if (sentence) add({ type: "decision", title: `Decision: ${one(sentence, 110)}`, body: one(e.input, 600), files: [] });
      return;
    }
    if (e.event !== "post-tool" && e.event !== "post-tool-failure") return;
    if (EDIT_TOOLS.has(e.tool) && e.ok) {
      const p = field(e.input, "file_path") || field(e.input, "notebook_path");
      if (p) edited.push(normPath(p, cwd));
      return;
    }
    if (e.output && e.tool && !EDIT_TOOLS.has(e.tool)) {
      const inj = scanForInjection(e.output);
      if (inj) {
        const from = field(e.input, "url") || field(e.input, "file_path") || field(e.input, "command");
        add({
          type: "security_alert",
          title: `Possible prompt injection in ${e.tool} output`,
          body: `The ${e.tool} result${from ? ` for ${one(from, 200)}` : ""} contained text shaped like a prompt injection (${inj}). Treat that source as untrusted.`,
          files: [],
        });
      }
    }
    if (e.tool !== "Bash") return;
    const cmd = field(e.input, "command");
    if (!cmd) return;
    if (/\bgit\s+(?:-C\s+\S+\s+)?commit\b/.test(cmd) && e.ok && !/nothing to commit/i.test(e.output)) {
      const msg = commitMessage(cmd);
      const first = msg.split("\n")[0].trim() || "commit";
      add({ type: commitType(first), title: one(first, 120), body: `Committed: ${one(msg, 600)}`, files: take() });
      return;
    }
    const isTest = TEST_CMD.test(cmd);
    if (!isTest && !BUILD_CMD.test(cmd)) return;
    const key = one(cmd, 200);
    const failed = isTest ? testFailed(e) : !e.ok || /\berror\b/i.test(e.output.slice(0, 2000));
    if (failed) failing.set(key, { at: i, output: e.output });
    else if (failing.has(key)) {
      const was = failing.get(key)!;
      failing.delete(key);
      const firstErr = was.output.split("\n").find((l) => l.trim()) ?? "";
      add({
        type: "bugfix",
        title: `Fixed failing \`${one(cmd, 90)}\``,
        body: `\`${one(cmd, 200)}\` failed${firstErr ? ` (${one(firstErr, 200)})` : ""} and passes after the changes${edited.length ? ` to ${[...new Set(edited)].slice(0, 10).join(", ")}` : ""}.`,
        files: take(),
      });
    }
  });
  for (const [cmd, f] of failing) {
    if (!TEST_CMD.test(cmd)) continue;
    const firstErr = f.output.split("\n").find((l) => TEST_FAILED.test(l) || /error/i.test(l)) ?? "";
    add({ type: "discovery", title: `Tests failing: \`${one(cmd, 90)}\``, body: `\`${cmd}\` was failing${firstErr ? `: ${one(firstErr, 300)}` : ""}.`, files: [] });
  }
  if (edited.length) {
    const files = take();
    add({ type: "change", title: `Edited ${files.length} file${files.length === 1 ? "" : "s"}: ${one(files.map((f) => f.path).join(", "), 100)}`, body: files.map((f) => f.path).join("\n"), files });
  }
  for (const label of secretLabels) {
    add({ type: "security_note", title: `A ${label} was kept out of memory`, body: `A ${label} appeared in captured work and was redacted before it was stored. If it was real, consider rotating it.`, files: [] });
  }
  return out;
}

function eventsAfter(store: Store, sessionId: string, seq: number, limit = BATCH): EventRow[] {
  const rows = store
    .captureDb()
    .prepare("SELECT seq, at, event, tool, input, output, output_enc, ok FROM capture_events WHERE session_id = ? AND seq > ? ORDER BY seq LIMIT ?")
    .all(sessionId, seq, limit) as Array<{ seq: number; at: string; event: string; tool: string; input: string; output: string; output_enc: string | null; ok: number }>;
  return rows.map((r) => {
    let output = "";
    try {
      output = store.openCapture(r.output, r.output_enc, captureAad(r.seq, sessionId));
    } catch {
      /* sealed with a key that is gone: the output is skipped, the rest still counts */
    }
    return { seq: r.seq, at: r.at, event: r.event, tool: r.tool, input: r.input, output, ok: r.ok === 1 };
  });
}

function session(store: Store, id: string): SessionRow | null {
  return (store.captureDb().prepare("SELECT id, namespace, cwd, distilled_seq, summary_note_id FROM sessions WHERE id = ?").get(id) as SessionRow | undefined) ?? null;
}

/** Words the observation templates themselves add: not concepts. */
const TEMPLATE_WORDS = new Set(["fixed", "failing", "failed", "passes", "changes", "decision", "session", "request", "tests", "test", "edited", "file", "files", "memory", "kept", "appeared", "captured", "committed", "redacted", "stored", "work"]);

function tagsFor(kind: "observation" | "summary", type: string, text: string): string[] {
  const concepts = extractKeywords(text).map((k) => k.replace(/^#/, "")).filter((k) => !TEMPLATE_WORDS.has(k) && !/[/\\`]/.test(k));
  return [kind, `obs.type:${type}`, ...concepts.slice(0, 5).map((k) => `obs.concept:${k}`)];
}

/** Write one capture note; a write the linter holds or refuses is skipped (the linter doing its job), never thrown. */
function write(store: Store, s: SessionRow, kind: "observation" | "summary", type: string, title: string, body: string, files: Observation["files"]): NoteRecord | null {
  try {
    const note = store.create(
      { namespace: s.namespace || DEFAULT_NAMESPACE, title, body, tags: tagsFor(kind, type, `${title} ${body}`), source: CAPTURE_SOURCE },
      { kind, sessionId: s.id, obsType: kind === "observation" ? type : "", skipEdges: true }
    );
    linkFiles(store, note.id, files);
    return note;
  } catch {
    return null;
  }
}

function linkFiles(store: Store, noteId: number, files: Observation["files"]): void {
  const ins = store.captureDb().prepare("INSERT OR IGNORE INTO note_files (note_id, path, action) VALUES (?, ?, ?)");
  for (const f of files.slice(0, 200)) ins.run(noteId, f.path.slice(0, 1000), f.action);
}

/** Pure: the summary text of a whole session. Null when there is nothing worth summarizing. */
export function summarize(events: readonly EventRow[], cwd: string, observationTitles: readonly string[]): { title: string; body: string; files: Observation["files"] } | null {
  const prompts = events.filter((e) => e.event === "user-prompt" && e.input.trim());
  const tools = events.filter((e) => e.event === "post-tool" || e.event === "post-tool-failure");
  if (!prompts.length && !tools.length) return null;
  const changed = new Set<string>();
  const read = new Set<string>();
  const commands: string[] = [];
  const errors: string[] = [];
  let lastTest: { cmd: string; failed: boolean } | null = null;
  let editsSinceCommit = new Set<string>();
  for (const e of tools) {
    const p = field(e.input, "file_path") || field(e.input, "notebook_path") || (READ_TOOLS.has(e.tool) ? field(e.input, "path") : "");
    if (p && EDIT_TOOLS.has(e.tool) && e.ok) {
      changed.add(normPath(p, cwd));
      editsSinceCommit.add(normPath(p, cwd));
    } else if (p && READ_TOOLS.has(e.tool)) read.add(normPath(p, cwd));
    if (!e.ok) errors.push(`${e.tool}: ${one(e.output.split("\n").find((l) => l.trim()) ?? "", 160)}`);
    if (e.tool !== "Bash") continue;
    const cmd = field(e.input, "command");
    if (!cmd) continue;
    const isTest = TEST_CMD.test(cmd);
    const failed = isTest ? testFailed(e) : !e.ok;
    commands.push(`${failed ? "✗" : "✓"} ${one(cmd, 120)}`);
    if (isTest) lastTest = { cmd: one(cmd, 120), failed };
    if (/\bgit\s+(?:-C\s+\S+\s+)?commit\b/.test(cmd) && e.ok) editsSinceCommit = new Set();
  }
  const request = prompts.length ? one(prompts[0].input, 300) : "";
  const lastWords = [...events].reverse().find((e) => (e.event === "stop" || e.event === "session-end") && e.input.trim());
  const outcome = [
    lastTest ? (lastTest.failed ? `tests failing (${lastTest.cmd})` : `tests passing (${lastTest.cmd})`) : "",
    commands.filter((c) => /\bgit\s+(?:-C\s+\S+\s+)?commit\b/.test(c) && c.startsWith("✓")).length ? "changes committed" : "",
  ].filter(Boolean);
  const next = lastTest?.failed
    ? `Fix the failing \`${lastTest.cmd}\`.`
    : editsSinceCommit.size
      ? `Review and commit the changes to ${[...editsSinceCommit].slice(0, 5).join(", ")}.`
      : "";
  const uniq = (xs: string[], n: number): string[] => [...new Set(xs)].slice(0, n);
  const lines = [
    request && `Request: ${request}`,
    (observationTitles.length || lastWords) && `Done: ${[...observationTitles.slice(0, 10), lastWords ? one(lastWords.input, 300) : ""].filter(Boolean).join("; ")}`,
    changed.size && `Files changed: ${uniq([...changed], 30).join(", ")}`,
    read.size && `Files read: ${uniq([...read], 30).join(", ")}`,
    commands.length && `Commands: ${uniq(commands, 15).join(" | ")}`,
    errors.length && `Errors: ${uniq(errors, 5).join(" | ")}`,
    outcome.length && `Outcome: ${outcome.join(", ")}`,
    next && `Next step: ${next}`,
  ].filter(Boolean) as string[];
  const where = cwd.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? "";
  return {
    title: `Session: ${request ? one(request, 80) : `work in ${where || "a project"}`}`,
    body: lines.join("\n"),
    files: [...[...changed].map((path) => ({ path, action: "changed" as const })), ...[...read].map((path) => ({ path, action: "read" as const }))],
  };
}

/**
 * Distill one session: observations for events after distilled_seq, then the session summary (created once, updated
 * after). Returns what was written.
 */
export function distillSession(store: Store, sessionId: string): { observations: number; summaryId: number | null } {
  const s = session(store, sessionId);
  if (!s) return { observations: 0, summaryId: null };
  let written = 0;
  let seq = s.distilled_seq;
  for (;;) {
    const batch = eventsAfter(store, sessionId, seq);
    if (!batch.length) break;
    for (const o of observe(batch, s.cwd)) if (write(store, s, "observation", o.type, o.title, o.body, o.files)) written++;
    seq = batch[batch.length - 1].seq;
    store.captureDb().prepare("UPDATE sessions SET distilled_seq = ? WHERE id = ?").run(seq, sessionId);
    if (batch.length < BATCH) break;
  }
  const all = eventsAfter(store, sessionId, 0, 20_000);
  const titles = store.list({ kinds: ["observation"], sessionId, limit: 50, order: "created_asc", includeDistrusted: true }).notes.map((n) => n.title);
  const sum = summarize(all, s.cwd, titles);
  if (!sum) return { observations: written, summaryId: s.summary_note_id };
  let id = s.summary_note_id;
  const existing = id !== null ? store.read(id) : null; // gate-ok: the capture writer re-reads its own summary note
  try {
    if (existing && existing.kind === "summary") {
      if (existing.body !== sum.body || existing.title !== sum.title) store.update(existing.id, { title: sum.title, body: sum.body });
      linkFiles(store, existing.id, sum.files);
    } else {
      id = write(store, s, "summary", "session", sum.title, sum.body, sum.files)?.id ?? null;
      if (id !== null) store.captureDb().prepare("UPDATE sessions SET summary_note_id = ? WHERE id = ?").run(id, sessionId);
    }
  } catch {
    /* a held or refused update leaves the previous summary in place */
  }
  return { observations: written, summaryId: id };
}

/** Sessions that never got a session-end (a crash, a closed window): distill them and mark them ended. */
export function distillStaleSessions(store: Store, exceptId: string, now = Date.now(), max = 5): number {
  const cutoff = new Date(now - STALE_SESSION_MS).toISOString();
  const rows = store
    .captureDb()
    .prepare(
      `SELECT s.id, (SELECT MAX(at) FROM capture_events e WHERE e.session_id = s.id) AS last FROM sessions s
       WHERE s.ended_at IS NULL AND s.id <> ? AND COALESCE((SELECT MAX(at) FROM capture_events e WHERE e.session_id = s.id), s.started_at) < ?
       LIMIT ?`
    )
    .all(exceptId, cutoff, max) as Array<{ id: string; last: string | null }>;
  for (const r of rows) {
    distillSession(store, r.id);
    store.captureDb().prepare("UPDATE sessions SET ended_at = ? WHERE id = ?").run(r.last ?? cutoff, r.id);
  }
  return rows.length;
}
