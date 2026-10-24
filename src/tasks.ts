// Task board, session handoffs and the one-call catch-up.
//
// All three are conventions on ordinary notes -- no new table, so they ride
// on everything notes already have: the change feed, namespaces and token
// scopes, at-rest encryption, retention, search, backup/restore and sync.
//
//   task     tags: "task", "status:<idea|planned|running|blocked|done|queued|failed>",
//            optionally "owner:<surface>" and the reserved "task.*" tags
//            (priority, due, parent, blocked_by, client key, lease, approval).
//            Body: "Next step: <one line>", optional single-line "Command:" /
//            "Result:" headers, a blank line, then free-form notes.
//   handoff  tags: "handoff", "surface:<who wrote it>". Body: labelled
//            sections (Done / Pending / Decisions), see buildHandoffBody.
//
// The tags `task`, `handoff` and `task.*` are reserved (reserved-tags.ts):
// only this module writes them, so an ordinary note write cannot forge a task,
// a handoff, a lease or an approval.
//
// Fields are validated here (clear ValidationErrors -> 400 / tool errors) so a
// hand-rolled client can't store a task the board can't read back. Callers
// (REST, MCP, the recall hook) do the token / scope / namespace gating and
// pass the resulting namespaces in; nothing here widens access.
import { createHash, timingSafeEqual, randomBytes } from "node:crypto";
import { Store, ValidationError, QuarantinedError, DEFAULT_NAMESPACE, type NoteRecord } from "./store.js";
import { runChanges, type ChangesResponse } from "./changes.js";
import { RESERVED_TAG_PREFIX } from "./reserved-tags.js";
import { runnerNotice } from "./liveness.js";
import {
  TASK_STATUSES,
  TASK_TAG,
  TAG_PRIORITY,
  TAG_DUE,
  TAG_PARENT,
  TAG_BLOCKED,
  TAG_CKEY,
  TAG_LEASE,
  TAG_APPROVAL,
  APPROVAL_RE,
  stateOf,
  parseBody,
  commandHash,
  verifyApproval,
  isTaskNote,
  type TaskStatus,
  type TaskState,
  type BodyParts,
  type TaskCommand,
  type ApprovalState,
} from "./task-core.js";

// The task primitives live in task-core.ts (below this module and liveness.ts,
// which is what keeps those two from importing each other). Re-exported so
// `import { ... } from "./tasks.js"` keeps working.
export {
  TASK_STATUSES,
  TASK_TAG,
  commandHash,
  verifyApproval,
  isTaskNote,
  approvalNonce,
  classifyQueuedCommand,
  scanQueuedCommands,
  scanWaitingCommands,
  waitingCommandTasks,
  envRunnerId,
  envRunnerTaskNamespace,
} from "./task-core.js";
export type { TaskStatus, TaskCommand, ApprovalState, WaitingCommand, RunnerIdentity, QueuedVerdict } from "./task-core.js";

/** Update of a task that doesn't exist / isn't yours to touch (REST: 404). */
export class TaskNotFoundError extends ValidationError {}

/** task_claim: someone else holds an unexpired lease (REST: 409). */
export class ClaimConflictError extends ValidationError {
  constructor(
    message: string,
    readonly holder: string,
    readonly until: string
  ) {
    super(message);
  }
}

export const HANDOFF_TAG = "handoff";

const T = RESERVED_TAG_PREFIX; // "task."

export const TASK_LIMITS = {
  title: 200,
  nextStep: 500,
  notes: 20_000,
  label: 64, // owner / surface
  summary: 1_000,
  listItems: 25,
  listItem: 500,
  maxList: 200,
  clientKey: 128,
  blockedBy: 20,
  priorityMax: 9,
  ttlMin: 5,
  ttlMax: 86_400,
  ttlDefault: 300,
  commandParams: 20,
  commandValue: 500,
  resultOutput: 4_000,
};

const LABEL = /^[A-Za-z0-9._@:+ -]{1,64}$/;
const CLIENT_KEY = /^[A-Za-z0-9._:@/+=-]{1,128}$/;
// C0/C1 controls (incl. ESC, tab, newline), DEL, line/paragraph separators
// and bidi/zero-width formatting characters.
// eslint-disable-next-line no-control-regex
const CONTROLS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/;
// eslint-disable-next-line no-control-regex
const CONTROLS_G = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;

export interface Task {
  id: number;
  namespace: string;
  title: string;
  status: TaskStatus;
  owner: string;
  next_step: string;
  notes: string;
  priority: number | null;
  due: string;
  parent_id: number | null;
  blocked_by: number[];
  /** Active lease (expired leases read as null). */
  lease: { owner: string; expires_at: string } | null;
  /** Command tasks only (see docs/tasks.md "Command tasks"). */
  command: TaskCommand | null;
  approval: ApprovalState;
  /** sha256 of the command as stored (what task_approve must echo back); null without a command. */
  command_hash: string | null;
  /** When the current approval stops being valid (ISO), or null. */
  approval_expires_at: string | null;
  result: Record<string, unknown> | null;
  rev: number;
  /** Server-stamped last writer of this task (token label / stdio / cli / server); "" = unknown. */
  written_by: string;
  /** `<server_id>/<written_by>`: the writer's stable id ("" = unknown). Always set by the server. */
  writer_id?: string;
  /** Server-stamped creator of this task; "" = unknown. */
  created_by: string;
  /** True only when a read opted in with include_distrusted and the writer is on the distrust list. */
  distrusted?: true;
  created_at: string;
  updated_at: string;
}

/** The compact shape catch_up and the board use: no notes, no command params. */
export type TaskSummary = Pick<
  Task,
  "id" | "namespace" | "title" | "status" | "owner" | "next_step" | "priority" | "due" | "parent_id" | "blocked_by" | "rev" | "written_by" | "writer_id" | "distrusted" | "updated_at"
>;

export function compactTask(t: Task): TaskSummary {
  return {
    id: t.id,
    namespace: t.namespace,
    title: t.title,
    status: t.status,
    owner: t.owner,
    next_step: t.next_step,
    priority: t.priority,
    due: t.due,
    parent_id: t.parent_id,
    blocked_by: t.blocked_by,
    rev: t.rev,
    written_by: t.written_by,
    writer_id: t.writer_id,
    ...(t.distrusted ? { distrusted: true as const } : {}),
    updated_at: t.updated_at,
  };
}

