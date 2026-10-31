// Replacing a memory, safely (1.6.0).
//
// One module that every surface (REST, the MCP tools, the CLI) goes through, so the guarantees cannot differ between them:
//
//   1. A replacement is TWO steps. `supersedePreview` writes nothing at all and returns a plain-language warning plus a
//      one-time confirmation code. `supersedeConfirm` is the only code that changes anything, and it needs a valid code.
//   2. The code is signed (HMAC with a per-store secret), expires in minutes, is bound to the exact notes AND their revisions
//      AND a hash of the exact replacement text AND the caller, and works once (a spent-code table that is written in the same
//      transaction as the replacement itself).
//   3. Nothing is deleted. The old note is archived and marked superseded (kept whole); `supersedeUndo` brings it back.
//   4. Trust guard: a writer on the distrust list, or a replacement that claims LESS confidence than the note it hides, is
//      refused unless the caller holds the admin scope AND acknowledges the red flag when confirming.
//   5. Errors never say more than "no note with id N" about notes the caller may not touch, in any namespace.
import { createHash, randomBytes } from "node:crypto";
import { currentWriter } from "./actor.js";
import { type Scope } from "./config.js";
import { scopeAllows } from "./security.js";
import { annotateStaleness } from "./staleness.js";
import { assertPlainWriteTags, isReservedTag } from "./reserved-tags.js";
import { Store, ValidationError, StaleWriteError, validateConfidence, type NoteRecord, type HistoryEntry } from "./store.js";
import { PREVIEW_MAX_OLD, type SupersedeReplacementInput } from "./supersede-shared.js";
import { blockedText, doneText, previewText, safe, type PreviewFlags, type PreviewNote } from "./supersede-text.js";

export { PREVIEW_MAX_OLD, type SupersedeReplacementInput } from "./supersede-shared.js";

const TOKEN_DOMAIN = "supersede-v1";
const SNIPPET_PREVIEW = 600;

/** How long a confirmation code lives (seconds). ONEMEMORY_SUPERSEDE_TTL_SECONDS, 30 to 3600, default 600. */
export function supersedeTtlSeconds(): number {
  const n = Number((process.env.ONEMEMORY_SUPERSEDE_TTL_SECONDS ?? "").trim());
  return Number.isFinite(n) && n > 0 ? Math.min(Math.max(Math.floor(n), 1), 3600) : 600;
}

/** A refusal with an HTTP-ish status and, for a hard "not allowed", the plain-language reason. */
export class SupersedeError extends ValidationError {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409 | 410 = 400,
    readonly warning?: string
  ) {
    super(message);
  }
}

/** Who is asking. `ownNamespace` set = confined to that tenant (token pin / server namespace); unset = unconfined. */
export interface Caller {
  scope: Scope;
  ownNamespace?: string;
  /** Override for tests and the CLI; normally the server-stamped writer of the current call. */
  writer?: string;
}

const writerOf = (c: Caller): string => c.writer ?? currentWriter();

/** A short fingerprint of WHO is asking; a code made for one caller is useless to another. */
function callerKey(c: Caller): string {
  return createHash("sha256").update(JSON.stringify([writerOf(c), c.scope, c.ownNamespace ?? "*"])).digest("hex").slice(0, 24);
}

const missing = (_id: number): SupersedeError => new SupersedeError("no note with that number", 404);

/** The note, if this caller may change it (and see it): else the same "no note" whether it is missing, hidden or another tenant's. */
function writable(store: Store, c: Caller, id: number): NoteRecord {
  const n = store.readVisible(id, { includeDistrusted: scopeAllows(c.scope, "admin") });
  if (!n) throw missing(id);
  if (c.ownNamespace !== undefined && n.namespace !== c.ownNamespace) throw missing(id);
  return n;
}

function hashContent(r: { title: string; body: string; tags: string[]; confidence?: number | null }): string {
  return createHash("sha256")
    .update(JSON.stringify([r.title, r.body, [...r.tags].sort(), r.confidence ?? null]))
    .digest("hex")
    .slice(0, 32);
}

