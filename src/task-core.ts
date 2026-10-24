// Task primitives shared by the task board (tasks.ts), the runner and the
// runner-status view (liveness.ts): the task <-> note conventions, the approval
// check, and THE one rule for "would this runner run this queued command?".
//
// This module sits BELOW tasks.ts and liveness.ts and imports neither of them:
// that is what removes the old tasks.ts <-> liveness.ts import cycle. Everything
// it exports is re-exported by tasks.ts, so existing imports keep working.
import { createHash, timingSafeEqual } from "node:crypto";
import type { Store, NoteRecord } from "./store.js";
import { RESERVED_TAG_PREFIX } from "./reserved-tags.js";

export const TASK_STATUSES = ["idea", "planned", "running", "blocked", "done", "queued", "failed"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_TAG = "task";

const T = RESERVED_TAG_PREFIX; // "task."
export const TAG_PRIORITY = `${T}priority:`;
export const TAG_DUE = `${T}due:`;
export const TAG_PARENT = `${T}parent:`;
export const TAG_BLOCKED = `${T}blocked_by:`;
export const TAG_CKEY = `${T}ckey:`;
export const TAG_LEASE = `${T}lease:`;
export const TAG_APPROVAL = `${T}approval:`;

export interface TaskCommand {
  action: string;
  params: Record<string, string>;
  /** Runner (machine) name this command is for. Required. */
  target: string;
}

export type ApprovalState = "none" | "approved" | "stale";

export function isTaskNote(n: NoteRecord): boolean {
  return n.tags.includes(TASK_TAG);
}

// ---- Task <-> note ------------------------------------------------------------

export interface TaskState {
  status: TaskStatus;
  owner: string;
  priority: number | null;
  due: string;
  parent: number | null;
  blockedBy: number[];
  lease: { owner: string; expMs: number } | null;
  ckey: string | null;
  approval: string | null; // "<nonce>.<mac>"
}

export function parseLease(tag: string): { owner: string; expMs: number } | null {
  const m = /^(\d{1,16}):(.+)$/.exec(tag);
  return m ? { expMs: Number(m[1]), owner: m[2] } : null;
}

export function stateOf(n: NoteRecord): TaskState {
  const tag = (prefix: string): string | undefined => n.tags.find((t) => t.startsWith(prefix))?.slice(prefix.length);
  const st = tag("status:") ?? "";
  const pr = tag(TAG_PRIORITY);
  const par = tag(TAG_PARENT);
  const lease = tag(TAG_LEASE);
  return {
    status: (TASK_STATUSES as readonly string[]).includes(st) ? (st as TaskStatus) : "idea",
    owner: tag("owner:") ?? "",
    priority: pr !== undefined && /^\d$/.test(pr) ? Number(pr) : null,
    due: tag(TAG_DUE) ?? "",
    parent: par !== undefined && /^\d+$/.test(par) ? Number(par) : null,
    blockedBy: n.tags
      .filter((t) => t.startsWith(TAG_BLOCKED))
      .map((t) => t.slice(TAG_BLOCKED.length))
      .filter((x) => /^\d+$/.test(x))
      .map(Number),
    lease: lease ? parseLease(lease) : null,
    ckey: tag(TAG_CKEY) ?? null,
    approval: tag(TAG_APPROVAL) ?? null,
  };
}

export interface BodyParts {
  nextStep: string;
  command: { action: string; params: Record<string, string>; target: string } | null;
  result: Record<string, unknown> | null;
  notes: string;
}

export function parseBody(body: string): BodyParts {
  const lines = body.split("\n");
  const first = /^Next step:[ \t]*(.*)$/.exec(lines[0] ?? "");
  if (!first) return { nextStep: "", command: null, result: null, notes: body };
  let command: BodyParts["command"] = null;
  let result: BodyParts["result"] = null;
  let i = 1;
  for (; i < lines.length; i++) {
    const m = /^(Command|Result): (.*)$/.exec(lines[i]);
    if (!m) break;
    try {
      const v = JSON.parse(m[2]) as unknown;
      if (v && typeof v === "object" && !Array.isArray(v)) {
        if (m[1] === "Command") {
          const c = v as { action?: unknown; params?: unknown; target?: unknown };
          if (typeof c.action === "string" && typeof c.target === "string") {
            const params: Record<string, string> = {};
            if (c.params && typeof c.params === "object" && !Array.isArray(c.params)) {
              for (const [k, x] of Object.entries(c.params)) if (typeof x === "string") params[k] = x;
            }
            command = { action: c.action, params, target: c.target };
          }
        } else {
          result = v as Record<string, unknown>;
        }
      }
    } catch {
      /* a mangled header is just ignored */
    }
  }
  if (lines[i] === "") i++;
  return { nextStep: first[1].trim(), command, result, notes: lines.slice(i).join("\n") };
}

/** Canonical text of a command, bound into the approval MAC. */
export function commandHash(namespace: string, id: number, c: TaskCommand): string {
  return createHash("sha256")
    .update(JSON.stringify(["onememory-task-cmd-v1", namespace, id, c.action, Object.entries(c.params).sort(), c.target]))
    .digest("hex");
}

/**
 * Is this note's approval tag a valid, current approval of the command it
 * carries? (store-keyed MAC over namespace, id, nonce and the command hash)
 */
export function verifyApproval(store: Store, n: NoteRecord, now = Date.now()): ApprovalState {
  const st = stateOf(n);
  if (!st.approval) return "none";
  const cmd = parseBody(n.body).command;
  const m = APPROVAL_RE.exec(st.approval);
  if (!cmd || !m) return "stale";
  const expMs = Number(m[2]);
  if (!Number.isSafeInteger(expMs) || expMs <= now) return "stale"; // expired approvals die
  try {
    const want = store.approvalMac([n.namespace, String(n.id), m[1], String(expMs), commandHash(n.namespace, n.id, cmd)], false);
    if (want === null) return "stale";
    const a = Buffer.from(want, "hex");
    const b = Buffer.from(m[3], "hex");
    return a.length === b.length && timingSafeEqual(a, b) ? "approved" : "stale";
  } catch {
    return "stale"; // fail closed
  }
}

/** Approval tag: "<nonce16>.<expiry ms>.<mac32>". */
export const APPROVAL_RE = /^([0-9a-f]{16})\.(\d{1,16})\.([0-9a-f]{32})$/;

/** The single-use nonce inside a note's approval tag ("" when none). */
export function approvalNonce(n: NoteRecord): string {
  return APPROVAL_RE.exec(stateOf(n).approval ?? "")?.[1] ?? "";
}

/** One queued command task whose approval is still waiting for the runner, or has lapsed. */
export interface WaitingCommand {
  id: number;
  namespace: string;
  /** The runner (machine) the command is addressed to. */
  target: string;
  /** "waiting" = valid, unexpired approval; "expired" = an approval that lapsed before the runner took it. */
  state: "waiting" | "expired";
  /** When the approval stops (or stopped) being valid, ms since epoch. */
  expires_ms: number;
  /** When the task last changed; for a waiting task that is when it was approved. */
  since: string;
}

/** The runner an approved command is addressed to: its machine name and the one task namespace it serves ("" = command tasks off). */
export interface RunnerIdentity {
  me: string;
  namespace: string;
  /**
   * True for a runner that has not said which namespace it serves (never sent a
   * heartbeat, or an older one): then `namespace` is "" and a command is judged in
   * its own namespace. Status counting only; the runner itself always knows its namespace.
   */
  unconfirmed?: boolean;
}

/**
 * This machine's runner name from the environment. Same rule as the runner's
 * own runnerId() (kept here, outside the runner files, so the server side can
 * use it: the runner is not part of the npm package).
 */
export function envRunnerId(): string {
  return process.env.ONEMEMORY_RUNNER_ID || process.env.COMPUTERNAME || process.env.HOSTNAME || "default";
}

/** The namespace whose command tasks the runner executes, from the environment ("" = off). */
export function envRunnerTaskNamespace(): string {
  return process.env.ONEMEMORY_RUNNER_TASK_NAMESPACE || "";
}

export type SkipReason = "not_command" | "other_namespace" | "other_target" | "unapproved" | "leased" | "distrusted";

export type QueuedVerdict =
  /** The runner may run it now (approval valid, unexpired, addressed to it, not leased, writer not distrusted). */
  | { kind: "runnable"; expires_ms: number; command: { action: string; params: Record<string, string>; target: string } }
  /** A genuine approval (MAC verifies) that lapsed before the runner took the task: an admin must re-approve. */
  | { kind: "expired"; expires_ms: number }
  /** Never runs on this runner: why, for tests and diagnostics. */
  | { kind: "skip"; why: SkipReason };

/**
 * THE one rule for "would this runner run this queued task?", used by the
 * runner's pollTasks and by the waiting-commands status, so they cannot
 * drift: it must be a command task in the runner's task namespace, addressed
 * to this runner, carrying an approval whose MAC verifies, with no live lease,
 * and not written by a writer the namespace's distrust list names (a command
 * from a distrusted writer is NEVER run, whatever its approval says).
 * (The runner's rate window is a runtime limit, not a property of the task.)
 * An approval that is past its time is reported "expired" only if its MAC
 * would have verified -- a forged or edited tag is "unapproved", so it can
 * neither run nor inflate the expired count.
 *
 * `distrusted` lets a caller that classifies many notes load the policy once.
 */
export function classifyQueuedCommand(
  store: Store,
  n: NoteRecord,
  who: RunnerIdentity,
  now: number,
  distrusted: (n: NoteRecord) => boolean = (x) => store.isDistrusted(x)
): QueuedVerdict {
  const cmd = parseBody(n.body).command;
  if (!cmd) return { kind: "skip", why: "not_command" };
  if (who.unconfirmed ? false : !who.namespace || n.namespace !== who.namespace) return { kind: "skip", why: "other_namespace" };
  if (cmd.target !== who.me) return { kind: "skip", why: "other_target" };
  if (distrusted(n)) return { kind: "skip", why: "distrusted" };
  const m = APPROVAL_RE.exec(stateOf(n).approval ?? "");
  if (!m) return { kind: "skip", why: "unapproved" };
  const expMs = Number(m[2]);
  if (!Number.isSafeInteger(expMs)) return { kind: "skip", why: "unapproved" };
  if (expMs <= now) {
    // verifyApproval treats "now" as the instant it is checked: ask it one
    // millisecond before the deadline to test the MAC itself.
    return verifyApproval(store, n, expMs - 1) === "approved" ? { kind: "expired", expires_ms: expMs } : { kind: "skip", why: "unapproved" };
  }
  if (verifyApproval(store, n, now) !== "approved") return { kind: "skip", why: "unapproved" };
  const lease = stateOf(n).lease;
  if (lease && lease.expMs > now) return { kind: "skip", why: "leased" };
  return { kind: "runnable", expires_ms: expMs, command: cmd };
}

/**
 * Read-only: every queued, approved command task in `namespaces` (undefined =
 * whole store, [] = nothing) that the runner for ITS target would run (or whose
 * real approval lapsed), classified by the rule above. `resolve` says which
 * runner a target is (its machine name and the task namespace it serves), so
 * each command is judged against the runner it is addressed to. Command text
 * and params are NOT returned -- ids, namespaces, targets and timing only.
 * `truncated` = the scan stopped at `maxTotal` matches, so the real count may
 * be higher ("at least").
 */
export function scanQueuedCommands(
  store: Store,
  resolve: (target: string) => RunnerIdentity,
  namespaces?: string[],
  now = Date.now(),
  maxTotal = 2_000
): { items: WaitingCommand[]; truncated: boolean } {
  const items: WaitingCommand[] = [];
  if (namespaces && namespaces.length === 0) return { items, truncated: false };
  const rules = store.distrustRules();
  const sid = store.serverId();
  const distrusted = rules.length === 0 ? () => false : (x: NoteRecord) => store.isDistrustedWith(rules, sid, x);
  const page = Math.min(200, Math.max(1, maxTotal));
  let seen = 0;
  for (let offset = 0; ; offset += page) {
    const r = store.list({ namespaces, limit: page, offset, withTags: [TASK_TAG, "status:queued"], withTagPrefix: TAG_APPROVAL });
    for (const n of r.notes) {
      const cmd = parseBody(n.body).command;
      if (!cmd) continue;
      const v = classifyQueuedCommand(store, n, resolve(cmd.target), now, distrusted);
      if (v.kind === "runnable") items.push({ id: n.id, namespace: n.namespace, target: cmd.target, state: "waiting", expires_ms: v.expires_ms, since: n.updated_at });
      else if (v.kind === "expired") items.push({ id: n.id, namespace: n.namespace, target: cmd.target, state: "expired", expires_ms: v.expires_ms, since: n.updated_at });
    }
    seen += r.notes.length;
    if (r.notes.length < page) return { items, truncated: false };
    if (seen >= maxTotal) return { items, truncated: seen < r.total };
  }
}

/** One runner's view: only commands addressed to `who.me` in `who.namespace`. */
export function scanWaitingCommands(
  store: Store,
  who: RunnerIdentity,
  namespaces?: string[],
  now = Date.now(),
  maxTotal = 2_000
): { items: WaitingCommand[]; truncated: boolean } {
  if (!who.namespace) return { items: [], truncated: false };
  if (namespaces && !namespaces.includes(who.namespace)) return { items: [], truncated: false };
  return scanQueuedCommands(store, () => who, [who.namespace], now, maxTotal);
}
