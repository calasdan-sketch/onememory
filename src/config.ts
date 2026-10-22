// Shared config: DB path + bearer token, used by the HTTP API, the stdio
// MCP server, and the HTTP/SSE MCP server so all three point at the same
// state file and accept the same token.

import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants as fsc,
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { resolveTimeZone } from "./time-parse.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = join(__dirname, "..", "..");

/** Where 1.0.x kept its state: inside the package (lost on npm update / npx cache purge). */
export const LEGACY_DATA_DIR = join(PROJECT_ROOT, "data");

/**
 * The data directory (database, token, tokens.json, spaces.json):
 *   1. ONEMEMORY_HOME, when set;
 *   2. the package's own ./data, when running from a git checkout that
 *      already has ./data/state.db (a from-source install keeps working
 *      exactly as before);
 *   3. otherwise ~/.onememory (Windows: %USERPROFILE%\.onememory) --
 *      outside the installed package, so updates never touch it.
 */
export function resolveDataDir(
  env: NodeJS.ProcessEnv = process.env,
  root: string = PROJECT_ROOT
): { dir: string; why: "env" | "checkout" | "home" } {
  if (env.ONEMEMORY_HOME && env.ONEMEMORY_HOME.trim()) {
    return { dir: resolve(env.ONEMEMORY_HOME.trim()), why: "env" };
  }
  if (existsSync(join(root, ".git")) && existsSync(join(root, "data", "state.db"))) {
    return { dir: join(root, "data"), why: "checkout" };
  }
  return { dir: join(homedir(), ".onememory"), why: "home" };
}

const DATA = resolveDataDir();
export const DATA_DIR = DATA.dir;
/** Why DATA_DIR was chosen (doctor reports it). */
export const DATA_DIR_SOURCE = DATA.why;

export const DB_PATH = process.env.ONEMEMORY_DB_PATH || join(DATA_DIR, "state.db");

export const TOKEN_FILE = join(DATA_DIR, ".token");

/** True when `p` sits inside a node_modules tree (an installed package). */
export function insideNodeModules(p: string): boolean {
  return resolve(p).split(sep).includes("node_modules");
}

/** chmod that is a no-op on Windows and never throws (permissions are best-effort hardening). */
export function chmodQuiet(p: string, mode: number): void {
  // ONEMEMORY_NO_CHMOD=1 leaves permissions alone (deliberately shared dirs,
  // e.g. a Docker volume read by a backup sidecar running as another uid).
  if (process.platform === "win32" || process.env.ONEMEMORY_NO_CHMOD === "1") return;
  try {
    chmodSync(p, mode);
  } catch {
    /* missing file or not ours: leave it */
  }
}

/** Create `dir` owner-only (0700) and re-tighten it if it already existed looser. */
export function privateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodQuiet(dir, 0o700);
}

/** The data-dir files that hold notes or credentials: owner read/write only. */
export const PRIVATE_FILES = ["state.db", "state.db-wal", "state.db-shm", "audit.log", ".token", "tokens.json", "spaces.json"];

/**
 * Run fn holding an exclusive lock file (created with O_EXCL, so only one
 * process can hold it). Waits up to 30 s for another holder; a lock older
 * than 2 minutes is presumed left by a crashed process and removed.
 */
function withLockFile<T>(lock: string, fn: () => T): T {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      closeSync(openSync(lock, "wx", 0o600));
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      try {
        if (Date.now() - statSync(lock).mtimeMs > 120_000) rmSync(lock, { force: true });
      } catch {
        /* holder just released it: retry */
      }
      if (Date.now() > deadline) throw new Error(`another process is still migrating (lock file ${lock})`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lock, { force: true });
  }
}

/**
 * One-time move of 1.0.x state from `from` (the package's ./data) to `to`
 * (the new data dir). Runs only when the old database exists and the new
 * one does not; the old files are left in place. The database is copied
 * with VACUUM INTO (a consistent snapshot that includes WAL content, even
 * if an old server is still running) into a temp file, then published with
 * a hard link -- never a replacing rename -- under an exclusive lock file,
 * so two processes starting at once can't swap the database under each
 * other. Returns human-readable lines describing what happened (empty =
 * nothing).
 */