export interface TaskInput {
  id?: number;
  namespace?: string;
  title?: string;
  status?: string;
  next_step?: string;
  owner?: string;
  notes?: string;
  if_rev?: number;
  /** null clears. */
  priority?: number | null;
  /** YYYY-MM-DD or an ISO time; "" / null clears. */
  due?: string | null;
  /** Parent task id; null clears. */
  parent_id?: number | null;
  /** Task ids that must finish first; [] clears. */
  blocked_by?: number[];
  /** Idempotency key for create: same key + namespace returns the existing task. */
  client_key?: string;
  /** Command task: {action, params}; null removes the command. Needs `target`. */
  command?: { action?: unknown; params?: unknown } | null;
  /** Runner name the command is for (must equal the runner's own id). */
  target?: string;
}

/** Where a write may land: set when the caller is pinned to one namespace. */
export interface WriteScope {
  namespace?: string;
}

function str(v: unknown, name: string): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new ValidationError(`${name} must be a string`);
  return v;
}

function oneLine(v: string): string {
  return v.replace(CONTROLS_G, " ").replace(/\s+/g, " ").trim();
}

/** Collapse whitespace and drop control characters: safe to print on one line. */
export function safeLine(v: unknown): string {
  return oneLine(String(v ?? ""));
}

function label(v: unknown, name: string): string | undefined {
  const s = str(v, name);
  if (s === undefined) return undefined;
  const t = s.trim();
  if (t === "") return "";
  if (!LABEL.test(t)) {
    throw new ValidationError(`${name} must be 1-${TASK_LIMITS.label} characters of letters, digits, space . _ @ : + -`);
  }
  return t;
}

function status(v: unknown): TaskStatus | undefined {
  const s = str(v, "status");
  if (s === undefined) return undefined;
  if (!(TASK_STATUSES as readonly string[]).includes(s)) {
    throw new ValidationError(`status must be one of ${TASK_STATUSES.join(", ")}`);
  }
  return s as TaskStatus;
}

function intOrNull(v: unknown, name: string): number | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1) throw new ValidationError(`${name} must be a positive integer`);
  return v;
}

/** YYYY-MM-DD that exists on the calendar (2026-02-31 does not). */
function realDate(ymd: string): boolean {
  const ms = Date.parse(ymd + "T00:00:00Z");
  return !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === ymd;
}

function normDue(v: unknown): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  if (typeof v !== "string") throw new ValidationError("due must be a string (YYYY-MM-DD or an ISO time)");
  const t = v.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) {
    if (!realDate(t)) throw new ValidationError("due is not a real calendar date");
    return t;
  }
  if (!/^\d{4}-\d{2}-\d{2}T/.test(t) || Number.isNaN(Date.parse(t))) {
    throw new ValidationError("due must be YYYY-MM-DD or an ISO-8601 time");
  }
  if (!realDate(t.slice(0, 10))) throw new ValidationError("due is not a real calendar date");
  return new Date(t).toISOString();
}

// ---- Task <-> note ------------------------------------------------------------

function tagsFromState(base: readonly string[], s: TaskState): string[] {
  const keep = base.filter(
    (t) => t !== TASK_TAG && !t.startsWith("status:") && !t.startsWith("owner:") && !t.startsWith(T)
  );
  return [
    ...keep,
    TASK_TAG,
    `status:${s.status}`,
    ...(s.owner ? [`owner:${s.owner}`] : []),
    ...(s.priority !== null ? [`${TAG_PRIORITY}${s.priority}`] : []),
    ...(s.due ? [`${TAG_DUE}${s.due}`] : []),
    ...(s.parent !== null ? [`${TAG_PARENT}${s.parent}`] : []),
    ...[...new Set(s.blockedBy)].sort((a, b) => a - b).map((id) => `${TAG_BLOCKED}${id}`),
    ...(s.lease ? [`${TAG_LEASE}${s.lease.expMs}:${s.lease.owner}`] : []),
    ...(s.ckey ? [`${TAG_CKEY}${s.ckey}`] : []),
    ...(s.approval ? [`${TAG_APPROVAL}${s.approval}`] : []),
  ];
}

function taskBody(p: BodyParts): string {
  const head = [`Next step: ${p.nextStep}`];
  if (p.command) head.push(`Command: ${JSON.stringify({ action: p.command.action, params: p.command.params, target: p.command.target })}`);
  if (p.result) head.push(`Result: ${JSON.stringify(p.result)}`);
  return `${head.join("\n")}\n\n${p.notes}`;
}

/** How long an approval stays valid (ONEMEMORY_APPROVAL_TTL_SECONDS, default 24 h, 60 s - 30 d). */
export function approvalTtlMs(): number {
  const raw = Number(process.env.ONEMEMORY_APPROVAL_TTL_SECONDS);
  const sec = Number.isFinite(raw) && raw > 0 ? Math.min(30 * 86_400, Math.max(60, Math.floor(raw))) : 86_400;
  return sec * 1000;
}

/** Max queued command tasks per namespace (ONEMEMORY_TASK_COMMAND_QUOTA, default 100). */
export function commandQuota(): number {
  const raw = Number(process.env.ONEMEMORY_TASK_COMMAND_QUOTA);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 100;
}

/** Note -> Task. Tolerates a hand-edited note (missing tags / header). */
export function taskFromNote(n: NoteRecord, store?: Store, now = Date.now()): Task {
  const st = stateOf(n);
  const body = parseBody(n.body);
  const lease = st.lease && st.lease.expMs > now ? { owner: st.lease.owner, expires_at: new Date(st.lease.expMs).toISOString() } : null;
  return {
    id: n.id,
    namespace: n.namespace,
    title: n.title,
    status: st.status,
    owner: st.owner,
    next_step: body.nextStep,
    notes: body.notes,
    priority: st.priority,
    due: st.due,
    parent_id: st.parent,
    blocked_by: st.blockedBy,
    lease,
    command: body.command,
    approval: store ? verifyApproval(store, n, now) : st.approval ? "stale" : "none",
    command_hash: body.command ? commandHash(n.namespace, n.id, body.command) : null,
    approval_expires_at: (() => {
      const e = st.approval ? Number(APPROVAL_RE.exec(st.approval)?.[2]) : NaN;
      return Number.isSafeInteger(e) ? new Date(e).toISOString() : null;
    })(),
    result: body.result,
    rev: n.rev,
    written_by: n.written_by,
    writer_id: n.writer_id ?? "",
    created_by: n.created_by,
    ...(n.distrusted ? { distrusted: true as const } : {}),
    created_at: n.created_at,
    updated_at: n.updated_at,
  };
}

// ---- Create / update ------------------------------------------------------------

function validateTitle(v: string): string {
  if (CONTROLS.test(v)) throw new ValidationError("title cannot contain line breaks or control characters");
  const t = v.trim();
  if (t.length > TASK_LIMITS.title) throw new ValidationError(`title exceeds ${TASK_LIMITS.title} chars`);
  return t;
}