function parseIds(raw: unknown): number[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new SupersedeError("old_ids must list the note number(s) to replace");
  if (raw.length > PREVIEW_MAX_OLD) throw new SupersedeError(`replace at most ${PREVIEW_MAX_OLD} notes at a time`);
  const ids = raw.map((x) => (typeof x === "string" && /^\d+$/.test(x.trim()) ? Number(x) : x));
  if (!ids.every((x) => Number.isInteger(x) && (x as number) > 0)) throw new SupersedeError("old_ids must be whole note numbers");
  if (new Set(ids).size !== ids.length) throw new SupersedeError("a note number is listed twice");
  return ids as number[];
}

function describeOld(store: Store, n: NoteRecord, staleFlag: boolean): PreviewNote {
  return {
    id: n.id,
    rev: n.rev,
    title: n.title,
    snippet: safe(n.body, SNIPPET_PREVIEW),
    chars: n.body.length,
    written_by: n.written_by,
    created_by: n.created_by,
    created_at: n.created_at,
    updated_at: n.updated_at,
    tags: n.tags,
    ...(typeof n.confidence === "number" ? { confidence: n.confidence, confidence_claimed_by: n.confidence_claimed_by ?? "" } : {}),
    similar_notes: store.neighbourCount(n.id),
    dependent_tasks: store.taskDependents(n.id, n.namespace),
    earlier_replaced: store.supersededBy(n.id).length,
    stale: staleFlag,
    ...(n.attested_writer ? { verified_writer: n.attested_writer } : {}),
  };
}

/** The facts behind the red flags, recomputed at preview AND at confirm (the distrust list may change in between). */
function assess(store: Store, c: Caller, olds: NoteRecord[], replacement: { confidence?: number | null }): PreviewFlags {
  const me = writerOf(c);
  const ns = olds[0].namespace;
  const replacerDistrusted = me !== "" && store.isDistrusted({ namespace: ns, written_by: me });
  const lower =
    typeof replacement.confidence === "number" &&
    olds.some((o) => typeof o.confidence === "number" && (replacement.confidence as number) < (o.confidence as number));
  const others = [...new Set(olds.map((o) => o.written_by).filter((w) => w && w !== me))];
  return {
    replacer_distrusted: replacerDistrusted,
    lower_confidence: lower,
    other_writers: others,
    verified_notes: olds.filter((o) => o.attested_writer).map((o) => o.id),
    needs_admin_ack: replacerDistrusted || lower,
  };
}

export interface SupersedePreview {
  ok: true;
  /** The plain-language "Are you sure?" text. Show it to the person, in full, before asking them to confirm. */
  warning: string;
  /** The one-time confirmation code. Pass it to confirm. */
  token: string;
  expires_at: string;
  expires_in_seconds: number;
  /** True when confirming must also say acknowledge_risk (an administrator, after a red flag). */
  requires_acknowledgement: boolean;
  notes_to_retire: PreviewNote[];
  replacement: { kind: "new" | "existing"; id?: number; title: string; chars: number; tags: string[]; confidence?: number };
  flags: PreviewFlags;
  /** How many notes will be replaced: the number a person types to confirm in the terminal. */
  count: number;
}

