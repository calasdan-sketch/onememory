// `onememory setup`: connect OneMemory to Claude Code, Claude Desktop, Cursor, Codex CLI, Gemini CLI, Muse, VS Code and Zed
// without hand-editing JSON (or TOML, for Codex).
//
// The promises, in the order a nervous person would ask for them:
//   * It shows a plain-language plan and the exact lines it will change BEFORE touching anything (`--dry-run` stops there).
//   * It writes only after you type y (`--yes` skips the question; the backup is made either way).
//   * Every file it changes is copied first (<file>.onememory-backup-<time>) and written atomically (temp file + rename).
//   * It changes ONLY the OneMemory entry. Other servers, other settings, comments, number formats, line endings and
//     key order stay byte for byte as they were (see jsonc-edit.ts). Nothing is ever deleted except the old
//     "claude-bridge" entry you agree to migrate; the old install folder and its database are never touched.
//   * `setup --undo` puts it back.
// Files are re-read right before the write and the edit is re-applied to what is there NOW, because Claude Code rewrites
// ~/.claude.json while it runs; a change made in between is kept, not overwritten.

import { copyFileSync, existsSync, fsyncSync, closeSync, openSync, mkdirSync, readFileSync, lstatSync, realpathSync, renameSync, statSync, unlinkSync, writeSync, chmodSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { applyOps, getMember, getPath, JsonEditError, opsAreApplied, parseDoc, parseJsonc, type Op } from "./jsonc-edit.js";
import { applyTomlOps, hasServer, tomlOpsApplied } from "./toml-table.js";

// ---- environment (injectable, so tests never touch a real configuration) ---------------------------------------------

export interface SetupEnv {
  home: string;
  platform: NodeJS.Platform;
  /** The process environment (APPDATA, CLAUDE_CONFIG_DIR, ONEMEMORY_*). */
  env: NodeJS.ProcessEnv;
  cwd: string;
  nodeVersion: string;
  execPath: string;
  /** Absolute path of this package's cli.js. */
  cliPath: string;
  version: string;
  now: () => Date;
}

/** Expand Windows 8.3 short names (PROGRA~1) and symlinks to the real long path; keep the input if that is impossible. */
export function longPath(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return p;
  }
}

export function realEnv(version: string, cliPath: string): SetupEnv {
  return {
    home: homedir(),
    platform: process.platform,
    env: process.env,
    cwd: process.cwd(),
    nodeVersion: process.versions.node,
    execPath: longPath(process.execPath),
    cliPath: longPath(cliPath),
    version,
    now: () => new Date(),
  };
}

export interface SetupIO {
  out(line: string): void;
  err(line: string): void;
  /** Ask a question; resolves with the typed answer. */
  ask(prompt: string): Promise<string>;
  interactive: boolean;
}

export interface SetupOptions {
  dryRun: boolean;
  yes: boolean;
  undo: boolean;
  /** "ask" (default), "yes" (--hook), "no" (--no-hook). */
  hook: "ask" | "yes" | "no";
  /** Automatic memory hooks: "ask" (default), "yes" (--capture), "no" (--no-capture). */
  capture?: "ask" | "yes" | "no";
  /** Restrict to these clients (CLIENT_IDS). */
  only?: string[];
  /** Also add to ./.mcp.json in the current folder. */
  project: boolean;
  /** Use this database for the new entry (default: the standard one, or the old one when migrating). */
  db?: string;
  noTestNote: boolean;
  noDoctor: boolean;
  /** "auto" (default), "node" (absolute node + cli.js) or "npx". */
  command: "auto" | "node" | "npx";
  /** Replace a config file that exists but is completely empty (0 bytes), which may be a half-written one. */
  forceEmpty: boolean;
}

export const DEFAULT_OPTIONS: SetupOptions = { dryRun: false, yes: false, undo: false, hook: "ask", project: false, noTestNote: false, noDoctor: false, command: "auto", forceEmpty: false };

const EMPTY_FILE_MSG = (file: string): string =>
  `${file} exists but is completely empty (0 bytes). A program may have been cut off while saving it, and replacing it could lose settings. Look for a backup next to it, or if you are sure it is empty run setup again with --force-empty.`;

export const CLIENT_IDS = ["claude-code", "claude-desktop", "cursor", "codex", "gemini", "muse", "vscode", "zed", "project"] as const;
export type ClientId = (typeof CLIENT_IDS)[number];

// ---- detection ---------------------------------------------------------------------------------------------------------

export interface ClientTarget {
  id: ClientId;
  label: string;
  file: string;
  exists: boolean;
  /** The app looks installed (its config folder exists) even when the file does not yet. */
  present: boolean;
}

export function claudeDir(e: SetupEnv): string {
  const c = e.env.CLAUDE_CONFIG_DIR?.trim();
  return c ? resolve(c) : join(e.home, ".claude");
}

const appData = (e: SetupEnv): string => e.env.APPDATA?.trim() || join(e.home, "AppData", "Roaming");
const xdgConfig = (e: SetupEnv): string => e.env.XDG_CONFIG_HOME?.trim() || join(e.home, ".config");
export const codexDir = (e: SetupEnv): string => (e.env.CODEX_HOME?.trim() ? resolve(e.env.CODEX_HOME.trim()) : join(e.home, ".codex"));

