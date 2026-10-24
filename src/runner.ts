// OneMemory command runner: the half that makes remote control actually work.
//
// The note store is a mailbox. On its own, a command note dropped from a
// phone just sits there. This module is the listener that opens the mail:
// it polls a dedicated namespace, verifies each command, claims it so it can
// only ever run once, executes it, and writes the result back as a reply note
// the phone can read.
//
// Threat model is deliberately paranoid: the store is reachable over a public
// Cloudflare tunnel, so ANY note arriving here is treated as hostile input.
// Three independent gates must all pass before a single process is spawned:
//
//   1. SIGNATURE  -- HMAC-SHA256 over the canonical command fields, compared
//                    in constant time. An unsigned or mis-signed note is
//                    ignored. Holding a store write-token is NOT enough to
//                    execute anything; the runner secret is separate.
//   2. FRESHNESS  -- the command must be recent (default 5 min). An attacker
//                    who captures a valid signed note can't replay it tomorrow.
//   3. ALLOWLIST  -- the action must name a pre-declared entry. There is no
//                    "run this string" path: the runner never starts a shell
//                    itself (shell:false), argv is built from the allowlist,
//                    and any caller-supplied parameter must match that
//                    action's own regex. Entries that point at a shell
//                    interpreter (cmd, powershell, pwsh, .bat/.cmd) are only
//                    accepted when their parameters cannot carry shell
//                    metacharacters. An unknown action is refused IN WRITING
//                    so the phone sees the refusal instead of silence.
//
// Everything below the gates is about not lying to the operator. Which notes
// have been handled is tracked in the runner's LOCAL ledger, never in a tag a
// store writer could set; results and the heartbeat are HMAC-signed with the
// runner secret (domain-separated from command signing) so the phone can tell
// a real answer from one forged by someone holding only a store token; and a
// heartbeat note says whether this loop is alive at all -- so "no reply" can
// be told apart from "PC is asleep".

import { execFile } from "node:child_process";
import { createHmac, randomUUID, timingSafeEqual, createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { PROJECT_ROOT } from "./config.js";
import { audit } from "./security.js";
import { Store, ValidationError, type NoteRecord } from "./store.js";
import { pollTasks } from "./runner-tasks.js";

// ---- Tunables (all overridable by env; defaults are the safe end) ----------
export const RUNNER = {
  /** Namespace watched for inbound command notes. */
  namespace: process.env.ONEMEMORY_RUNNER_NAMESPACE || "commands",
  /** Namespace results are written to. */
  resultsNamespace: process.env.ONEMEMORY_RUNNER_RESULTS_NAMESPACE || "results",
  /** Seconds between polls. */
  pollMs: Number(process.env.ONEMEMORY_RUNNER_POLL_MS || 30_000),
  /** How old a signed command may be and still run. Replay defense. */
  freshnessMs: Number(process.env.ONEMEMORY_RUNNER_FRESHNESS_MS || 300_000),
  /** Hard ceiling on any single command's runtime. */
  timeoutMs: Number(process.env.ONEMEMORY_RUNNER_TIMEOUT_MS || 120_000),
  /** Heartbeat note refresh interval. */
  heartbeatMs: Number(process.env.ONEMEMORY_RUNNER_HEARTBEAT_MS || 180_000),
  /** Max characters of stdout/stderr kept in a result note. */
  outputChars: 20_000,
  /** Max command ids remembered in the replay ledger. */
  ledgerMax: 5_000,
  /** Max note ids remembered as already examined (rejected or handled). */
  seenMax: 20_000,
  /**
   * Most notes that FAIL verification examined in one poll pass. Junk costs
   * a ledger entry and a store write each, so it is bounded; it never counts
   * against the execution budget below.
   */
  maxRejectsPerPoll: Number(process.env.ONEMEMORY_RUNNER_MAX_REJECTS_PER_POLL || 200),
  /** Most VERIFIED commands executed in a single poll pass. Overflow waits, not lost. */
  maxPerPoll: Number(process.env.ONEMEMORY_RUNNER_MAX_PER_POLL || 10),
  /** Flood ceiling: most commands executed per rolling window. */
  maxPerWindow: Number(process.env.ONEMEMORY_RUNNER_MAX_PER_WINDOW || 60),
  windowMs: Number(process.env.ONEMEMORY_RUNNER_WINDOW_MS || 600_000),
  /** Delete handled commands and results older than this. 0 disables. */
  retentionDays: Number(process.env.ONEMEMORY_RUNNER_RETENTION_DAYS || 30),
  /**
   * Namespace whose approved COMMAND TASKS this runner executes (see
   * runner-tasks.ts). Empty = command tasks are off (the default). Must be
   * set explicitly: a task only ever runs if it lives in exactly this
   * namespace, is addressed to this runner, and carries a valid admin approval.
   */
  taskNamespace: process.env.ONEMEMORY_RUNNER_TASK_NAMESPACE || "",
  /** Minimum gap between prune sweeps, regardless of heartbeat rate. */
  pruneEveryMs: Number(process.env.ONEMEMORY_RUNNER_PRUNE_EVERY_MS || 3_600_000),
};

/** Reserved action name: ask the PC what it is allowed to do. */
export const INTROSPECT_ACTION = "__actions";

export const CLAIMED_TAG = "claimed";
export const RESULT_TAG = "result";

// ---- Command shape ---------------------------------------------------------

export interface CommandEnvelope {
  /** Signed-format version. Only 2 is accepted. */
  v: 2;
  cmd_id: string;
  action: string;
  params?: Record<string, string>;
  /**
   * Optional machine name this command is for. Empty = any listener. If you
   * ever run a second runner against the same store, this is what stops the
   * wrong PC answering -- and because it is inside the signature, an attacker
   * cannot re-point a captured command at a different machine.
   */
  target?: string;
  issued_at: string;
  nonce: string;
  sig: string;
}

/** This machine's runner name, matched against a command's `target`. */
export function runnerId(): string {
  return (
    process.env.ONEMEMORY_RUNNER_ID ||
    process.env.COMPUTERNAME ||
    process.env.HOSTNAME ||
    "default"
  );
}

export interface AllowEntry {
  /** Executable to run. Never passed through a shell. */
  file: string;
  /** Fixed arguments, always applied. */
  args?: string[];
  /**
   * Caller-supplied parameters this action accepts. Each maps to a regex the
   * value MUST fully match. A parameter not declared here is rejected -- this
   * is what stops `--upload-pack=...`-style argument injection through an
   * otherwise innocent action.
   */
  params?: Record<string, string>;
  /** Where the params land in argv, as `{name}` placeholders. */
  paramArgs?: string[];
  cwd?: string;
  timeoutMs?: number;
  description?: string;
}

export type Allowlist = Record<string, AllowEntry>;

// ---- Gate 1: signature -----------------------------------------------------

/** Command signing format. v1 (k=v&k=v joined text) was ambiguous; gone. */
export const COMMAND_FORMAT = 2;
/** Domain-separation prefixes: a result signature can never pass as a command one. */
export const COMMAND_DOMAIN = "onememory-cmd-v2";
export const RESULT_DOMAIN = "onememory-result-v1";

/**
 * Deterministic JSON: object keys sorted, no whitespace, undefined members
 * dropped. MUST stay byte-identical to canonicalJson() in docs/signer.js
 * (test/signer-parity.test.ts enforces it).
 */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return "[" + v.map(canonicalJson).join(",") + "]";
  const o = v as Record<string, unknown>;
  return (
    "{" +
    Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => JSON.stringify(k) + ":" + canonicalJson(o[k]))
      .join(",") +
    "}"
  );
}

