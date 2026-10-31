// At-rest encryption for note bodies (AES-256-GCM).
//
// WHY THIS SHAPE. OneMemory's keyword search is SQLite FTS5 over an
// external-content index of `notes(title, body, tags)`, maintained by SQL
// triggers. You cannot encrypt the `body` column in place: the trigger would
// happily index the ciphertext, and every search would silently match
// base64 noise. So ciphertext lives in a SEPARATE column (`body_enc`) and
// `body` is left empty for encrypted notes -- FTS then indexes title+tags
// only, which is the honest tradeoff of at-rest encryption with a plaintext
// index. Reads decrypt at the single row->record boundary, so every consumer
// (REST, MCP, dashboard, export) sees plaintext without knowing.
//
// WHAT IS AND IS NOT PROTECTED. Bodies (the sensitive part: pasted secrets,
// private context) are encrypted. Titles, tags and timestamps stay plaintext
// because search and namespace isolation both need them. That residual leak
// is real and documented, not hidden -- see the README "Encryption at rest"
// section. For full-file protection use OS disk encryption too.
//
// DEPENDENCY-FREE on purpose: node:crypto only, same as the rest of the
// project. The key is a 32-byte random file beside the database, mode 0600.

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { renameSync } from "node:fs";
import { join } from "node:path";

/**
 * Envelope version prefixes.
 *
 * v1: `v1:<iv>:<tag>:<ct>`  -- no associated data (1.2.0 and earlier). Still
 *     READ forever so existing databases keep working.
 * v2: `v2:<iv>:<tag>:<ct>`  -- GCM additional authenticated data (AAD) binds
 *     the ciphertext to the row it belongs to (`<id>|<namespace>` for notes),
 *     so a body_enc copied into another note/namespace fails to decrypt
 *     instead of silently reading as that note's body.
 * New writes made with an AAD are v2; calls without an AAD still emit v1.
 */
export const ENC_PREFIX = "v1:";
export const ENC_PREFIX_V2 = "v2:";
const ALGO = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12; // GCM standard nonce length
const TAG_BYTES = 16;

/** The AAD that binds a note's ciphertext to its row. */
export function noteAad(id: number, namespace: string): string {
  return `${id}|${namespace}`;
}

/** The AAD that binds a sealed capture event output or input (capture.ts) to its row; the two never open each other. */
export function captureAad(seq: number, sessionId: string, field: "output" | "input" = "output"): string {
  return `${field === "input" ? "capture-input" : "capture"}|${seq}|${sessionId}`;
}

/** Default key location: beside the database, in the data dir. */
export const KEY_FILENAME = ".key";

/** Resolved key path, honoring ONEMEMORY_KEY_FILE for tests / custom layouts. */
export function keyPath(dataDir: string): string {
  return process.env.ONEMEMORY_KEY_FILE || join(dataDir, KEY_FILENAME);
}

/**
 * Whether at-rest encryption is active.
 *
 * Opt-in by PRESENCE of a key file, not by an env flag: the key file is the
 * source of truth. A stale ONEMEMORY_ENCRYPT=1 with no key would produce
 * unreadable notes, so we never infer "on" from an environment variable
 * alone. `onememory encrypt enable` creates the key; `disable` removes it.
 */
export function encryptionEnabled(dataDir: string): boolean {
  if (process.env.ONEMEMORY_ENCRYPT === "0") return false; // hard off (tests)
  try {
    return existsSync(keyPath(dataDir));
  } catch {
    return false;
  }
}

/**
 * Load the 32-byte key, or null when no key file exists.
 *
 * Returns null rather than throwing so read paths can degrade to plaintext
 * cleanly when encryption is off. A key file that exists but is the wrong
 * size IS an error (corrupt/partial write) -- silently ignoring it would
 * write new notes with no key while old ones stay encrypted.
 */
export function loadKey(dataDir: string): Buffer | null {
  const p = keyPath(dataDir);
  if (!existsSync(p)) return null;
  try {
    if (statSync(p).isDirectory()) {
      throw new Error(
        `onememory: the encryption key path ${p} is a directory, not a file. ` +
          `Point ONEMEMORY_KEY_FILE at a file (or unset it to use <data dir>/${KEY_FILENAME}).`
      );
    }
  } catch (e) {
    if ((e as Error).message.startsWith("onememory:")) throw e;
  }
  const raw = readFileSync(p);
  if (raw.length !== KEY_BYTES) {
    throw new Error(
      `onememory: encryption key at ${p} is ${raw.length} bytes, expected ${KEY_BYTES}. ` +
        `Restore it from a backup, or run \`onememory encrypt disable --wipe\` to start over ` +
        `(existing encrypted notes become unreadable).`
    );
  }
  return raw;
}

