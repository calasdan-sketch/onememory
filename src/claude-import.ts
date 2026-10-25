// `onememory import --claude`: bring what Claude Code already remembers into OneMemory.
//
// Reads, on THIS machine only (nothing is sent anywhere):
//   * ~/.claude/CLAUDE.md                       your user-level instructions
//   * <project>/CLAUDE.md, <project>/.claude/CLAUDE.md, <project>/CLAUDE.local.md   (the current folder, or --project)
//   * ~/.claude/projects/<project>/memory/*.md  Claude Code's auto memory (topic files; MEMORY.md is only an index)
// (layout as documented at https://code.claude.com/docs/en/memory)
//
// Each file is cut into separate notes at its headings (levels 1 and 2). A note is tagged with where it came from and its
// project, and carries a stable key in `source`, so running the import again adds only what is new. Anything the
// secret linter flags is skipped, counted, and never printed or stored. Symlinks that lead somewhere other than a
// Markdown file are not followed, and `@imports` inside a file are not followed (they are counted).

import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import { lintContent } from "./lint.js";
import { LIMITS } from "./security.js";
import type { SetupEnv, SetupIO } from "./setup.js";
import { claudeDir } from "./setup.js";

export const IMPORT_TAG = "claude-import";
export const IMPORT_WRITER = "import:claude";
export const MAX_FILE_BYTES = 1024 * 1024; // a CLAUDE.md over 1 MiB is not instructions; skip it

export type SourceKind = "user-claude-md" | "project-claude-md" | "auto-memory";

export interface SourceFile {
  kind: SourceKind;
  /** Shown to the person (never the content). */
  display: string;
  real: string;
  /** Stable, machine-independent place of the file: "CLAUDE.md", ".claude/CLAUDE.md", "memory/user_role.md". */
  rel: string;
  project: string;
  /** Distinguishes two projects with the same folder name. */
  projectId: string;
}

export interface DiscoverResult {
  files: SourceFile[];
  skipped: Array<{ display: string; why: string }>;
}

const h = (s: string, n = 16): string => createHash("sha256").update(s).digest("hex").slice(0, n);

function cleanLabel(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim().slice(0, 80) || "unnamed";
}

/**
 * A file we may read: a regular file (after following a symlink) whose real name ends in .md, small enough, and - when
 * `mustBeInside` is given - physically inside that folder (a symlink in the memory folder pointing at ~/.ssh is refused).
 */
function acceptFile(path: string, mustBeInside: string | null): { real: string } | { why: string } {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return { why: "not found" };
  }
  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    return { why: "cannot be resolved" };
  }
  if (st.isSymbolicLink() || real !== resolve(path)) {
    if (!/\.md$/i.test(real)) return { why: "a link that does not lead to a Markdown file" };
  }
  if (mustBeInside) {
    const root = realpathSync(mustBeInside);
    const rel = relative(root, real);
    if (rel === "" || rel.startsWith("..") || resolve(root, rel) !== real) return { why: "a link that leads outside the memory folder" };
  }
  let s;
  try {
    s = statSync(real);
  } catch {
    return { why: "cannot be read" };
  }
  if (!s.isFile()) return { why: "not a regular file" };
  if (s.size > MAX_FILE_BYTES) return { why: `larger than ${MAX_FILE_BYTES / 1024 / 1024} MiB` };
  return { real };
}