/** C0 controls and DEL. Rejected in every signed command field. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export function hasControlChars(cmd: Omit<CommandEnvelope, "sig" | "v">): boolean {
  const strs = [cmd.cmd_id, cmd.action, cmd.target ?? "", cmd.issued_at, cmd.nonce];
  for (const [k, val] of Object.entries(cmd.params ?? {})) strs.push(k, val);
  return strs.some((x) => CONTROL_CHARS.test(x));
}

/**
 * Canonical bytes that get signed: a domain prefix, then canonical JSON of
 * the command fields (sig excluded). JSON escaping makes every field
 * unambiguous -- no value can impersonate a separator.
 */
export function canonicalString(cmd: Omit<CommandEnvelope, "sig" | "v">): string {
  return (
    COMMAND_DOMAIN +
    "\n" +
    canonicalJson({
      v: COMMAND_FORMAT,
      cmd_id: cmd.cmd_id,
      action: cmd.action,
      params: cmd.params ?? {},
      target: cmd.target ?? "",
      issued_at: cmd.issued_at,
      nonce: cmd.nonce,
    })
  );
}

export function signCommand(secret: string, cmd: Omit<CommandEnvelope, "sig" | "v">): string {
  return createHmac("sha256", secret).update(canonicalString(cmd), "utf8").digest("hex");
}

/** Constant-time hex compare; hashed first so length never leaks via timing. */
function sigEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}

// ---- Signed results and heartbeat ------------------------------------------
// A store token lets anyone write into `results` and `runner`. Without a
// signature they could post "result <id>: ok" for a command that never ran,
// or keep a dead PC looking alive. So every body the runner writes carries an
// HMAC over its canonical JSON, under a prefix commands never use.

export type SignedKind = "result" | "heartbeat";

function resultMac(secret: string, payload: Record<string, unknown>): string {
  return createHmac("sha256", secret)
    .update(RESULT_DOMAIN + "\n" + canonicalJson(payload), "utf8")
    .digest("hex");
}

/** Return the note body for a signed result/heartbeat payload. */
export function signedBody(
  secret: string,
  kind: SignedKind,
  payload: Record<string, unknown>
): string {
  // Round-trip through JSON first so what is signed is exactly what a reader
  // will parse back (undefined dropped, NaN -> null, and so on).
  const clean = JSON.parse(JSON.stringify({ ...payload, kind })) as Record<string, unknown>;
  delete clean.sig;
  return JSON.stringify({ ...clean, sig: resultMac(secret, clean) }, null, 2);
}

export type ResultVerify =
  | { ok: true; kind: SignedKind; payload: Record<string, unknown> }
  | { ok: false; reason: string };

/** Check a result or heartbeat note body against the runner secret. */
export function verifyResult(secret: string, body: string): ResultVerify {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { ok: false, reason: "body is not valid JSON" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "body is not an object" };
  }
  const { sig, ...rest } = parsed as Record<string, unknown>;
  if (typeof sig !== "string" || !sig) return { ok: false, reason: "not signed" };
  if (rest.kind !== "result" && rest.kind !== "heartbeat") {
    return { ok: false, reason: "unknown kind" };
  }
  if (!sigEqual(resultMac(secret, rest), sig)) return { ok: false, reason: "bad signature" };
  return { ok: true, kind: rest.kind, payload: rest };
}

// ---- Verification pipeline -------------------------------------------------

export type VerifyResult =
  | { ok: true; cmd: CommandEnvelope }
  | {
      ok: false;
      reason: string;
      /**
       * True only when the signature checked out and a later gate failed
       * (stale, future-dated). Only then is the reason worth writing back:
       * anything unauthenticated gets silence, never an oracle reply.
       */
      authenticated: boolean;
      cmd_id?: string;
      cmd?: CommandEnvelope;
    };

