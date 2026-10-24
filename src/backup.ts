// `onememory backup`: a consistent hot copy of the store.
//
// VACUUM INTO writes a complete, defragmented database file from one read
// snapshot, so it is safe while the server is running and writing (no
// -wal/-shm juggling, no torn copy). If at-rest encryption is on, the
// notes' bodies are ciphertext and the key file (.key) is what opens them:
// we copy it too, with mode 0600, and say loudly that it must be stored
// SEPARATELY from the backup -- a backup and its key in one place defeats the
// encryption, and a backup without its key is unreadable.
import { chmodSync, copyFileSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Store } from "./store.js";
import { keyPath } from "./crypto.js";

export interface BackupResult {
  dir: string;
  db: string;
  bytes: number;
  notes: number;
  key: string | null;
  /** True when the command-task approval key was copied into the backup (--include-approval-key). */
  approvalKey: boolean;
}

export function backupStore(
  store: Store,
  dbPath: string,
  outDir: string,
  opts: { includeApprovalKey?: boolean } = {}
): BackupResult {
  const dir = resolve(outDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const db = join(dir, "state.db");
  if (existsSync(db)) throw new Error(`${db} already exists; choose another --out directory (backups never overwrite)`);
  store.backupTo(db);
  try {
    chmodSync(db, 0o600);
  } catch {
    /* windows */
  }
  // The command-task approval key lets its holder mint approvals the runner
  // honours. A backup must not carry it unless asked: restored without it,
  // existing approvals fail their check ("stale") -- fail closed -- and the
  // admin simply re-approves.
  if (!opts.includeApprovalKey) {
    const strip = new DatabaseSync(db);
    try {
      strip.prepare("DELETE FROM _meta WHERE key = 'approval_key'").run();
      strip.exec("VACUUM");
    } finally {
      strip.close();
    }
  }
  // Prove the copy opens and is internally consistent before reporting success.
  const copy = new DatabaseSync(db, { readOnly: true });
  let notes = 0;
  try {
    const ic = copy.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
    if (ic.integrity_check !== "ok") throw new Error(`backup failed its integrity check: ${ic.integrity_check}`);
    notes = Number((copy.prepare("SELECT COUNT(*) AS c FROM notes").get() as { c: number }).c);
  } finally {
    copy.close();
  }
  let key: string | null = null;
  const kp = keyPath(dirname(dbPath));
  if (existsSync(kp)) {
    key = join(dir, ".key");
    copyFileSync(kp, key);
    try {
      chmodSync(key, 0o600);
    } catch {
      /* windows */
    }
  }
  writeFileSync(
    join(dir, "README.txt"),
    [
      "OneMemory backup",
      `made: ${new Date().toISOString()}`,
      "",
      "state.db  a complete copy of the database (restore: stop the server, put it at <data dir>/state.db,",
      "          delete any state.db-wal / state.db-shm beside it, start the server).",
      key
        ? ".key      the at-rest encryption key. Without it the encrypted note bodies are unreadable; WITH it next to\n" +
          "          the database, anyone who gets this folder can read everything. Move it somewhere else (a password\n" +
          "          manager, a separate drive) and keep a second copy."
        : "(no .key: at-rest encryption was off)",
      opts.includeApprovalKey
        ? "approval key INCLUDED (--include-approval-key): whoever holds this folder AND can write to a live store can mint\ncommand-task approvals. Guard it like the .key."
        : "approval key NOT included: command-task approvals in a restored copy read as stale (fail closed); an admin\nre-approves the tasks that are still queued.",
      "",
    ].join("\n"),
    { mode: 0o600 }
  );
  return { dir, db, bytes: statSync(db).size, notes, key, approvalKey: Boolean(opts.includeApprovalKey) };
}
