// `onememory sync --git <repo>`: keep your memory in step across your own computers with a git repository YOU own.
//
// There is no OneMemory server in this. It is the existing Markdown export/import (docs/file-sync.md) with git doing the
// carrying: fetch, merge what other computers pushed, three-way merge the files into the local database, write the
// result back out, commit, push. Use a PRIVATE repository. With --encrypt every note file is sealed (AES-256-GCM, the
// same primitives as at-rest encryption) before it is committed, and the repository then holds only opaque names and
// ciphertext; the key stays in a file on your computers and is never written inside the repository.

import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { decrypt, encrypt, keyPath } from "./crypto.js";

export const VAULT_PLAIN = "onememory";
export const VAULT_ENC = "onememory-enc";
const KEY_BYTES = 32;

export interface GitSyncIO {
  out(line: string): void;
  err(line: string): void;
  ask(prompt: string): Promise<string>;
  interactive: boolean;
}

export interface GitSyncOptions {
  repo: string;
  remote?: string;
  encrypt: boolean;
  keyFile?: string;
  dryRun: boolean;
  noPush: boolean;
  yes: boolean;
  dataDir: string;
  dbPath: string;
  env: NodeJS.ProcessEnv;
  now?: () => Date;
}

class SyncStop extends Error {}

function git(repo: string, args: string[], env: NodeJS.ProcessEnv, input?: string): { ok: boolean; out: string; err: string; code: number | null } {
  const r = spawnSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    input,
    // Never wait for a password prompt: a script must fail, not hang.
    env: { ...env, GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: env.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes", LC_ALL: "C" },
    timeout: 120_000,
  });
  return { ok: r.status === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim(), code: r.status };
}

function mustGit(repo: string, args: string[], env: NodeJS.ProcessEnv, what: string): string {
  const r = git(repo, args, env);
  if (!r.ok) throw new SyncStop(`${what} failed: ${r.err || r.out || `git exited with ${r.code}`}`);
  return r.out;
}

// ---- key ---------------------------------------------------------------------------------------------------------------------

export function syncKeyPath(opts: Pick<GitSyncOptions, "keyFile" | "dataDir" | "env">): string {
  if (opts.keyFile) return resolve(opts.keyFile);
  if (opts.env.ONEMEMORY_SYNC_KEY_FILE?.trim()) return resolve(opts.env.ONEMEMORY_SYNC_KEY_FILE.trim());
  // Reuse the at-rest key when that is on, so there is one key to look after; otherwise a key of its own.
  const rest = keyPath(opts.dataDir);
  return existsSync(rest) ? rest : join(opts.dataDir, ".sync-key");
}

function readKey(p: string): Buffer | null {
  if (!existsSync(p)) return null;
  const raw = readFileSync(p);
  if (raw.length !== KEY_BYTES) throw new SyncStop(`the key file ${p} is ${raw.length} bytes; it must be ${KEY_BYTES}. Restore it from your other computer.`);
  return raw;
}

function createKey(p: string): Buffer {
  mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
  const key = randomBytes(KEY_BYTES);
  const tmp = `${p}.tmp-${process.pid}`;
  writeFileSync(tmp, key, { mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    /* best effort on Windows */
  }
  renameSync(tmp, p);
  return key;
}

/** Is `file` inside `dir` (after resolving links)? */
export function isInside(dir: string, file: string): boolean {
  const real = (p: string): string => {
    try {
      return realpathSync(p);
    } catch {
      return resolve(p);
    }
  };
  const rel = relative(real(dir), real(file));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

// ---- sealed files -------------------------------------------------------------------------------------------------------------

function blobName(rel: string): string {
  return createHash("sha256").update(rel).digest("hex").slice(0, 32) + ".enc";
}

/** Relative paths we accept from a decrypted blob: plain Markdown inside the vault, no tricks. */
export function safeRelPath(p: unknown): string | null {
  if (typeof p !== "string" || p.length === 0 || p.length > 400) return null;
  if (p.includes("\0") || p.includes("\\") || p.startsWith("/") || /^[A-Za-z]:/.test(p)) return null;
  const parts = p.split("/");
  if (parts.length > 3 || parts.some((x) => x === "" || x === "." || x === ".." || x.startsWith("."))) return null;
  if (!/\.md$/i.test(p)) return null;
  return p;
}

export function sealFile(rel: string, text: string, key: Buffer): string {
  const name = blobName(rel);
  return encrypt(JSON.stringify({ p: rel, t: text }), key, `git-sync|${name}`) + "\n";
}

export function openFile(name: string, blob: string, key: Buffer): { rel: string; text: string } {
  const json = JSON.parse(decrypt(blob.trim(), key, `git-sync|${name}`)) as { p?: unknown; t?: unknown };
  const rel = safeRelPath(json.p);
  if (!rel || typeof json.t !== "string") throw new Error("a sealed file holds an unsafe path");
  if (blobName(rel) !== name) throw new Error("a sealed file is stored under the wrong name");
  return { rel, text: json.t };
}

function listMd(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, depth: number): void => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const p = join(d, e.name);
      if (e.isDirectory() && depth < 2) walk(p, depth + 1);
      else if (e.isFile() && e.name.toLowerCase().endsWith(".md")) out.push(relative(dir, p).split(sep).join("/"));
    }
  };
  walk(dir, 1);
  return out.sort();
}