/** Step 1. Reads only. Nothing is written, nothing is reserved, no note is touched. */
export function supersedePreview(
  store: Store,
  caller: Caller,
  req: { old_ids: unknown; new_note?: SupersedeReplacementInput | null; new_id?: unknown },
  howToConfirm = 'To go ahead, confirm with this code: {token}'
): SupersedePreview {
  if (!scopeAllows(caller.scope, "write")) throw new SupersedeError("replacing a note needs a write or admin token", 403);
  const ids = parseIds(req.old_ids);
  const hasNew = req.new_note !== undefined && req.new_note !== null;
  const hasId = req.new_id !== undefined && req.new_id !== null;
  if (hasNew === hasId) throw new SupersedeError("give exactly one of new_note (a new note to write) or new_id (a note that already exists)");

  const olds = ids.map((id) => writable(store, caller, id));
  const ns = olds[0].namespace;
  for (const o of olds) {
    if (o.namespace !== ns) throw new SupersedeError("notes from different namespaces cannot be replaced together");
    if (o.superseded_by !== undefined) throw new SupersedeError(`note ${o.id} was already replaced by note ${o.superseded_by}`, 409);
    if (o.archived_at) throw new SupersedeError(`note ${o.id} is archived, not a live note, so there is nothing to replace`, 409);
    if (o.tags.some(isReservedTag)) throw new SupersedeError(`note ${o.id} is a task, a handoff or captured work; those are managed by their own tools, not replaced`);
  }

  let replacementView: SupersedePreview["replacement"];
  let content: { title: string; body: string; tags: string[]; confidence?: number | null };
  let newId = 0;
  let newRev = 0;
  if (hasId) {
    const nid = req.new_id;
    if (typeof nid !== "number" || !Number.isInteger(nid) || nid < 1) throw new SupersedeError("new_id must be a whole note number");
    if (ids.includes(nid)) throw new SupersedeError("a note cannot replace itself");
    const target = writable(store, caller, nid);
    if (target.namespace !== ns) throw new SupersedeError("the replacing note must be in the same namespace");
    if (target.superseded_by !== undefined || target.archived_at) throw new SupersedeError(`note ${nid} is not a live note, so it cannot take the place of another`, 409);
    if (target.tags.some(isReservedTag)) throw new SupersedeError(`note ${nid} is a task, a handoff or captured work and cannot replace a note`);
    if (store.isDistrusted(target)) throw new SupersedeError("a note from a writer on the distrust list cannot replace another note", 403);
    newId = nid;
    newRev = target.rev;
    content = { title: target.title, body: target.body, tags: target.tags, confidence: target.confidence ?? null };
    replacementView = { kind: "existing", id: nid, title: target.title, chars: target.body.length, tags: target.tags, ...(typeof target.confidence === "number" ? { confidence: target.confidence } : {}) };
  } else {
    const nn = req.new_note as SupersedeReplacementInput;
    if (!nn || typeof nn !== "object" || typeof nn.title !== "string" || !nn.title.trim()) throw new SupersedeError("new_note needs a title");
    if (nn.body !== undefined && typeof nn.body !== "string") throw new SupersedeError("new_note.body must be text");
    if (nn.tags !== undefined && (!Array.isArray(nn.tags) || nn.tags.some((t) => typeof t !== "string"))) throw new SupersedeError("new_note.tags must be a list of text");
    validateConfidence(nn.confidence);
    assertPlainWriteTags(nn.tags);
    content = { title: nn.title, body: nn.body ?? "", tags: nn.tags ?? [], confidence: typeof nn.confidence === "number" ? nn.confidence : null };
    // The linter's verdict, before a code is issued: a text that would be refused or held must not get a "go ahead".
    const lint = store.lintDryRun(content);
    if (lint.status === "held") {
      throw new SupersedeError("the new text would be held for an administrator's review by the memory checker, so it cannot replace anything yet", 409);
    }
    replacementView = {
      kind: "new",
      title: content.title,
      chars: content.body.length,
      tags: content.tags,
      ...(typeof nn.confidence === "number" ? { confidence: nn.confidence } : {}),
    };
  }

  const flags = assess(store, caller, olds, { confidence: content.confidence ?? undefined });
  const isAdmin = scopeAllows(caller.scope, "admin");
  if (flags.needs_admin_ack && !isAdmin) {
    const why = flags.replacer_distrusted && flags.lower_confidence ? "both" : flags.replacer_distrusted ? "distrusted" : "lower_confidence";
    throw new SupersedeError("this replacement needs an administrator", 403, blockedText(why, writerOf(caller)));
  }

  const now = Date.now();
  const ttl = supersedeTtlSeconds();
  const expMs = now + ttl * 1000;
  const nonce = randomBytes(12).toString("hex");
  const token = store.mintToken(TOKEN_DOMAIN, {
    o: olds.map((o) => [o.id, o.rev]),
    ni: newId,
    nr: newRev,
    h: hashContent(content),
    k: callerKey(caller),
    n: ns,
    e: expMs,
    x: nonce,
    r: flags.needs_admin_ack ? 1 : 0,
  });

  const notes = olds.map((o) => describeOld(store, o, annotateStaleness(o).stale));
  const how = flags.needs_admin_ack ? howToConfirm.replace("{token}", token) + "\n(You must also say you accept the red flag above: acknowledge_risk.)" : howToConfirm.replace("{token}", token);
  const warning = previewText({
    notes,
    replacement: { kind: replacementView.kind, id: replacementView.id, title: content.title, snippet: safe(content.body, SNIPPET_PREVIEW), chars: content.body.length, tags: content.tags, confidence: content.confidence ?? undefined },
    flags,
    replacer: writerOf(caller) || "you",
    expiresInSeconds: ttl,
    howToConfirm: how,
  });
  return {
    ok: true,
    warning,
    token,
    expires_at: new Date(expMs).toISOString(),
    expires_in_seconds: ttl,
    requires_acknowledgement: flags.needs_admin_ack,
    notes_to_retire: notes,
    replacement: replacementView,
    flags,
    count: olds.length,
  };
}

