// `onememory uninstall [--purge] [--dry-run] [--yes] [--no-backup]`: take OneMemory out of every app setup wired,
// and with --purge also delete the data folder (after a final backup).
//
// It reuses setup's own undo (setup.ts undoSession): every config file setup changed is put back from its backup when
// nothing touched it since (byte-identical; a file setup created is deleted), or else only the OneMemory entry is taken
// out and the rest of the file is kept. Nothing setup did not record is changed: an entry you added by hand is listed,
// not removed. Like setup it shows the plan first and writes only after you type y.

import { cpSync, existsSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, relative, resolve } from "node:path";
import { dataHome, detectClients, hookHosts, readHistory, saveHistory, stamp, undoSession, type HistorySession, type SetupEnv, type SetupIO } from "./setup.js";

export interface UninstallOptions {
  dryRun: boolean;
  yes: boolean;
  purge: boolean;
  noBackup: boolean;
}

type Change = HistorySession["changes"][number];
const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

/** Total bytes of the files under `dir` (0 when it is missing). */
export function dirBytes(dir: string): number {
  let n = 0;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const d of entries) {
    const p = join(dir, d.name);
    try {
      if (d.isDirectory()) n += dirBytes(p);
      else if (d.isFile()) n += statSync(p).size;
    } catch {
      /* gone meanwhile */
    }
  }
  return n;
}

/** What undo will do to one recorded change, in words (nothing is written). */
function describe(c: Change): string {
  if (!existsSync(c.real)) return "already gone, nothing to do";
  if (sha(readFileSync(c.real, "utf8")) === c.afterSha) return c.createdFile ? "delete it (setup created it)" : `put back the original (${c.backup})`;
  return "take out only the OneMemory part (the file changed since setup; the rest is kept)";
}

/** App configs that still mention OneMemory but were not changed by setup: listed, never touched. */
function leftovers(e: SetupEnv, recorded: Set<string>): string[] {
  const files = new Set([...detectClients(e).map((t) => t.file), ...hookHosts(e).map((h) => h.file)]);
  return [...files].filter((f) => {
    if (recorded.has(resolve(f))) return false;
    try {
      return /"onememory"\s*:|\[mcp_servers\.onememory\]|onememory[^\n]{0,160}\b(?:hook [a-z-]+|recall --budget-ms)/.test(readFileSync(f, "utf8"));
    } catch {
      return false;
    }
  });
}

/** Copy the whole data folder to `out`; the database through a consistent hot copy (backupStore), never a raw file copy. */
async function finalBackup(dir: string, out: string): Promise<void> {
  const db = join(dir, "state.db");
  if (existsSync(db)) {
    const { Store } = await import("./store.js");
    const { backupStore } = await import("./backup.js");
    const s = new Store(db);
    try {
      backupStore(s, db, out, { includeApprovalKey: true, includeAttestKey: true });
    } finally {
      s.close();
    }
  }
  // Everything else (tokens, spaces.json, spool, pre-upgrade copies...), without overwriting what backupStore wrote.
  cpSync(dir, out, { recursive: true, force: false, errorOnExist: false, filter: (src) => !/[\\/]state\.db(-wal|-shm|-journal)?$/.test(src) });
}

export async function runUninstall(e: SetupEnv, io: SetupIO, opts: UninstallOptions): Promise<number> {
  const all = readHistory(e);
  const sessions = all.filter((s) => !s.undone).reverse(); // newest first: each one's backup is the state the older one left
  const recorded = new Set(sessions.flatMap((s) => s.changes.map((c) => resolve(c.file))));
  const dir = dataHome(e);
  const backupDir = join(e.home, `onememory-final-backup-${stamp(e.now())}`);
  const configBackups = opts.purge ? sessions.flatMap((s) => s.changes.flatMap((c) => (c.backup ? [c.backup] : []))) : [];

  io.out("OneMemory uninstall\n");
  io.out("What I will do:");
  let n = 1;
  for (const s of sessions) for (const c of [...s.changes].reverse()) io.out(`  ${n++}. ${c.label}: ${c.file}: ${describe(c)}`);
  if (!sessions.length) io.out("  (setup has not changed any app's configuration on this computer, or it was already undone)");
  if (opts.purge) {
    if (existsSync(dir)) {
      if (!opts.noBackup) io.out(`  ${n++}. Make a final backup of ${dir} at ${backupDir}`);
      io.out(`  ${n++}. DELETE the data folder ${dir} (${(dirBytes(dir) / 1e6).toFixed(1)} MB): every note, key and token in it${opts.noBackup ? ", with NO backup (--no-backup)" : ""}`);
    } else io.out(`  (no data folder at ${dir}; nothing to delete)`);
    for (const b of configBackups) io.out(`  ${n++}. Delete setup's copy ${b}`);
  } else io.out(`  Your notes in ${dir} are kept (add --purge to delete them too).`);
  const pinned = e.env.ONEMEMORY_DB_PATH?.trim();
  if (opts.purge && pinned && relative(dir, resolve(pinned)).startsWith("..")) io.out(`  (ONEMEMORY_DB_PATH points at ${pinned}, outside the data folder: it is NOT deleted)`);
  const left = leftovers(e, recorded);
  for (const f of left) io.out(`  (left alone) ${f} mentions OneMemory, but setup did not add it; take it out by hand if you want`);
  io.out("");

  const nothing = sessions.length === 0 && !(opts.purge && (existsSync(dir) || configBackups.length));
  if (nothing) {
    io.out("Nothing to remove.");
    return 0;
  }
  if (opts.dryRun) {
    io.out("Dry run: nothing was changed.");
    return 0;
  }
  if (!opts.yes) {
    if (!io.interactive) {
      io.err("This is not an interactive terminal, so I cannot ask. Re-run with --yes to go ahead, or --dry-run to only look.");
      return 1;
    }
    const a = (await io.ask("Go ahead? Type y to continue, anything else cancels: ")).trim().toLowerCase();
    if (a !== "y" && a !== "yes") {
      io.out("Cancelled. Nothing was changed.");
      return 0;
    }
  }

  io.out("Removed:");
  let failed = 0;
  for (const s of sessions) {
    const f = undoSession(e, io, s);
    failed += f;
    if (f === 0) s.undone = true;
  }
  if (sessions.length) saveHistory(e, all);
  if (failed) {
    io.err(`\n${failed} file(s) could not be put back (see above), so I stopped${opts.purge ? " and did NOT delete your data" : ""}. Fix that, then run uninstall again.`);
    return 1;
  }
  if (opts.purge) {
    if (existsSync(dir)) {
      if (!opts.noBackup) {
        try {
          await finalBackup(dir, backupDir);
        } catch (err) {
          io.err(`  The final backup failed (${(err as Error).message}), so your data was NOT deleted.`);
          return 1;
        }
        io.out(`  final backup made: ${backupDir}`);
      }
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
      } catch (err) {
        io.err(`  Could not delete ${dir} (${(err as Error).message}). Close every app using OneMemory and run uninstall --purge again.`);
        return 1;
      }
      io.out(`  deleted the data folder ${dir}`);
    }
    for (const b of configBackups) {
      try {
        unlinkSync(b);
        io.out(`  deleted ${b}`);
      } catch {
        /* already gone */
      }
    }
  }
  io.out("\nDone. Restart the apps that had OneMemory so they forget it.");
  return 0;
}