export function migrateLegacyData(from: string, to: string): string[] {
  const oldDb = join(from, "state.db");
  const newDb = join(to, "state.db");
  if (resolve(from) === resolve(to) || !existsSync(oldDb) || existsSync(newDb)) return [];
  privateDir(to);
  return withLockFile(join(to, ".migrate.lock"), () => {
    if (existsSync(newDb)) return []; // another process migrated while we waited
    const tmp = `${newDb}.migrating-${process.pid}`;
    rmSync(tmp, { force: true });
    try {
      const src = new DatabaseSync(oldDb);
      try {
        src.exec("PRAGMA busy_timeout = 5000;");
        src.prepare("VACUUM INTO ?").run(tmp);
      } finally {
        src.close();
      }
      chmodQuiet(tmp, 0o600);
      try {
        linkSync(tmp, newDb);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EEXIST") return [];
        throw e;
      }
    } finally {
      rmSync(tmp, { force: true });
    }
    const out = [`copied database ${oldDb} -> ${newDb}`];
    for (const f of [".token", "tokens.json", "spaces.json"]) {
      const a = join(from, f);
      const b = join(to, f);
      if (existsSync(a) && !existsSync(b)) {
        copyFileSync(a, b, fsc.COPYFILE_EXCL);
        chmodQuiet(b, 0o600);
        out.push(`copied ${f}`);
      }
    }
    out.push(`the old copy in ${from} was left in place; delete it once you're happy`);
    return out;
  });
}

let prepared = false;

/**
 * Call once at startup, before opening the database: migrates 1.0.x state
 * out of the package into DATA_DIR (see migrateLegacyData) and says so on
 * stderr. Skipped when ONEMEMORY_DB_PATH pins the database explicitly.
 * Never throws: on failure it warns and the server starts on DATA_DIR.
 */
export function prepareDataDir(): void {
  if (prepared) return;
  prepared = true;
  // Owner-only data dir + files on every start (POSIX; no-op on Windows):
  // the dir may predate this release at 0755 and the files at 0644.
  try {
    privateDir(DATA_DIR);
    for (const f of PRIVATE_FILES) chmodQuiet(join(DATA_DIR, f), 0o600);
  } catch {
    /* read-only or foreign-owned dir: hardening is best-effort */
  }
  if (process.env.ONEMEMORY_DB_PATH) return;
  // The npm preinstall copies 1.0.x data into ~/.onememory using the install
  // shell's environment; a client that sets a different ONEMEMORY_HOME would
  // otherwise start empty without a word.
  const homeDefault = join(homedir(), ".onememory");
  if (
    resolve(DATA_DIR) !== resolve(homeDefault) &&
    !existsSync(join(DATA_DIR, "state.db")) &&
    existsSync(join(homeDefault, "state.db"))
  ) {
    console.error(
      `[onememory] ${DATA_DIR} has no store yet, but ${homeDefault} does. ` +
        `To keep using it, unset ONEMEMORY_HOME or copy ${homeDefault} into ${DATA_DIR}.`
    );
  }
  try {
    const lines = migrateLegacyData(LEGACY_DATA_DIR, DATA_DIR);
    for (const l of lines) console.error(`[onememory] data migration: ${l}`);
  } catch (e) {
    console.error(
      `[onememory] data migration from ${LEGACY_DATA_DIR} failed: ${(e as Error).message}. ` +
        `Copy state.db and .token into ${DATA_DIR} by hand, or set ONEMEMORY_HOME=${LEGACY_DATA_DIR}.`
    );
  }
}

/**
 * Resolve the bearer token: env var wins; otherwise read/create a token
 * file on disk so the token is stable across restarts without forcing the
 * operator to set an env var every time.
 */
export function resolveToken(): string {
  if (process.env.ONEMEMORY_TOKEN && process.env.ONEMEMORY_TOKEN.trim()) {
    return process.env.ONEMEMORY_TOKEN.trim();
  }
  if (existsSync(TOKEN_FILE)) {
    const existing = readFileSync(TOKEN_FILE, "utf8").trim();
    if (existing) return existing;
  }
  const token = randomBytes(32).toString("hex");
  privateDir(dirname(TOKEN_FILE));
  writeFileSync(TOKEN_FILE, token, { mode: 0o600 });
  // Never print the token value itself -- this line may be captured by a
  // Windows Scheduled Task's redirected output, a service manager's logs, or
  // future log-shipping, and the token is a full-access credential valid
  // over the public tunnel. Reference only the file path it was saved to.
  // eslint-disable-next-line no-console
  console.error(`[onememory] Generated new bearer token, saved to ${TOKEN_FILE}`);
  return token;
}

/**
 * Access scopes, least to most powerful:
 *   read  -> read/search/list
 *   write -> read + create/update
 *   admin -> write + delete + import + full /export  (primary token is admin)
 */
export type Scope = "read" | "write" | "admin";

export interface TokenEntry {
  token: string;
  scope: Scope;
  label: string;
  /**
   * Optional per-token namespace pin (PERMISSIONS, not decoration).
   *
   * When set, this token is confined to `namespace` for EVERY request,
   * regardless of the server's own cwd-resolved namespace. That is what makes
   * one shared bridge safe for several agents: token A in "work" and token B
   * in "personal" cannot read or write each other's notes even though they
   * hit the same server process.
   *
   * When unset, the token inherits the server's startup-resolved namespace
   * exactly as before (full backward compatibility). The primary token never
   * carries one -- it stays the operator's unrestricted escape hatch.
   */
  namespace?: string;
}

