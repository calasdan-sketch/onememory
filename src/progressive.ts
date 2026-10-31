// Progressive disclosure over captured memory, shared by the MCP tools and the REST routes (same answers on both):
//   memory_index    (GET /index)            compact rows: id, kind, type, title, date, files, ~tokens
//   memory_timeline (GET /timeline)         compact rows before and after an anchor, oldest first
//   memory_get      (POST /get)             the full notes (max 20) with their files, session and an `om:#id` citation
//   session_list    (GET /sessions, /sessions/:id) sessions with their summary; one session's observations
//   GET /files/timeline?path=               every row linked to a file, oldest first
// An agent reads the index first (cheap), opens the timeline around what looks relevant, and fetches only the few notes
// it needs. Every read goes through the store's normal filters: the caller passes the namespaces it may read
// (undefined = the whole store, the legacy no-resolution mode) and whether distrusted writers are shown.
import type { Store, NoteRecord, NoteKind } from "./store.js";
import { NOTE_KINDS, ValidationError } from "./store.js";

export interface ReadScope {
  /** Readable namespaces; undefined = every namespace (no namespace resolution). */
  namespaces?: string[];
  includeDistrusted?: boolean;
}

export interface IndexRow {
  id: number;
  kind: NoteKind;
  type: string;
  title: string;
  date: string;
  namespace: string;
  files: string[];
  tokens: number;
}

export interface IndexQuery {
  query?: string;
  kind?: string;
  obs_type?: string;
  file?: string;
  session?: string;
  since?: string;
  limit?: number;
}

export const GET_MAX_IDS = 20;

function kindsOf(kind: string | undefined): readonly NoteKind[] {
  if (!kind || kind === "all") return NOTE_KINDS;
  if (!(NOTE_KINDS as readonly string[]).includes(kind)) throw new ValidationError(`kind must be one of ${NOTE_KINDS.join(", ")} or all`);
  return [kind as NoteKind];
}

function sinceIso(since: string | undefined): string | undefined {
  if (!since) return undefined;
  const t = Date.parse(since);
  if (Number.isNaN(t)) throw new ValidationError("since must be an ISO-8601 date or time");
  return new Date(t).toISOString();
}

const clamp = (v: number | undefined, def: number, max: number): number =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(Math.max(Math.floor(v), 1), max) : def;

function filesOf(store: Store, ids: number[]): Map<number, Array<{ path: string; action: string }>> {
  const out = new Map<number, Array<{ path: string; action: string }>>();
  if (!ids.length) return out;
  const rows = store
    .captureDb()
    .prepare(`SELECT note_id, path, action FROM note_files WHERE note_id IN (${ids.map(() => "?").join(",")}) ORDER BY path`)
    .all(...ids) as Array<{ note_id: number; path: string; action: string }>;
  for (const r of rows) {
    const l = out.get(r.note_id) ?? [];
    l.push({ path: r.path, action: r.action });
    out.set(r.note_id, l);
  }
  return out;
}

export function toRows(store: Store, notes: NoteRecord[]): IndexRow[] {
  const files = filesOf(store, notes.map((n) => n.id));
  return notes.map((n) => ({
    id: n.id,
    kind: n.kind ?? "note",
    type: n.obs_type || n.kind || "note",
    title: n.title,
    date: n.created_at,
    namespace: n.namespace,
    files: [...new Set((files.get(n.id) ?? []).map((f) => f.path))].slice(0, 20),
    tokens: Math.max(1, Math.ceil((n.title.length + n.body.length) / 4)),
    ...(n.distrusted ? { distrusted: true } : {}),
  }));
}

