// `onememory import --from claude-mem|mem0|basic-memory`: bring another memory tool's notes into OneMemory.
//
//   * claude-mem   (github.com/thedotmack/claude-mem): its SQLite database, ~/.claude-mem/claude-mem.db by default
//                  ($CLAUDE_MEM_DATA_DIR/claude-mem.db when set). Opened READ-ONLY. `observations` become rows of kind
//                  'observation' (obs_type = its type: bugfix, feature, decision, discovery, change, ...), with the files
//                  they read or changed; `session_summaries` become rows of kind 'summary'. Schema as created by its
//                  src/services/sqlite/SessionStore.ts; the columns added by later versions are read only when present.
//   * mem0         a JSON export: a list of memories, or { "results": [...] } / { "memories": [...] } as get_all returns,
//                  each with id, memory (or text), created_at, metadata (categories), user_id.
//   * basic-memory (github.com/basicmachines-co/basic-memory): a folder of Markdown files with front matter (title, type,
//                  permalink, tags) and Observations / Relations sections. One file = one note; the permalink is its id.
//
// Same rules as `import --claude` (claude-import.ts): local only, a dry run first, anything that looks like a secret is
// skipped and never shown, every write goes through Store.create (memory linter, quarantine), and the stable id of each item
// is kept in `source`, so running it again adds only what is new. Everything read is untrusted: claude-mem's rows were written
// by a model, so they are tagged `imported:claude-mem` (there is no separate "model-written" label yet).

import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { chunkBody, looksLikeCredential, MAX_FILE_BYTES, parseFrontmatter, readHeld, writeHeld } from "./claude-import.js";
import { lintContent } from "./lint.js";
import { LIMITS } from "./security.js";
import type { SetupEnv, SetupIO } from "./setup.js";

export const FOREIGN_SOURCES = ["claude-mem", "mem0", "basic-memory"] as const;
export type ForeignSource = (typeof FOREIGN_SOURCES)[number];

const MAX_JSON_BYTES = 256 * 1024 * 1024;
const MAX_MD_FILES = 100_000;

export interface Item {
  /** Stable id of the item in the other tool: kept in `source` as `import:<tool>:<id>`. */
  id: string;
  /** Row label in the summary (project, user, folder). */
  group: string;
  title: string;
  body: string;
  tags: string[];
  createdAt?: string;
  kind?: "observation" | "summary";
  obsType?: string;
  sessionId?: string;
  files?: Array<{ path: string; action: "read" | "changed" }>;
}

