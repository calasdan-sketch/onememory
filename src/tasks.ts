// Task board, session handoffs and the one-call catch-up.
//
// All three are conventions on ordinary notes -- no new table, so they ride
// on everything notes already have: the change feed, namespaces and token
// scopes, at-rest encryption, retention, search, backup/restore and sync.
//
//   task     tags: "task", "status:<idea|planned|running|blocked|done>",
//            optionally "owner:<surface>". Body: "Next step: <one line>",
//            a blank line, then free-form notes.
//   handoff  tags: "handoff", "surface:<who wrote it>". Body: labelled
//            sections (Done / Pending / Decisions), see buildHandoffBody.
//
// Fields are validated here (clear ValidationErrors -> 400 / tool errors) so a
// hand-rolled client can't store a task the board can't read back. Callers
// (REST, MCP, the recall hook) do the token / scope / namespace gating and
// pass the resulting namespaces in; nothing here widens access.
import { Store, ValidationError, type NoteRecord } from "./store.js";
import { runChanges, type ChangesResponse } from "./changes.js";

/** Update of a task that doesn't exist / isn't yours to touch (REST: 404). */
export class TaskNotFoundError extends ValidationError {}

export const TASK_STATUSES = ["idea", "planned", "running", "blocked", "done"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_TAG = "task";
export const HANDOFF_TAG = "handoff";

export const TASK_LIMITS = {
  title: 200,
  nextStep: 500,
  notes: 20_000,
  label: 64, // owner / surface
  summary: 1_000,
  listItems: 25,
  listItem: 500,
  maxList: 200,
};

const LABEL = /^[A-Za-z0-9._@:+ -]{1,64}$/;

export interface Task {
  id: number;
  namespace: string;
  title: string;
  status: TaskStatus;
  owner: string;
  next_step: string;
  notes: string;
  rev: number;
  created_at: string;
  updated_at: string;
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
  return v.replace(/\s+/g, " ").trim();
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

export function isTaskNote(n: NoteRecord): boolean {
  return n.tags.includes(TASK_TAG);
}

function taskBody(nextStep: string, notes: string): string {
  return `Next step: ${nextStep}\n\n${notes}`;
}

/** Note -> Task. Tolerates a hand-edited note (missing tags / header). */
export function taskFromNote(n: NoteRecord): Task {
  const st = n.tags.find((t) => t.startsWith("status:"))?.slice(7) ?? "";
  const owner = n.tags.find((t) => t.startsWith("owner:"))?.slice(6) ?? "";
  let nextStep = "";
  let notes = n.body;
  const m = /^Next step:[ \t]*([^\n]*)(?:\n\n?([\s\S]*))?$/.exec(n.body);
  if (m) {
    nextStep = m[1].trim();
    notes = m[2] ?? "";
  }
  return {
    id: n.id,
    namespace: n.namespace,
    title: n.title,
    status: (TASK_STATUSES as readonly string[]).includes(st) ? (st as TaskStatus) : "idea",
    owner,
    next_step: nextStep,
    notes,
    rev: n.rev,
    created_at: n.created_at,
    updated_at: n.updated_at,
  };
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
): { task: Task; note: NoteRecord } {
  const title = str(input.title, "title");
  const st = status(input.status);
  const nextStepRaw = str(input.next_step, "next_step");
  const nextStep = nextStepRaw === undefined ? undefined : oneLine(nextStepRaw);
  const owner = label(input.owner, "owner");
  const notes = str(input.notes, "notes");
  if (title !== undefined && title.trim().length > TASK_LIMITS.title) {
    throw new ValidationError(`title exceeds ${TASK_LIMITS.title} chars`);
  }
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

  const tagsFor = (base: string[], s: TaskStatus, o: string): string[] => [
    ...base.filter((t) => t !== TASK_TAG && !t.startsWith("status:") && !t.startsWith("owner:")),
    TASK_TAG,
    `status:${s}`,
    ...(o ? [`owner:${o}`] : []),
  ];

  if (input.id !== undefined && input.id !== null) {
    if (!Number.isInteger(input.id) || input.id < 1) throw new ValidationError("id must be a positive integer");
    if (title === undefined && st === undefined && nextStep === undefined && owner === undefined && notes === undefined) {
      throw new ValidationError("nothing to update: pass at least one of title, status, next_step, owner, notes");
    }
    if (title !== undefined && !title.trim()) throw new ValidationError("title cannot be empty");
    const existing = store.read(input.id);
    if (
      !existing ||
      existing.archived_at ||
      !isTaskNote(existing) ||
      (scope.namespace !== undefined && existing.namespace !== scope.namespace)
    ) {
      throw new TaskNotFoundError(`no task with id ${input.id}`);
    }
    const cur = taskFromNote(existing);
    const nextOwner = owner === undefined ? cur.owner : owner;
    const nextStatus = st ?? cur.status;
    const note = store.update(
      input.id,
      {
        title: title === undefined ? undefined : title.trim(),
        body: taskBody(nextStep ?? cur.next_step, notes ?? cur.notes),
        tags: tagsFor(existing.tags, nextStatus, nextOwner),
        source: nextOwner || existing.source || "task",
      },
      { ifRev, lintWarnings }
    );
    if (!note) throw new TaskNotFoundError(`no task with id ${input.id}`);
    return { task: taskFromNote(note), note };
  }

  if (!title || !title.trim()) throw new ValidationError("title is required when creating a task");
  const s = st ?? "idea";
  const o = owner ?? "";
  const note = store.create(
    {
      namespace: scope.namespace ?? ns,
      title: title.trim(),
      body: taskBody(nextStep ?? "", notes ?? ""),
      tags: tagsFor([], s, o),
      source: o || "task",
    },
    { lintWarnings }
  );
  return { task: taskFromNote(note), note };
}

export interface TaskListOpts {
  /** undefined = whole store; [] = nothing readable. */
  namespaces?: string[];
  /** One status, or "all"; default = open (everything except done). */
  status?: string;
  owner?: string;
  limit?: number;
}

export function listTasks(store: Store, opts: TaskListOpts = {}): { tasks: Task[]; total: number } {
  const st = str(opts.status, "status");
  const withTags = [TASK_TAG];
  const withoutTags: string[] = [];
  if (st === undefined || st === "open") withoutTags.push("status:done");
  else if (st !== "all") withTags.push(`status:${status(st)}`);
  const owner = label(opts.owner, "owner");
  if (owner) withTags.push(`owner:${owner}`);
  const limit = Math.min(TASK_LIMITS.maxList, Math.max(1, Math.floor(opts.limit ?? 50) || 50));
  const { notes, total } = store.list({ namespaces: opts.namespaces, limit, withTags, withoutTags });
  return { tasks: notes.map(taskFromNote), total };
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
): { handoff: Handoff; note: NoteRecord } {
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
  const ns = str(input.namespace, "namespace");
  const stamp = new Date().toISOString().slice(0, 16).replace("T", " ") + "Z";
  const note = store.create(
    {
      namespace: scope.namespace ?? ns,
      title: `Handoff from ${surface} (${stamp})`,
      body: buildHandoffBody({ summary, nextStep, done, pending, decisions }),
      tags: [HANDOFF_TAG, `surface:${surface}`],
      source: surface,
    },
    { lintWarnings }
  );
  return { handoff: handoffFromNote(note), note };
}

export function listHandoffs(
  store: Store,
  opts: { namespaces?: string[]; surface?: string; limit?: number } = {}
): Handoff[] {
  const withTags = [HANDOFF_TAG];
  const surface = label(opts.surface, "surface");
  if (surface) withTags.push(`surface:${surface}`);
  const limit = Math.min(50, Math.max(1, Math.floor(opts.limit ?? 3) || 3));
  return store.list({ namespaces: opts.namespaces, limit, withTags }).notes.map(handoffFromNote);
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
}

export const CATCH_UP_SHOWN_CHANGES = 30;
const CATCH_UP_MAX_PAGES = 20;

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
  };
  tasks: { open: Task[]; total: number };
  handoffs: Handoff[];
}