/**
 * Parse + verify a note body. Returns a plain reason string on failure so the
 * caller can write it back to the operator rather than failing silently.
 */
export function verifyCommand(
  secret: string,
  body: string,
  now: number = Date.now(),
  freshnessMs: number = RUNNER.freshnessMs
): VerifyResult {
  const reject = (reason: string): VerifyResult => ({ ok: false, reason, authenticated: false });
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return reject("body is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return reject("body is not a command object");
  }
  const c = parsed as Partial<CommandEnvelope> & { v?: unknown };
  if (c.v !== COMMAND_FORMAT) {
    return reject("unsupported command format (reload the signing page)");
  }
  for (const field of ["cmd_id", "action", "issued_at", "nonce", "sig"] as const) {
    if (typeof c[field] !== "string" || !c[field]) {
      return reject(`missing or empty field: ${field}`);
    }
  }
  if (c.target !== undefined && typeof c.target !== "string") {
    return reject("target must be a string");
  }
  if (c.params !== undefined) {
    if (!c.params || typeof c.params !== "object" || Array.isArray(c.params)) {
      return reject("params must be an object of string values");
    }
    for (const [k, v] of Object.entries(c.params)) {
      if (typeof v !== "string") return reject(`param "${k}" must be a string`);
    }
  }

  const cmd = c as CommandEnvelope;
  if (hasControlChars(cmd)) return reject("control characters are not allowed");

  // Signature BEFORE freshness: never let unauthenticated input steer control
  // flow any further than it has to.
  const expected = signCommand(secret, cmd);
  if (!sigEqual(expected, cmd.sig)) return reject("bad signature");

  const late = (reason: string): VerifyResult => ({
    ok: false,
    reason,
    authenticated: true,
    cmd_id: cmd.cmd_id,
    cmd,
  });
  const issued = Date.parse(cmd.issued_at);
  if (!Number.isFinite(issued)) return late("issued_at is not a valid timestamp");
  const age = now - issued;
  // Reject clearly-future timestamps too (small skew allowance), otherwise a
  // command dated next year would stay replayable forever.
  if (age > freshnessMs) return late(`command is stale (${Math.round(age / 1000)}s old)`);
  if (age < -60_000) return late("issued_at is in the future");

  return { ok: true, cmd };
}

// ---- Gate 3: allowlist -----------------------------------------------------

export type ResolveResult =
  | { ok: true; file: string; args: string[]; cwd?: string; timeoutMs: number }
  | { ok: false; reason: string };

/**
 * Characters cmd.exe / PowerShell treat as syntax. A program in that family
 * re-parses its own command line, so shell:false alone does not keep a value
 * like `x & del /q *` inert.
 */
export const SHELL_META = ["&", "|", "<", ">", "^", "%", '"', "'", "`", ";", "!", "(", ")", "\n", "\r"];

/** Basename of a Windows or POSIX path, lowercased, trailing dots/spaces dropped. */
function exeBase(file: string): string {
  return (file.split(/[\\/]/).pop() ?? "").toLowerCase().replace(/[. ]+$/, "");
}

/** True when `file` is cmd/powershell/pwsh (any path, any case) or a batch file. */
export function isShellInterpreter(file: string): boolean {
  const base = exeBase(file);
  if (/\.(bat|cmd)$/.test(base)) return true;
  return ["cmd", "powershell", "pwsh"].includes(base.replace(/\.(exe|com)$/, ""));
}

/** Absolute on either Windows (C:\..., \\server\...) or POSIX (/...). */
function isAbsolutePath(file: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(file) || file.startsWith("\\\\") || posix.isAbsolute(file);
}

/** Probe strings: does `re` accept any of these, each holding `c`? */
function acceptsChar(re: RegExp, c: string): boolean {
  const probes = [c, c + c, `a${c}`, `${c}a`, `a${c}a`, `0${c}0`, `A${c}A`, `-${c}-`, `a ${c} a`];
  return probes.some((p) => re.test(p));
}

/**
 * Check every entry; drop the unsafe ones with a reason. Rules:
 *  - `file` must be an absolute path, except bare `cmd` / `cmd.exe` on an
 *    entry that takes no parameters (the PATH lookup is the only risk there).
 *  - a shell-interpreter entry (cmd, powershell, pwsh, .bat/.cmd) is refused
 *    if any param pattern accepts a shell metacharacter (see SHELL_META).
 */
export function validateAllowlist(raw: Record<string, unknown>): {
  allow: Allowlist;
  errors: string[];
} {
  const allow: Allowlist = {};
  const errors: string[] = [];
  for (const [name, val] of Object.entries(raw)) {
    const e = val as AllowEntry;
    const fail = (why: string): void => void errors.push(`"${name}": ${why}`);
    if (!e || typeof e !== "object" || Array.isArray(e) || typeof e.file !== "string" || !e.file) {
      fail("needs a `file` string");
      continue;
    }
    const strArr = (x: unknown): boolean =>
      x === undefined || (Array.isArray(x) && x.every((y) => typeof y === "string"));
    if (!strArr(e.args) || !strArr(e.paramArgs)) {
      fail("`args` and `paramArgs` must be arrays of strings");
      continue;
    }
    const params = e.params ?? {};
    if (typeof params !== "object" || Array.isArray(params) ||
        Object.values(params).some((x) => typeof x !== "string")) {
      fail("`params` must map names to regex strings");
      continue;
    }
    const takesParams = Object.keys(params).length > 0 || (e.paramArgs?.length ?? 0) > 0;
    const bareCmd = ["cmd", "cmd.exe"].includes(e.file.toLowerCase());
    if (!isAbsolutePath(e.file) && !(bareCmd && !takesParams)) {
      fail(`file "${e.file}" must be an absolute path`);
      continue;
    }
    if (isShellInterpreter(e.file)) {
      let bad = "";
      for (const [pname, pattern] of Object.entries(params)) {
        let re: RegExp;
        try {
          re = new RegExp(`^(?:${pattern})$`);
        } catch {
          bad = `pattern for "${pname}" is not a valid regex`;
          break;
        }
        const hit = SHELL_META.find((c) => acceptsChar(re, c));
        if (hit !== undefined) {
          bad = `runs a shell interpreter and the pattern for "${pname}" accepts ${JSON.stringify(hit)}`;
          break;
        }
      }
      if (bad) {
        fail(bad);
        continue;
      }
    }
    allow[name] = e;
  }
  return { allow, errors };
}