export function discoverSources(e: Pick<SetupEnv, "home" | "env" | "cwd">, opts: { projects?: string[]; includeIndex?: boolean } = {}): DiscoverResult {
  const files: SourceFile[] = [];
  const skipped: DiscoverResult["skipped"] = [];
  const seen = new Set<string>();
  const add = (kind: SourceKind, path: string, rel: string, project: string, projectId: string, inside: string | null): void => {
    if (!existsSync(path) && !isDanglingLink(path)) return;
    const ok = acceptFile(path, inside);
    if ("why" in ok) {
      skipped.push({ display: path, why: ok.why });
      return;
    }
    if (seen.has(ok.real)) return; // the same file reached twice (a link, or two projects)
    seen.add(ok.real);
    files.push({ kind, display: path, real: ok.real, rel: rel.split(sep).join("/"), project: cleanLabel(project), projectId });
  };
  const cdir = claudeDir({ ...(e as SetupEnv) });
  add("user-claude-md", join(cdir, "CLAUDE.md"), "CLAUDE.md", "user", "user", null);
  for (const dir of (opts.projects && opts.projects.length ? opts.projects : [e.cwd]).map((d) => resolve(e.cwd, d))) {
    let id = dir;
    try {
      id = realpathSync(dir);
    } catch {
      skipped.push({ display: dir, why: "folder not found" });
      continue;
    }
    for (const rel of ["CLAUDE.md", join(".claude", "CLAUDE.md"), "CLAUDE.local.md"]) add("project-claude-md", join(dir, rel), rel, basename(dir), h(id.toLowerCase(), 8), null);
  }
  const projRoot = join(cdir, "projects");
  let projects: string[] = [];
  try {
    projects = readdirSync(projRoot).sort();
  } catch {
    /* no auto memory yet */
  }
  for (const p of projects) {
    const memDir = join(projRoot, p, "memory");
    let entries: string[] = [];
    try {
      entries = readdirSync(memDir).sort();
    } catch {
      continue;
    }
    for (const f of entries) {
      if (!/\.md$/i.test(f)) continue;
      if (f.toUpperCase() === "MEMORY.MD" && !opts.includeIndex) continue; // an index of the other files
      add("auto-memory", join(memDir, f), join("memory", f), p, h(p, 8), memDir);
    }
  }
  return { files, skipped };
}

function isDanglingLink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

// ---- splitting ---------------------------------------------------------------------------------------------------------------

export interface Section {
  heading: string;
  /** "H1 / H2" context used in the title. */
  path: string;
  body: string;
  /** Position among sections with the same path (keeps repeated headings apart). */
  occurrence: number;
}

