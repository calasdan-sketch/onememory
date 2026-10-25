// Plain-file sync: export the store as one Markdown file per note, and merge
// a directory of such files back in. Built for git / Syncthing / Dropbox:
//
//   <dir>/<namespace>/<slug>--<origin8>-<id>.md
//
//   ---
//   id: 12
//   origin: "5f0c...-uuid"          # store that first wrote the note
//   namespace: "work"
//   title: "Release cadence"
//   tags: ["decision"]
//   source: "claude-code"
//   created_at: "2026-10-14T09:00:00.000Z"
//   updated_at: "2026-10-15T10:30:00.000Z"
//   rev: 3
//   hash: "9b1f0c2a7d3e4f51"         # content hash at export = the merge base
//   ---
//   Ship weekly on Thursdays.
//
// Export is deterministic: fixed key order, JSON-encoded scalars (valid
// YAML), LF endings, one trailing newline, files written only when their
// bytes change, notes in id order. Filenames do not depend on which machine
// exported, so two machines exporting into one git repo converge.
//
// Identity across machines: every store has a uuid (_meta store_uuid). A
// note's identity is (origin, id) where origin is the store that first
// wrote it. Importing another store's file creates a local note and records
// the mapping (sync_map), so the next import updates that note instead of
// duplicating it, and this store's own export keeps the original identity.
//
// Merge (import) is three-way. The base is the content hash this store last
// exported or merged for the note (sync_base), falling back to the `hash`
// in the file's front-matter for a note this store has never synced:
//   file unchanged since export, store unchanged -> nothing to do
//   file edited, store unchanged                 -> file wins (update)
//   file unchanged, store edited                 -> store wins (skip)
//   both edited, same content                    -> nothing to do
//   both edited, different content (conflict)    -> the newer side wins
//     (front-matter updated_at vs store updated_at; file mtime is ignored --
//     sync tools rewrite it) and the losing version is written to
//     <dir>/.conflicts/ -- never lost.
// Every import write goes through the store's write path, so the memory
// linter runs on it (blocked / quarantined files are reported; content
// already pending in quarantine is not queued twice). Import never deletes
// notes; a file for a note deleted in this store is skipped unless it was
// edited, in which case the note is restored and the file rewritten with
// the restored note's identity. A file may only claim a note of THIS store
// that this store exported or merged (sync_base), and may not move a note
// to another namespace unless `allowMove` is set.
//
// Export never overwrites a file edited since the last sync (it is skipped
// and reported: import first) unless `force`, which first copies the file to
// .conflicts/. Prune removes only stale copies this store can account for
// (a renamed note's old file, or a deleted own note's unedited file), never
// another machine's unimported file. Every write refuses symlinked path
// segments under the sync dir and goes through temp file + rename.

import { createHash } from "node:crypto";
import {
  closeSync,
  constants as fsc,
  existsSync,
  lstatSync,
  openSync,
  realpathSync,
  writeSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import {
  Store,
  ValidationError,
  QuarantinedError,
  type NoteRecord,
} from "./store.js";
import { parseWriterRef } from "./trust.js";
import { maybeEmbed } from "./search-service.js";


/** The approval tag family is store-keyed: a file can neither carry nor mint one. */
const APPROVAL_TAG_PREFIX = "task.approval:";

/** Tags to store for an imported file: everything except approvals (which stay as the store has them). */
function importTags(fileTags: readonly string[], localTags: readonly string[] = []): string[] {
  const keepLocal = localTags.filter((t) => t.startsWith(APPROVAL_TAG_PREFIX));
  return [...fileTags.filter((t) => !t.startsWith(APPROVAL_TAG_PREFIX)), ...keepLocal];
}

/** Front-matter keys, in the order export writes them. */
const KEYS = [
  "id",
  "origin",
  "namespace",
  "title",
  "tags",
  "source",
  "created_at",
  "updated_at",
  "rev",
  // Who wrote the note on the machine that exported it (`<server_id>/<label>`).
  // An UNVERIFIED claim: a file can say anything. The importing store keeps it
  // only as `imported_written_by` and never lets it count as a writer (see docs/trust.md).
  "origin_writer",
  "hash",
] as const;

export interface NoteContent {
  namespace: string;
  title: string;
  body: string;
  tags: string[];
}

/** Same normalization the store applies to tags (trim, dedupe, drop empty). */
function normTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  return Array.from(new Set(tags.map((t) => String(t).trim()).filter(Boolean)));
}