/** Notes matching the filters, newest first (or best match first with a query). */
function find(store: Store, scope: ReadScope, q: IndexQuery & { order?: "created_desc" | "created_asc"; endISO?: string; startISO?: string }, limit: number): NoteRecord[] {
  const f = {
    kinds: kindsOf(q.kind),
    ...(q.obs_type ? { obsTypes: [q.obs_type] } : {}),
    ...(q.session ? { sessionId: q.session } : {}),
    ...(q.file ? { filePath: q.file.replace(/\\/g, "/") } : {}),
    ...(q.since || q.startISO ? { startISO: q.startISO ?? sinceIso(q.since) } : {}),
    ...(q.endISO ? { endISO: q.endISO } : {}),
    ...(scope.includeDistrusted ? { includeDistrusted: true } : {}),
  };
  if (scope.namespaces && scope.namespaces.length === 0) return [];
  let notes: NoteRecord[];
  if (q.query && q.query.trim()) {
    const spaces = scope.namespaces ?? [undefined];
    notes = spaces
      .flatMap((ns) => store.searchRanked(q.query!, { ...f, namespace: ns, limit }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((h) => h.note);
  } else {
    notes = store.list({ ...f, namespaces: scope.namespaces, limit, order: q.order ?? "created_desc" }).notes;
  }
  return scope.includeDistrusted ? store.markDistrusted(notes) : notes;
}

export function memoryIndex(store: Store, scope: ReadScope, q: IndexQuery): { rows: IndexRow[] } {
  return { rows: toRows(store, find(store, scope, q, clamp(q.limit, 30, 200))) };
}

/** A note the caller may read, or null (missing, outside the namespaces, archived, distrusted). */
function readable(store: Store, scope: ReadScope, id: number, track = false): NoteRecord | null {
  const probe = store.read(id); // gate-ok: access probe: readVisible decides before anything is returned
  if (!probe || probe.archived_at) return null;
  if (scope.namespaces && !scope.namespaces.includes(probe.namespace)) return null;
  return store.readVisible(id, { trackAccess: track, includeDistrusted: scope.includeDistrusted === true });
}

export function memoryTimeline(
  store: Store,
  scope: ReadScope,
  q: { anchor?: number; query?: string; file?: string; session?: string; before?: number; after?: number }
): { anchor: number | null; rows: IndexRow[] } {
  const before = clamp(q.before, 5, 50);
  const after = clamp(q.after, 5, 50);
  let anchor: NoteRecord | null = null;
  if (q.anchor !== undefined) anchor = readable(store, scope, q.anchor);
  else if (q.query || q.file || q.session) anchor = find(store, scope, { query: q.query, file: q.file, session: q.session }, 1)[0] ?? null;
  if (!anchor) return { anchor: null, rows: [] };
  const near = { ...scope, namespaces: [anchor.namespace] };
  const sess = q.session ? { session: q.session } : {};
  const older = find(store, near, { ...sess, endISO: anchor.created_at, order: "created_desc" }, before).reverse();
  const newer = find(store, near, { ...sess, startISO: anchor.created_at, order: "created_asc" }, after + 1).filter((n) => n.id !== anchor!.id).slice(0, after);
  return { anchor: anchor.id, rows: toRows(store, [...older, anchor, ...newer]) };
}

interface SessionRow {
  id: string;
  namespace: string;
  cwd: string;
  agent: string;
  started_at: string;
  ended_at: string | null;
  prompt_count: number;
  event_count: number;
  summary_note_id: number | null;
}

function sessionRow(store: Store, scope: ReadScope, id: string): SessionRow | null {
  const r = store.captureDb().prepare("SELECT id, namespace, cwd, agent, started_at, ended_at, prompt_count, event_count, summary_note_id FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;
  if (!r || (scope.namespaces && !scope.namespaces.includes(r.namespace))) return null;
  return { ...r };
}

export function memoryGet(store: Store, scope: ReadScope, ids: unknown): { notes: Array<NoteRecord & { files: Array<{ path: string; action: string }>; session: SessionRow | null; citation: string }>; missing: number[] } {
  if (!Array.isArray(ids) || ids.length === 0 || !ids.every((x) => Number.isInteger(x))) throw new ValidationError("ids must be a non-empty list of note ids");
  if (ids.length > GET_MAX_IDS) throw new ValidationError(`at most ${GET_MAX_IDS} ids per call`);
  const found: NoteRecord[] = [];
  const missing: number[] = [];
  for (const id of [...new Set(ids as number[])]) {
    const n = readable(store, scope, id, true);
    if (n) found.push(n);
    else missing.push(id);
  }
  const files = filesOf(store, found.map((n) => n.id));
  return {
    notes: found.map((n) => ({ ...n, files: files.get(n.id) ?? [], session: n.session_id ? sessionRow(store, scope, n.session_id) : null, citation: `om:#${n.id}` })),
    missing,
  };
}

export function sessionList(store: Store, scope: ReadScope, limit?: number): { sessions: Array<SessionRow & { summary: string | null }> } {
  if (scope.namespaces && scope.namespaces.length === 0) return { sessions: [] };
  const ns = scope.namespaces;
  const rows = store
    .captureDb()
    .prepare(
      `SELECT id, namespace, cwd, agent, started_at, ended_at, prompt_count, event_count, summary_note_id FROM sessions
       ${ns ? `WHERE namespace IN (${ns.map(() => "?").join(",")})` : ""} ORDER BY started_at DESC LIMIT ?`
    )
    .all(...(ns ?? []), clamp(limit, 20, 200)) as unknown as SessionRow[];
  return {
    sessions: rows.map((r) => {
      const sum = r.summary_note_id !== null ? readable(store, scope, r.summary_note_id) : null;
      return { ...r, summary: sum ? sum.title : null };
    }),
  };
}

export function sessionGet(store: Store, scope: ReadScope, id: string): { session: SessionRow; summary: NoteRecord | null; rows: IndexRow[] } | null {
  const s = sessionRow(store, scope, id);
  if (!s) return null;
  const summary = s.summary_note_id !== null ? readable(store, scope, s.summary_note_id) : null;
  return { session: s, summary, rows: toRows(store, find(store, { ...scope, namespaces: [s.namespace] }, { session: id, order: "created_asc" }, 200)) };
}

export function fileTimeline(store: Store, scope: ReadScope, path: string, limit?: number): { path: string; rows: IndexRow[] } {
  if (!path || !path.trim()) throw new ValidationError("path is required");
  return { path, rows: toRows(store, find(store, scope, { file: path, order: "created_asc" }, clamp(limit, 50, 200))) };
}