function isScope(s: unknown): s is Scope {
  return s === "read" || s === "write" || s === "admin";
}

/**
 * All accepted bearer tokens with their scope. The primary token
 * (ONEMEMORY_TOKEN or <data dir>/.token) is always admin, so single-token
 * setups behave exactly as before. Extra scoped tokens are optional and come
 * from ONEMEMORY_TOKENS (a JSON array) and/or a <data dir>/tokens.json file,
 * each entry { "token": "...", "scope": "read|write|admin", "label": "...",
 * "namespace": "..." }. `namespace` optionally PINS that token to one
 * namespace (see TokenEntry.namespace) -- per-token isolation on a shared
 * server. The primary token never carries a namespace pin.
 * Invalid or duplicate entries are skipped rather than failing startup.
 */
const SCOPE_RANK: Record<Scope, number> = { read: 1, write: 2, admin: 3 };

export function resolveTokens(): TokenEntry[] {
  const byToken = new Map<string, TokenEntry>();
  const locked = new Set<string>(); // the primary admin token's scope is fixed
  const add = (
    token: unknown,
    scope: unknown,
    label: unknown,
    lock = false,
    namespace?: unknown
  ): void => {
    if (typeof token !== "string" || !token.trim()) return;
    if (!isScope(scope)) return;
    const t = token.trim();
    // A namespace pin is only honored when it is a non-empty string. Trimmed
    // here so "  work  " and "work" are the same pin (a mismatch would be a
    // silent isolation hole, not a cosmetic diff).
    const ns = typeof namespace === "string" && namespace.trim() ? namespace.trim() : undefined;
    const existing = byToken.get(t);
    if (existing) {
      // Never downgrade/change the primary token. For any other token listed
      // more than once, keep the MOST restrictive scope (lowest rank) AND the
      // most restrictive namespace: a pin always beats no pin, and on a
      // genuine conflict (two different pins) keep the first and warn -- an
      // ambiguous pin must never silently widen to "no pin".
      if (!locked.has(t)) {
        const scopeDown = SCOPE_RANK[scope] < SCOPE_RANK[existing.scope];
        const pinTighter = ns !== undefined && existing.namespace === undefined;
        if (scopeDown || pinTighter) {
          const nextNs = pinTighter ? ns : existing.namespace;
          if (ns !== undefined && existing.namespace !== undefined && ns !== existing.namespace) {
            console.error(
              `[onememory] token ${existing.label || "(unnamed)"} is listed with two different ` +
                `namespaces ("${existing.namespace}" and "${ns}"); keeping "${existing.namespace}"`
            );
          }
          byToken.set(t, {
            token: t,
            scope: scopeDown ? scope : existing.scope,
            label: scopeDown && typeof label === "string" ? label : existing.label,
            ...(nextNs !== undefined ? { namespace: nextNs } : {}),
          });
        } else if (ns !== undefined && existing.namespace !== undefined && ns !== existing.namespace) {
          console.error(
            `[onememory] token ${existing.label || "(unnamed)"} is listed with two different ` +
              `namespaces ("${existing.namespace}" and "${ns}"); keeping "${existing.namespace}"`
          );
        }
      }
      return;
    }
    byToken.set(t, {
      token: t,
      scope,
      label: typeof label === "string" ? label : "",
      ...(ns !== undefined ? { namespace: ns } : {}),
    });
    if (lock) locked.add(t);
  };

  // Primary token is always admin (keeps single-token setups unchanged).
  try {
    add(resolveToken(), "admin", "primary", true);
  } catch {
    /* no primary token available (e.g. doctor on a fresh box) */
  }

  const parseList = (raw: string, where: string): void => {
    let arr: unknown;
    try {
      arr = JSON.parse(raw);
    } catch {
      console.error(`[onememory] ignoring ${where}: not valid JSON`);
      return;
    }
    if (!Array.isArray(arr)) {
      console.error(
        `[onememory] ignoring ${where}: expected a JSON array of { token, scope, label }`
      );
      return;
    }
    for (const e of arr) {
      const o = e as { token?: unknown; scope?: unknown; label?: unknown; namespace?: unknown };
      add(o?.token, o?.scope, o?.label, false, o?.namespace);
    }
  };

  if (process.env.ONEMEMORY_TOKENS && process.env.ONEMEMORY_TOKENS.trim()) {
    parseList(process.env.ONEMEMORY_TOKENS, "ONEMEMORY_TOKENS");
  }
  const tokensFile = join(DATA_DIR, "tokens.json");
  if (existsSync(tokensFile)) {
    parseList(readFileSync(tokensFile, "utf8"), tokensFile);
  }

  return [...byToken.values()];
}