export interface SupersedeResult {
  ok: true;
  message: string;
  retired: Array<{ id: number; title: string; status: "superseded"; superseded_by: number }>;
  replacement: NoteRecord;
  created_replacement: boolean;
}

/** Step 2. The ONLY path that retires a note. Needs a valid, unexpired, unused code made for this caller. */
export function supersedeConfirm(
  store: Store,
  caller: Caller,
  req: { token: unknown; new_note?: SupersedeReplacementInput | null; acknowledge_risk?: unknown }
): SupersedeResult {
  if (!scopeAllows(caller.scope, "write")) throw new SupersedeError("replacing a note needs a write or admin token", 403);
  if (typeof req.token !== "string" || !req.token) throw new SupersedeError("a confirmation code from the preview is required", 400);
  // ONE message for a damaged code, a made-up code, and a real code made for somebody else (or for another tenant), and the caller is
  // checked BEFORE the expiry and the used-check, so a code that is not yours tells you nothing, not even whether it is still good.
  const notValid = (): SupersedeError => new SupersedeError("that is not a valid confirmation code (it may have been copied wrongly); run the preview again", 400);
  const t = store.openToken(TOKEN_DOMAIN, req.token);
  if (!t || t.k !== callerKey(caller)) throw notValid();
  const exp = Number(t.e);
  if (!Number.isFinite(exp) || Date.now() > exp) throw new SupersedeError("that confirmation code has expired; run the preview again", 410);
  const nonce = String(t.x ?? "");
  if (!/^[0-9a-f]{24}$/.test(nonce)) throw notValid();
  if (store.tokenSpent(nonce)) throw new SupersedeError("that confirmation code was already used; run the preview again if you still want to replace", 410);

  const oldPairs = Array.isArray(t.o) ? (t.o as unknown[]).map((p) => (Array.isArray(p) ? [Number(p[0]), Number(p[1])] : [NaN, NaN])) : [];
  if (oldPairs.length === 0 || oldPairs.some((p) => !Number.isInteger(p[0]) || !Number.isInteger(p[1]))) throw notValid();
  const newId = Number(t.ni) || 0;
  const newRev = Number(t.nr) || 0;
  const tokenRisk = Number(t.r) === 1;
  const isAdmin = scopeAllows(caller.scope, "admin");
  const acknowledged = req.acknowledge_risk === true;
  if (tokenRisk && !isAdmin) throw new SupersedeError("this replacement needs an administrator", 403);
  if (tokenRisk && !acknowledged) {
    throw new SupersedeError("this replacement carries a red flag (see the warning). Confirm again with acknowledge_risk set to true if you accept it", 400);
  }

  // Everything below runs under the database write lock, in ONE transaction with the replacement itself.
  const newNoteInput = req.new_note ?? null;
  let created = false;
  const out = store.transaction(() => {
    const ids = oldPairs.map((p) => p[0]);
    const olds = ids.map((id) => writable(store, caller, id));
    olds.forEach((o, i) => {
      if (o.rev !== oldPairs[i][1] || o.superseded_by !== undefined || o.archived_at) {
        throw new StaleWriteError(`note ${o.id} changed (or was already retired) after the preview; nothing was changed. Run the preview again`);
      }
    });
    let content: { title: string; body: string; tags: string[]; confidence?: number | null };
    let replacementId = newId;
    let record: NoteRecord | undefined;
    if (newId > 0) {
      const target = writable(store, caller, newId);
      if (target.rev !== newRev) throw new StaleWriteError("the replacing note was edited after the preview; nothing was changed. Run the preview again");
      if (store.isDistrusted(target)) throw new SupersedeError("a note from a writer on the distrust list cannot replace another note", 403);
      content = { title: target.title, body: target.body, tags: target.tags, confidence: target.confidence ?? null };
      if (hashContent(content) !== t.h) throw new StaleWriteError("the replacing note changed after the preview; nothing was changed");
      record = target;
    } else {
      const nn = newNoteInput;
      if (!nn || typeof nn !== "object" || typeof nn.title !== "string") {
        throw new SupersedeError("send the same new_note you previewed together with the code", 400);
      }
      validateConfidence(nn.confidence);
      assertPlainWriteTags(nn.tags);
      content = { title: nn.title, body: nn.body ?? "", tags: nn.tags ?? [], confidence: typeof nn.confidence === "number" ? nn.confidence : null };
      if (hashContent(content) !== t.h) {
        throw new SupersedeError("the new note is not the one that was previewed; nothing was changed. Run the preview again", 400);
      }
    }
    // The red flags are judged again NOW: a writer distrusted, or a note's confidence changed, since the preview.
    const flags = assess(store, caller, olds, { confidence: content.confidence ?? undefined });
    if (flags.needs_admin_ack && !tokenRisk) {
      throw new SupersedeError("something changed since the preview and this replacement now carries a red flag; run the preview again", 409);
    }
    if (flags.needs_admin_ack && (!isAdmin || !acknowledged)) throw new SupersedeError("this replacement needs an administrator who accepts the red flag", 403);
    if (replacementId === 0) {
      const made = store.create({
        namespace: olds[0].namespace,
        title: content.title,
        body: content.body,
        tags: content.tags,
        ...(typeof content.confidence === "number" ? { confidence: content.confidence } : {}),
      });
      replacementId = made.id;
      record = made;
      created = true;
    }
    const flagText = [flags.replacer_distrusted ? "replacer-distrusted" : "", flags.lower_confidence ? "lower-confidence" : "", flags.needs_admin_ack ? "acknowledged" : ""].filter(Boolean).join(",");
    store.supersedeCommit({
      oldIds: ids,
      oldRevs: oldPairs.map((p) => p[1]),
      newId: replacementId,
      ...(newId > 0 ? { newRev } : {}),
      actor: writerOf(caller),
      nonce,
      expiresMs: exp,
      flags: flagText,
    });
    return { olds, replacementId, record: record as NoteRecord };
  });

  const replacement = out.record;
  const retired = out.olds.map((o) => ({ id: o.id, title: o.title, status: "superseded" as const, superseded_by: out.replacementId }));
  return { ok: true, message: doneText(retired, out.replacementId, created), retired, replacement, created_replacement: created };
}