/** Files are LF-only; a body's CR / CRLF is the same content. */
const lf = (s: string): string => s.replace(/\r\n?/g, "\n");

/** Content hash used as the three-way merge base (16 hex chars). */
export function contentHash(c: NoteContent): string {
  return createHash("sha256")
    .update(JSON.stringify([c.namespace, c.title, lf(c.body), normTags(c.tags)]))
    .digest("hex")
    .slice(0, 16);
}

/** Readable slug: keeps Unicode letters/digits (Greek, CJK), drops accents. */
function slugify(title: string, max = 60): string {
  const s = Array.from(
    title
      .normalize("NFKD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+/, "")
  )
    .slice(0, Math.max(1, max))
    .join("")
    .replace(/-+$/g, "");
  return s || "note";
}

const WIN_RESERVED = /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\..*)?$/i;
const FOLDER_MAX = 64;

/** A filesystem-safe folder for a namespace (cosmetic: front-matter wins). */
export function namespaceFolder(ns: string): string {
  let f = ns
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .slice(0, FOLDER_MAX)
    .replace(/[. ]+$/, "") // Windows strips trailing dots / spaces
    .replace(/^\./, "_"); // dot-folders are skipped on import
  if (WIN_RESERVED.test(f)) f = `_${f}`;
  return f || "_";
}

/** Keep <dir>/<folder>/<file> under Windows' 260-char MAX_PATH. */
const PATH_BUDGET = 250;

export function noteFileName(title: string, origin: string, id: number, maxSlug = 60): string {
  return `${slugify(title, maxSlug)}--${origin.replace(/-/g, "").slice(0, 8)}-${id}.md`;
}

/** Note file path under `dir`, shortening the slug to fit PATH_BUDGET. */
function notePath(dir: string, namespace: string, title: string, origin: string, id: number): string {
  const folder = namespaceFolder(namespace);
  const fixed = join(dir, folder, `--${origin.replace(/-/g, "").slice(0, 8)}-${id}.md`).length;
  return join(dir, folder, noteFileName(title, origin, id, Math.min(60, Math.max(1, PATH_BUDGET - fixed))));
}

// ---- Symlink-safe file IO under the sync dir --------------------------------
// The sync dir is shared with other machines and tools; a planted symlink
// (dir/work -> ~/.ssh) must never redirect a write or delete outside it.

/** Throw if any existing segment of `p` below `root` is a symlink. */
function refuseSymlinks(root: string, p: string): void {
  let cur = root;
  for (const seg of relative(root, p).split(sep).filter(Boolean)) {
    cur = join(cur, seg);
    let st;
    try {
      st = lstatSync(cur);
    } catch {
      return; // missing: nothing below it exists either
    }
    if (st.isSymbolicLink()) throw new ValidationError(`refusing to follow symlink: ${relative(root, cur)}`);
  }
}

/**
 * Re-check, right before touching `p`, that its real parent directory is
 * inside the real sync root (closes the gap between refuseSymlinks and the
 * write/rename/rm: a directory swapped for a symlink in between).
 */
function assertInsideRoot(root: string, p: string): void {
  const r = realpathSync(root);
  const d = realpathSync(dirname(p));
  if (d !== r && !d.startsWith(r.endsWith(sep) ? r : r + sep)) {
    throw new ValidationError(`refusing to write outside the sync dir: ${relative(root, p)}`);
  }
}