function validateCommand(raw: TaskInput["command"]): { action: string; params: Record<string, string> } | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) throw new ValidationError("command must be an object {action, params}");
  const action = raw.action;
  if (typeof action !== "string" || !/^[A-Za-z0-9_.:-]{1,64}$/.test(action)) {
    throw new ValidationError("command.action must be 1-64 characters of letters, digits and . _ : -");
  }
  const params: Record<string, string> = {};
  if (raw.params !== undefined && raw.params !== null) {
    if (typeof raw.params !== "object" || Array.isArray(raw.params)) throw new ValidationError("command.params must be an object of strings");
    const entries = Object.entries(raw.params as Record<string, unknown>);
    if (entries.length > TASK_LIMITS.commandParams) throw new ValidationError(`command.params has too many entries (max ${TASK_LIMITS.commandParams})`);
    for (const [k, v] of entries) {
      if (!/^\w{1,64}$/.test(k)) throw new ValidationError("command.params names must be 1-64 word characters");
      if (typeof v !== "string") throw new ValidationError(`command.params.${k} must be a string`);
      if (v.length > TASK_LIMITS.commandValue || CONTROLS.test(v)) {
        throw new ValidationError(`command.params.${k} is too long or contains control characters`);
      }
      params[k] = v;
    }
  }
  return { action, params };
}

function validateTarget(v: unknown): string | undefined {
  const s = str(v, "target");
  if (s === undefined) return undefined;
  const t = s.trim();
  if (!/^[A-Za-z0-9._@-]{1,64}$/.test(t)) throw new ValidationError("target must be 1-64 characters of letters, digits, . _ @ -");
  return t;
}

/** Turn a caller's idempotency key into the stored tag value (never stored raw). */
function ckeyTag(namespace: string, key: string): string {
  return createHash("sha256").update(`onememory-ckey-v1\0${namespace}\0${key}`).digest("hex").slice(0, 24);
}

function clientKey(v: unknown): string | undefined {
  const s = str(v, "client_key");
  if (s === undefined) return undefined;
  if (!CLIENT_KEY.test(s)) {
    throw new ValidationError(`client_key must be 1-${TASK_LIMITS.clientKey} characters of letters, digits and . _ : @ / + = -`);
  }
  return s;
}

/** A task other than `selfId`, alive, in `ns`: a valid parent / blocker. */
function requireTaskRef(store: Store, id: number, ns: string, selfId: number | null, what: string): NoteRecord {
  if (selfId !== null && id === selfId) throw new ValidationError(`${what}: a task cannot reference itself`);
  const n = store.read(id);
  if (!n || n.archived_at || !isTaskNote(n) || n.namespace !== ns) {
    throw new ValidationError(`${what}: no task with id ${id} in this namespace`);
  }
  return n;
}

function assertNoCycle(store: Store, selfId: number, parentId: number): void {
  let cur: number | null = parentId;
  for (let i = 0; cur !== null && i < 64; i++) {
    if (cur === selfId) throw new ValidationError("parent_id would create a cycle");
    const n = store.read(cur);
    cur = n ? stateOf(n).parent : null;
  }
}

/** Run fn in one write transaction, but let a quarantine (which is a stored result) commit. */
function inTransaction<T>(store: Store, fn: () => T): T {
  let quarantined: QuarantinedError | null = null;
  const out = store.transaction(() => {
    try {
      return fn();
    } catch (e) {
      if (e instanceof QuarantinedError) {
        quarantined = e;
        return undefined as unknown as T;
      }
      throw e;
    }
  });
  if (quarantined) throw quarantined;
  return out;
}

export interface PutTaskResult {
  task: Task;
  note: NoteRecord;
  /** client_key matched an existing task: nothing was written. */
  replayed?: true;
}

/**
 * Create a task, or update one by id (only fields you pass change). An
 * update only ever touches notes that are tasks and live in the caller's
 * writable namespace; anything else reports the same "no task" so ids in
 * other namespaces can't be probed.
 */