// Parse a port from the environment, falling back (loudly) on anything that
// isn't a valid 1-65535 integer so a typo can't make listen() pick a random port.
function parsePort(envVal: string | undefined, def: number): number {
  if (!envVal) return def;
  const n = Number(envVal);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    console.error(`[onememory] invalid port "${envVal}"; falling back to ${def}`);
    return def;
  }
  return n;
}

export const API_PORT = parsePort(process.env.ONEMEMORY_PORT, 8790);
export const MCP_HTTP_PORT = parsePort(process.env.ONEMEMORY_MCP_PORT, 8791);

// Bind to loopback by default. Public exposure is opt-in and is expected to
// sit behind an authenticated tunnel (e.g. Cloudflare Tunnel + Access).
export const BIND_HOST = process.env.ONEMEMORY_BIND || "127.0.0.1";

export function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

/**
 * Parse a human interval like "24h", "30m", "90s", or a bare number of
 * seconds ("3600") into milliseconds. Returns null for anything else
 * (empty, garbage, negative). Bare numbers mean seconds — that matches how
 * operators already write timeout-ish env vars.
 */
export function parseIntervalToMs(raw: string | undefined): number | null {
  if (!raw || !raw.trim()) return null;
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/.exec(raw.trim().toLowerCase());
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n < 0) return null;
  const mult: Record<string, number> = {
    ms: 1,
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
  };
  return Math.round(n * mult[m[2] ?? "s"]);
}

/**
 * How often the background auto-consolidation runs (see start.ts). Unset =
 * off. The scheduler only auto-merges near-identical pairs (score >= 0.99);
 * weaker candidates are logged for review, never merged blindly.
 */
export const AUTO_CONSOLIDATE_INTERVAL_MS = parseIntervalToMs(
  process.env.ONEMEMORY_AUTO_CONSOLIDATE_INTERVAL
);

/**
 * Fail closed: never open a non-loopback listener without an explicit token.
 * An auto-generated token is fine for a local-only server, but if the
 * operator binds to a public interface they must set ONEMEMORY_TOKEN
 * deliberately rather than relying on an auto-minted one.
 */
export function assertSafeExposure(): void {
  // Read the bind host from the environment here (not the cached BIND_HOST
  // constant) so this guard reflects the actual configured bind and stays
  // unit-testable. Default matches BIND_HOST.
  const bind = process.env.ONEMEMORY_BIND || "127.0.0.1";
  const hasExplicitToken = !!(
    process.env.ONEMEMORY_TOKEN && process.env.ONEMEMORY_TOKEN.trim()
  );
  if (!isLoopback(bind) && !hasExplicitToken) {
    throw new Error(
      "Refusing to bind to a non-loopback address without ONEMEMORY_TOKEN set. " +
        "Set an explicit token, or keep the default localhost bind and expose it " +
        "through an authenticated tunnel (see INFRA.md)."
    );
  }
}

/**
 * IANA timezone used to interpret natural-language time phrases
 * ("yesterday", "last week") in time-aware search. Set ONEMEMORY_TIMEZONE,
 * e.g. ONEMEMORY_TIMEZONE=America/Winnipeg; unset, the host's system
 * timezone is used. Invalid names log to stderr and fall back to "UTC"
 * (never throw at import time).
 */
export const TIME_ZONE = resolveTimeZone(process.env.ONEMEMORY_TIMEZONE);

/**
 * Staleness detection (time-aware memory): notes older than these thresholds
 * (by updated_at, i.e. the most recent write wins) are flagged stale so
 * agents verify them before acting on outdated facts. Stale notes are never
 * hidden or deleted -- they are annotated (stale/ageDays/staleWarning) and
 * ranked slightly lower in search.
 */
export interface StalenessConfig {
  /** Days after which any note is stale. */
  staleDays: number;
  /** Tags that expire faster (compared with or without a leading "#"). */
  staleTags: string[];
  /** Days after which a note carrying a stale tag is stale. */
  staleTagDays: number;
}

function parsePositiveDays(raw: string | undefined, def: number): number {
  const n = Number((raw ?? "").trim());
  return Number.isFinite(n) && n > 0 ? n : def;
}

function parseTagList(raw: string | undefined, def: string): string[] {
  const tags = (raw ?? def)
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  return tags.length ? tags : [def];
}

/**
 * Read the staleness thresholds from the environment (read at call time so
 * operators can change them without a restart of the importing module, and
 * so tests can override them). Invalid values fall back to the defaults.
 */
export function stalenessConfig(): StalenessConfig {
  return {
    staleDays: parsePositiveDays(process.env.ONEMEMORY_STALE_DAYS, 90),
    staleTags: parseTagList(process.env.ONEMEMORY_STALE_TAGS, "#status"),
    staleTagDays: parsePositiveDays(process.env.ONEMEMORY_STALE_TAG_DAYS, 30),
  };
}