export function detectClients(e: SetupEnv): ClientTarget[] {
  const out: ClientTarget[] = [];
  const cfgDir = e.env.CLAUDE_CONFIG_DIR?.trim();
  const ccFile = cfgDir ? join(resolve(cfgDir), ".claude.json") : join(e.home, ".claude.json");
  out.push({ id: "claude-code", label: "Claude Code", file: ccFile, exists: existsSync(ccFile), present: existsSync(ccFile) || existsSync(claudeDir(e)) });
  let desk: string;
  if (e.platform === "win32") desk = join(appData(e), "Claude", "claude_desktop_config.json");
  else if (e.platform === "darwin") desk = join(e.home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  else desk = join(xdgConfig(e), "Claude", "claude_desktop_config.json");
  out.push({ id: "claude-desktop", label: "Claude Desktop", file: desk, exists: existsSync(desk), present: existsSync(desk) || existsSync(dirname(desk)) });
  const cur = join(e.home, ".cursor", "mcp.json");
  out.push({ id: "cursor", label: "Cursor", file: cur, exists: existsSync(cur), present: existsSync(cur) || existsSync(dirname(cur)) });
  const add = (id: ClientId, label: string, file: string, dir = dirname(file)): void => void out.push({ id, label, file, exists: existsSync(file), present: existsSync(file) || existsSync(dir) });
  add("codex", "Codex CLI", join(codexDir(e), "config.toml"));
  add("gemini", "Gemini CLI", join(e.home, ".gemini", "settings.json"));
  // Muse documents only ~/.config/muse (or $XDG_CONFIG_HOME/muse); on Windows it runs under WSL2, so a native Windows
  // path is unverified and the same ~/.config path is used.
  add("muse", "Muse", join(xdgConfig(e), "muse", "settings.json"));
  add("vscode", "VS Code", join(e.platform === "win32" ? appData(e) : e.platform === "darwin" ? join(e.home, "Library", "Application Support") : xdgConfig(e), "Code", "User", "mcp.json"));
  add("zed", "Zed", e.platform === "win32" ? join(appData(e), "Zed", "settings.json") : join(xdgConfig(e), "zed", "settings.json"));
  const proj = join(e.cwd, ".mcp.json");
  out.push({ id: "project", label: "This folder's .mcp.json", file: proj, exists: existsSync(proj), present: existsSync(proj) });
  return out;
}

// ---- the entry we write ------------------------------------------------------------------------------------------------

export interface ServerEntry {
  type?: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  [k: string]: unknown;
}

/** Is this process running from the npx cache (which is deleted from time to time)? */
export function runningFromNpxCache(cliPath: string): boolean {
  return /[\\/]_npx[\\/]/.test(cliPath);
}

export function buildServerEntry(e: SetupEnv, opts: Pick<SetupOptions, "command">, env?: Record<string, string>, withType = false): ServerEntry {
  const useNpx = opts.command === "npx" || (opts.command === "auto" && runningFromNpxCache(e.cliPath));
  let entry: ServerEntry;
  if (useNpx) {
    // Pinned to this version on purpose: a database upgrade is one-way, so it must be a choice, not a side effect of npx.
    const pkg = `onememory-mcp@${e.version}`;
    // On native Windows, npx is a .cmd script, so a config usually needs it wrapped as `cmd /c npx`. This is commonly needed;
    // the Claude Code MCP docs do not state it (checked), so it is not confirmed there. Verify with `/mcp` after setup.
    entry = e.platform === "win32" ? { command: "cmd", args: ["/c", "npx", "-y", pkg, "mcp"] } : { command: "npx", args: ["-y", pkg, "mcp"] };
  } else {
    // Absolute node + absolute cli.js: nothing depends on PATH, and it is the same on every OS.
    entry = { command: e.execPath, args: [e.cliPath, "mcp"] };
  }
  if (withType) entry = { type: "stdio", ...entry };
  if (env && Object.keys(env).length) entry.env = env;
  return entry;
}

/** The command a hook runs (a shell runs it, so: bare `node`, forward slashes, quoted path). */
export function buildHookCommand(e: SetupEnv, opts: Pick<SetupOptions, "command">, dbPath?: string): string {
  const useNpx = opts.command === "npx" || (opts.command === "auto" && runningFromNpxCache(e.cliPath));
  const db = dbPath ? ` --db "${dbPath.replace(/\\/g, "/")}"` : "";
  if (useNpx) return `npx -y onememory-mcp@${e.version} recall --budget-ms 800${db}`;
  return `node "${e.cliPath.replace(/\\/g, "/")}" recall --budget-ms 800${db}`;
}

export type EntryKind = "onememory" | "legacy" | "other";

export function classifyEntry(name: string, entry: unknown): EntryKind {
  if (name === "onememory") return "onememory";
  const o = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
  const args = Array.isArray(o.args) ? o.args.map(String) : [];
  const line = [typeof o.command === "string" ? o.command : "", ...args].join(" ").toLowerCase().replace(/\\/g, "/");
  const envKeys = o.env && typeof o.env === "object" ? Object.keys(o.env as object) : [];
  const legacy = name === "claude-bridge" || /claude-bridge/.test(line) || envKeys.some((k) => k.startsWith("CLAUDE_BRIDGE_"));
  if (legacy) return "legacy";
  if (/onememory/.test(line)) return "onememory";
  return "other";
}

/** Where the old install keeps its data when the entry names no database: <install>/data/state.db. */
function dbBesideInstall(entry: Record<string, unknown>): string | null {
  const args = Array.isArray(entry.args) ? entry.args.map(String) : [];
  for (const a of args) {
    const m = /^(.*)[\\/]dist[\\/]src[\\/][^\\/]+\.js$/.exec(a);
    if (m) {
      const sep = a.includes("\\") ? "\\" : "/";
      return `${m[1]}${sep}data${sep}state.db`;
    }
  }
  return null;
}

/** Turn an old claude-bridge entry into the OneMemory entry that keeps its data. */
export function migrateEntry(e: SetupEnv, opts: Pick<SetupOptions, "command">, old: Record<string, unknown>, withType: boolean): { entry: ServerEntry; db: string | null; notes: string[] } {
  const notes: string[] = [];
  const env: Record<string, string> = {};
  const oldEnv = old.env && typeof old.env === "object" ? (old.env as Record<string, unknown>) : {};
  // A name already in the new style wins over its old-style twin, exactly as at run time (legacy-env.ts).
  for (const [k, v] of Object.entries(oldEnv)) if (typeof v === "string" && !k.startsWith("CLAUDE_BRIDGE_")) env[k] = v;
  for (const [k, v] of Object.entries(oldEnv)) {
    if (typeof v !== "string" || !k.startsWith("CLAUDE_BRIDGE_")) continue;
    const nk = "ONEMEMORY_" + k.slice("CLAUDE_BRIDGE_".length);
    if (!(nk in env)) env[nk] = v;
  }
  let db = env.ONEMEMORY_DB_PATH ?? null;
  if (!db) {
    const guess = dbBesideInstall(old);
    if (guess && existsSync(guess)) {
      env.ONEMEMORY_DB_PATH = guess;
      db = guess;
      notes.push(`the old entry named no database; found one at ${guess} and pointed the new entry at it`);
    } else {
      notes.push("the old entry named no database and none was found next to it: the new entry will start with the standard location (~/.onememory)");
    }
  }
  const entry = buildServerEntry(e, opts, env, withType);
  // Keep any extra setting the old entry had (a timeout, "disabled") rather than silently dropping it.
  for (const [k, v] of Object.entries(old)) if (!["command", "args", "env", "type"].includes(k)) entry[k] = v;
  return { entry, db, notes };
}

// ---- planning ----------------------------------------------------------------------------------------------------------

export interface FileChange {
  client: ClientId;
  label: string;
  file: string;
  /** Text as read when planned (null: the file does not exist yet). */
  before: string | null;
  ops: Op[];
  /** One line each, plain language. */
  lines: string[];
  /** Ops that put things back (recorded for --undo). */
  inverse: Op[];
  /** Allow replacing an existing 0-byte file (--force-empty). */
  allowEmpty?: boolean;
  /** Codex's config.toml: ops are TOML table edits (toml-table.ts), not JSON. */
  format?: "toml";
}

/** applyOps / opsAreApplied for either file format. */
const applyFor = (text: string, ops: readonly Op[], format?: "toml"): string => (format === "toml" ? applyTomlOps(text, ops) : applyOps(text, ops));
const appliedFor = (text: string, ops: readonly Op[], format?: "toml"): boolean => (format === "toml" ? tomlOpsApplied(text, ops) : opsAreApplied(text, ops));

export interface SetupPlan {
  nodeOk: boolean;
  found: ClientTarget[];
  changes: FileChange[];
  /** Databases to open (each distinct). */
  dbs: string[];
  warnings: string[];
  /** Entries that are already fine. */
  already: string[];
  conflicts: string[];
}

const MIN_NODE = 24;

export function nodeIsOk(v: string): boolean {
  return Number(v.split(".")[0]) >= MIN_NODE;
}

export function readTextFile(file: string): string | null {
  try {
    const buf = readFileSync(file);
    const text = buf.toString("utf8");
    if (Buffer.from(text, "utf8").compare(buf) !== 0) throw new JsonEditError(`${file} is not valid UTF-8 text; fix it first`);
    return text;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

function safeParseEntry(text: string, node: { start: number; end: number }): Record<string, unknown> | null {
  const slice = text.slice(node.start, node.end);
  let v: unknown;
  try {
    v = JSON.parse(slice);
  } catch {
    try {
      v = parseJsonc(slice); // comments or trailing commas inside the entry
    } catch {
      return null;
    }
  }
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

interface FoundServer {
  path: string[]; // path to the mcpServers object
  name: string;
  start: number;
  end: number;
}

function findServers(text: string, includeProjects: boolean, key = "mcpServers"): FoundServer[] {
  const doc = parseDoc(text);
  const res: FoundServer[] = [];
  const add = (path: string[]): void => {
    const node = getPath(doc, path);
    if (!node || node.kind !== "object") return;
    for (const m of node.members!) res.push({ path, name: m.key, start: m.value.start, end: m.value.end });
  };
  add([key]);
  if (includeProjects) {
    const projects = getPath(doc, ["projects"]);
    if (projects && projects.kind === "object") for (const p of projects.members!) add(["projects", p.key, "mcpServers"]);
  }
  return res;
}

/**
 * The object that holds the servers in each app's file. VS Code: "servers"; Zed: "context_servers"; Muse documents
 * "mcp_servers" (Meta's docs) but "mcpServers" is also seen and accepted as a legacy spelling, so an existing
 * "mcpServers" is kept rather than adding a second block.
 */
function serversKey(id: ClientId, text: string): string {
  if (id === "vscode") return "servers";
  if (id === "zed") return "context_servers";
  if (id === "muse") return text.trim() && !getPath(parseDoc(text), ["mcp_servers"]) && getPath(parseDoc(text), ["mcpServers"]) ? "mcpServers" : "mcp_servers";
  return "mcpServers";
}

/** Codex CLI: one [mcp_servers.onememory] table in ~/.codex/config.toml (command/args/env), everything else untouched. */
function planToml(e: SetupEnv, opts: SetupOptions, target: ClientTarget, text: string | null, shared: { dbs: Set<string> }): { change: FileChange | null; already: string[]; conflicts: string[]; warnings: string[] } {
  if (text !== null && hasServer(text, "onememory")) return { change: null, already: [`${target.label}: "onememory" is already set up`], conflicts: [], warnings: [] };
  const entry = buildServerEntry(e, opts, opts.db ? { ONEMEMORY_DB_PATH: opts.db } : undefined);
  if (opts.db) shared.dbs.add(opts.db);
  const ops: Op[] = [{ op: "set", path: ["mcp_servers"], key: "onememory", value: entry }];
  const lines = [`add the "onememory" memory server${opts.db ? ` (database ${opts.db})` : ""}`];
  return { change: { client: target.id, label: target.label, file: target.file, before: text, ops, lines, inverse: [{ op: "remove", path: ["mcp_servers"], key: "onememory" }], allowEmpty: opts.forceEmpty, format: "toml" }, already: [], conflicts: [], warnings: [] };
}

export function planFile(e: SetupEnv, opts: SetupOptions, target: ClientTarget, shared: { dbs: Set<string> }): { change: FileChange | null; already: string[]; conflicts: string[]; warnings: string[] } {
  const text = readTextFile(target.file);
  if (text === "" && !opts.forceEmpty) return { change: null, already: [], conflicts: [EMPTY_FILE_MSG(target.file)], warnings: [] };
  if (target.id === "codex") return planToml(e, opts, target, text, shared);
  const base = text ?? "";
  const key = serversKey(target.id, base);
  const already: string[] = [];
  const conflicts: string[] = [];
  const warnings: string[] = [];
  const lines: string[] = [];
  const ops: Op[] = [];
  const inverse: Op[] = [];
  const withType = target.id === "claude-code" || target.id === "project" || target.id === "vscode";
  const servers = base.trim() === "" ? [] : findServers(base, target.id === "claude-code", key);
  const top = servers.filter((s) => s.path.length === 1);
  const hasOneTop = top.some((s) => classifyEntry(s.name, safeParseEntry(base, s) ?? {}) === "onememory");
  let migrated = 0;
  for (const s of servers) {
    const entry = safeParseEntry(base, s);
    if (!entry) {
      warnings.push(
        /bridge/i.test(s.name)
          ? `${target.label}: the entry "${s.name}" looks like the old claude-bridge, but I could not read it, so I did NOT migrate it and left it alone. By hand: in the file, rename "${s.name}" to "onememory", set its "command" and "args" as shown in docs/live-claude-code.md, and rename its CLAUDE_BRIDGE_* settings to ONEMEMORY_* (same ending). Your data is not touched.`
          : `${target.label}: the entry "${s.name}" is in a form I do not understand; I left it alone`
      );
      continue;
    }
    const kind = classifyEntry(s.name, entry);
    const where = s.path.length === 1 ? "" : ` (project ${s.path[1]})`;
    if (kind === "onememory") {
      already.push(`${target.label}: "${s.name}"${where} is already set up`);
      continue;
    }
    if (kind !== "legacy") continue;
    // An existing "onememory" next to the old one: do not merge two things by guesswork.
    const sibling = servers.some((x) => x.name === "onememory" && x.path.join("\u0000") === s.path.join("\u0000"));
    if (sibling) {
      conflicts.push(`${target.label}: both "${s.name}" and "onememory" exist${where}; remove the one you do not want, then run setup again`);
      continue;
    }
    const m = migrateEntry(e, opts, entry, withType);
    if (opts.db) m.entry.env = { ...(m.entry.env ?? {}), ONEMEMORY_DB_PATH: opts.db };
    ops.push({ op: "rename", path: s.path, key: s.name, newKey: "onememory", value: m.entry });
    inverse.unshift({ op: "rename", path: s.path, key: "onememory", newKey: s.name, value: entry });
    lines.push(`replace the old "${s.name}" entry${where} with "onememory"; ${m.db ? `your data stays where it is (${m.db})` : "standard data location"}. The old install folder is not touched`);
    lines.push(...m.notes.map((n) => "note: " + n));
    const dbToCheck = opts.db ?? m.db;
    if (dbToCheck) shared.dbs.add(dbToCheck);
    migrated++;
  }
  if (migrated === 0 && !hasOneTop && (target.id !== "project" || opts.project) && !already.length) {
    const env: Record<string, string> = {};
    if (opts.db) env.ONEMEMORY_DB_PATH = opts.db;
    let entry = buildServerEntry(e, opts, env, withType);
    // Muse: "optional" so a server that fails to start is skipped with a warning instead of aborting the whole run.
    if (target.id === "muse") entry = { transport: "stdio", ...entry, mode: "optional" };
    // Muse refuses to start without "schema_version": 1, so a file we create (or one missing it) gets it.
    if (target.id === "muse" && !(base.trim() && getPath(parseDoc(base), ["schema_version"]))) {
      ops.push({ op: "set", path: [], key: "schema_version", value: 1 });
      inverse.unshift({ op: "remove", path: [], key: "schema_version" });
    }
    ops.push({ op: "set", path: [key], key: "onememory", value: entry });
    inverse.unshift({ op: "remove", path: [key], key: "onememory" });
    lines.push(`add the "onememory" memory server${opts.db ? ` (database ${opts.db})` : ""}`);
    if (opts.db) shared.dbs.add(opts.db);
  }
  if (ops.length === 0) return { change: null, already, conflicts, warnings };
  return { change: { client: target.id, label: target.label, file: target.file, before: text, ops, lines, inverse, allowEmpty: opts.forceEmpty }, already, conflicts, warnings };
}

export const HOOK_MARKER = "recall --budget-ms";
/** Our own start-of-session hook: the recall command we write, any command line naming onememory with recall, or the capture session-start hook. */
const HOOK_DETECT = /recall --budget-ms|onememory[^\n]{0,120}\b(?:recall|hook session-start)\b/;

/**
 * Automatic memory: the Claude Code events the capture hooks run on, the `onememory hook <event>` each runs, and whether
 * it runs in the background (`async`: the agent does not wait for it). user-prompt is synchronous so the prompt is
 * recorded before the tools it causes; session-start (below) is synchronous because its output is the injected context.
 */
export const CAPTURE_HOOKS: ReadonlyArray<{ on: string; event: string; async: boolean; matcher?: string }> = [
  { on: "UserPromptSubmit", event: "user-prompt", async: false },
  // Advisory: what memory knows about a file, shown just before the agent reads it (never denies). Synchronous: its output is the context.
  { on: "PreToolUse", event: "file-context", async: false, matcher: "Read" },
  { on: "PostToolUse", event: "post-tool", async: true, matcher: "*" },
  { on: "PostToolUseFailure", event: "post-tool-failure", async: true, matcher: "*" },
  { on: "Stop", event: "stop", async: true },
  { on: "SubagentStop", event: "subagent-stop", async: true },
  { on: "SessionEnd", event: "session-end", async: true },
];

/** `onememory hook <event>` as a hook command (same launcher rules as buildHookCommand). */
export function buildCaptureCommand(e: SetupEnv, opts: Pick<SetupOptions, "command">, event: string, dbPath?: string): string {
  const useNpx = opts.command === "npx" || (opts.command === "auto" && runningFromNpxCache(e.cliPath));
  const db = dbPath ? ` --db "${dbPath.replace(/\\/g, "/")}"` : "";
  if (useNpx) return `npx -y onememory-mcp@${e.version} hook ${event}${db}`;
  return `node "${e.cliPath.replace(/\\/g, "/")}" hook ${event}${db}`;
}

export function planHook(e: SetupEnv, opts: SetupOptions, dbForHook?: string): { change: FileChange | null; already: boolean; conflict?: string } {
  return planHooks(e, opts, dbForHook, { recall: true, capture: false });
}

type CaptureHook = { on: string; event: string; async: boolean; matcher?: string };

/** An agent with command hooks: where they live, its start-of-session event, and its events mapped to `onememory hook <event>`. */
export interface HookHost {
  client: ClientId;
  label: string;
  /** Who "does" things, in the plan's wording. */
  agent: string;
  file: string;
  start: { on: string; matcher?: string };
  events: ReadonlyArray<CaptureHook>;
  /** Extra plan lines (notes). */
  notes?: string[];
}

/**
 * Every agent whose hooks setup can wire. All take the Claude Code shape ({hooks: {<Event>: [{matcher?, hooks: [{type:
 * "command", command}]}]}}) and send session_id / cwd / prompt / tool_name / tool_input / tool_response on stdin
 * (capture.ts reads Gemini's AfterAgent `prompt_response` too).
 *  - Codex: ~/.codex/hooks.json; events and fields from developers.openai.com/codex/hooks (async is documented there).
 *  - Gemini CLI: the "hooks" key of ~/.gemini/settings.json; BeforeAgent/AfterTool/AfterAgent/SessionEnd per
 *    geminicli.com/docs/hooks. Lifecycle matchers must match exactly, so SessionStart gets none; no async field.
 *  - Muse: the "hooks" key of its settings.json. Meta lists the same event names as Claude Code but does not publish the
 *    stdin fields or the allowed group keys, and it skips a group with a key it does not know, so ours carry nothing but
 *    the command (no matcher, no async) and are recognised by their command line alone. UNVERIFIED: the stdin field names.
 */
export function hookHosts(e: SetupEnv): HookHost[] {
  const muse = detectClients(e).find((t) => t.id === "muse")!.file;
  return [
    { client: "claude-code", label: "Claude Code hook", agent: "Claude", file: join(claudeDir(e), "settings.json"), start: { on: "SessionStart", matcher: "startup|clear" }, events: CAPTURE_HOOKS },
    {
      client: "codex",
      label: "Codex CLI hook",
      agent: "Codex",
      file: join(codexDir(e), "hooks.json"),
      start: { on: "SessionStart", matcher: "startup|clear" },
      events: [
        { on: "UserPromptSubmit", event: "user-prompt", async: false },
        { on: "PostToolUse", event: "post-tool", async: true, matcher: "*" },
        { on: "Stop", event: "stop", async: true },
      ],
      notes: ["note: Codex runs a new hook only after you trust it: type /hooks in Codex and approve the OneMemory ones"],
    },
    {
      client: "gemini",
      label: "Gemini CLI hook",
      agent: "Gemini",
      file: join(e.home, ".gemini", "settings.json"),
      start: { on: "SessionStart" },
      events: [
        { on: "BeforeAgent", event: "user-prompt", async: false },
        { on: "AfterTool", event: "post-tool", async: false, matcher: "*" },
        { on: "AfterAgent", event: "stop", async: false },
        { on: "SessionEnd", event: "session-end", async: false },
      ],
    },
    {
      client: "muse",
      label: "Muse hook",
      agent: "Muse",
      file: muse,
      start: { on: "SessionStart" },
      events: ["UserPromptSubmit:user-prompt", "PostToolUse:post-tool", "PostToolUseFailure:post-tool-failure", "Stop:stop", "SubagentStop:subagent-stop", "SessionEnd:session-end"].map((x) => {
        const [on, event] = x.split(":");
        return { on, event, async: false };
      }),
    },
  ];
}

/**
 * The hooks to add to ~/.claude/settings.json: the start-of-session context (`recall`, unless one of ours is already
 * there) and, with `capture`, one entry per CAPTURE_HOOKS event (each only if that event has no onememory hook yet).
 * With capture the start-of-session entry is `hook session-start`, which prints the same context and also does the
 * capture housekeeping. Existing entries, ours or anyone's, are never touched; every addition has its own undo op.
 */
export function planHooks(e: SetupEnv, opts: SetupOptions, dbForHook: string | undefined, want: { recall: boolean; capture: boolean }, host: HookHost = hookHosts(e)[0]): { change: FileChange | null; already: boolean; conflict?: string } {
  const file = host.file;
  const text = readTextFile(file);
  if (text === "" && !opts.forceEmpty) return { change: null, already: false, conflict: EMPTY_FILE_MSG(file) };
  const doc = text && text.trim() ? parseDoc(text) : null;
  const has = (on: string, re: RegExp): boolean => {
    const arr = doc ? getPath(doc, ["hooks", on]) : null;
    return !!arr && re.test(text!.slice(arr.start, arr.end));
  };
  const ops: Op[] = [];
  const inverse: Op[] = [];
  const lines: string[] = [];
  if (want.recall && !has(host.start.on, HOOK_DETECT)) {
    const command = want.capture ? buildCaptureCommand(e, opts, "session-start", dbForHook) : buildHookCommand(e, opts, dbForHook);
    const hooks = [{ type: "command", command }];
    ops.push({ op: "append", path: ["hooks"], key: host.start.on, value: host.start.matcher ? { matcher: host.start.matcher, hooks } : { hooks } });
    inverse.unshift({ op: "unappend", path: ["hooks"], key: host.start.on, marker: want.capture ? "hook session-start" : HOOK_MARKER });
    lines.push(`add a start-of-session hook that shows your recent notes to ${host.agent} (your existing hooks stay as they are)`);
  }
  if (want.capture) {
    let added = 0;
    for (const h of host.events) {
      // Ours: a command line naming onememory (the package or its cli.js) with `hook <event>`; another tool's hook is not.
      if (has(h.on, new RegExp(`onememory[^\\n]{0,160}\\bhook ${h.event}(?![\\w-])`))) continue;
      const hook = { type: "command", command: buildCaptureCommand(e, opts, h.event, dbForHook), ...(h.async ? { async: true } : {}) };
      ops.push({ op: "append", path: ["hooks"], key: h.on, value: h.matcher ? { matcher: h.matcher, hooks: [hook] } : { hooks: [hook] } });
      inverse.unshift({ op: "unappend", path: ["hooks"], key: h.on, marker: `hook ${h.event}` });
      added++;
    }
    if (added) lines.push(`record what ${host.agent} does in this project (files, commands, errors) into OneMemory, stored only on this machine (ONEMEMORY_CAPTURE=off turns it off)`);
  }
  if (!ops.length) return { change: null, already: true };
  if (host.notes) lines.push(...host.notes);
  return {
    change: { client: host.client, label: host.label, file, before: text, ops, lines, inverse, allowEmpty: opts.forceEmpty },
    already: false,
  };
}

// ---- diff (shown to the person) ------------------------------------------------------------------------------------------

const SECRET_LINE = /("[^"\n]*(?:TOKEN|KEY|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)[^"\n]*"\s*:\s*)"[^"\n]*"/gi;
const PLAIN_ENV_KEY = /_(PATH|HOME|DIR|FILE|PORT|HOST|BIND|TIMEZONE)$/;
const ENV_STYLE_LINE = /("([A-Z][A-Z0-9_]{2,})"\s*:\s*)"[^"\n]*"/g;
const URL_CREDS = /(\b\w{1,20}:\/\/[^\s:@/"]{1,100}:)[^\s@/"]{1,200}@/g;

/** Hide values that could be secrets in a diff shown on screen: secret-looking keys, any ALL_CAPS env value that is not a plain path/port/etc., and user:pass@ in URLs. */
export function redact(s: string): string {
  return s
    .replace(SECRET_LINE, '$1"***"')
    .replace(ENV_STYLE_LINE, (m, pre: string, key: string) => (PLAIN_ENV_KEY.test(key) ? m : `${pre}"***"`))
    .replace(URL_CREDS, "$1***@");
}

/** A small, exact line diff: the unchanged head and tail are trimmed, the middle is shown with 2 lines of context. */
export function lineDiff(before: string, after: string, file: string): string[] {
  const a = before.replace(/\r\n/g, "\n").split("\n");
  const b = after.replace(/\r\n/g, "\n").split("\n");
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const ctx = 2;
  const from = Math.max(0, head - ctx);
  const out = [`--- ${file}${before === "" ? " (new file)" : ""}`, `+++ ${file}`, `@@ line ${from + 1} @@`];
  for (let i = from; i < head; i++) out.push("  " + redact(a[i]));
  if (before !== "") for (let i = head; i < a.length - tail; i++) out.push("- " + redact(a[i]));
  for (let i = head; i < b.length - tail; i++) out.push("+ " + redact(b[i]));
  for (let i = a.length - tail; i < Math.min(a.length, a.length - tail + ctx); i++) out.push("  " + redact(a[i]));
  return out;
}

// ---- writing: backup + atomic + re-read ----------------------------------------------------------------------------------

export interface WrittenChange {
  file: string;
  /** Resolved real file (the target of a symlink). */
  real: string;
  backup: string | null;
  createdFile: boolean;
  afterSha: string;
  inverse: Op[];
  label: string;
  format?: "toml";
}

const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

export function stamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function renameWithRetry(from: string, to: string): void {
  // Windows can refuse a rename for a moment while antivirus or another program has the file open.
  for (let i = 0; ; i++) {
    try {
      renameSync(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // About 2 seconds elsewhere; about 7 on Windows, where antivirus and indexers hold files longer.
      const tries = process.platform === "win32" ? 12 : 8;
      if (i < tries && (code === "EPERM" || code === "EBUSY" || code === "EACCES")) {
        sleepSync(process.platform === "win32" ? Math.min(100 * (i + 1), 800) : 60 * (i + 1));
        continue;
      }
      throw err;
    }
  }
}

function writeAtomic(real: string, text: string, mode: number | null): void {
  const tmp = join(dirname(real), `.${basename(real)}.onememory-tmp-${process.pid}-${randomBytes(3).toString("hex")}`);
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeSync(fd, text);
    try {
      fsyncSync(fd);
    } catch {
      /* some filesystems refuse; the rename is still atomic */
    }
  } finally {
    closeSync(fd);
  }
  try {
    if (mode !== null && process.platform !== "win32") chmodSync(tmp, mode);
    renameWithRetry(tmp, real);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* gone */
    }
    throw err;
  }
}

/**
 * Apply `change.ops` to the file as it is RIGHT NOW. If the file changes between our read and the rename (Claude Code
 * rewrites ~/.claude.json while it runs) the edit is re-applied to the newer text, up to 5 times. After the rename the
 * file is read back and the edit must still be there.
 */
export function writeChange(e: SetupEnv, change: FileChange): WrittenChange | null {
  const file = change.file;
  let real = file;
  try {
    real = realpathSync(file); // a symlinked config is edited at its target, so the link survives
  } catch {
    let isLink = false;
    try {
      isLink = lstatSync(file).isSymbolicLink();
    } catch {
      /* not there at all: fine, it will be created */
    }
    if (isLink) throw new JsonEditError(`${file} is a link to a file that does not exist; nothing was written (fix or remove the link, then run setup again)`);
    mkdirSync(dirname(file), { recursive: true });
  }
  for (let attempt = 0; attempt < 5; attempt++) {
    let buf: Buffer | null = null;
    try {
      buf = readFileSync(real);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    if (buf && buf.length === 0 && !change.allowEmpty) throw new JsonEditError(EMPTY_FILE_MSG(file));
    const current = buf ? buf.toString("utf8") : null;
    if (buf && current !== null && Buffer.from(current, "utf8").compare(buf) !== 0) throw new JsonEditError(`${file} is not valid UTF-8 text; nothing was written`);
    if (current !== null && appliedFor(current, change.ops, change.format)) return null; // already in place (someone else added it in the meantime)
    const next = applyFor(current ?? "", change.ops, change.format);
    let backup: string | null = null;
    if (buf) {
      backup = `${real}.onememory-backup-${stamp(e.now())}`;
      for (let n = 1; existsSync(backup); n++) backup = `${real}.onememory-backup-${stamp(e.now())}-${n}`;
      const bfd = openSync(backup, "wx", 0o600);
      try {
        writeSync(bfd, buf);
      } finally {
        closeSync(bfd);
      }
    }
    let mode: number | null = null;
    try {
      mode = statSync(real).mode & 0o777;
    } catch {
      /* new file */
    }
    // Last look before the swap: unchanged since we computed `next`?
    let again: Buffer | null = null;
    try {
      again = readFileSync(real);
    } catch {
      /* still absent */
    }
    if ((again === null) !== (buf === null) || (again && buf && again.compare(buf) !== 0)) {
      if (backup) unlinkSync(backup);
      sleepSync(40);
      continue; // changed under us: redo the edit on the newer text
    }
    writeAtomic(real, next, mode);
    // Read back: our edit must be there (a program holding an older copy could have written it over).
    const back = readFileSync(real, "utf8");
    const stillThere = appliedFor(back, change.ops, change.format);
    if (stillThere) return { file, real, backup, createdFile: buf === null, afterSha: sha(back), inverse: change.inverse, label: change.label, ...(change.format ? { format: change.format } : {}) };
    if (attempt === 4) throw new Error(`${file} keeps being rewritten by another program, so the change did not stay. Close Claude Code and run setup again.`);
    sleepSync(80);
  }
  throw new Error(`${file} changed while I was working on it; run setup again (close Claude Code first).`);
}

// ---- undo history ----------------------------------------------------------------------------------------------------------

export interface HistorySession {
  id: string;
  at: string;
  version: string;
  undone?: boolean;
  changes: WrittenChange[];
  /** Databases setup opened, with the schema version each had BEFORE (null: none yet), so --undo can say what rolling back needs. */
  dbs?: Array<{ path: string; before: number | null }>;
  /** An old claude-bridge entry was replaced in this session. */
  migratedLegacy?: boolean;
}

/** The data folder: ONEMEMORY_HOME, else ~/.onememory. */
export function dataHome(e: SetupEnv): string {
  const home = e.env.ONEMEMORY_HOME?.trim();
  return home ? resolve(home) : join(e.home, ".onememory");
}

export function historyFile(e: SetupEnv): string {
  return join(dataHome(e), "setup-history.json");
}

export function readHistory(e: SetupEnv): HistorySession[] {
  try {
    const v = JSON.parse(readFileSync(historyFile(e), "utf8")) as unknown;
    return Array.isArray(v) ? (v as HistorySession[]) : [];
  } catch {
    return [];
  }
}

export function saveHistory(e: SetupEnv, all: HistorySession[]): void {
  const f = historyFile(e);
  mkdirSync(dirname(f), { recursive: true, mode: 0o700 });
  writeAtomic(f, JSON.stringify(all, null, 2) + "\n", 0o600);
}

/**
 * `--undo` puts the configuration back; it never touches a database. If the old claude-bridge entry came back after the
 * database was upgraded, that old program cannot open the upgraded file, so say exactly how to go back.
 */
async function reportDatabaseAfterUndo(s: HistorySession, io: SetupIO): Promise<void> {
  const { Store } = await import("./store.js");
  const upgraded: Array<{ path: string; before: number; now: number }> = [];
  for (const d of s.dbs ?? []) {
    const now = Store.peekSchemaVersion(d.path);
    if (d.before !== null && now !== null && now > d.before) upgraded.push({ path: d.path, before: d.before, now });
  }
  if (!s.migratedLegacy || upgraded.length === 0) {
    io.out("Your notes (the database) were not touched" + (s.migratedLegacy ? " and were not upgraded by setup." : "."));
    return;
  }
  io.out("\nIMPORTANT: your notes were NOT rolled back, only the configuration was.");
  for (const u of upgraded) {
    const bak = `${u.path}.pre-v${u.now}-backup`;
    io.out(`  ${u.path} was upgraded from schema v${u.before} to v${u.now}. The old claude-bridge program cannot open an upgraded database,`);
    io.out("  so the restored entry will fail until you do ONE of these:");
    io.out("   A. Keep the new database and use OneMemory:  onememory setup   (it will reconnect you).");
    io.out(`   B. Go fully back (notes written since the upgrade are lost, so run \`onememory backup --out <folder>\` first if you want them):`);
    io.out("        1. Close Claude Code and every program that uses the database.");
    io.out(`        2. Move the safety copy over it:  ${bak}  ->  ${u.path}`);
    io.out(`        3. Delete  ${u.path}-wal  and  ${u.path}-shm  if they exist (they belong to the upgraded file).`);
    if (!existsSync(bak)) io.out(`      (I do not see ${bak}; if it was removed, option B is not possible.)`);
  }
}
export async function undoLast(e: SetupEnv, io: SetupIO): Promise<number> {
  const all = readHistory(e);
  const idx = [...all.keys()].reverse().find((i) => !all[i].undone);
  if (idx === undefined) {
    io.out("Nothing to undo: setup has not changed any file on this computer (or it was already undone).");
    return 0;
  }
  const s = all[idx];
  io.out(`Undoing the setup from ${s.at}:`);
  if (undoSession(e, io, s) === 0) {
    s.undone = true;
    saveHistory(e, all);
    io.out("Done. Restart Claude Code.");
    await reportDatabaseAfterUndo(s, io);
    return 0;
  }
  return 1;
}

/** Put back every file one setup session changed (newest change first). Returns how many could not be undone. */
export function undoSession(e: SetupEnv, io: SetupIO, s: HistorySession): number {
  let failed = 0;
  for (const c of [...s.changes].reverse()) {
    try {
      const current = existsSync(c.real) ? readFileSync(c.real, "utf8") : null;
      if (current === null) {
        io.out(`  ${c.file}: already gone, nothing to do`);
        continue;
      }
      if (sha(current) === c.afterSha) {
        // Untouched since we wrote it: put the exact original back.
        if (c.createdFile) {
          unlinkSync(c.real);
          io.out(`  ${c.file}: removed (setup had created it)`);
        } else if (c.backup && existsSync(c.backup)) {
          const orig = readFileSync(c.backup);
          writeAtomic(c.real, orig.toString("utf8"), statSync(c.real).mode & 0o777);
          io.out(`  ${c.file}: restored from ${c.backup}`);
        } else {
          io.err(`  ${c.file}: the backup ${c.backup} is missing; nothing was changed`);
          failed++;
        }
        continue;
      }
      // The program changed the file since (Claude Code does). Undo only OUR change; keep theirs.
      const reverted = applyFor(current, c.inverse, c.format);
      if (reverted === current) io.out(`  ${c.file}: our change is not there any more, nothing to do`);
      else {
        const backup = `${c.real}.onememory-backup-${stamp(e.now())}-before-undo`;
        copyFileSync(c.real, backup);
        writeAtomic(c.real, reverted, statSync(c.real).mode & 0o777);
        io.out(`  ${c.file}: it had changed since setup, so only the OneMemory change was taken out (copy of the file as it was: ${backup})`);
      }
    } catch (err) {
      failed++;
      io.err(`  ${c.file}: could not undo (${(err as Error).message}). Your backup is ${c.backup ?? "(none; the file was new)"}`);
    }
  }
  return failed;
}

// ---- the command --------------------------------------------------------------------------------------------------------------

function describeSchema(v: number | null, current: number): string {
  if (v === null) return "no database there yet (or it cannot be read); a new one will be created when you go ahead";
  if (v === current) return `schema v${v}, up to date`;
  if (v < current) return `schema v${v}; this version upgrades it to v${current}, and first saves a safety copy next to it (<database>.pre-v${current}-backup). The upgrade is one-way: close Claude Code and anything else using this database first`;
  return `schema v${v} is NEWER than this version (v${current}); setup will not open it`;
}

export async function runSetup(e: SetupEnv, io: SetupIO, opts: SetupOptions): Promise<number> {
  if (!nodeIsOk(e.nodeVersion)) {
    io.err(
      `OneMemory needs Node.js ${MIN_NODE} or newer, and this computer has Node ${e.nodeVersion}.\n` +
        `  Fix: install Node ${MIN_NODE} (https://nodejs.org), open a NEW terminal, check with:  node -v\n` +
        "  Then run this again. Nothing was changed. (No Node 24? Docker works too: see INSTALL.md.)"
    );
    return 1;
  }
  if (opts.undo) return undoLast(e, io);

  // A database pinned in the shell (ONEMEMORY_DB_PATH, or the old CLAUDE_BRIDGE_DB_PATH) must also reach the app's entry,
  // because the app will not run inside this shell.
  const envDb = (e.env.ONEMEMORY_DB_PATH || e.env.CLAUDE_BRIDGE_DB_PATH || "").trim();
  if (!opts.db && envDb) opts = { ...opts, db: envDb };
  io.out(`OneMemory setup (version ${e.version})`);
  io.out(`  Node ${e.nodeVersion}: OK\n`);
  if (opts.only) {
    const bad = opts.only.filter((x) => !(CLIENT_IDS as readonly string[]).includes(x));
    if (bad.length) {
      io.err(`Unknown client: ${bad.join(", ")}. Choose from: ${CLIENT_IDS.join(", ")}.`);
      return 1;
    }
  }
  const found = detectClients(e);
  io.out("What I found:");
  for (const t of found) {
    if (t.id === "project" && !t.exists) continue;
    io.out(`  ${t.label.padEnd(26)} ${(t.exists ? "found" : t.present ? "installed, no config file yet" : "not found").padEnd(30)}${t.present ? t.file : ""}`.trimEnd());
  }
  io.out("");

  const plan: SetupPlan = { nodeOk: true, found, changes: [], dbs: [], warnings: [], already: [], conflicts: [], };
  const shared = { dbs: new Set<string>() };
  try {
    for (const t of found) {
      if (opts.only && !opts.only.includes(t.id)) continue;
      const asked = !!opts.only?.includes(t.id) || (t.id === "project" && opts.project);
      if (!t.present && !asked) continue; // an app that is not installed is left alone unless you name it
      const r = planFile(e, opts, t, shared);
      plan.already.push(...r.already);
      plan.conflicts.push(...r.conflicts);
      plan.warnings.push(...r.warnings);
      if (r.change) plan.changes.push(r.change);
    }
  } catch (err) {
    io.err(`I could not read a configuration file safely, so I stopped before changing anything:\n  ${(err as Error).message}`);
    return 1;
  }
  const { Store, SCHEMA_VERSION } = await import("./store.js");
  const { DB_PATH } = await import("./config.js");
  const primaryDb = opts.db ?? [...shared.dbs][0] ?? DB_PATH;
  const dbs = shared.dbs.size ? [...shared.dbs] : [primaryDb];
  plan.dbs = dbs;
  for (const d of dbs) {
    const v = Store.peekSchemaVersion(d);
    if (v !== null && v > SCHEMA_VERSION) plan.conflicts.push(`database ${d} is at schema v${v}, which is newer than this version (v${SCHEMA_VERSION}); install the newest onememory-mcp`);
  }

  if (plan.changes.length === 0 && plan.conflicts.length === 0) {
    if (plan.already.length === 0) io.out("I found no app to connect. Pass --only claude-code (or claude-desktop, cursor, codex, gemini, muse, vscode, zed) to create its config, or --project for this folder.");
  }
  if (plan.conflicts.length) {
    io.err("Stopped, because:");
    for (const c of plan.conflicts) io.err("  - " + c);
    return 1;
  }

  // Hook decision: every installed agent with command hooks (Claude Code, Codex, Gemini CLI, Muse). One answer covers all.
  let wantHook = false;
  let wantCapture = false;
  const hookDb = primaryDbIfCustom(primaryDb, DB_PATH, opts);
  const hosts = hookHosts(e).filter((h) => !!found.find((t) => t.id === h.client)?.present && (!opts.only || opts.only.includes(h.client)));
  /** Per host: the start-of-session hook alone, and the automatic memory plan (which includes it). */
  const hookPlans = new Map<HookHost, FileChange>();
  const capturePlans = new Map<HookHost, FileChange>();
  const capture = opts.capture ?? "ask";
  for (const h of hosts) {
    const who = h.label.replace(/ hook$/, "");
    if (opts.hook !== "no") {
      const ph = planHooks(e, opts, hookDb, { recall: true, capture: false }, h);
      if (ph.conflict) plan.conflicts.push(ph.conflict);
      else if (ph.already) plan.already.push(`${who}: the start-of-session hook is already installed`);
      else if (ph.change) {
        if (opts.hook === "yes") wantHook = true;
        hookPlans.set(h, ph.change);
      }
    }
    // Automatic memory builds on the start-of-session hook: with --no-hook it is only added when asked for by name (--capture).
    if (capture !== "no" && !(capture === "ask" && opts.hook === "no")) {
      const pc = planHooks(e, opts, hookDb, { recall: opts.hook !== "no", capture: true }, h);
      if (pc.conflict) plan.conflicts.push(pc.conflict);
      else if (pc.already) plan.already.push(`${who}: the automatic memory hooks are already installed`);
      else if (pc.change && pc.change.lines.some((l) => l.startsWith("record what "))) {
        if (capture === "yes") wantCapture = true;
        capturePlans.set(h, pc.change);
      }
    }
  }
  const anyHook = hookPlans.size > 0;
  const anyCapture = capturePlans.size > 0;

  if (plan.changes.length === 0 && !anyHook && !anyCapture) {
    for (const a of plan.already) io.out(`  (already fine) ${a}`);
    for (const w of plan.warnings) io.out(`  (careful) ${w}`);
    io.out(plan.already.length ? "\nNothing to change: OneMemory is already connected. To check it, run:  onememory doctor" : "\nNothing was changed.");
    return 0;
  }

  io.out("What I will do:");
  let n = 1;
  for (const c of plan.changes) for (const l of c.lines) io.out(`  ${l.startsWith("note:") ? "   " : `${n++}. ${c.label}: `}${l}`);
  for (const d of dbs) io.out(`  ${n++}. Database ${d}: ${describeSchema(Store.peekSchemaVersion(d), SCHEMA_VERSION)}`);
  if (!opts.noTestNote) io.out(`  ${n++}. Write a first test note ("OneMemory is connected") and read it back, so you know it works`);
  io.out(`  ${n++}. Run \`onememory doctor\` and tell you how to check it inside Claude Code`);
  for (const a of plan.already) io.out(`  (already fine) ${a}`);
  for (const w of plan.warnings) io.out(`  (careful) ${w}`);
  io.out("");
  io.out("Before any file is changed, a copy is saved beside it (name ends in .onememory-backup-<time>). `onememory setup --undo` puts it back.");
  io.out("Please close Claude Code and Claude Desktop first: Claude Code rewrites ~/.claude.json while it runs.\n");

  // With automatic memory offered, its plan (which includes the start-of-session hook) is the one shown.
  const optional = hosts.flatMap((h) => capturePlans.get(h) ?? hookPlans.get(h) ?? []);
  const shown = [...plan.changes, ...optional];
  if (shown.length) {
    io.out("The exact change" + (shown.length > 1 ? "s" : "") + ":");
    for (const c of shown) {
      if (optional.includes(c)) io.out(`  Optional, only if you agree (${c.lines.join("; ")}):`);
      let after: string;
      try {
        after = applyFor(c.before ?? "", c.ops, c.format);
      } catch (err) {
        io.err(`I cannot make this edit safely (${(err as Error).message}). Nothing was changed.`);
        return 1;
      }
      for (const l of lineDiff(c.before ?? "", after, c.file)) io.out("  " + l);
      io.out("");
    }
  }

  if (opts.dryRun) {
    io.out("Dry run: nothing was changed. No file was written, and no database was created or upgraded.");
    if ((anyHook && !wantHook) || (anyCapture && !wantCapture)) io.out("(The hooks above are only added if you say yes to them, or pass --hook / --capture.)");
    return 0;
  }
  if (plan.changes.length === 0 && !anyHook && !anyCapture) return 0;

  if (!opts.yes) {
    if (!io.interactive) {
      io.err("This is not an interactive terminal, so I cannot ask. Re-run with --yes to go ahead (a backup is still made), or --dry-run to only look.");
      return 1;
    }
    const a = (await io.ask(plan.changes.length ? "Go ahead with the changes above? Type y to continue, anything else cancels: " : "Install the hooks? Type y: ")).trim().toLowerCase();
    if (a !== "y" && a !== "yes") {
      io.out("Cancelled. Nothing was changed.");
      return 0;
    }
    if (anyHook && opts.hook === "ask") {
      const h = (await io.ask("Also install the start-of-session hook (Claude sees your recent notes when a session starts)? Type y or n: ")).trim().toLowerCase();
      wantHook = h === "y" || h === "yes";
    }
    // Asked only after a yes to the start-of-session hook (or when it is already there): a no to that is a no to both.
    if (anyCapture && capture === "ask" && (wantHook || !anyHook)) {
      const c = (await io.ask("Also record what Claude does in this project (files, commands, errors), stored only on this machine? Type y or n: ")).trim().toLowerCase();
      wantCapture = c === "y" || c === "yes";
    }
  } else {
    if (anyHook && opts.hook === "ask") wantHook = false; // --yes alone never adds a hook; it needs --hook
    if (anyCapture && capture === "ask") wantCapture = false; // ... or --capture
  }

  const dbsBefore = dbs.map((d) => ({ path: d, before: Store.peekSchemaVersion(d) }));
  const migratedLegacy = plan.changes.some((c) => c.inverse.some((o) => o.op === "rename"));
  // 1. The database first: if it cannot be opened, no config is touched.
  const storeErr: string[] = [];
  {
    for (const d of dbs) {
      try {
        const s = new Store(d);
        try {
          if (!opts.noTestNote) {
            const have = s.list({ limit: 1, withTags: ["setup-check"] });
            if (have.total === 0) {
              const note = s.create({
                title: "OneMemory is connected",
                body: "This note was written by `onememory setup` to check that writing and reading work. You can delete it any time.",
                tags: ["setup-check"],
                source: "onememory setup",
              });
              const back = s.read(note.id); // gate-ok: setup reads back the test note it wrote a moment ago
              if (!back || back.title !== note.title || back.body !== note.body) throw new Error("the test note was written but did not read back the same");
              io.out(`Database ${d}: test note #${note.id} written and read back.`);
            } else io.out(`Database ${d}: opens fine (a test note is already there).`);
          } else io.out(`Database ${d}: opens fine.`);
        } finally {
          s.close();
        }
      } catch (err) {
        storeErr.push(`${d}: ${(err as Error).message}`);
      }
    }
  }
  if (storeErr.length) {
    io.err("The database could not be opened, so I changed NO configuration:");
    for (const m of storeErr) io.err("  " + m);
    return 1;
  }

  // 2. Configuration files.
  const written: WrittenChange[] = [];
  // Each hook file: automatic memory (with the start-of-session hook when that was wanted too), else the hook alone.
  const hookChanges = hosts.flatMap((h) => {
    const c = wantCapture ? planHooks(e, opts, hookDb, { recall: wantHook || (opts.hook !== "no" && !hookPlans.has(h)), capture: true }, h).change : wantHook ? hookPlans.get(h) : null;
    return c ? [c] : [];
  });
  const toWrite = [...plan.changes, ...hookChanges];
  try {
    for (const c of toWrite) {
      const w = writeChange(e, c);
      if (w) {
        written.push(w);
        io.out(`${c.label}: updated ${c.file}${w.backup ? `\n    backup: ${w.backup}` : " (new file)"}`);
      } else io.out(`${c.label}: ${c.file} already had it, unchanged`);
    }
  } catch (err) {
    io.err(`Stopped: ${(err as Error).message}`);
    if (written.length) {
      const all = readHistory(e);
      all.push({ id: stamp(e.now()), at: e.now().toISOString(), version: e.version, changes: written, dbs: dbsBefore, migratedLegacy });
      saveHistory(e, all);
      io.err("What was already written can be undone with: onememory setup --undo");
    }
    return 1;
  }
  if (written.length) {
    const all = readHistory(e);
    all.push({ id: stamp(e.now()), at: e.now().toISOString(), version: e.version, changes: written, dbs: dbsBefore, migratedLegacy });
    saveHistory(e, all);
  }

  // 3. Doctor.
  if (!opts.noDoctor) {
    io.out("\nonememory doctor:");
    const env = { ...e.env };
    if (primaryDb !== DB_PATH) env.ONEMEMORY_DB_PATH = primaryDb;
    const r = spawnSync(e.execPath, [e.cliPath, "doctor"], { env, encoding: "utf8", timeout: 60_000 });
    for (const l of `${r.stdout ?? ""}${r.stderr ?? ""}`.split("\n")) if (l.trim()) io.out("  " + l);
  }

  // 4. Re-check after a moment: a running Claude Code may rewrite its file from an older copy in memory.
  sleepSync(1200);
  const missing: string[] = [];
  for (const w of written) {
    try {
      const cur = readFileSync(w.real, "utf8");
      if (!toWrite.filter((x) => x.file === w.file).every((c) => appliedFor(cur, c.ops, c.format))) missing.push(w.file);
    } catch {
      missing.push(w.file);
    }
  }
  if (missing.length) {
    io.err(`\nWarning: ${missing.join(", ")} was changed by another program just after I wrote it, and the OneMemory entry is gone. Close Claude Code completely, then run setup again.`);
    return 1;
  }
  io.out("\nDone. To check it inside Claude Code:");
  io.out("  1. Close every Claude Code window, then open Claude Code again.");
  io.out("  2. Type  /mcp  : you should see  onememory  connected (a green dot or the word connected).");
  io.out("  3. Ask: \"Search my memory for 'OneMemory is connected'\". It should find the test note.");
  io.out("  If it is missing or red: docs/live-claude-code.md has the fixes. To go back: onememory setup --undo");
  return 0;
}

function primaryDbIfCustom(primary: string, std: string, opts: SetupOptions): string | undefined {
  return opts.db || resolve(primary) !== resolve(std) ? primary : undefined;
}

/** Backups left by setup next to a config file (for tests and `doctor`). */
export function listBackups(file: string): string[] {
  const dir = dirname(file);
  const base = basename(file) + ".onememory-backup-";
  try {
    return readdirSync(dir).filter((f) => f.startsWith(base)).map((f) => join(dir, f));
  } catch {
    return [];
  }
}

export { getMember };