export function putTask(
  store: Store,
  input: TaskInput,
  scope: WriteScope = {},
  lintWarnings?: import("./lint.js").LintFinding[]
): PutTaskResult {
  const titleRaw = str(input.title, "title");
  const title = titleRaw === undefined ? undefined : validateTitle(titleRaw);
  const st = status(input.status);
  const nextStepRaw = str(input.next_step, "next_step");
  const nextStep = nextStepRaw === undefined ? undefined : oneLine(nextStepRaw);
  const owner = label(input.owner, "owner");
  const notes = str(input.notes, "notes");
  if (nextStep !== undefined && nextStep.length > TASK_LIMITS.nextStep) {
    throw new ValidationError(`next_step exceeds ${TASK_LIMITS.nextStep} chars`);
  }
  if (notes !== undefined && notes.length > TASK_LIMITS.notes) {
    throw new ValidationError(`notes exceeds ${TASK_LIMITS.notes} chars`);
  }
  let ifRev: number | undefined;
  if (input.if_rev !== undefined && input.if_rev !== null) {
    if (!Number.isInteger(input.if_rev) || input.if_rev < 1) {
      throw new ValidationError("if_rev must be a positive integer");
    }
    ifRev = input.if_rev;
  }
  const ns = str(input.namespace, "namespace");
  const priority = (() => {
    if (input.priority === undefined) return undefined;
    if (input.priority === null) return null;
    if (typeof input.priority !== "number" || !Number.isInteger(input.priority) || input.priority < 0 || input.priority > TASK_LIMITS.priorityMax) {
      throw new ValidationError(`priority must be a whole number 0-${TASK_LIMITS.priorityMax} (or null to clear)`);
    }
    return input.priority;
  })();
  const due = normDue(input.due);
  const parentId = intOrNull(input.parent_id, "parent_id");
  let blockedBy: number[] | undefined;
  if (input.blocked_by !== undefined) {
    if (!Array.isArray(input.blocked_by) || input.blocked_by.length > TASK_LIMITS.blockedBy) {
      throw new ValidationError(`blocked_by must be a list of at most ${TASK_LIMITS.blockedBy} task ids`);
    }
    blockedBy = input.blocked_by.map((x) => {
      if (typeof x !== "number" || !Number.isInteger(x) || x < 1) throw new ValidationError("blocked_by must be a list of positive integers");
      return x;
    });
  }
  const key = clientKey(input.client_key);
  const target = validateTarget(input.target);
  const cmd = validateCommand(input.command);

  if (input.id !== undefined && input.id !== null) {
    if (!Number.isInteger(input.id) || input.id < 1) throw new ValidationError("id must be a positive integer");
    if (key !== undefined) throw new ValidationError("client_key applies to creating a task; use if_rev to guard an update");
    if (
      title === undefined && st === undefined && nextStep === undefined && owner === undefined && notes === undefined &&
      priority === undefined && due === undefined && parentId === undefined && blockedBy === undefined &&
      cmd === undefined && target === undefined
    ) {
      throw new ValidationError("nothing to update: pass at least one of title, status, next_step, owner, notes, priority, due, parent_id, blocked_by, command");
    }
    if (title !== undefined && !title) throw new ValidationError("title cannot be empty");
    const existing = store.read(input.id);
    if (
      !existing ||
      existing.archived_at ||
      !isTaskNote(existing) ||
      (scope.namespace !== undefined && existing.namespace !== scope.namespace)
    ) {
      throw new TaskNotFoundError(`no task with id ${input.id}`);
    }
    const cur = stateOf(existing);
    const curBody = parseBody(existing.body);
    const next: TaskState = { ...cur };
    if (owner !== undefined) {
      const lease = cur.lease && cur.lease.expMs > Date.now() ? cur.lease : null;
      if (lease && owner !== lease.owner) {
        throw new ClaimConflictError(
          `task #${existing.id} is claimed by "${lease.owner}" until ${new Date(lease.expMs).toISOString()}; ask them to release it`,
          lease.owner,
          new Date(lease.expMs).toISOString()
        );
      }
      next.owner = owner;
    }
    if (st !== undefined) next.status = st;
    if (priority !== undefined) next.priority = priority;
    if (due !== undefined) next.due = due ?? "";
    if (parentId !== undefined) {
      if (parentId !== null) {
        requireTaskRef(store, parentId, existing.namespace, existing.id, "parent_id");
        assertNoCycle(store, existing.id, parentId);
      }
      next.parent = parentId;
    }
    if (blockedBy !== undefined) {
      for (const b of blockedBy) requireTaskRef(store, b, existing.namespace, existing.id, "blocked_by");
      next.blockedBy = blockedBy;
    }
    if (next.lease && next.lease.expMs <= Date.now()) next.lease = null; // expired leases are dropped on write
    // Command / target edits. Any change to the command, its target, or a
    // re-queue voids the approval (it is also bound to a hash of the command,
    // so a text edit that bypassed this still fails at the runner).
    let command = curBody.command;
    let commandTouched = false;
    if (cmd === null) {
      if (command) commandTouched = true;
      command = null;
    } else if (cmd) {
      const tgt = target ?? command?.target;
      if (!tgt) throw new ValidationError("a command needs a `target`: the runner name that may execute it");
      command = { action: cmd.action, params: cmd.params, target: tgt };
      commandTouched = true;
    } else if (target !== undefined && command) {
      if (target !== command.target) commandTouched = true;
      command = { ...command, target };
    }
    if (commandTouched && command) next.status = "queued";
    if (command && next.status === "queued" && cur.status !== "queued") assertCommandQuota(store, existing.namespace, existing.id);
    else if (commandTouched && command && !curBody.command) assertCommandQuota(store, existing.namespace, existing.id);
    if (commandTouched && !command && next.status === "queued") next.status = "idea";
    if (commandTouched || (next.status === "queued" && cur.status !== "queued") || !command) next.approval = null;
    const note = store.update(
      input.id,
      {
        title,
        body: taskBody({
          nextStep: nextStep ?? curBody.nextStep,
          command,
          result: commandTouched ? null : curBody.result,
          notes: notes ?? curBody.notes,
        }),
        tags: tagsFromState(existing.tags, next),
        source: next.owner || "task",
      },
      { ifRev, lintWarnings }
    );
    if (!note) throw new TaskNotFoundError(`no task with id ${input.id}`);
    return { task: taskFromNote(note, store), note };
  }

  // ---- create ----
  if (!title) throw new ValidationError("title is required when creating a task");
  const namespace = (scope.namespace ?? ns)?.trim() || DEFAULT_NAMESPACE;
  const s0: TaskState = {
    status: cmd ? "queued" : st ?? "idea",
    owner: owner ?? "",
    priority: priority ?? null,
    due: due ?? "",
    parent: null,
    blockedBy: [],
    lease: null,
    ckey: key ? ckeyTag(namespace, key) : null,
    approval: null,
  };
  if (cmd && !target) throw new ValidationError("a command needs a `target`: the runner name that may execute it");
  if (cmd && st !== undefined && st !== "queued") {
    throw new ValidationError("a command task is always created with status queued");
  }
  if (cmd === undefined && target !== undefined) throw new ValidationError("target only applies to a command task");
  if (parentId !== undefined && parentId !== null) {
    requireTaskRef(store, parentId, namespace, null, "parent_id");
    s0.parent = parentId;
  }
  if (blockedBy !== undefined) {
    for (const b of blockedBy) requireTaskRef(store, b, namespace, null, "blocked_by");
    s0.blockedBy = blockedBy;
  }
  const command: BodyParts["command"] = cmd ? { action: cmd.action, params: cmd.params, target: target! } : null;
  if (command) assertCommandQuota(store, namespace, null);
  const doCreate = (): NoteRecord =>
    store.create(
      {
        namespace,
        title,
        body: taskBody({ nextStep: nextStep ?? "", command, result: null, notes: notes ?? "" }),
        tags: tagsFromState([], s0),
        source: s0.owner || "task",
      },
      { lintWarnings }
    );
  if (!key) {
    const note = doCreate();
    return { task: taskFromNote(note, store), note };
  }
  // Idempotent create: look up and create under ONE write lock, so two
  // retries (even from two processes) cannot both create.
  let replay = false;
  const note = inTransaction(store, () => {
    // includeDistrusted: an idempotent retry must find its own task even if the writer was distrusted since.
    const hit = store.list({ namespace, limit: 1, withTags: [TASK_TAG, `${TAG_CKEY}${s0.ckey}`], includeDistrusted: true }).notes[0];
    if (hit) {
      replay = true;
      return hit;
    }
    return doCreate();
  });
  return { task: taskFromNote(note, store), note, ...(replay ? { replayed: true as const } : {}) };
}

/**
 * Per-namespace cap on queued command tasks, so one write token cannot bury
 * the admin's approval queue (or the runner) under thousands of them.
 */
function assertCommandQuota(store: Store, namespace: string, exceptId: number | null): void {
  const quota = commandQuota();
  let n = 0;
  const page = 500;
  for (let offset = 0; ; offset += page) {
    // Distrusted tasks still count against the quota: a hidden task must not be a way round it.
    const r = store.list({ namespace, limit: page, offset, withTags: [TASK_TAG, "status:queued"], includeDistrusted: true });
    for (const x of r.notes) if (x.id !== exceptId && parseBody(x.body).command !== null) n++;
    if (n >= quota || r.notes.length < page) break;
  }
  if (n >= quota) {
    throw new ValidationError(
      `too many queued command tasks in namespace "${namespace}" (limit ${quota}); wait for the runner or have an admin clear some`
    );
  }
}