/** Turn an allowed action + validated params into a concrete argv. */
export function resolveAction(
  allow: Allowlist,
  action: string,
  params: Record<string, string> = {}
): ResolveResult {
  const entry = allow[action];
  if (!entry) {
    const known = Object.keys(allow).sort().join(", ") || "(none configured)";
    return { ok: false, reason: `action "${action}" is not allowed. Allowed actions: ${known}` };
  }

  const declared = entry.params ?? {};
  for (const name of Object.keys(params)) {
    if (!(name in declared)) {
      return { ok: false, reason: `action "${action}" does not accept a parameter named "${name}"` };
    }
  }
  for (const [name, pattern] of Object.entries(declared)) {
    const value = params[name];
    if (value === undefined) {
      return { ok: false, reason: `action "${action}" requires parameter "${name}"` };
    }
    // Anchored on both ends: a pattern like \w+ must match the WHOLE value,
    // so "repo; rm -rf /" can't sneak through on a partial match.
    let re: RegExp;
    try {
      re = new RegExp(`^(?:${pattern})$`);
    } catch {
      return { ok: false, reason: `allowlist for "${action}" has an invalid pattern for "${name}"` };
    }
    if (!re.test(value)) {
      return { ok: false, reason: `parameter "${name}" does not match the allowed pattern` };
    }
    // Belt and braces behind the loader's pattern probe: a program that
    // re-parses its command line never receives a metacharacter, whatever
    // the pattern says.
    if (isShellInterpreter(entry.file) && SHELL_META.some((c) => value.includes(c))) {
      return { ok: false, reason: `parameter "${name}" contains a character the shell would interpret` };
    }
  }

  const args = [...(entry.args ?? [])];
  for (const tpl of entry.paramArgs ?? []) {
    args.push(tpl.replace(/\{(\w+)\}/g, (_m, k: string) => params[k] ?? ""));
  }

  return {
    ok: true,
    file: entry.file,
    args,
    cwd: entry.cwd,
    timeoutMs: entry.timeoutMs ?? RUNNER.timeoutMs,
  };
}

/** Load the allowlist from env or disk. Missing file = no actions allowed. */
export function loadAllowlist(): Allowlist {
  const raw =
    process.env.ONEMEMORY_RUNNER_ALLOW ||
    (() => {
      const p = join(PROJECT_ROOT, "data", "runner-allow.json");
      return existsSync(p) ? readFileSync(p, "utf8") : "";
    })();
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const { allow, errors } = validateAllowlist(parsed as Record<string, unknown>);
    for (const err of errors) console.error(`[onememory:runner] allowlist entry refused: ${err}`);
    return allow;
  } catch {
    console.error("[onememory:runner] ignoring allowlist: not valid JSON");
    return {};
  }
}

// ---- Local ledger ----------------------------------------------------------
// The runner's own record of what it has done, kept on the PC and never in the
// store. Two lists:
//   - command ids already executed (replay defense: the same cmd_id arriving
//     again as a NEW note is refused);
//   - note ids already examined (handled, refused or rejected), so neither a
//     finished command nor a junk note is re-read every poll.
// This is the source of truth for "claimed". A `claimed` tag is still added to
// the note as a hint for people and for pruning, but a store writer setting
// that tag can no longer stop a command running.

export class Ledger {
  private cmds: string[] = [];
  private cmdSet = new Set<string>();
  private notes: number[] = [];
  private noteSet = new Set<number>();
  private dirty = false;
  constructor(
    private path: string,
    private max = RUNNER.ledgerMax,
    private noteMax = RUNNER.seenMax
  ) {
    try {
      if (existsSync(path)) {
        const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
        // Legacy format: a bare array of command ids.
        const obj = Array.isArray(raw) ? { cmds: raw } : (raw as { cmds?: unknown; notes?: unknown });
        if (obj && Array.isArray(obj.cmds)) {
          this.cmds = obj.cmds.filter((x): x is string => typeof x === "string");
          this.cmdSet = new Set(this.cmds);
        }
        if (obj && Array.isArray(obj.notes)) {
          this.notes = obj.notes.filter((x): x is number => Number.isInteger(x));
          this.noteSet = new Set(this.notes);
        }
      }
    } catch {
      /* a corrupt ledger must not stop the runner; worst case we re-run once */
    }
  }
  has(id: string): boolean {
    return this.cmdSet.has(id);
  }
  /** Record an executed command id and persist immediately (before running). */
  add(id: string): void {
    if (!this.cmdSet.has(id)) {
      this.cmdSet.add(id);
      this.cmds.push(id);
      while (this.cmds.length > this.max) this.cmdSet.delete(this.cmds.shift()!);
    }
    this.dirty = true;
    this.flush();
  }
  hasNote(id: number): boolean {
    return this.noteSet.has(id);
  }
  /** Record an examined note id. Persisted on the next flush(). */
  markNote(id: number): void {
    if (this.noteSet.has(id)) return;
    this.noteSet.add(id);
    this.notes.push(id);
    while (this.notes.length > this.noteMax) this.noteSet.delete(this.notes.shift()!);
    this.dirty = true;
  }
  flush(): void {
    if (!this.dirty) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(this.path, JSON.stringify({ cmds: this.cmds, notes: this.notes }));
      this.dirty = false;
    } catch {
      /* best effort */
    }
  }
}