const h = (s: string, n = 16): string => createHash("sha256").update(s).digest("hex").slice(0, n);
const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
const tag = (t: string): string => t.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, LIMITS.tagLen);
const firstLine = (s: string): string => s.trim().split("\n")[0].replace(/^#+\s*/, "").trim();
export const writerFor = (from: ForeignSource): string => `import:${from}`;
export const tagFor = (from: ForeignSource): string => `imported:${from}`;
/** A source key short enough for the held file (claude-import keeps keys under 100 chars). */
export function sourceFor(from: ForeignSource, id: string): string {
  const s = `import:${from}:${id}`;
  return s.length <= 90 && !/[\s\u0000-\u001f]/.test(s) ? s : `import:${from}:h${h(id)}`;
}

function isoFrom(epochMs: unknown, text: unknown): string | undefined {
  if (typeof epochMs === "number" && Number.isFinite(epochMs) && epochMs > 0) return new Date(epochMs).toISOString();
  const t = Date.parse(str(text));
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}

function jsonList(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string" && x.trim() !== "");
  if (typeof v !== "string" || !v.trim()) return [];
  try {
    return jsonList(JSON.parse(v));
  } catch {
    return [v.trim()];
  }
}

// ---- claude-mem ----------------------------------------------------------------------------------------------------------

export function defaultPath(from: ForeignSource, e: Pick<SetupEnv, "home" | "env">): string {
  if (from === "claude-mem") return join(e.env.CLAUDE_MEM_DATA_DIR || join(e.home, ".claude-mem"), "claude-mem.db");
  if (from === "basic-memory") return join(e.home, "basic-memory");
  return "";
}

export function readClaudeMem(path: string): Item[] {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const cols = (t: string): Set<string> => new Set((db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map((c) => c.name));
    const pick = (have: Set<string>, want: string[]): string => want.map((c) => (have.has(c) ? c : `NULL AS ${c}`)).join(", ");
    const oc = cols("observations");
    const sc = cols("session_summaries");
    if (!oc.size && !sc.size) throw new Error("this is not a claude-mem database (no observations or session_summaries table)");
    const items: Item[] = [];
    const files = (read: unknown, changed: unknown): Item["files"] => [
      ...jsonList(changed).map((p) => ({ path: p, action: "changed" as const })),
      ...jsonList(read).map((p) => ({ path: p, action: "read" as const })),
    ];
    if (oc.size) {
      const sel = pick(oc, ["id", "memory_session_id", "project", "text", "type", "title", "subtitle", "facts", "narrative", "concepts", "files_read", "files_modified", "created_at", "created_at_epoch"]);
      for (const r of db.prepare(`SELECT ${sel} FROM observations ORDER BY id`).iterate() as Iterable<Record<string, unknown>>) {
        const facts = jsonList(r.facts);
        const body = [str(r.subtitle), str(r.narrative), str(r.text), facts.length ? facts.map((f) => `- ${f}`).join("\n") : ""].map((s) => s.trim()).filter(Boolean).join("\n\n");
        const title = str(r.title).trim() || firstLine(body);
        if (!title && !body) continue;
        const type = str(r.type).toLowerCase().replace(/[^a-z_]/g, "_").slice(0, 40);
        const project = str(r.project) || "unknown";
        items.push({
          id: `obs:${str(r.id)}`,
          group: project,
          title: title.slice(0, 200),
          body,
          tags: ["observation", ...(type ? [`obs.type:${type}`] : []), `project:${project}`, ...jsonList(r.concepts).slice(0, 10).map((c) => `obs.concept:${c}`)],
          createdAt: isoFrom(r.created_at_epoch, r.created_at),
          kind: "observation",
          obsType: /^[a-z_]{1,40}$/.test(type) ? type : "",
          sessionId: r.memory_session_id ? `claude-mem:${str(r.memory_session_id)}`.slice(0, 200) : undefined,
          files: files(r.files_read, r.files_modified),
        });
      }
    }
    if (sc.size) {
      const sel = pick(sc, ["id", "memory_session_id", "project", "request", "investigated", "learned", "completed", "next_steps", "notes", "files_read", "files_edited", "created_at", "created_at_epoch"]);
      for (const r of db.prepare(`SELECT ${sel} FROM session_summaries ORDER BY id`).iterate() as Iterable<Record<string, unknown>>) {
        const parts: Array<[string, unknown]> = [["Request", r.request], ["Investigated", r.investigated], ["Learned", r.learned], ["Completed", r.completed], ["Next steps", r.next_steps], ["Notes", r.notes]];
        const body = parts.filter(([, v]) => str(v).trim()).map(([k, v]) => `## ${k}\n${str(v).trim()}`).join("\n\n");
        if (!body) continue;
        const project = str(r.project) || "unknown";
        items.push({
          id: `sum:${str(r.id)}`,
          group: project,
          title: `Session summary: ${firstLine(str(r.request)) || project}`.slice(0, 200),
          body,
          tags: ["summary", "obs.type:session", `project:${project}`],
          createdAt: isoFrom(r.created_at_epoch, r.created_at),
          kind: "summary",
          sessionId: r.memory_session_id ? `claude-mem:${str(r.memory_session_id)}`.slice(0, 200) : undefined,
          files: files(r.files_read, r.files_edited),
        });
      }
    }
    return items;
  } finally {
    db.close();
  }
}

// ---- mem0 ----------------------------------------------------------------------------------------------------------------

export function readMem0(path: string): Item[] {
  if (statSync(path).size > MAX_JSON_BYTES) throw new Error(`larger than ${MAX_JSON_BYTES / 1024 / 1024} MiB`);
  const j = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, "")) as unknown;
  const o = j as { results?: unknown; memories?: unknown };
  const list = Array.isArray(j) ? j : Array.isArray(o?.results) ? o.results : Array.isArray(o?.memories) ? o.memories : null;
  if (!list) throw new Error("expected a JSON list of memories (or { \"results\": [...] })");
  const items: Item[] = [];
  list.forEach((m: Record<string, unknown>, i) => {
    if (!m || typeof m !== "object") return;
    const data = (m.data ?? {}) as Record<string, unknown>;
    const text = (str(m.memory) || str(m.text) || str(data.memory)).trim();
    if (!text) return;
    const meta = (m.metadata && typeof m.metadata === "object" ? m.metadata : {}) as Record<string, unknown>;
    const user = str(m.user_id) || str(m.agent_id) || "mem0";
    const cats = [...jsonList(meta.categories), ...jsonList(m.categories)];
    items.push({
      id: str(m.id) || `h${h(text)}:${i}`,
      group: user,
      title: firstLine(text).slice(0, 200),
      body: text,
      tags: [...new Set(cats)].slice(0, 20).map((c) => `category:${c}`).concat(`mem0-user:${user}`),
      createdAt: isoFrom(undefined, m.created_at),
    });
  });
  return items;
}