/**
 * Create the key file if absent and return the key. Owner-only (0600),
 * written via a temp file + rename so a crash can't leave a truncated key
 * that would silently fail to decrypt existing notes.
 */
export function ensureKey(dataDir: string): Buffer {
  const existing = loadKey(dataDir);
  if (existing) return existing;
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const key = randomBytes(KEY_BYTES);
  const p = keyPath(dataDir);
  const tmp = `${p}.tmp-${process.pid}`;
  writeFileSync(tmp, key, { mode: 0o600 });
  try {
    chmodSync(tmp, 0o600); // no-op-ish on win32, best effort elsewhere
  } catch {
    /* best effort */
  }
  // renameSync is atomic within a directory: a reader sees either no key or
  // a complete one, never a half-written file that would fail to decrypt
  // every existing note the next time the server starts.
  renameSync(tmp, p);
  try {
    chmodSync(p, 0o600);
  } catch {
    /* best effort */
  }
  return key;
}

/** True when `s` is an encryption envelope we produced. */
export function isEncrypted(s: string | null | undefined): boolean {
  return typeof s === "string" && (s.startsWith(ENC_PREFIX) || s.startsWith(ENC_PREFIX_V2));
}

/**
 * Encrypt `plaintext` -> `v1:<iv>:<tag>:<ciphertext>` (all base64).
 *
 * Each call draws a fresh 12-byte IV, so the same note written twice yields
 * different ciphertext (no deterministic leak). The auth tag binds the
 * ciphertext, so tampering in the DB fails loudly on decrypt instead of
 * returning garbage to an agent.
 */
export function encrypt(plaintext: string, key: Buffer, aad?: string): string {
  assertKey(key);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  if (aad !== undefined) cipher.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${aad !== undefined ? ENC_PREFIX_V2 : ENC_PREFIX}${iv.toString("base64")}:${tag.toString("base64")}:${ct.toString("base64")}`;
}

/**
 * Decrypt an envelope back to plaintext.
 *
 * Throws on a wrong key or a tampered ciphertext (GCM authentication
 * failure) -- that is deliberate: handing an agent corrupted memory is worse
 * than erroring, and it is the signal that the key file was swapped out.
 */
export function decrypt(envelope: string, key: Buffer, aad?: string): string {
  assertKey(key);
  if (!isEncrypted(envelope)) {
    throw new Error("onememory: not an encrypted value (missing v1:/v2: prefix)");
  }
  const v2 = envelope.startsWith(ENC_PREFIX_V2);
  if (v2 && aad === undefined) {
    throw new Error("onememory: v2 envelope needs its row binding (id|namespace) to decrypt");
  }
  const parts = envelope.slice(ENC_PREFIX.length).split(":");
  if (parts.length !== 3) {
    throw new Error("onememory: malformed encryption envelope (expected iv:tag:ciphertext)");
  }
  const [ivB64, tagB64, ctB64] = parts;
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const ct = Buffer.from(ctB64, "base64");
  if (iv.length !== IV_BYTES) throw new Error("onememory: malformed IV in encryption envelope");
  if (tag.length !== TAG_BYTES) {
    throw new Error("onememory: malformed auth tag in encryption envelope");
  }
  const decipher = createDecipheriv(ALGO, key, iv);
  if (v2) decipher.setAAD(Buffer.from(aad as string, "utf8"));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

function assertKey(key: Buffer): void {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) {
    throw new Error(`onememory: encryption key must be ${KEY_BYTES} bytes`);
  }
}

/**
 * Best-effort decrypt for read paths: returns the plaintext, or the original
 * string when it is not an envelope (a plaintext note in a partially
 * migrated store). NEVER swallows a real authentication failure -- a wrong
 * key must surface, not silently return ciphertext to the caller.
 */
export function decryptIfEncrypted(value: string, key: Buffer | null, aad?: string): string {
  if (!isEncrypted(value)) return value;
  if (!key) {
    throw new Error(
      "onememory: this note is encrypted but no key file is present. " +
        "Restore the key, or the note body cannot be read."
    );
  }
  return decrypt(value, key, aad);
}