// ---- Single instance lock --------------------------------------------------

/** True if a process with this pid is alive (signal 0 = existence probe). */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Take the runner lock. A stale lock (owner process gone) is reclaimed rather
 * than wedging the loop forever after an unclean shutdown.
 */
export function acquireLock(path: string): boolean {
  try {
    if (existsSync(path)) {
      const pid = Number(readFileSync(path, "utf8").trim());
      if (Number.isInteger(pid) && pid > 0 && pidAlive(pid)) return false;
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, String(process.pid));
    return true;
  } catch {
    return false;
  }
}

export function releaseLock(path: string): void {
  try {
    if (existsSync(path) && readFileSync(path, "utf8").trim() === String(process.pid)) {
      unlinkSync(path);
    }
  } catch {
    /* ignore */
  }
}

// ---- Output handling -------------------------------------------------------

export function truncate(s: string, max = RUNNER.outputChars): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n...[truncated ${s.length - max} chars]`;
}

export interface ExecOutcome {
  exit_code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  duration_ms: number;
  timed_out: boolean;
}

/**
 * Run an allowlisted command. shell:false is the whole point -- argv is passed
 * as an array, so no value can ever be interpreted as shell syntax. The child
 * gets a trimmed environment: the runner secret and the store token are
 * removed so an allowlisted script can't read the credentials that authorized
 * it.
 */
export function runCommand(
  file: string,
  args: string[],
  opts: { cwd?: string; timeoutMs: number }
): Promise<ExecOutcome> {
  const started = Date.now();
  // Scrub credential-shaped variables from the child's environment. An
  // allowlisted script has no business reading the secret that authorized it
  // -- and while we are at it, nor should it inherit unrelated API keys that
  // happen to be set on this machine. Narrow beats convenient here.
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (/(^ONEMEMORY_(TOKEN|TOKENS|RUNNER_SECRET)$)|SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|CREDENTIAL|PRIVATE_?KEY/i.test(k)) {
      delete env[k];
    }
  }
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        cwd: opts.cwd,
        timeout: opts.timeoutMs,
        maxBuffer: 10 * 1024 * 1024,
        shell: false,
        windowsHide: true,
        env,
      },
      (err, stdout, stderr) => {
        const e = err as (Error & { code?: number | string; signal?: string }) | null;
        // Use the `killed` flag Node sets when IT enforced the timeout, rather
        // than inferring from elapsed time (which races on a slow machine).
        const killed = !!(e as (Error & { killed?: boolean }) | null)?.killed;
        const timedOut = killed;
        resolve({
          exit_code: typeof e?.code === "number" ? e.code : e ? 1 : 0,
          signal: e?.signal ?? null,
          stdout: truncate(String(stdout ?? "")),
          stderr: truncate(String(stderr ?? "") + (e && !stderr ? `\n${e.message}` : "")),
          duration_ms: Date.now() - started,
          timed_out: timedOut,
        });
      }
    );
  });
}

// ---- The loop ---------------------------------------------------------------

export interface RunnerDeps {
  store: Store;
  secret: string;
  allow: Allowlist;
  ledger: Ledger;
  now?: () => number;
  /** Timestamps of recent executions, for the flood ceiling. Managed here. */
  recent?: number[];
  /** Override this machine's name (tests, or multiple runners on one box). */
  runnerId?: string;
  /** Override RUNNER.taskNamespace (tests). "" / undefined = from RUNNER. */
  taskNamespace?: string;
}

/**
 * Tag a note `claimed`. A HINT only -- for people browsing the namespace and
 * for retention pruning. Whether a note has been handled is decided by the
 * local Ledger, because anyone with a store write token can set this tag.
 * Returns true if this call added the tag.
 */
export function claimNote(store: Store, note: NoteRecord): boolean {
  if (note.tags.includes(CLAIMED_TAG)) return false;
  try {
    const updated = store.update(
      note.id,
      { tags: [...note.tags, CLAIMED_TAG] },
      { ifRev: note.rev }
    );
    return updated !== null;
  } catch (e) {
    // ValidationError here means another writer moved the note first. Not a
    // fault, and not a reason to skip the command.
    if (e instanceof ValidationError) return false;
    throw e;
  }
}

function resultEnvelope(cmdId: string, payload: Record<string, unknown>): Record<string, unknown> {
  return { cmd_id: cmdId, completed_at: new Date().toISOString(), runner: runnerId(), ...payload };
}

/** Write the outcome (or refusal) back, signed, where the phone can read it. */
export function writeResult(
  store: Store,
  secret: string,
  cmdId: string,
  payload: Record<string, unknown>
): number | null {
  try {
    const note = store.create({
      namespace: RUNNER.resultsNamespace,
      title: `result ${cmdId}`,
      body: signedBody(secret, "result", resultEnvelope(cmdId, payload)),
      tags: [RESULT_TAG, `cmd:${cmdId}`],
      source: "onememory-runner",
    });
    return note.id;
  } catch (e) {
    // A result that can't be stored (e.g. output tripped the secret scanner)
    // must still leave a trace, or the operator sees silence and assumes the
    // PC is down.
    const why = e instanceof Error ? e.message : String(e);
    try {
      const note = store.create({
        namespace: RUNNER.resultsNamespace,
        title: `result ${cmdId}`,
        body: signedBody(secret, "result", {
          cmd_id: cmdId,
          runner: runnerId(),
          status: "error",
          error: `result could not be stored: ${why}`,
        }),
        tags: [RESULT_TAG, `cmd:${cmdId}`],
        source: "onememory-runner",
      });
      return note.id;
    } catch {
      console.error(`[onememory:runner] could not write result for ${cmdId}: ${why}`);
      return null;
    }
  }
}

/**
 * Update an already-open result note, falling back to a fresh note if the
 * update fails. Used to close out a "running" note once the command finishes.
 */
export function closeResult(
  store: Store,
  secret: string,
  noteId: number | null,
  cmdId: string,
  payload: Record<string, unknown>
): void {
  if (noteId !== null) {
    try {
      const body = signedBody(secret, "result", resultEnvelope(cmdId, payload));
      if (store.update(noteId, { body }) !== null) return;
    } catch {
      /* fall through to writing a new note */
    }
  }
  writeResult(store, secret, cmdId, payload);
}

/**
 * Answer the reserved introspection action: what may this PC be asked to do?
 * Worth having because the allowlist lives on the machine you are away from,
 * and guessing an action name just produces refusals.
 */
export function describeActions(allow: Allowlist): Record<string, unknown> {
  const actions = Object.entries(allow)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, e]) => ({
      action: name,
      description: e.description ?? "",
      params: Object.keys(e.params ?? {}),
    }));
  return { status: "ok", action: INTROSPECT_ACTION, actions, count: actions.length };
}

/**
 * Delete handled commands and results past the retention window. Without
 * this the namespaces grow forever, every poll pages through more history,
 * and a year from now the loop is reading thousands of dead notes.
 */
export function pruneOld(store: Store, days: number = RUNNER.retentionDays, now = Date.now()): number {
  if (!days || days <= 0) return 0;
  const cutoff = now - days * 86_400_000;
  const pageSize = 200;
  const maxPages = 100;
  const doomed: number[] = [];

  // list() returns NEWEST first, so the notes old enough to prune are at the
  // END of the namespace. An earlier version read only the first page and
  // stopped -- which meant retention quietly never deleted anything. Walk all
  // the way to the end, collect, then delete.
  for (const ns of [RUNNER.namespace, RUNNER.resultsNamespace]) {
    for (let page = 0; page < maxPages; page++) {
      const { notes, total } = store.list({
        namespace: ns,
        limit: pageSize,
        offset: page * pageSize,
      });
      if (notes.length === 0) break;
      for (const n of notes) {
        const handled = ns === RUNNER.resultsNamespace || n.tags.includes(CLAIMED_TAG);
        if (handled && Date.parse(n.updated_at) < cutoff) doomed.push(n.id);
      }
      if ((page + 1) * pageSize >= total) break;
    }
  }

  let removed = 0;
  for (const id of doomed) if (store.delete(id)) removed++;
  if (removed) audit({ op: "runner.prune", bytes: removed });
  return removed;
}

/** Process one note end-to-end. Exported so tests can drive it directly. */
export async function processNote(deps: RunnerDeps, note: NoteRecord): Promise<string> {
  const now = deps.now ?? Date.now;
  const verdict = verifyCommand(deps.secret, note.body, now(), RUNNER.freshnessMs);
  const me = deps.runnerId ?? runnerId();

  if (!verdict.ok) {
    // An authenticated-but-late command addressed to another machine is that
    // machine's business: no reply from us, just stop looking at it.
    if (verdict.cmd?.target && verdict.cmd.target !== me) {
      deps.ledger.markNote(note.id);
      return `skipped: addressed to ${verdict.cmd.target}`;
    }
    deps.ledger.markNote(note.id);
    claimNote(deps.store, note);
    audit({ op: "runner.reject", id: note.id, namespace: note.namespace });
    // Only answer notes whose signature checked out. Anything else gets
    // silence -- replying would turn the runner into an oracle, and would let
    // a token holder plant "rejected" replies against real command ids.
    if (verdict.authenticated && verdict.cmd_id) {
      writeResult(deps.store, deps.secret, verdict.cmd_id, {
        status: "rejected",
        reason: verdict.reason,
      });
    }
    return `rejected: ${verdict.reason}`;
  }

  const cmd = verdict.cmd;

  // Addressed to a different machine: leave it alone entirely -- not even
  // marked as seen, so it is re-checked (cheaply) until it goes stale.
  if (cmd.target && cmd.target !== me) {
    return `skipped: addressed to ${cmd.target}`;
  }

  // Claim in the LOCAL ledger. This is the only claim that counts.
  deps.ledger.markNote(note.id);
  if (deps.ledger.has(cmd.cmd_id)) {
    deps.ledger.flush();
    claimNote(deps.store, note);
    audit({ op: "runner.replay", id: note.id });
    writeResult(deps.store, deps.secret, cmd.cmd_id, {
      status: "rejected",
      reason: "this command id has already been executed",
    });
    return "rejected: replay";
  }
  // Record BEFORE running (add() persists): if the machine dies mid-command
  // we would rather not run it a second time on restart.
  deps.ledger.add(cmd.cmd_id);
  claimNote(deps.store, note);

  const done = await executeCommand(deps, cmd, note.id, note.namespace);
  return done.verdict;
}

export interface ExecDone {
  /** processNote-style verdict string ("ok", "failed", "refused: ...", "ok: actions listed"). */
  verdict: string;
  ok: boolean;
  status: string;
  exit_code?: number | null;
  output?: string;
  reason?: string;
}

/**
 * Steps shared by signed command notes and approved command tasks, run AFTER
 * the command passed verification and was recorded in the replay ledger:
 * the reserved introspection action, the allowlist gate, then the spawn
 * (shell:false) and the signed result note. Nothing here widens what an
 * allowlist entry permits.
 */
export async function executeCommand(
  deps: RunnerDeps,
  cmd: CommandEnvelope,
  auditId: number,
  auditNamespace: string
): Promise<ExecDone> {
  // The reserved introspection action never executes anything -- it just
  // reports what this machine is willing to do.
  if (cmd.action === INTROSPECT_ACTION) {
    const desc = describeActions(deps.allow);
    writeResult(deps.store, deps.secret, cmd.cmd_id, desc);
    return { verdict: "ok: actions listed", ok: true, status: "ok", output: JSON.stringify(desc) };
  }

  const resolved = resolveAction(deps.allow, cmd.action, cmd.params ?? {});
  if (!resolved.ok) {
    audit({ op: "runner.refuse", id: auditId });
    writeResult(deps.store, deps.secret, cmd.cmd_id, { status: "refused", reason: resolved.reason });
    return { verdict: `refused: ${resolved.reason}`, ok: false, status: "refused", reason: resolved.reason };
  }

  // Open the result note BEFORE spawning anything. If the PC loses power or
  // the process is killed mid-command, the operator still finds a note saying
  // "running since 14:02" instead of silence -- which, from another country,
  // is the difference between "it's working on it" and "my PC is dead".
  audit({ op: "runner.exec", id: auditId, namespace: auditNamespace });
  const openId = writeResult(deps.store, deps.secret, cmd.cmd_id, {
    status: "running",
    action: cmd.action,
    started_at: new Date().toISOString(),
    pid: process.pid,
  });

  const outcome = await runCommand(resolved.file, resolved.args, {
    cwd: resolved.cwd,
    timeoutMs: resolved.timeoutMs,
  });
  const status = outcome.timed_out ? "timed_out" : outcome.exit_code === 0 ? "ok" : "failed";
  closeResult(deps.store, deps.secret, openId, cmd.cmd_id, {
    status,
    action: cmd.action,
    ...outcome,
  });
  return {
    verdict: outcome.exit_code === 0 ? "ok" : "failed",
    ok: outcome.exit_code === 0 && !outcome.timed_out,
    status,
    exit_code: outcome.exit_code,
    output: [outcome.stdout, outcome.stderr].filter(Boolean).join("\n"),
  };
}

/**
 * Would this note be EXECUTED (as opposed to rejected, refused as a replay,
 * or skipped)? Only these count against the flood budget, so junk posted by
 * a token holder without the secret can never crowd out real commands.
 */
function isRunnable(deps: RunnerDeps, note: NoteRecord, now: number): boolean {
  const v = verifyCommand(deps.secret, note.body, now, RUNNER.freshnessMs);
  if (!v.ok) return false;
  if (v.cmd.target && v.cmd.target !== (deps.runnerId ?? runnerId())) return false;
  return !deps.ledger.has(v.cmd.cmd_id);
}

/**
 * One poll pass. Returns how many notes were dealt with (run, refused or
 * rejected). Notes are examined newest-first, so a fresh real command is
 * found even behind a pile of junk; the runnable ones then execute
 * oldest-first, in the order they were sent.
 */
export async function pollOnce(deps: RunnerDeps): Promise<number> {
  // Page through the namespace rather than reading one window: handled notes
  // stay until pruned, so a single window could hide pending ones forever.
  const pageSize = 100;
  const maxPages = 20; // bounded so one poll can't run forever
  const pending: NoteRecord[] = []; // newest first, as list() returns them
  for (let page = 0; page < maxPages; page++) {
    const { notes, total } = deps.store.list({
      namespace: RUNNER.namespace,
      limit: pageSize,
      offset: page * pageSize,
    });
    if (notes.length === 0) break;
    // The local ledger -- not the `claimed` tag -- decides what is pending.
    for (const n of notes) if (!deps.ledger.hasNote(n.id)) pending.push(n);
    if ((page + 1) * pageSize >= total) break;
  }

  const now = (deps.now ?? Date.now)();
  const runnable: NoteRecord[] = [];
  let handled = 0;
  let rejects = 0;
  for (const note of pending) {
    if (isRunnable(deps, note, now)) {
      runnable.push(note);
      continue;
    }
    // Bounded: junk costs a ledger entry and a tag write each. What is left
    // over is examined next pass; it never touches the execution budget.
    if (rejects >= RUNNER.maxRejectsPerPoll) continue;
    rejects++;
    try {
      const verdict = await processNote(deps, note);
      if (!verdict.startsWith("skipped")) handled++;
      else rejects--; // another machine's command is not junk
    } catch (e) {
      console.error(`[onememory:runner] note ${note.id} failed:`, e);
    }
  }
  runnable.reverse(); // oldest first

  // Flood control, on VERIFIED commands only. If the signing secret ever
  // leaked, an attacker could queue thousands of valid commands. Overflow is
  // DEFERRED, not refused: a genuine burst still runs across several polls.
  deps.recent = (deps.recent ?? []).filter((t) => now - t < RUNNER.windowMs);
  const windowRoom = Math.max(0, RUNNER.maxPerWindow - deps.recent.length);
  const room = Math.min(RUNNER.maxPerPoll, windowRoom);
  if (runnable.length > room) {
    console.error(
      `[onememory:runner] ${runnable.length} commands pending, running ${room} this pass`
    );
  }

  for (const note of runnable.slice(0, room)) {
    deps.recent.push(now);
    try {
      await processNote(deps, note);
      handled++;
    } catch (e) {
      // One bad note must never kill the loop -- that would silently end
      // remote control until Dan next looks at the PC.
      console.error(`[onememory:runner] note ${note.id} failed:`, e);
    }
  }
  deps.ledger.flush();
  return handled;
}

/**
 * Heartbeat: a single note, updated in place, saying the loop is alive. This
 * is what lets the operator tell "PC ignored me" from "PC isn't listening".
 */
let heartbeatId: number | null = null;

export function beat(store: Store, secret: string, startedAt: string): void {
  const title = "runner heartbeat";
  // Signed, so a token holder cannot keep a dead PC looking alive. They can
  // still replay an OLD signed beat, which only ever makes it look staler.
  const body = signedBody(secret, "heartbeat", {
    alive_at: new Date().toISOString(),
    started_at: startedAt,
    pid: process.pid,
    host: process.env.COMPUTERNAME || process.env.HOSTNAME || "unknown",
    runner: runnerId(),
    poll_ms: RUNNER.pollMs,
    // What runner_status needs to count only commands THIS runner would run,
    // and to size its "offline" threshold from the real beat interval.
    heartbeat_ms: RUNNER.heartbeatMs,
    task_namespace: RUNNER.taskNamespace,
  });
  try {
    // Cache the id. Re-scanning a window each beat would silently start
    // creating duplicate heartbeats once the namespace outgrew that window,
    // and duplicate heartbeats are worse than none -- you would not know
    // which one to trust.
    if (heartbeatId !== null && store.update(heartbeatId, { body }) !== null) return;
    const existing = store
      .list({ namespace: "runner", limit: 200 })
      .notes.find((n) => n.title === title);
    if (existing) {
      heartbeatId = existing.id;
      store.update(existing.id, { body });
    } else {
      heartbeatId = store.create({
        namespace: "runner",
        title,
        body,
        tags: ["heartbeat"],
        source: "onememory-runner",
      }).id;
    }
  } catch {
    /* a missed heartbeat must not stop command processing */
  }
}

/** Test seam: forget the cached heartbeat note. */
export function resetHeartbeat(): void {
  heartbeatId = null;
}

export interface StartedRunner {
  stop: () => void;
}

/** Start the polling loop. Returns a handle so callers/tests can stop it. */
export function startRunner(deps: RunnerDeps): StartedRunner {
  const startedAt = new Date().toISOString();
  let stopped = false;
  let busy = false;

  const tick = async (): Promise<void> => {
    if (stopped || busy) return; // never overlap passes
    busy = true;
    try {
      await pollOnce(deps);
      await pollTasks(deps);
    } finally {
      busy = false;
    }
  };

  beat(deps.store, deps.secret, startedAt);
  const pollTimer = setInterval(() => void tick(), RUNNER.pollMs);
  // Prune on its own clock, not on every heartbeat. Heartbeats are every few
  // minutes; walking both namespaces to the end that often is wasted work on
  // a store with any history in it.
  let lastPrune = 0;
  const beatTimer = setInterval(() => {
    beat(deps.store, deps.secret, startedAt);
    const now = (deps.now ?? Date.now)();
    if (now - lastPrune < RUNNER.pruneEveryMs) return;
    lastPrune = now;
    try {
      pruneOld(deps.store);
    } catch (e) {
      console.error("[onememory:runner] prune failed:", e);
    }
  }, RUNNER.heartbeatMs);
  void tick();

  return {
    stop(): void {
      stopped = true;
      clearInterval(pollTimer);
      clearInterval(beatTimer);
    },
  };
}

/** Entry point for `npm run runner`. */
export function main(): void {
  const secret = process.env.ONEMEMORY_RUNNER_SECRET?.trim();
  if (!secret) {
    console.error(
      "[onememory:runner] refusing to start: ONEMEMORY_RUNNER_SECRET is not set.\n" +
        "Without it every note in the commands namespace would be unauthenticated input."
    );
    process.exit(1);
  }
  const allow = loadAllowlist();
  if (Object.keys(allow).length === 0) {
    console.error(
      "[onememory:runner] warning: no allowlisted actions. The runner will refuse everything " +
        "until data/runner-allow.json (or ONEMEMORY_RUNNER_ALLOW) names some."
    );
  }
  const lockPath = join(PROJECT_ROOT, "data", "runner.lock");
  if (!acquireLock(lockPath)) {
    console.error("[onememory:runner] another runner is already holding the lock; exiting.");
    process.exit(1);
  }
  const dbPath = process.env.ONEMEMORY_DB_PATH || join(PROJECT_ROOT, "data", "state.db");
  const store = new Store(dbPath);
  const ledger = new Ledger(join(PROJECT_ROOT, "data", "runner-seen.json"));
  const handle = startRunner({ store, secret, allow, ledger });

  const shutdown = (): void => {
    handle.stop();
    releaseLock(lockPath);
    store.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  console.error(
    `[onememory:runner] listening on namespace "${RUNNER.namespace}" every ${RUNNER.pollMs}ms ` +
      `(${Object.keys(allow).length} allowed action(s))`
  );
  console.error(
    RUNNER.taskNamespace
      ? `[onememory:runner] command tasks ON: namespace "${RUNNER.taskNamespace}", this runner is "${runnerId()}" ` +
          "(only admin-approved tasks addressed to that name run)"
      : "[onememory:runner] command tasks off (set ONEMEMORY_RUNNER_TASK_NAMESPACE to enable)"
  );
}

/** Helper for senders (phone/CLI): build a ready-to-post signed command. */
export function buildCommand(
  secret: string,
  action: string,
  params: Record<string, string> = {},
  target = ""
): CommandEnvelope {
  const base = {
    cmd_id: randomUUID(),
    action,
    params,
    target,
    issued_at: new Date().toISOString(),
    nonce: randomUUID(),
  };
  if (hasControlChars(base)) throw new Error("control characters are not allowed in a command");
  return { v: COMMAND_FORMAT, ...base, sig: signCommand(secret, base) };
}