// ---- basic-memory --------------------------------------------------------------------------------------------------------

/** `tags: [a, b]`, `tags: a, b` or a YAML list under `tags:`. */
function fmTags(text: string, inline: string | undefined): string[] {
  if (inline && inline.trim()) return inline.replace(/^\[|\]$/g, "").split(",").map((t) => t.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
  const m = /^tags:[ \t]*\n((?:[ \t]*-[ \t]+.+\n?){1,100})/m.exec(text.replace(/\r\n?/g, "\n").split("\n---")[0]);
  return m ? m[1].split("\n").map((l) => l.replace(/^[ \t]*-[ \t]+/, "").trim().replace(/^["']|["']$/g, "")).filter(Boolean) : [];
}

export function readBasicMemory(root: string): Item[] {
  const items: Item[] = [];
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      if (name.startsWith(".") || files.length >= MAX_MD_FILES) continue;
      const p = join(dir, name);
      const st = lstatSync(p); // links are not followed: the folder is read as it is
      if (st.isDirectory()) walk(p);
      else if (st.isFile() && /\.md$/i.test(name) && st.size <= MAX_FILE_BYTES) files.push(p);
    }
  };
  walk(root);
  for (const p of files) {
    const text = readFileSync(p, "utf8");
    const { fm, body } = parseFrontmatter(text);
    const clean = body.trim();
    if (!clean) continue;
    const rel = relative(root, p).split("\\").join("/");
    const folder = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "(top)";
    const title = (fm.title || /^#{1,6}[ \t]+(.+)$/m.exec(clean)?.[1]?.trim() || basename(p).replace(/\.md$/i, "")).slice(0, 200);
    items.push({
      id: fm.permalink || rel.replace(/\.md$/i, ""),
      group: folder,
      title,
      body: clean,
      tags: [...fmTags(text, fm.tags), ...(fm.type ? [`bm-type:${fm.type}`] : [])],
      createdAt: isoFrom(undefined, fm.created) ?? statSync(p).mtime.toISOString(),
    });
  }
  return items;
}

// ---- the command ---------------------------------------------------------------------------------------------------------

export interface ForeignImportOptions {
  from: ForeignSource;
  path?: string;
  dryRun: boolean;
  yes: boolean;
  namespace?: string;
  dbPath: string;
}

interface Candidate {
  item: Item;
  title: string;
  body: string;
  tags: string[];
  source: string;
  secret: boolean;
}

function candidates(from: ForeignSource, items: Item[]): Candidate[] {
  const out: Candidate[] = [];
  for (const it of items) {
    const parts = chunkBody(it.body);
    parts.forEach((part, i) => {
      const title = (parts.length > 1 ? `${it.title} (part ${i + 1} of ${parts.length})` : it.title || "Untitled").slice(0, LIMITS.title);
      const tags = [...new Set([tagFor(from), ...it.tags.map(tag).filter(Boolean)])].slice(0, LIMITS.tagCount);
      const finds = lintContent({ title, body: part, tags });
      const secret = finds.some((f) => f.category === "secret" || f.category === "entropy") || looksLikeCredential(title + "\n" + part);
      out.push({ item: it, title, body: part, tags, source: sourceFor(from, parts.length > 1 ? `${it.id}#${i + 1}` : it.id), secret });
    });
  }
  return out;
}

export async function runForeignImport(e: Pick<SetupEnv, "home" | "env" | "cwd">, io: SetupIO, opts: ForeignImportOptions): Promise<number> {
  const { from } = opts;
  const path = opts.path ? resolve(e.cwd, opts.path) : defaultPath(from, e);
  if (!path) {
    io.err(`Name the mem0 export file: onememory import --from mem0 --path <export.json>`);
    return 1;
  }
  if (!existsSync(path)) {
    io.err(`I found nothing at ${path}. Use --path to point at the ${from === "basic-memory" ? "folder" : "file"}.`);
    return 1;
  }
  io.out(`Reading ${from} data from ${path} (read only; nothing leaves this computer):`);
  let items: Item[];
  try {
    items = from === "claude-mem" ? readClaudeMem(path) : from === "mem0" ? readMem0(path) : readBasicMemory(path);
  } catch (err) {
    io.err(`Could not read ${path}: ${(err as Error).message}`);
    return 1;
  }
  const cands = candidates(from, items);
  const { Store, SCHEMA_VERSION } = await import("./store.js");
  // Same as import --claude: look only at a current database; a missing or older one cannot hold an earlier import.
  const store = Store.peekSchemaVersion(opts.dbPath) === SCHEMA_VERSION ? new Store(opts.dbPath) : null;
  let writer: InstanceType<typeof Store> | null = store;
  try {
    const known = new Set<string>();
    for (let offset = 0; store; offset += 500) {
      const page = store.list({ withTags: [tagFor(from)], kinds: ["note", "observation", "summary"], limit: 500, offset, includeArchived: true, includeSuperseded: true });
      for (const n of page.notes) known.add(n.source);
      if (page.notes.length < 500) break;
    }
    const heldBefore = readHeld(opts.dbPath);
    const groups = new Map<string, { n: number; create: number; same: number; secrets: number }>();
    const todo: Candidate[] = [];
    let heldSkipped = 0;
    for (const c of cands) {
      const g = groups.get(c.item.group) ?? { n: 0, create: 0, same: 0, secrets: 0 };
      groups.set(c.item.group, g);
      g.n++;
      if (c.secret) g.secrets++;
      else if (known.has(c.source)) g.same++;
      else if (heldBefore.has(c.source)) heldSkipped++;
      else {
        g.create++;
        todo.push(c);
      }
    }
    io.out("");
    for (const [name, g] of groups) io.out(`  ${name.slice(0, 60).padEnd(30)} ${g.n} item(s): ${g.create} new, ${g.same} already imported, ${g.secrets} skipped (secret)`);
    const t = [...groups.values()].reduce((a, g) => ({ n: a.n + g.n, c: a.c + g.create, s: a.s + g.same, x: a.x + g.secrets }), { n: 0, c: 0, s: 0, x: 0 });
    io.out(`\n${t.n} item(s): ${t.c} new, ${t.s} already imported, ${t.x} skipped because they look like a secret.`);
    if (t.x) io.out("  Skipped items are not stored and not shown. Take the secret out at the source (or keep it in a password manager) and run again.");
    if (heldSkipped) io.out(`  ${heldSkipped} item(s) were held by the memory linter on an earlier run and are not queued again (see \`onememory quarantine\`).`);
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
    writer = writer ?? new Store(opts.dbPath);
    let created = 0;
    let held = 0;
    let failed = 0;
    for (const c of todo) {
      const it = c.item;
      try {
        // ponytail: one write per item, no batching transaction; fine for tens of thousands of rows.
        const note = writer.create(
          { namespace: opts.namespace, title: c.title, body: c.body, tags: c.tags, source: c.source, created_at: it.createdAt },
          { writtenBy: writerFor(from), skipEdges: !!it.kind, ...(it.kind ? { kind: it.kind, sessionId: it.sessionId, obsType: it.obsType ?? "" } : {}) }
        );
        if (it.kind) writer.restoreCaptureLinks(note, it.files);
        created++;
      } catch (err) {
        if ((err as Error).constructor.name === "QuarantinedError") {
          held++;
          heldBefore.add(c.source);
        } else failed++;
      }
    }
    if (held) writeHeld(opts.dbPath, heldBefore);
    io.out(`\nImported ${created} new note(s). They are tagged "${tagFor(from)}" and written by "${writerFor(from)}".`);
    if (held) io.out(`${held} item(s) were held by the memory linter (it saw something that reads like an instruction to an AI): see \`onememory quarantine\`.`);
    if (failed) {
      io.err(`${failed} item(s) could not be stored.`);
      return 1;
    }
    return 0;
  } finally {
    writer?.close();
    if (store && store !== writer) store.close();
  }
}