export interface TaskListOpts {
  /** undefined = whole store; [] = nothing readable. */
  namespaces?: string[];
  /** One status, or "all"; default = open (everything except done). */
  status?: string;
  owner?: string;
  parent_id?: number;
  limit?: number;
  /** Only tasks whose server-stamped content writer is exactly this. */
  writtenBy?: string;
  /** Skip tasks whose server-stamped content writer is this. */
  notWrittenBy?: string;
  /** Also list tasks whose writer is on the distrust list (marked `distrusted`). Default: they are left out. */
  includeDistrusted?: boolean;
}

export function listTasks(store: Store, opts: TaskListOpts = {}): { tasks: Task[]; total: number } {
  const st = str(opts.status, "status");
  const withTags = [TASK_TAG];
  const withoutTags: string[] = [];
  if (st === undefined || st === "open") withoutTags.push("status:done");
  else if (st !== "all") withTags.push(`status:${status(st)}`);
  const owner = label(opts.owner, "owner");
  if (owner) withTags.push(`owner:${owner}`);
  if (opts.parent_id !== undefined) withTags.push(`${TAG_PARENT}${intOrNull(opts.parent_id, "parent_id")}`);
  const limit = Math.min(TASK_LIMITS.maxList, Math.max(1, Math.floor(opts.limit ?? 50) || 50));
  const { notes, total } = store.list({
    namespaces: opts.namespaces,
    limit,
    withTags,
    withoutTags,
    writtenBy: opts.writtenBy,
    notWrittenBy: opts.notWrittenBy,
    includeDistrusted: opts.includeDistrusted,
  });
  const shown = opts.includeDistrusted ? store.markDistrusted(notes) : notes;
  return { tasks: shown.map((n) => taskFromNote(n, store)), total };
}

/** The refusal for acting on a task a distrusted writer wrote. */
function distrustedTaskError(id: number): ValidationError {
  return new ValidationError(
    `task #${id} was written by a writer on this namespace's distrust list; it cannot be claimed or approved. ` +
      "An admin can review it (include_distrusted) and, if it is fine, rewrite it under a trusted writer or take the writer off the list."
  );
}

/**
 * One task, in full (notes, command, result). Same visibility rules as
 * listTasks: a task from a distrusted writer reads as "not found" unless
 * `includeDistrusted` (then it comes back marked `distrusted: true`).
 */
export function getTask(store: Store, id: number, namespaces?: string[], opts: { includeDistrusted?: boolean } = {}): Task {
  if (!Number.isInteger(id) || id < 1) throw new ValidationError("id must be a positive integer");
  const n = store.read(id);
  if (!n || n.archived_at || !isTaskNote(n) || (namespaces !== undefined && !namespaces.includes(n.namespace))) {
    throw new TaskNotFoundError(`no task with id ${id}`);
  }
  const flagged = store.markDistrusted([n])[0];
  if (flagged.distrusted && !opts.includeDistrusted) throw new TaskNotFoundError(`no task with id ${id}`);
  return taskFromNote(opts.includeDistrusted ? flagged : n, store);
}

// ---- Claim / lease --------------------------------------------------------------

export interface ClaimInput {
  id: number;
  owner: string;
  ttl_seconds?: number;
  /** Give the lease up (only the holder can). */
  release?: boolean;
}

/**
 * Cooperative lease on a task, with compare-and-swap semantics: the check and
 * the write are one rev-guarded UPDATE, so two sessions racing for the same
 * task cannot both win. Claiming a task you already hold extends it
 * (heartbeat). An expired lease can be taken by anyone. Release is by the holder.
 */
export function claimTask(
  store: Store,
  input: ClaimInput,
  scope: WriteScope = {},
  now = Date.now()
): { task: Task; heartbeat: boolean; released: boolean } {
  if (!Number.isInteger(input.id) || input.id < 1) throw new ValidationError("id must be a positive integer");
  const owner = label(input.owner, "owner");
  if (!owner) throw new ValidationError("owner is required: who is taking the task");
  let ttl = TASK_LIMITS.ttlDefault;
  if (input.ttl_seconds !== undefined && input.ttl_seconds !== null) {
    if (!Number.isInteger(input.ttl_seconds) || input.ttl_seconds < TASK_LIMITS.ttlMin || input.ttl_seconds > TASK_LIMITS.ttlMax) {
      throw new ValidationError(`ttl_seconds must be a whole number from ${TASK_LIMITS.ttlMin} to ${TASK_LIMITS.ttlMax}`);
    }
    ttl = input.ttl_seconds;
  }
  for (let attempt = 0; attempt < 5; attempt++) {
    const existing = store.read(input.id);
    if (
      !existing ||
      existing.archived_at ||
      !isTaskNote(existing) ||
      (scope.namespace !== undefined && existing.namespace !== scope.namespace)
    ) {
      throw new TaskNotFoundError(`no task with id ${input.id}`);
    }
    // A task a distrusted writer wrote is not for the board to hand out (a holder may still let go of a lease).
    if (!input.release && store.isDistrusted(existing)) throw distrustedTaskError(existing.id);
    const cur = stateOf(existing);
    if (parseBody(existing.body).command && !input.release) {
      throw new ValidationError(
        `task #${existing.id} is a command task: only the runner works on it, so it cannot be claimed (an admin approval clears any lease)`
      );
    }
    if (cur.status === "done" && !input.release) {
      throw new ValidationError(`task #${existing.id} is already done; reopen it with task_put before claiming it`);
    }
    const live = cur.lease && cur.lease.expMs > now ? cur.lease : null;
    const next: TaskState = { ...cur, lease: null };
    let heartbeat = false;
    let released = false;
    if (input.release) {
      if (live && live.owner !== owner) {
        throw new ClaimConflictError(
          `task #${existing.id} is claimed by "${live.owner}" until ${new Date(live.expMs).toISOString()}; only the holder can release it`,
          live.owner,
          new Date(live.expMs).toISOString()
        );
      }
      released = true;
      if (live && cur.owner === owner) next.owner = "";
    } else {
      if (live && live.owner !== owner) {
        throw new ClaimConflictError(
          `task #${existing.id} is already claimed by "${live.owner}" until ${new Date(live.expMs).toISOString()}`,
          live.owner,
          new Date(live.expMs).toISOString()
        );
      }
      heartbeat = Boolean(live);
      next.lease = { owner, expMs: now + ttl * 1000 };
      next.owner = owner;
      if (next.status === "idea" || next.status === "planned") next.status = "running";
    }
    try {
      const note = store.update(
        existing.id,
        { tags: tagsFromState(existing.tags, next), source: next.owner || "task" },
        { ifRev: existing.rev }
      );
      if (!note) throw new TaskNotFoundError(`no task with id ${input.id}`);
      return { task: taskFromNote(note, store, now), heartbeat, released };
    } catch (e) {
      if (e instanceof ValidationError && e.message.startsWith("stale write:")) continue; // lost a race: re-read and re-decide
      throw e;
    }
  }
  throw new ValidationError(`task #${input.id} is being changed too quickly; retry`);
}