/** Write `text` to `p` (under `root`) via temp file + rename, no symlinks. */
function safeWrite(root: string, p: string, text: string): void {
  refuseSymlinks(root, p);
  mkdirSync(dirname(p), { recursive: true });
  refuseSymlinks(root, p);
  assertInsideRoot(root, p);
  const tmp = join(dirname(p), `.${basename(p)}.${process.pid}.${Date.now()}.tmp`);
  // O_EXCL (+ O_NOFOLLOW where the platform has it): never follow or reuse
  // an existing path; owner-only like the rest of the data.
  const fd = openSync(tmp, fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL | (fsc.O_NOFOLLOW ?? 0), 0o600);
  try {
    writeSync(fd, text);
  } finally {
    closeSync(fd);
  }
  try {
    assertInsideRoot(root, p);
    renameSync(tmp, p);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/** Read an existing file under `root` (null if missing), refusing symlinks. */
function safeRead(root: string, p: string): string | null {
  refuseSymlinks(root, p);
  try {
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

/** The names a file's `origin_writer` claim contains: the whole value (a writer id) and its label part. */
function claimNames(raw: string): string[] {
  const ref = parseWriterRef(raw.trim().slice(0, 300));
  return [...new Set([ref.serverId ? `${ref.serverId}/${ref.label}` : ref.label, ref.label].filter(Boolean))];
}

/** Render one note as Markdown with YAML front-matter. */
export function renderNoteFile(
  note: NoteRecord,
  identity: { origin: string; id: number },
  extra: { distrusted?: boolean } = {}
): string {
  const fm: Record<(typeof KEYS)[number], unknown> = {
    id: identity.id,
    origin: identity.origin,
    namespace: note.namespace,
    title: note.title,
    tags: note.tags,
    source: note.source,
    created_at: note.created_at,
    updated_at: note.updated_at,
    rev: note.rev,
    origin_writer: note.writer_id || note.written_by || "",
    hash: contentHash(note),
  };
  const lines = KEYS.map((k) => `${k}: ${JSON.stringify(fm[k])}`);
  // Written only for a note the trust policy hides from agents (export --include-distrusted).
  if (extra.distrusted) lines.push("distrusted: true");
  return `---\n${lines.join("\n")}\n---\n${lf(note.body)}\n`;
}

/** Parse one YAML-ish scalar / flow sequence written by us or by a human. */
function parseValue(raw: string): unknown {
  const v = raw.trim();
  if (v === "") return "";
  if (/^["[{]|^-?\d|^(true|false|null)$/.test(v)) {
    try {
      return JSON.parse(v);
    } catch {
      /* hand-written YAML: fall through */
    }
  }
  if (v.startsWith("[") && v.endsWith("]")) {
    return v
      .slice(1, -1)
      .split(",")
      .map((x) => x.trim().replace(/^['"]|['"]$/g, ""))
      .filter(Boolean);
  }
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'");
  return v;
}

export interface ParsedFile {
  fm: Record<string, unknown>;
  body: string;
  hasFrontMatter: boolean;
}

/** Parse a note file: front-matter (if any) + body. CRLF is normalized. */
export function parseNoteFile(text: string): ParsedFile {
  const t = lf(text);
  const stripOne = (b: string): string => (b.endsWith("\n") ? b.slice(0, -1) : b);
  if (!t.startsWith("---\n")) return { fm: {}, body: stripOne(t), hasFrontMatter: false };
  const end = t.indexOf("\n---\n", 3);
  const endAtEof = end < 0 && t.endsWith("\n---") ? t.length - 4 : -1;
  const close = end >= 0 ? end : endAtEof;
  if (close < 0) return { fm: {}, body: stripOne(t), hasFrontMatter: false };
  const fm: Record<string, unknown> = {};
  let listKey: string | null = null;
  for (const line of t.slice(4, close).split("\n")) {
    const item = /^\s*-\s+(.*)$/.exec(line);
    if (item && listKey) {
      (fm[listKey] as unknown[]).push(parseValue(item[1]));
      continue;
    }
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s?(.*)$/.exec(line);
    if (!m) continue;
    if (m[2].trim() === "") {
      fm[m[1]] = [];
      listKey = m[1];
    } else {
      fm[m[1]] = parseValue(m[2]);
      listKey = null;
    }
  }
  const body = end >= 0 ? t.slice(end + 5) : "";
  return { fm, body: stripOne(body), hasFrontMatter: true };
}

/** All .md files one or two levels deep, skipping dot-directories. */
function listNoteFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, depth: number): void => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const p = join(d, e.name);
      if (e.isDirectory() && depth < 2) walk(p, depth + 1);
      else if (e.isFile() && e.name.toLowerCase().endsWith(".md")) out.push(p);
    }
  };
  walk(dir, 1);
  return out.sort();
}

function isOurFile(p: ParsedFile): boolean {
  return p.hasFrontMatter && typeof p.fm.origin === "string" && typeof p.fm.id === "number";
}

/**
 * The note content a file stands for. Title: front-matter, else a leading
 * "# Heading", else the filename. Namespace: front-matter, else the folder.
 */
function fileContent(parsed: ParsedFile, file: string, dir: string): NoteContent {
  const { fm } = parsed;
  let body = parsed.body;
  let title = typeof fm.title === "string" ? fm.title : "";
  if (!title.trim()) {
    const h = /^#[ \t]+(.+)\n?/.exec(body);
    if (h) {
      title = h[1].trim();
      body = body.slice(h[0].length).replace(/^\n/, "");
    } else {
      title = basename(file, ".md");
    }
  }
  const namespace =
    typeof fm.namespace === "string" && fm.namespace.trim()
      ? fm.namespace.trim()
      : dirname(file) !== dir
        ? basename(dirname(file))
        : "default";
  return { namespace, title, body, tags: normTags(fm.tags) };
}

export interface ExportResult {
  dir: string;
  notes: number;
  written: number;
  unchanged: number;
  removed: number;
  /** Files left alone (edited since the last sync, unsafe path, IO error). */
  skipped: Array<{ file: string; detail: string }>;
}

/**
 * Write one Markdown file per note under `dir`. A file edited since the last
 * sync is skipped (import it first) unless `force`, which saves it to
 * .conflicts/ before overwriting. With `prune` (default) the stale file of a
 * renamed note, or the unedited file of a note this store deleted, is
 * removed; other files are never touched.
 */
export function exportMarkdown(
  store: Store,
  dir: string,
  opts: { namespace?: string; prune?: boolean; force?: boolean; includeDistrusted?: boolean } = {}
): ExportResult {
  const self = store.storeId();
  const origins = store.syncOrigins();
  mkdirSync(dir, { recursive: true });
  const everything = store.exportAll().filter((n) => !opts.namespace || n.namespace === opts.namespace); // gate-ok: the vault export skips hidden notes itself (hiddenIds) unless --include-distrusted
  // A vault is a folder other tools and agents read, outside every read gate: notes touched by a
  // distrusted writer are left out (and their earlier, unedited files pruned) unless asked for,
  // and then each such file is marked `distrusted: true`.
  const notes = opts.includeDistrusted ? everything : store.filterVisible(everything);
  // A Set of the visible ids: `notes.includes(n)` per note made this quadratic in the number of hidden notes.
  const visibleIds = new Set<number>(notes.map((n) => n.id));
  const hiddenIds = new Set<number>(opts.includeDistrusted ? [] : everything.filter((n) => !visibleIds.has(n.id)).map((n) => n.id));
  const marked = new Set<number>(opts.includeDistrusted ? store.markDistrusted(everything).filter((n) => n.distrusted).map((n) => n.id) : []);
  const keep = new Set<string>();
  /** local id -> [merge base before this export, current content hash] */
  const exported = new Map<number, [string | null, string]>();
  const skipped: ExportResult["skipped"] = [];
  let written = 0;
  let unchanged = 0;
  for (const note of notes) {
    const o = origins.get(note.id);
    const identity = o ? { origin: o.origin, id: o.originId } : { origin: self, id: note.id };
    const path = notePath(dir, note.namespace, note.title, identity.origin, identity.id);
    const rel = relative(dir, path);
    if (path.length > PATH_BUDGET) {
      skipped.push({ file: rel, detail: `path is ${path.length} characters (limit ${PATH_BUDGET}); use a sync folder closer to the drive root` });
      continue;
    }
    keep.add(path);
    const hash = contentHash(note);
    const base = store.syncBase(note.id);
    exported.set(note.id, [base, hash]);
    try {
      const text = renderNoteFile(note, identity, { distrusted: marked.has(note.id) });
      const current = safeRead(dir, path);
      if (current === text) {
        store.setSyncBase(note.id, hash);
        unchanged++;
        continue;
      }
      if (current !== null) {
        const onDisk = contentHash(fileContent(parseNoteFile(current), path, dir));
        if (onDisk !== base && onDisk !== hash) {
          if (!opts.force) {
            skipped.push({ file: rel, detail: "file was edited since the last sync; import it first (or export with force)" });
            continue;
          }
          const saved = join(dir, ".conflicts", `${basename(path, ".md")}.overwritten.md`);
          safeWrite(dir, saved, current);
          skipped.push({ file: rel, detail: `overwritten (force); previous file saved to ${relative(dir, saved)}` });
        }
      }
      safeWrite(dir, path, text);
      store.setSyncBase(note.id, hash);
      written++;
    } catch (e) {
      skipped.push({ file: rel, detail: (e as Error).message });
    }
  }
  let removed = 0;
  if (opts.prune !== false) {
    for (const p of listNoteFiles(dir)) {
      if (keep.has(p)) continue;
      let parsed: ParsedFile;
      try {
        parsed = parseNoteFile(readFileSync(p, "utf8"));
      } catch {
        continue;
      }
      if (!isOurFile(parsed)) continue; // never delete a file we didn't write
      if (opts.namespace && parsed.fm.namespace !== opts.namespace) continue;
      const origin = parsed.fm.origin as string;
      const id = parsed.fm.id as number;
      const localId = origin === self ? id : store.syncLookup(origin, id);
      const onDisk = contentHash(fileContent(parsed, p, dir));
      let stale: boolean;
      if (localId !== null && hiddenIds.has(localId)) {
        // The note is now hidden by the trust policy: its earlier file goes too, unless someone edited it.
        stale = onDisk === parsed.fm.hash || onDisk === store.syncBase(localId);
      } else if (localId !== null && exported.has(localId)) {
        // Old path of a renamed note: stale iff it holds what we last synced.
        const [base, hash] = exported.get(localId)!;
        stale = onDisk === base || onDisk === hash;
      } else if (origin === self && store.read(id) === null) { // gate-ok: existence check only (deleted here?)
        // Our own note, deleted here: stale iff nobody edited the file.
        stale = onDisk === parsed.fm.hash;
      } else if (localId === null && origin !== self && store.syncDeleted(origin, id) !== undefined) {
        // Another machine's note, imported then deleted here: same rule,
        // against what this store last synced for it.
        stale = onDisk === (store.syncDeleted(origin, id) ?? parsed.fm.hash);
      } else {
        continue; // another machine's file we never imported, or not ours to judge
      }
      const rel = relative(dir, p);
      if (!stale) {
        skipped.push({ file: rel, detail: "not pruned: file was edited since the last sync; import it first" });
        continue;
      }
      try {
        refuseSymlinks(dir, p);
        assertInsideRoot(dir, p);
        rmSync(p);
        removed++;
      } catch (e) {
        skipped.push({ file: rel, detail: (e as Error).message });
      }
    }
  }
  return { dir, notes: notes.length, written, unchanged, removed, skipped };
}

export type ImportAction =
  | "created"
  | "updated"
  | "restored"
  | "unchanged"
  | "skipped"
  | "conflict"
  | "quarantined"
  | "rejected";

export interface ImportEntry {
  file: string;
  action: ImportAction;
  id?: number;
  detail?: string;
}

export interface ImportResult {
  dir: string;
  entries: ImportEntry[];
  counts: Record<ImportAction, number>;
}

/**
 * Merge a directory of note files into the store (see the header for the
 * rules). `dryRun` reports what would happen without writing anything;
 * `allowMove` lets a file move a note to another namespace.
 */
export async function importMarkdown(
  store: Store,
  dir: string,
  opts: { dryRun?: boolean; allowMove?: boolean } = {}
): Promise<ImportResult> {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new ValidationError(`not a directory: ${dir}`);
  }
  const self = store.storeId();
  const dry = opts.dryRun === true;
  const entries: ImportEntry[] = [];
  const conflictsDir = join(dir, ".conflicts");
  const saveConflict = (name: string, text: string): string => {
    const p = join(conflictsDir, name);
    if (!dry) safeWrite(dir, p, text);
    return relative(dir, p);
  };

  for (const file of listNoteFiles(dir)) {
    const rel = relative(dir, file);
    const push = (action: ImportAction, extra: Omit<ImportEntry, "file" | "action"> = {}): void => {
      entries.push({ file: rel, action, ...extra });
    };
    // Sync tools' conflict copies carry the same identity as the original;
    // importing both would let whichever sorts last win. Leave them to a human.
    if (/\.sync-conflict-|\(conflicted copy/i.test(basename(file))) {
      push("skipped", { detail: "sync-tool conflict copy; merge it by hand" });
      continue;
    }
    let parsed: ParsedFile;
    try {
      parsed = parseNoteFile(readFileSync(file, "utf8"));
    } catch (e) {
      push("rejected", { detail: `unreadable: ${(e as Error).message}` });
      continue;
    }
    const { fm } = parsed;
    const content = fileContent(parsed, file, dir);
    const { namespace, title, body } = content;
    const fileHash = contentHash(content);
    const fmHash = typeof fm.hash === "string" ? fm.hash : null;
    const origin = typeof fm.origin === "string" ? fm.origin : null;
    const originId = typeof fm.id === "number" && Number.isInteger(fm.id) ? fm.id : null;
    const hasIdentity = origin !== null && originId !== null;

    let localId: number | null = null;
    if (hasIdentity) localId = origin === self ? originId : store.syncLookup(origin!, originId!);
    const local = localId !== null ? store.read(localId) : null; // gate-ok: import merge-base lookup: compares hashes, returns nothing to a caller
    // A file may only claim a note of this store that this store exported or
    // merged; otherwise any dropped-in file could overwrite any local note.
    if (local && origin === self && store.syncBase(local.id) === null) {
      push("rejected", { detail: `claims note #${local.id} of this store, which this store never exported` });
      continue;
    }
    // Merge base: what THIS store last synced for the note; the file's own
    // front-matter hash only when this store has never synced it (another
    // machine's export carries that machine's base, not ours).
    const baseHash = (local ? store.syncBase(local.id) : null) ?? fmHash;
    const fileChanged = baseHash === null || fileHash !== baseHash;
    const remember = (id: number, hash: string): void => {
      if (!dry) store.setSyncBase(id, hash);
    };

    // Run a store write, mapping linter / validation outcomes to entries.
    const attempt = async (
      fn: () => NoteRecord | null,
      ok: ImportAction,
      detail?: string
    ): Promise<void> => {
      if (local && namespace !== local.namespace && !opts.allowMove) {
        push("rejected", {
          id: local.id,
          detail: `file moves note #${local.id} from namespace "${local.namespace}" to "${namespace}"; allow moves to apply it`,
        });
        return;
      }
      if (dry) {
        push(ok, { ...(local ? { id: local.id } : {}), detail: detail ? `${detail} (dry run)` : "dry run" });
        return;
      }
      // Re-importing content already held for review must not queue it again.
      const held = store.pendingQuarantineId(namespace, title, body, content.tags);
      if (held !== null) {
        push("quarantined", { detail: `already held in quarantine #${held}` });
        return;
      }
      try {
        const n = fn();
        if (!n) {
          push("skipped", { detail: "note vanished during import" });
          return;
        }
        await maybeEmbed(store, n);
        remember(n.id, contentHash(n));
        push(ok, { id: n.id, ...(detail ? { detail } : {}) });
      } catch (e) {
        if (e instanceof QuarantinedError) {
          push("quarantined", { detail: `quarantine #${e.quarantineId}: ${e.message}` });
        } else if (e instanceof ValidationError) {
          push("rejected", { detail: e.message });
        } else {
          throw e;
        }
      }
    };
    const createFrom = (): NoteRecord => {
      // importMarkdown is a LOCAL, admin-trust path (CLI only; no token can
      // reach it), so a restore from files must bring back tasks, handoffs
      // and legacy notes tagged `task`. Approvals never travel by file.
      const n = store.create(
        {
          namespace,
          title,
          body,
          tags: importTags(content.tags),
          source: typeof fm.source === "string" ? fm.source : undefined,
          created_at: typeof fm.created_at === "string" ? fm.created_at : undefined,
        },
        {
          updatedAt: typeof fm.updated_at === "string" ? fm.updated_at : undefined,
          // The file's writer claim is displayed, never trusted: the note is stamped with who imported it.
          // A claim can only ADD taint: the names it gives also go into merged_from_writers, so a
          // distrusted writer's note does not become a trusted one by passing through a vault.
          ...(typeof fm.origin_writer === "string" && fm.origin_writer.trim()
            ? { importedWrittenBy: fm.origin_writer.trim().slice(0, 200), mergedFromWriters: claimNames(fm.origin_writer) }
            : {}),
        }
      );
      if (hasIdentity && origin !== self) store.syncLink(origin!, originId!, n.id);
      // A hand-written file, or one restoring a note deleted here (which
      // got a new id), gets the note's identity written back, so the next
      // import updates this note instead of creating it again.
      else safeWrite(dir, file, renderNoteFile(n, { origin: self, id: n.id }));
      return n;
    };

    // Another machine's note this store imported and then deleted: a local
    // delete, not a new note -- only an edit made since brings it back.
    const deletedBase = hasIdentity && origin !== self && localId === null ? store.syncDeleted(origin!, originId!) : undefined;
    if (deletedBase !== undefined) {
      const base = deletedBase ?? fmHash;
      if (base === null || fileHash !== base) await attempt(createFrom, "restored", "note was deleted here but the file was edited");
      else push("skipped", { detail: "note was deleted in this store" });
      continue;
    }

    if (!local) {
      if (hasIdentity && origin === self) {
        // Deleted in this store after the export.
        if (fileChanged) await attempt(createFrom, "restored", "note was deleted here but the file was edited");
        else push("skipped", { detail: "note was deleted in this store" });
      } else {
        await attempt(createFrom, "created");
      }
      continue;
    }

    const localHash = contentHash(local);
    if (localHash === fileHash) {
      remember(local.id, localHash);
      push("unchanged", { id: local.id });
      continue;
    }
    const localChanged = baseHash === null || localHash !== baseHash;
    const applyFile = (): NoteRecord | null => {
      return store.update(
        local.id,
        { namespace, title, body, tags: importTags(content.tags, local.tags) },
        { ifRev: local.rev, ...(typeof fm.origin_writer === "string" && fm.origin_writer.trim() ? { alsoTouchedBy: claimNames(fm.origin_writer) } : {}) }
      );
    };

    if (!fileChanged) {
      push("skipped", { id: local.id, detail: "store has a newer version" });
      continue;
    }
    if (!localChanged) {
      await attempt(applyFile, "updated");
      continue;
    }
    // Both sides changed: newer wins (front-matter updated_at only; mtime is
    // rewritten by sync tools), the loser is preserved.
    const fileTime = typeof fm.updated_at === "string" ? Date.parse(fm.updated_at) || 0 : 0;
    const localTime = Date.parse(local.updated_at) || 0;
    const stem = basename(file, ".md");
    try {
      if (fileTime > localTime) {
        const saved = saveConflict(
          `${stem}.store-rev${local.rev}.md`,
          renderNoteFile(local, hasIdentity ? { origin: origin!, id: originId! } : { origin: self, id: local.id })
        );
        await attempt(applyFile, "conflict", `file was newer and won; store version saved to ${saved}`);
      } else {
        const saved = saveConflict(`${stem}.file.md`, readFileSync(file, "utf8"));
        // The file's version is now preserved and "seen": until the store
        // exports again (or the file is edited again) the store keeps winning.
        remember(local.id, fileHash);
        push("conflict", { id: local.id, detail: `store was newer and won; file version saved to ${saved}` });
      }
    } catch (e) {
      if (!(e instanceof ValidationError)) throw e;
      push("rejected", { id: local.id, detail: `conflict not resolved: ${e.message}` });
    }
  }

  const counts = {
    created: 0,
    updated: 0,
    restored: 0,
    unchanged: 0,
    skipped: 0,
    conflict: 0,
    quarantined: 0,
    rejected: 0,
  } as Record<ImportAction, number>;
  for (const e of entries) counts[e.action]++;
  return { dir, entries, counts };
}