export function parseFrontmatter(text: string): { fm: Record<string, string>; body: string } {
  const t = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  if (!t.startsWith("---\n")) return { fm: {}, body: t };
  const end = t.indexOf("\n---", 4);
  if (end < 0) return { fm: {}, body: t };
  const after = t.indexOf("\n", end + 4);
  const fm: Record<string, string> = {};
  for (const line of t.slice(4, end).split("\n")) {
    const m = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (m) fm[m[1].toLowerCase()] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return { fm, body: after < 0 ? "" : t.slice(after + 1) };
}

const HEADING = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/;

export function splitSections(markdown: string, fallbackTitle: string): { sections: Section[]; imports: number } {
  const lines = markdown.replace(/^﻿/, "").replace(/\r\n?/g, "\n").split("\n");
  const raw: Array<{ level: number; heading: string; h1: string; lines: string[] }> = [];
  let cur = { level: 0, heading: fallbackTitle, h1: "", lines: [] as string[] };
  let fence: string | null = null;
  let h1 = "";
  let imports = 0;
  for (const line of lines) {
    const f = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(line);
    if (f) {
      if (fence === null) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
    }
    if (fence === null) {
      if (/^@\S+/.test(line.trim())) imports++;
      const m = HEADING.exec(line);
      if (m && m[1].length <= 2) {
        raw.push(cur);
        if (m[1].length === 1) h1 = m[2].trim();
        cur = { level: m[1].length, heading: m[2].trim(), h1: m[1].length === 2 ? h1 : "", lines: [] };
        continue;
      }
    }
    cur.lines.push(line);
  }
  raw.push(cur);
  const counts = new Map<string, number>();
  const sections: Section[] = [];
  for (const r of raw) {
    const body = r.lines.join("\n").replace(/<!--[\s\S]*?-->/g, "").trim();
    if (!body) continue;
    const path = r.h1 && r.h1 !== r.heading ? `${r.h1} / ${r.heading}` : r.heading;
    const n = counts.get(path) ?? 0;
    counts.set(path, n + 1);
    sections.push({ heading: r.heading, path, body, occurrence: n });
  }
  return { sections, imports };
}

/** Cut a body that is over the note size limit into parts at blank lines. */
export function chunkBody(body: string, max = LIMITS.body - 2000): string[] {
  if (body.length <= max) return [body];
  const parts: string[] = [];
  let cur = "";
  for (const para of body.split(/\n{2,}/)) {
    if (cur && cur.length + para.length + 2 > max) {
      parts.push(cur);
      cur = "";
    }
    cur = cur ? cur + "\n\n" + para : para;
    while (cur.length > max) {
      parts.push(cur.slice(0, max));
      cur = cur.slice(max);
    }
  }
  if (cur) parts.push(cur);
  return parts;
}

// ---- an extra check for passwords written as plain text -------------------------------------------------------------
// The memory linter knows token SHAPES (AWS, GitHub, JWT, private keys, long random strings). A CLAUDE.md more often holds a
// password typed as `password: hunter22x` or a URL with the password inside, which has no shape. Before anything is stored,
// a name that means a credential, followed by : or =, followed by a value that mixes letters and digits, counts as a secret
// here. Placeholders (<...>, $VAR, your_..., xxxx) do not. It errs on the side of skipping a section; it never prints it.
// Every repetition is bounded, so hostile text cannot make the check slow.
const CREDENTIAL_ASSIGNMENT = /(?<![A-Za-z0-9])(?:[A-Za-z0-9]{1,30}[_-]){0,4}(?:pass(?:word|wd|phrase)?|pwd|secret|token|api[_ -]?key|access[_ -]?key|private[_ -]?key|auth(?:orization)?|bearer|credentials?)\b["'`]?[ \t]{0,4}(?::|=|is)[ \t]{0,4}["'`]?(?=[^\s"'`<>]{0,80}\d)(?=[^\s"'`<>]{0,80}[A-Za-z])(?![^\s"'`<>]{0,80}(?:xxx|\*\*\*|example|placeholder|your[_-]|changeme))[^\s"'`<>$]{8,200}/i;
const URL_PASSWORD = /\b[a-z][a-z0-9+.-]{0,20}:\/\/[^\s/:@]{1,64}:[^\s/@]{3,64}@/i;

export function looksLikeCredential(text: string): boolean {
  return CREDENTIAL_ASSIGNMENT.test(text) || URL_PASSWORD.test(text);
}

// ---- candidates --------------------------------------------------------------------------------------------------------------

export interface Candidate {
  file: SourceFile;
  title: string;
  body: string;
  tags: string[];
  /** Stable key of the place in the file. */
  loc: string;
  /** Hash of the text. */
  content: string;
  source: string;
  secret: boolean;
}

export function sourceKey(loc: string, content: string): string {
  return `claude-import:v1:${loc}:${content}`;
}

export function parseSourceKey(source: string): { loc: string; content: string } | null {
  const m = /^claude-import:v1:([0-9a-f]{16}):([0-9a-f]{16})$/.exec(source);
  return m ? { loc: m[1], content: m[2] } : null;
}

export interface Counts {
  sections: number;
  create: number;
  same: number;
  changed: number;
  secrets: number;
  held: number;
}

export function buildCandidates(files: SourceFile[]): { candidates: Candidate[]; imports: number; unreadable: string[] } {
  const candidates: Candidate[] = [];
  const unreadable: string[] = [];
  let imports = 0;
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(file.real, "utf8");
    } catch {
      unreadable.push(file.display);
      continue;
    }
    const baseTags = [IMPORT_TAG, file.kind === "auto-memory" ? "claude-auto-memory" : "claude-md", `project:${file.project}`.slice(0, LIMITS.tagLen)];
    const stem = basename(file.rel).replace(/\.md$/i, "");
    const push = (title: string, body: string, key: string, extraTags: string[]): void => {
      const parts = chunkBody(body);
      parts.forEach((part, i) => {
        const t = (parts.length > 1 ? `${title} (part ${i + 1} of ${parts.length})` : title).slice(0, LIMITS.title);
        const loc = h([file.kind, file.projectId, file.rel, key, String(i)].join("\u0000"));
        const content = h(part);
        const tags = [...baseTags, ...extraTags].map((x) => x.slice(0, LIMITS.tagLen));
        const finds = lintContent({ title: t, body: part, tags });
        const secret = finds.some((f) => f.category === "secret" || f.category === "entropy") || looksLikeCredential(t + "\n" + part);
        candidates.push({ file, title: t, body: part, tags, loc, content, source: sourceKey(loc, content), secret });
      });
    };
    if (file.kind === "auto-memory") {
      // One topic file = one memory.
      const { fm, body } = parseFrontmatter(text);
      const clean = body.replace(/<!--[\s\S]*?-->/g, "").trim();
      const desc = fm.description ? `${fm.description}\n\n` : "";
      if (!clean && !desc) continue;
      const first = /^#{1,6}[ \t]+(.+)$/m.exec(clean);
      const title = (fm.name || first?.[1]?.trim() || stem.replace(/[_-]+/g, " ")).slice(0, LIMITS.title);
      push(title, desc + clean, "file", fm.type ? [`memory-type:${fm.type}`.slice(0, LIMITS.tagLen)] : []);
      imports += (clean.match(/^@\S+/gm) ?? []).length;
      continue;
    }
    const { sections, imports: n } = splitSections(text, file.kind === "user-claude-md" ? "User instructions" : stem === "CLAUDE.local" ? "Local instructions" : "Project instructions");
    imports += n;
    for (const s of sections) push(s.path, s.body, `${s.path}\u0000${s.occurrence}`, []);
  }
  return { candidates, imports, unreadable };
}