// ---- Command tasks: approval and results ------------------------------------------

/**
 * Approve (or revoke approval of) a command task. The caller MUST have
 * checked admin scope: this is the explicit human gate in front of the
 * runner. The approval is a MAC, keyed by a secret only this store holds, over
 * the namespace, task id, a fresh single-use nonce and a hash of the command
 * -- so it cannot be copied to another task, survives no edit to the command,
 * and cannot be forged by anyone who can only write notes.
 */
export function approveTask(
  store: Store,
  input: {
    id: number;
    revoke?: boolean;
    /** What the admin read (Task.command_hash). Approving requires this or if_rev. */
    command_hash?: string;
    /** Or: the revision the admin read (Task.rev). */
    if_rev?: number;
  },
  scope: WriteScope = {}
): Task {
  if (!Number.isInteger(input.id) || input.id < 1) throw new ValidationError("id must be a positive integer");
  const existing = store.read(input.id);
  if (
    !existing ||
    existing.archived_at ||
    !isTaskNote(existing) ||
    (scope.namespace !== undefined && existing.namespace !== scope.namespace)
  ) {
    throw new TaskNotFoundError(`no task with id ${input.id}`);
  }
  // Never put the admin gate in front of a command a distrusted writer wrote.
  if (!input.revoke && store.isDistrusted(existing)) throw distrustedTaskError(existing.id);
  const cur = stateOf(existing);
  const cmd = parseBody(existing.body).command;
  const next: TaskState = { ...cur, lease: null }; // approving or revoking also clears any lease
  if (input.revoke) next.approval = null;
  else {
    if (!cmd) throw new ValidationError("this task has no command to approve");
    if (cur.status !== "queued") throw new ValidationError(`only a queued command task can be approved (this one is ${cur.status})`);
    if (input.command_hash === undefined && input.if_rev === undefined) {
      throw new ValidationError(
        "approving needs `command_hash` (or `if_rev`) from the task you read (task_get): you approve exactly what you saw, not whatever is stored now"
      );
    }
    if (input.if_rev !== undefined) {
      if (!Number.isInteger(input.if_rev) || input.if_rev < 1) throw new ValidationError("if_rev must be a positive integer");
      if (input.if_rev !== existing.rev) {
        throw new ValidationError(`stale approval: task #${existing.id} changed since you read it (rev ${existing.rev}, you saw ${input.if_rev}); read it again`);
      }
    }
    const hash = commandHash(existing.namespace, existing.id, cmd);
    if (input.command_hash !== undefined) {
      const a = Buffer.from(String(input.command_hash));
      const b = Buffer.from(hash);
      if (a.length !== b.length || !timingSafeEqual(a, b)) {
        throw new ValidationError(`stale approval: the command of task #${existing.id} is not the one you read (command_hash mismatch); read it again`);
      }
    }
    const nonce = randomBytes(8).toString("hex");
    const expMs = Date.now() + approvalTtlMs();
    next.approval = `${nonce}.${expMs}.${store.approvalMac([existing.namespace, String(existing.id), nonce, String(expMs), hash])}`;
  }
  const note = store.update(
    existing.id,
    { tags: tagsFromState(existing.tags, next) },
    { ifRev: existing.rev }
  );
  if (!note) throw new TaskNotFoundError(`no task with id ${input.id}`);
  return taskFromNote(note, store);
}

/**
 * Runner side: queued command tasks in one namespace that carry an approval
 * tag (approval is verified by the caller). Filtered in SQL and paged until
 * exhausted, so a pile of unapproved tasks cannot push an approved one out of
 * the window. Newest first.
 */
export function queuedCommandTasks(store: Store, namespace: string, maxTotal = 2_000): NoteRecord[] {
  const out: NoteRecord[] = [];
  const page = 200;
  for (let offset = 0; offset < maxTotal; offset += page) {
    const r = store.list({ namespace, limit: page, offset, withTags: [TASK_TAG, "status:queued"], withTagPrefix: TAG_APPROVAL });
    for (const n of r.notes) if (parseBody(n.body).command !== null) out.push(n);
    if (r.notes.length < page) break;
  }
  return out;
}

/**
 * Runner side: queued -> running, only if the task is still at `rev` (CAS).
 * The approval is CONSUMED in this same write, before anything executes: a
 * crash (or a lost local ledger) can never replay it.
 */
export function markCommandRunning(store: Store, n: NoteRecord): NoteRecord | null {
  try {
    return store.update(n.id, { tags: tagsFromState(n.tags, { ...stateOf(n), status: "running", approval: null }) }, { ifRev: n.rev });
  } catch (e) {
    if (e instanceof ValidationError) return null; // edited meanwhile: not ours to run
    throw e;
  }
}

/** Runner side: record how a command task ended. */
export function finishCommandTask(
  store: Store,
  id: number,
  outcome: { ok: boolean; status: string; exit_code?: number | null; output?: string; reason?: string }
): void {
  const n = store.read(id);
  if (!n || !isTaskNote(n)) return;
  const body = parseBody(n.body);
  const result: Record<string, unknown> = {
    status: outcome.status,
    finished_at: new Date().toISOString(),
    ...(outcome.exit_code !== undefined ? { exit_code: outcome.exit_code } : {}),
    ...(outcome.reason ? { reason: safeLine(outcome.reason).slice(0, 500) } : {}),
    ...(outcome.output ? { output: outcome.output.slice(0, TASK_LIMITS.resultOutput) } : {}),
  };
  const write = (r: Record<string, unknown>): void => {
    store.update(
      id,
      {
        body: taskBody({ ...body, result: r }),
        // The approval is single-use: it is consumed by the run.
        tags: tagsFromState(n.tags, { ...stateOf(n), status: outcome.ok ? "done" : "failed", approval: null }),
      },
      // The outcome is bookkeeping: whoever wrote the command stays its writer.
      { keepWriter: true }
    );
  };
  try {
    write(result);
  } catch (e) {
    // e.g. the output tripped the secret scanner: keep the outcome, drop the text.
    const { output: _drop, ...rest } = result;
    write({ ...rest, output_withheld: e instanceof Error ? safeLine(e.message).slice(0, 200) : "not storable" });
  }
}

// ---- Handoffs ---------------------------------------------------------------

export interface HandoffInput {
  namespace?: string;
  surface?: string;
  summary?: string;
  done?: string[];
  pending?: string[];
  decisions?: string[];
  next_step?: string;
  /** Idempotency key: same key + namespace returns the existing handoff. */
  client_key?: string;
}