/** Bring a replaced note back. Safe by design (it restores, never removes), so no code is needed; it is recorded. */
export function supersedeUndo(store: Store, caller: Caller, id: unknown): { ok: true; message: string; note: NoteRecord } {
  if (!scopeAllows(caller.scope, "write")) throw new SupersedeError("bringing a replaced note back needs a write or admin token", 403);
  if (typeof id !== "number" || !Number.isInteger(id) || id < 1) throw new SupersedeError("give the note number to bring back");
  const n = writable(store, caller, id);
  if (n.superseded_by === undefined) throw new SupersedeError(`note ${id} has not been replaced, so there is nothing to undo`, 409);
  const me = writerOf(caller);
  if (me !== "" && store.isDistrusted({ namespace: n.namespace, written_by: me }) && !scopeAllows(caller.scope, "admin")) {
    throw new SupersedeError("a writer on the distrust list cannot bring replaced notes back", 403);
  }
  // Bringing a note back undoes somebody's decision to hide it. A write token may only undo ITS OWN replacement; undoing anyone
  // else's (for example an administrator's, made to hide a bad note) is for an administrator.
  if (!scopeAllows(caller.scope, "admin") && (n.superseded_by_writer ?? "") !== me) {
    throw new SupersedeError("this note was replaced by someone else; only an administrator (or the person who replaced it) can bring it back", 403);
  }
  const back = store.supersedeUndo(id, me);
  if (!back) throw new SupersedeError(`note ${id} has not been replaced, so there is nothing to undo`, 409);
  return { ok: true, message: `Note ${id} is back. It shows up in search again, exactly as it was. The note that replaced it was not touched.`, note: back };
}