// ---- the sync ------------------------------------------------------------------------------------------------------------------

export async function runGitSync(io: GitSyncIO, o: GitSyncOptions): Promise<number> {
  const now = o.now ?? (() => new Date());
  let repo: string;
  try {
    repo = realpathSync(o.repo);
  } catch {
    io.err(`Not found: ${o.repo}. Create or clone your PRIVATE git repository first, then pass its folder.`);
    return 1;
  }
  const probe = spawnSync("git", ["--version"], { encoding: "utf8" });
  if (probe.status !== 0) {
    io.err("git is not installed (or not on PATH). Install git, open a new terminal, and try again.");
    return 1;
  }
  const inside = git(repo, ["rev-parse", "--show-toplevel"], o.env);
  if (!inside.ok) {
    io.err(`${repo} is not a git repository. Run \`git init\` (or \`git clone <your private repo>\`) there first. Nothing was changed.`);
    return 1;
  }
  const top = realpathSync(inside.out);
  const vaultName = o.encrypt ? VAULT_ENC : VAULT_PLAIN;
  const otherName = o.encrypt ? VAULT_PLAIN : VAULT_ENC;
  const vault = join(repo, vaultName);
  try {
    if (existsSync(join(repo, otherName)) && readdirSync(join(repo, otherName)).length > 0) {
      throw new SyncStop(`This repository already uses ${otherName}/ (${o.encrypt ? "plain" : "sealed"} files). Mixing the two would leak or lose notes; use the same mode as before${o.encrypt ? " (drop --encrypt)" : " (add --encrypt)"}.`);
    }
    // symbolic-ref also works on a brand-new clone of an empty repository (no commit yet).
    const head = git(repo, ["symbolic-ref", "--short", "-q", "HEAD"], o.env);
    if (!head.ok || !head.out) throw new SyncStop("The repository is on a detached HEAD; check out a branch first.");
    const branch = head.out;
    const remotes = mustGit(repo, ["remote"], o.env, "listing remotes").split("\n").filter(Boolean);
    const remote = o.remote ?? remotes[0];
    if (o.remote && !remotes.includes(o.remote)) throw new SyncStop(`The repository has no remote called "${o.remote}".`);
    const keyFile = o.encrypt ? syncKeyPath(o) : null;
    if (keyFile && isInside(top, keyFile)) throw new SyncStop(`The key file ${keyFile} is inside the repository. A key must never be committed; move it elsewhere (--key-file).`);

    io.out(`Git sync of ${o.dbPath}`);
    io.out(`  repository : ${repo}  (branch ${branch}, remote ${remote ?? "none: committing locally only"})`);
    io.out(`  files      : ${vaultName}/ ${o.encrypt ? "(sealed: names and text are encrypted; key stays in " + keyFile + ")" : "(PLAIN TEXT Markdown: use a private repository, or add --encrypt)"}`);
    if (!remote || o.noPush) io.out(`  push       : no (${!remote ? "no remote" : "--no-push"})`);

    if (!o.encrypt && !o.yes && !o.dryRun) {
      // The one-way door: plain notes in a repository. Ask once per run, in words.
      if (!io.interactive) throw new SyncStop("Plain-text sync commits your notes as readable files. Add --encrypt, or --yes to confirm the repository is private.");
      const a = (await io.ask("This commits your notes as readable text. Is the repository PRIVATE? Type y to continue: ")).trim().toLowerCase();
      if (a !== "y" && a !== "yes") {
        io.out("Cancelled. Nothing was changed.");
        return 0;
      }
    }

    const { Store } = await import("./store.js");
    const { importMarkdown, exportMarkdown } = await import("./sync.js");

    if (o.dryRun) {
      // Look only: merge the vault as it is now into nothing, writing nothing.
      let dryDir = vault;
      let cleanup: (() => void) | null = null;
      if (o.encrypt) {
        const key = keyFile ? readKey(keyFile) : null;
        mkdirSync(o.dataDir, { recursive: true, mode: 0o700 });
        dryDir = mkdtempSync(join(o.dataDir, ".sync-dry-"));
        cleanup = () => rmSync(dryDir, { recursive: true, force: true });
        if (key) decryptInto(vault, dryDir, key);
      }
      try {
        if (existsSync(dryDir)) {
          const store = new Store(o.dbPath);
          try {
            const r = await importMarkdown(store, dryDir, { dryRun: true });
            const c = r.counts;
            io.out(`  [dry run] files already in the repository would bring: ${c.created} new, ${c.updated} updated, ${c.conflict} conflict(s), ${c.unchanged} unchanged.`);
          } finally {
            store.close();
          }
        } else io.out("  [dry run] the repository has no notes yet; the first sync would export yours.");
      } finally {
        cleanup?.();
      }
      io.out("Dry run: nothing was fetched, merged, written, committed or pushed.");
      return 0;
    }

    let key: Buffer | null = null;
    if (o.encrypt) {
      key = readKey(keyFile!);
    }

    for (let round = 1; round <= 2; round++) {
      // 1. Take in what other computers pushed.
      const ident = git(repo, ["config", "user.email"], o.env).out ? [] : ["-c", "user.name=OneMemory", "-c", "user.email=onememory@localhost"];
      // Local edits to the vault folder are committed first, so a merge never trips over them.
      if (git(repo, ["status", "--porcelain", "--", vaultName], o.env).out) {
        mustGit(repo, ["add", "-A", "--", vaultName], o.env, "staging local edits");
        mustGit(repo, [...ident, "commit", "-m", "onememory: local edits before sync", "--", vaultName], o.env, "committing local edits");
      }
      if (remote) {
        mustGit(repo, ["fetch", remote], o.env, `fetching from ${remote}`);
        const has = git(repo, ["rev-parse", "--verify", "--quiet", `refs/remotes/${remote}/${branch}`], o.env);
        if (has.ok) {
          const m = git(repo, [...ident, "merge", "--no-edit", `${remote}/${branch}`], o.env);
          if (!m.ok) {
            const conflicted = git(repo, ["diff", "--name-only", "--diff-filter=U"], o.env).out.split("\n").filter(Boolean);
            git(repo, ["merge", "--abort"], o.env);
            throw new SyncStop(
              `git could not merge ${remote}/${branch} on its own (${conflicted.length ? conflicted.slice(0, 5).join(", ") : m.err.split("\n")[0]}). ` +
                `Nothing was changed in your memory. Resolve it in the repository with git, then run sync again.`
            );
          }
        }
      }
      // 2. Seal/unseal, merge into the database, write back.
      if (o.encrypt) {
        const sealedHere = existsSync(vault) ? readdirSync(vault).filter((f) => f.endsWith(".enc")) : [];
        if (!key) {
          if (sealedHere.length > 0) throw new SyncStop(`This repository already holds sealed notes, but there is no key at ${keyFile}. Copy the key file from the computer that created it (never through the repository), then run sync again.`);
          key = createKey(keyFile!);
          io.out(`  Created a new key at ${keyFile}. Copy that file to your other computers (NOT into the repository) before syncing there; without it the sealed notes cannot be read.`);
        }
      }
      if (o.encrypt) mkdirSync(o.dataDir, { recursive: true, mode: 0o700 });
      const work = o.encrypt ? mkdtempSync(join(o.dataDir, ".sync-work-")) : vault;
      try {
        mkdirSync(work, { recursive: true });
        let before = new Map<string, string>();
        if (o.encrypt) before = decryptInto(vault, work, key!);
        const store = new Store(o.dbPath);
        try {
          const imp = await importMarkdown(store, work, {});
          const c = imp.counts;
          const exp = exportMarkdown(store, work, {});
          io.out(`  merged: ${c.created} new, ${c.updated} updated, ${c.unchanged} unchanged, ${c.conflict} conflict(s), ${c.rejected} rejected; wrote ${exp.written} file(s), removed ${exp.removed}.`);
          if (c.conflict > 0) {
            const keep = join(o.dataDir, "sync-conflicts", now().toISOString().replace(/[:.]/g, "-"));
            if (existsSync(join(work, ".conflicts"))) {
              mkdirSync(keep, { recursive: true, mode: 0o700 });
              copyTree(join(work, ".conflicts"), keep);
              io.out(`  ${c.conflict} note(s) were edited on two computers; the losing text is saved in ${keep}`);
            }
          }
          if (c.rejected > 0) io.err(`  ${c.rejected} file(s) were rejected (see \`onememory import --dir\` for details).`);
        } finally {
          store.close();
        }
        if (o.encrypt) writeSealed(vault, work, key!, before);
      } finally {
        if (o.encrypt) rmSync(work, { recursive: true, force: true });
      }
      // 3. Commit and push.
      mustGit(repo, ["add", "-A", "--", vaultName], o.env, "staging");
      const staged = git(repo, ["diff", "--cached", "--name-only", "--", vaultName], o.env).out;
      if (staged) {
        mustGit(repo, [...ident, "commit", "-m", `onememory sync ${now().toISOString()}`, "--", vaultName], o.env, "committing");
        io.out(`  committed ${staged.split("\n").length} changed file(s).`);
      } else io.out("  nothing new to commit.");
      if (remote && !o.noPush) {
        const upstream = git(repo, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], o.env).ok;
        const p = git(repo, ["push", ...(upstream ? [] : ["-u"]), remote, branch], o.env);
        if (p.ok) {
          io.out(`  pushed to ${remote}/${branch}.`);
          return 0;
        }
        if (round === 1 && /non-fast-forward|fetch first|rejected/i.test(p.err)) {
          io.out("  another computer pushed in the meantime; merging again.");
          continue;
        }
        throw new SyncStop(`pushing to ${remote} failed: ${p.err.split("\n").slice(-2).join(" ")}. Your memory is safe and committed locally; fix the connection and run sync again.`);
      }
      return 0;
    }
    return 0;
  } catch (e) {
    if (e instanceof SyncStop) {
      io.err("Stopped: " + e.message);
      return 1;
    }
    io.err("Stopped: " + (e as Error).message);
    return 1;
  }
}