export interface Handoff {
  id: number;
  namespace: string;
  surface: string;
  at: string;
  summary: string;
  next_step: string;
  done: string[];
  pending: string[];
  decisions: string[];
  /** Server-stamped writer of this handoff (token label / stdio / cli / server); "" = unknown. `surface` is only the writer's claim. */
  written_by: string;
  /** `<server_id>/<written_by>` ("" = unknown). Always set by the server. */
  writer_id?: string;
  /** True only when a read opted in with include_distrusted and the writer is on the distrust list. */
  distrusted?: true;
}

function items(v: unknown, name: string): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new ValidationError(`${name} must be a list of strings`);
  if (v.length > TASK_LIMITS.listItems) throw new ValidationError(`${name} has too many items (max ${TASK_LIMITS.listItems})`);
  const out: string[] = [];
  for (const x of v) {
    if (typeof x !== "string") throw new ValidationError(`${name} must be a list of strings`);
    const t = oneLine(x);
    if (!t) continue;
    if (t.length > TASK_LIMITS.listItem) throw new ValidationError(`an item in ${name} exceeds ${TASK_LIMITS.listItem} chars`);
    out.push(t);
  }
  return out;
}

function buildHandoffBody(h: { summary: string; nextStep: string; done: string[]; pending: string[]; decisions: string[] }): string {
  const lines: string[] = [];
  if (h.summary) lines.push(`Summary: ${h.summary}`);
  if (h.nextStep) lines.push(`Next step: ${h.nextStep}`);
  for (const [name, list] of [["Done", h.done], ["Pending", h.pending], ["Decisions", h.decisions]] as const) {
    if (list.length) lines.push("", `${name}:`, ...list.map((x) => `- ${x}`));
  }
  return lines.join("\n").trim();
}

/** Note -> Handoff. Tolerates a hand-edited body (fields it can't find stay empty). */
export function handoffFromNote(n: NoteRecord): Handoff {
  const out: Handoff = {
    id: n.id,
    namespace: n.namespace,
    surface: n.tags.find((t) => t.startsWith("surface:"))?.slice(8) ?? n.source,
    at: n.created_at,
    summary: "",
    next_step: "",
    done: [],
    pending: [],
    decisions: [],
    written_by: n.written_by,
    writer_id: n.writer_id ?? "",
    ...(n.distrusted ? { distrusted: true as const } : {}),
  };
  let section: "done" | "pending" | "decisions" | null = null;
  for (const raw of n.body.split("\n")) {
    const line = raw.trimEnd();
    let m: RegExpExecArray | null;
    if ((m = /^Summary:\s*(.*)$/.exec(line))) out.summary = m[1];
    else if ((m = /^Next step:\s*(.*)$/.exec(line))) out.next_step = m[1];
    else if (/^Done:$/.test(line)) section = "done";
    else if (/^Pending:$/.test(line)) section = "pending";
    else if (/^Decisions:$/.test(line)) section = "decisions";
    else if (section && (m = /^- (.*)$/.exec(line))) out[section].push(m[1]);
  }
  return out;
}

export function writeHandoff(
  store: Store,
  input: HandoffInput,
  scope: WriteScope = {},
  lintWarnings?: import("./lint.js").LintFinding[]
): { handoff: Handoff; note: NoteRecord; replayed?: true } {
  const surface = label(input.surface, "surface");
  if (!surface) throw new ValidationError("surface is required: which device, chat or model is handing off");
  const summaryRaw = str(input.summary, "summary");
  const summary = summaryRaw === undefined ? "" : oneLine(summaryRaw);
  if (summary.length > TASK_LIMITS.summary) throw new ValidationError(`summary exceeds ${TASK_LIMITS.summary} chars`);
  const nsRaw = str(input.next_step, "next_step");
  const nextStep = nsRaw === undefined ? "" : oneLine(nsRaw);
  if (nextStep.length > TASK_LIMITS.nextStep) throw new ValidationError(`next_step exceeds ${TASK_LIMITS.nextStep} chars`);
  const done = items(input.done, "done");
  const pending = items(input.pending, "pending");
  const decisions = items(input.decisions, "decisions");
  if (!summary && !nextStep && !done.length && !pending.length && !decisions.length) {
    throw new ValidationError("a handoff needs something in it: summary, next_step, done, pending or decisions");
  }
  const key = clientKey(input.client_key);
  const ns = str(input.namespace, "namespace");
  const namespace = (scope.namespace ?? ns)?.trim() || DEFAULT_NAMESPACE;
  const stamp = new Date().toISOString().slice(0, 16).replace("T", " ") + "Z";
  const ck = key ? ckeyTag(namespace, key) : null;
  const doCreate = (): NoteRecord =>
    store.create(
      {
        namespace,
        title: `Handoff from ${surface} (${stamp})`,
        body: buildHandoffBody({ summary, nextStep, done, pending, decisions }),
        tags: [HANDOFF_TAG, `surface:${surface}`, ...(ck ? [`${TAG_CKEY}${ck}`] : [])],
        source: surface,
      },
      { lintWarnings }
    );
  if (!ck) {
    const note = doCreate();
    return { handoff: handoffFromNote(note), note };
  }
  let replay = false;
  const note = inTransaction(store, () => {
    const hit = store.list({ namespace, limit: 1, withTags: [HANDOFF_TAG, `${TAG_CKEY}${ck}`], includeDistrusted: true }).notes[0];
    if (hit) {
      replay = true;
      return hit;
    }
    return doCreate();
  });
  return { handoff: handoffFromNote(note), note, ...(replay ? { replayed: true as const } : {}) };
}

export function listHandoffs(
  store: Store,
  opts: {
    namespaces?: string[];
    surface?: string;
    limit?: number;
    writtenBy?: string;
    notWrittenBy?: string;
    /** Also list handoffs from distrusted writers (marked `distrusted`). Default: left out. */
    includeDistrusted?: boolean;
  } = {}
): Handoff[] {
  const withTags = [HANDOFF_TAG];
  const surface = label(opts.surface, "surface");
  if (surface) withTags.push(`surface:${surface}`);
  const limit = Math.min(50, Math.max(1, Math.floor(opts.limit ?? 3) || 3));
  const { notes } = store.list({
    namespaces: opts.namespaces,
    limit,
    withTags,
    writtenBy: opts.writtenBy,
    notWrittenBy: opts.notWrittenBy,
    includeDistrusted: opts.includeDistrusted,
  });
  return (opts.includeDistrusted ? store.markDistrusted(notes) : notes).map(handoffFromNote);
}

// ---- Catch-up ---------------------------------------------------------------