// ---- the command -------------------------------------------------------------------------------------------------------------

export interface ClaudeImportOptions {
  dryRun: boolean;
  yes: boolean;
  /** Refresh notes whose file text changed since the last import. */
  update: boolean;
  projects: string[];
  namespace?: string;
  includeIndex: boolean;
  dbPath: string;
}

interface Row {
  label: string;
  project: string;
  sections: number;
  create: number;
  same: number;
  changed: number;
  secrets: number;
}

function table(io: SetupIO, rows: Row[]): void {
  const head = ["Source", "Project", "Sections", "New", "Already there", "Changed", "Skipped (secret)"];
  const data = rows.map((r) => [r.label, r.project, r.sections, r.create, r.same, r.changed, r.secrets].map(String));
  const w = head.map((x, i) => Math.max(x.length, ...data.map((d) => d[i].length), 4));
  const line = (cells: string[]): string => cells.map((c, i) => (i < 2 ? c.padEnd(w[i]) : c.padStart(w[i]))).join("  ");
  io.out(line(head));
  io.out(line(w.map((n) => "-".repeat(n))));
  for (const d of data) io.out(line(d));
}

export async function runClaudeImport(e: Pick<SetupEnv, "home" | "env" | "cwd">, io: SetupIO, opts: ClaudeImportOptions): Promise<number> {
  const { files, skipped } = discoverSources(e, { projects: opts.projects, includeIndex: opts.includeIndex });
  io.out("Reading Claude Code's memory files on this computer (nothing leaves it):");
  if (files.length === 0) {
    io.out("  I found no CLAUDE.md or auto-memory files. Looked in the Claude folder, this folder and its .claude folder.");
    io.out("  Use --project <folder>[,<folder>] to name a project folder.");
    for (const s of skipped) io.out(`  skipped ${s.display}: ${s.why}`);
    return 0;
  }
  const { candidates, imports, unreadable } = buildCandidates(files);
  const { Store, SCHEMA_VERSION } = await import("./store.js");

  // What is already in the store (archived notes count: archiving is how you say "keep it out of the way").
  // The database is only opened to LOOK when it is already current. A missing or older one cannot hold an earlier import
  // (the import tag is new in this release), so every section counts as new, and it is created or upgraded only when
  // you have said yes and something is actually written.
  const onDisk = Store.peekSchemaVersion(opts.dbPath);
  const store = onDisk === SCHEMA_VERSION ? new Store(opts.dbPath) : null;
  let writer: InstanceType<typeof Store> | null = store;
  try {
    const known = new Map<string, { id: number; content: string }>();
    for (let offset = 0; store; offset += 500) {
      const page = store.list({ withTags: [IMPORT_TAG], limit: 500, offset, includeArchived: true, includeSuperseded: true });
      for (const n of page.notes) {
        const k = parseSourceKey(n.source);
        if (k) known.set(k.loc, { id: n.id, content: k.content });
      }
      if (page.notes.length < 500) break;
    }
    const perFile = new Map<SourceFile, Row>();
    const todo: Array<{ c: Candidate; action: "create" | "refresh"; id?: number }> = [];
    for (const c of candidates) {
      let r = perFile.get(c.file);
      if (!r) {
        r = { label: c.file.display, project: c.file.project, sections: 0, create: 0, same: 0, changed: 0, secrets: 0 };
        perFile.set(c.file, r);
      }
      r.sections++;
      if (c.secret) {
        r.secrets++;
        continue;
      }
      const k = known.get(c.loc);
      if (!k) {
        r.create++;
        todo.push({ c, action: "create" });
      } else if (k.content === c.content) r.same++;
      else {
        r.changed++;
        if (opts.update) todo.push({ c, action: "refresh", id: k.id });
      }
    }
    const rows = [...perFile.values()];
    io.out("");
    table(io, rows);
    const tot = rows.reduce((a, r) => ({ s: a.s + r.sections, c: a.c + r.create, same: a.same + r.same, ch: a.ch + r.changed, sec: a.sec + r.secrets }), { s: 0, c: 0, same: 0, ch: 0, sec: 0 });
    io.out(`\n${tot.s} section(s): ${tot.c} new, ${tot.same} already imported, ${tot.ch} changed since, ${tot.sec} skipped because they look like a secret.`);
    if (tot.sec) io.out("  Skipped sections are not stored and not shown. Take the secret out of the file (or keep it in a password manager) and run again.");
    if (tot.ch && !opts.update) io.out("  Changed sections were left as they are; add --update to refresh them.");
    if (imports) io.out(`  ${imports} "@file" import line(s) were not followed (the imported file is read only if it is one of the files above).`);
    for (const s of skipped) io.out(`  skipped ${s.display}: ${s.why}`);
    for (const u of unreadable) io.out(`  could not read ${u}`);
    if (opts.dryRun) {
      io.out("\nDry run: nothing was written.");
      return 0;
    }
    if (todo.length === 0) {
      io.out("\nNothing to import.");
      return 0;
    }
    if (!opts.yes && io.interactive) {
      const a = (await io.ask(`\nImport ${todo.length} note(s) into ${opts.dbPath}? Type y to continue: `)).trim().toLowerCase();
      if (a !== "y" && a !== "yes") {
        io.out("Cancelled. Nothing was written.");
        return 0;
      }
    }
    let created = 0;
    let refreshed = 0;
    let held = 0;
    let failed = 0;
    writer = writer ?? new Store(opts.dbPath);
    const target = writer;
    for (const t of todo) {
      try {
        if (t.action === "create") {
          target.create({ namespace: opts.namespace, title: t.c.title, body: t.c.body, tags: t.c.tags, source: t.c.source }, { writtenBy: IMPORT_WRITER, skipEdges: false });
          created++;
        } else {
          target.update(t.id!, { title: t.c.title, body: t.c.body, source: t.c.source }, { writtenBy: IMPORT_WRITER });
          refreshed++;
        }
      } catch (err) {
        if ((err as Error).constructor.name === "QuarantinedError") held++;
        else failed++;
      }
    }
    io.out(`\nImported ${created} new note(s)${refreshed ? `, refreshed ${refreshed}` : ""}. They are tagged "${IMPORT_TAG}" and written by "${IMPORT_WRITER}".`);
    if (held) io.out(`${held} section(s) were held by the memory linter (it saw something that reads like an instruction to an AI): see \`onememory quarantine\`.`);
    if (failed) {
      io.err(`${failed} section(s) could not be stored.`);
      return 1;
    }
    return 0;
  } finally {
    writer?.close();
    if (store && store !== writer) store.close();
  }
}