/** Decrypt every sealed file into `work`; returns relative path -> text as found. Any bad file stops everything. */
function decryptInto(vault: string, work: string, key: Buffer): Map<string, string> {
  const seen = new Map<string, string>();
  if (!existsSync(vault)) return seen;
  for (const f of readdirSync(vault)) {
    if (!f.endsWith(".enc")) continue;
    let opened: { rel: string; text: string };
    try {
      opened = openFile(f, readFileSync(join(vault, f), "utf8"), key);
    } catch (e) {
      throw new SyncStop(`could not open the sealed file ${f}: ${(e as Error).message}. Is this the right key? Nothing was changed.`);
    }
    const dest = join(work, ...opened.rel.split("/"));
    if (!isInside(work, dest)) throw new SyncStop(`a sealed file points outside the work folder; stopped.`);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, opened.text);
    seen.set(opened.rel, opened.text);
  }
  return seen;
}

/** Write sealed files for what changed (unchanged text keeps its old bytes, so git sees no change) and remove vanished ones. */
function writeSealed(vault: string, work: string, key: Buffer, before: Map<string, string>): void {
  mkdirSync(vault, { recursive: true });
  const now = new Set<string>();
  for (const rel of listMd(work)) {
    now.add(rel);
    const text = readFileSync(join(work, ...rel.split("/")), "utf8");
    if (before.get(rel) === text && existsSync(join(vault, blobName(rel)))) continue;
    writeFileSync(join(vault, blobName(rel)), sealFile(rel, text, key));
  }
  for (const rel of before.keys()) if (!now.has(rel)) rmSync(join(vault, blobName(rel)), { force: true });
}

function copyTree(from: string, to: string): void {
  for (const e of readdirSync(from, { withFileTypes: true })) {
    const s = join(from, e.name);
    const d = join(to, e.name);
    if (e.isDirectory()) {
      mkdirSync(d, { recursive: true });
      copyTree(s, d);
    } else if (e.isFile()) writeFileSync(d, readFileSync(s));
  }
}