// ---- History -------------------------------------------------------------------------------------------------------

export interface HistoryView {
  note_id: number;
  /** The text that is current now (not part of `versions`). */
  current: { version: number; title: string; written_by: string; updated_at: string };
  versions: HistoryEntry[];
  /** Versions left out because their writer is on the distrust list (an administrator can ask to see them). */
  hidden_by_trust_policy: number;
}

function historyGate(store: Store, c: Caller, id: number): NoteRecord {
  // Old text can contain what someone deliberately took out of a note, so it is for administrators.
  if (!scopeAllows(c.scope, "admin")) throw new SupersedeError("a note's history is for administrators: it can hold text that was taken out on purpose", 403);
  if (typeof id !== "number" || !Number.isInteger(id) || id < 1) throw new SupersedeError("give a note number");
  const n = store.readVisible(id, { includeDistrusted: scopeAllows(c.scope, "admin") });
  if (!n || (c.ownNamespace !== undefined && n.namespace !== c.ownNamespace)) throw missing(id);
  return n;
}

/** Earlier versions of a note, newest first. Administrators only. */
export function noteHistory(store: Store, caller: Caller, id: number, opts: { includeDistrusted?: boolean } = {}): HistoryView {
  const n = historyGate(store, caller, id);
  const all = store.historyOf(id);
  const rules = store.distrustRules();
  const sid = store.serverId();
  const visible = opts.includeDistrusted
    ? all
    : all.filter((e) => !store.isDistrustedWith(rules, sid, { namespace: n.namespace, written_by: e.written_by || e.claimed_writer || "" }));
  return {
    note_id: id,
    current: { version: n.rev, title: n.title, written_by: n.written_by, updated_at: n.updated_at },
    versions: visible,
    hidden_by_trust_policy: all.length - visible.length,
  };
}

/** Put an earlier version back as a NEW version (the text it replaces goes into the history). Administrators only. */
export function restoreVersion(store: Store, caller: Caller, id: number, version: unknown, opts: { ifRev?: number } = {}): { ok: true; message: string; note: NoteRecord } {
  const n = historyGate(store, caller, id);
  if (n.superseded_by !== undefined) throw new SupersedeError(`note ${id} was replaced by note ${n.superseded_by}; bring it back (supersede undo) before restoring a version`, 409);
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) throw new SupersedeError("give the version number to restore");
  const entry = store.historyVersion(id, version);
  if (!entry) throw new SupersedeError(`note ${id} has no saved version ${version}`, 404);
  // A version written by someone the policy does not trust is not quietly put back by an administrator who has not asked to see it.
  if (store.isDistrusted({ namespace: n.namespace, written_by: entry.written_by || entry.claimed_writer || "" })) {
    throw new SupersedeError(`version ${version} was written by a writer on the distrust list; it cannot be put back`, 403);
  }
  const back = store.restoreVersion(id, version, opts.ifRev !== undefined ? { ifRev: opts.ifRev } : {});
  if (!back) throw missing(id);
  return { ok: true, message: `Version ${version} of note ${id} is the current text again, saved as version ${back.rev}. The text it replaced is kept in the history.`, note: back };
}

/** Forget a note's kept versions. Administrators only; the note itself is untouched. */
export function purgeNoteHistory(store: Store, caller: Caller, id: number): { ok: true; removed: number; message: string } {
  historyGate(store, caller, id);
  const removed = store.purgeHistory(id);
  return { ok: true, removed, message: `${removed} earlier version${removed === 1 ? "" : "s"} of note ${id} forgotten. The note itself was not changed.` };
}