/**
 * Everything a fresh session needs, in one read: what changed since THIS
 * consumer last looked (the "last" marker advances, so the next call shows
 * only newer changes), the open tasks, and the latest handoffs.
 */
export function catchUp(store: Store, opts: CatchUpOpts = {}): CatchUp {
  const out: CatchUp = { tasks: { open: [], total: 0 }, handoffs: [] };
  if (opts.changes !== false) {
    let page = runChanges(store, { since: "last", consumer: opts.consumer, namespaces: opts.namespaces, limit: 500 });
    const first = page;
    const all = [...page.changes];
    // Page to the end so the marker advances past everything reported.
    for (let i = 0; page.nextCursor && i < CATCH_UP_MAX_PAGES; i++) {
      page = runChanges(store, { cursor: page.nextCursor, namespaces: opts.namespaces });
      all.push(...page.changes);
    }
    const recent = all.slice(-CATCH_UP_SHOWN_CHANGES);
    out.changes = {
      consumer: first.consumer ?? "default",
      since: first.since,
      until: first.until,
      counts: first.counts,
      bySource: first.bySource,
      ...(first.markerReset ? { markerReset: true as const } : {}),
      recent,
      omitted: Math.max(0, first.counts.total - recent.length),
    };
  }
  const t = listTasks(store, { namespaces: opts.namespaces, limit: opts.tasks ?? 20 });
  out.tasks = { open: t.tasks, total: t.total };
  out.handoffs = listHandoffs(store, { namespaces: opts.namespaces, limit: opts.handoffs ?? 3 });
  return out;
}

/** Compact text for the SessionStart hook: open tasks + the latest handoff. */
export function buildBoardSummary(tasks: Task[], handoff: Handoff | null, maxChars = 2500): string {
  if (tasks.length === 0 && !handoff) return "";
  const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1) + "…" : s);
  const lines: string[] = [];
  if (tasks.length) {
    lines.push(`Open tasks (${tasks.length}):`);
    for (const t of tasks) {
      lines.push(
        `- #${t.id} [${t.status}] ${clip(t.title, 120)}` +
          (t.owner ? ` (${t.owner})` : "") +
          (t.next_step ? ` -> next: ${clip(t.next_step, 160)}` : "")
      );
    }
  }
  if (handoff) {
    lines.push(`Latest handoff from ${handoff.surface} (${handoff.at.slice(0, 16).replace("T", " ")}Z):`);
    if (handoff.summary) lines.push(`- summary: ${clip(handoff.summary, 240)}`);
    if (handoff.next_step) lines.push(`- next: ${clip(handoff.next_step, 240)}`);
    for (const [k, list] of [["pending", handoff.pending], ["decisions", handoff.decisions]] as const) {
      if (list.length) lines.push(`- ${k}: ${clip(list.join("; "), 300)}`);
    }
  }
  let text = lines.join("\n");
  if (text.length > maxChars) text = text.slice(0, maxChars - 1) + "…";
  return text;
}