export interface CatchUpOpts {
  namespaces?: string[];
  /** "last" marker label for the changes part; default "default". */
  consumer?: string;
  /** false skips the changes part (and leaves the marker alone). */
  changes?: boolean;
  tasks?: number;
  handoffs?: number;
  /** "manual": the marker moves only when `ack_token` comes back (see changes.ts). */
  ackMode?: "auto" | "manual";
  ackToken?: string;
  excludeSelf?: boolean;
  /** Only changes / tasks / handoffs whose writer is exactly this (changes: the change's own writer). */
  writtenBy?: string;
  /** Skip those written by this writer (changes: the change's own writer; also notes it touched via merge / attestation). */
  notWrittenBy?: string;
  /** Changes only: filter on the note's CURRENT writer (tasks and handoffs are notes, so their `writtenBy` already is that). */
  noteWrittenBy?: string;
  notNoteWrittenBy?: string;
  /** Include changes, tasks and handoffs from writers on the distrust list (marked `distrusted`). Default: left out. */
  includeDistrusted?: boolean;
}

export const CATCH_UP_SHOWN_CHANGES = 30;

export interface CatchUp {
  changes?: {
    consumer: string;
    since: string;
    until: string;
    counts: ChangesResponse["counts"];
    bySource: ChangesResponse["bySource"];
    markerReset?: true;
    /** Newest changes (titles only); `counts` covers the whole window. */
    recent: ChangesResponse["changes"];
    omitted: number;
    ack_token?: string;
    acked?: true;
  };
  /** Compact tasks: title / status / owner / next step -- fetch one with task_get. */
  tasks: { open: TaskSummary[]; total: number };
  handoffs: Handoff[];
  /** One line, present only when approved commands are waiting and the runner looks offline (see liveness.ts). */
  runner_notice?: string;
}

/**
 * Everything a fresh session needs, in one read: what changed since THIS
 * consumer last looked, the open tasks (compact), and the latest handoffs.
 * The changes part is ONE tail query over the whole gap -- however many
 * thousand changes piled up, `recent` is the true newest and `counts` the
 * true totals -- and the marker moves to the end of that window (or, in
 * manual ack mode, when the returned ack_token comes back).
 */
export function catchUp(store: Store, opts: CatchUpOpts = {}): CatchUp {
  const out: CatchUp = { tasks: { open: [], total: 0 }, handoffs: [] };
  if (opts.changes !== false) {
    const r = runChanges(store, {
      since: "last",
      consumer: opts.consumer,
      namespaces: opts.namespaces,
      tail: CATCH_UP_SHOWN_CHANGES,
      ackMode: opts.ackMode,
      ackToken: opts.ackToken,
      excludeSelf: opts.excludeSelf,
      writtenBy: opts.writtenBy,
      notWrittenBy: opts.notWrittenBy,
      noteWrittenBy: opts.noteWrittenBy,
      notNoteWrittenBy: opts.notNoteWrittenBy,
      includeDistrusted: opts.includeDistrusted,
    });
    out.changes = {
      consumer: r.consumer ?? "default",
      since: r.since,
      until: r.until,
      counts: r.counts,
      bySource: r.bySource,
      ...(r.markerReset ? { markerReset: true as const } : {}),
      recent: r.changes,
      omitted: Math.max(0, r.counts.total - r.changes.length),
      ...(r.ack_token ? { ack_token: r.ack_token } : {}),
      ...(r.acked ? { acked: true as const } : {}),
    };
  } else if (opts.ackToken) {
    throw new ValidationError("ack_token needs the changes part (include_changes) so the consumer's marker can be read");
  }
  const wf = { writtenBy: opts.writtenBy, notWrittenBy: opts.notWrittenBy, includeDistrusted: opts.includeDistrusted };
  const t = listTasks(store, { namespaces: opts.namespaces, limit: opts.tasks ?? 20, ...wf });
  out.tasks = { open: t.tasks.map(compactTask), total: t.total };
  out.handoffs = listHandoffs(store, { namespaces: opts.namespaces, limit: opts.handoffs ?? 3, ...wf });
  // Returns at once when no approved command is queued (see runnerNotice): the
  // common case costs one cheap probe, not a heartbeat read and a classifier pass.
  const notice = runnerNotice(store, opts.namespaces);
  if (notice) out.runner_notice = notice;
  return out;
}

/**
 * Compact text for the SessionStart hook: open tasks + the latest handoff.
 * Every field is untrusted (anyone with a write token wrote it), so each is
 * reduced to one printable line first: no line breaks, no control or ESC
 * characters, so a title can't forge extra lines or terminal escapes. Each
 * section has its OWN budget, so a long task list can never cut the handoff.
 */
export function buildBoardSummary(
  tasks: Array<Pick<Task, "id" | "status" | "title" | "owner" | "next_step">>,
  handoff: Handoff | null,
  maxChars = 2500,
  totalTasks?: number
): string {
  if (tasks.length === 0 && !handoff) return "";
  const clip = (s: unknown, n: number): string => {
    const v = safeLine(s);
    return v.length > n ? v.slice(0, n - 1) + "…" : v;
  };
  const taskBudget = Math.floor(maxChars * 0.6);
  const handoffBudget = maxChars - taskBudget - 1;
  const sections: string[] = [];
  if (tasks.length) {
    const total = Math.max(totalTasks ?? tasks.length, tasks.length);
    const lines: string[] = [];
    let used = 0;
    let shown = 0;
    for (const t of tasks) {
      const line =
        `- #${t.id} [${clip(t.status, 12)}] ${clip(t.title, 100)}` +
        (t.owner ? ` (${clip(t.owner, 40)})` : "") +
        (t.next_step ? ` -> next: ${clip(t.next_step, 120)}` : "");
      if (used + line.length + 1 > taskBudget - 60) break;
      lines.push(line);
      used += line.length + 1;
      shown++;
    }
    const more = total - shown;
    sections.push(
      [`Open tasks (${total}${more > 0 ? `, showing ${shown}` : ""}):`, ...lines, ...(more > 0 ? [`- … and ${more} more (task_list)`] : [])].join("\n")
    );
  }
  if (handoff) {
    const lines = [`Latest handoff from ${clip(handoff.surface, 40)} (${clip(handoff.at.slice(0, 16).replace("T", " "), 20)}Z):`];
    if (handoff.summary) lines.push(`- summary: ${clip(handoff.summary, 240)}`);
    if (handoff.next_step) lines.push(`- next: ${clip(handoff.next_step, 240)}`);
    for (const [k, list] of [["pending", handoff.pending], ["decisions", handoff.decisions]] as const) {
      if (list.length) lines.push(`- ${k}: ${clip(list.join("; "), 300)}`);
    }
    let text = lines.join("\n");
    if (text.length > handoffBudget) text = text.slice(0, handoffBudget - 1) + "…";
    sections.push(text);
  }
  return sections.join("\n");
}
