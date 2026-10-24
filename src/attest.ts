// Signed writer attestations (1.4.0).
//
// Each database has one Ed25519 key pair. The private key lives in a file
// beside the at-rest key (`.attest-key`, mode 0600) and is NEVER exported,
// backed up or sent anywhere; the public key and its key id go in the header
// of every export. An export signs, for every note, a detached attestation
// over the exporting server's own record of it:
//
//   { server_id, note id, namespace, content hash, written_by, created_by,
//     updated_at, attested_writer, attested_by, merged_from_writers }
//
// An import checks each attestation against a list of public keys the
// importing admin chose to trust. This proves ONE thing: a key the importer
// trusts signed exactly this record, so the content, the namespace and the
// writer labels were not altered after export. It does NOT prove the content is
// true or safe, or that the exporting server's operators labelled honestly, and
// it says nothing about a key nobody added to the trust list. See docs/trust.md.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";
import { chmodSync, existsSync, linkSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const ATTEST_VERSION = 1;
export const ATTEST_KEY_FILENAME = ".attest-key";
const DOMAIN = "onememory-attest-v1";
const CONTENT_DOMAIN = "onememory-content-v1";

/** The detached attestation carried in an export, beside each note. */
export interface Attestation {
  v: number;
  /** The exporting database's server_id (also inside the signed bytes). */
  server_id: string;
  /** First 16 hex digits of SHA-256 over the raw public key. */
  key_id: string;
  /** sha256 over the canonical title + body + tags, as the exporter held them. */
  content_hash: string;
  /** Ed25519 signature, base64url. */
  sig: string;
}

/** The fields the signature covers, read from the note exactly as exported. */
export interface AttestedRecord {
  id: number;
  namespace: string;
  title: string;
  body: string;
  tags: readonly string[];
  written_by: string;
  created_by: string;
  updated_at: string;
  attested_writer?: string;
  attested_by?: string;
  merged_from_writers?: readonly string[];
}

/** sha256 of the canonical form of a note's content: title, body and the sorted, de-duplicated tags. */
export function contentHash(title: string, body: string, tags: readonly string[]): string {
  const t = [...new Set(tags.map((x) => String(x).trim()).filter(Boolean))].sort();
  return createHash("sha256").update(JSON.stringify([CONTENT_DOMAIN, title, body, t])).digest("hex");
}

function signedBytes(serverId: string, r: AttestedRecord, hash: string): Buffer {
  return Buffer.from(
    JSON.stringify([
      DOMAIN,
      serverId,
      r.id,
      r.namespace,
      hash,
      r.written_by ?? "",
      r.created_by ?? "",
      r.updated_at,
      r.attested_writer ?? "",
      r.attested_by ?? "",
      [...(r.merged_from_writers ?? [])].sort(),
    ])
  );
}

export interface SigningKey {
  privateKey: KeyObject;
  /** Raw 32-byte public key, base64url (what the trust list stores). */
  publicKey: string;
  keyId: string;
}

/** Key id of a raw public key (base64url). */
export function keyIdOf(publicKey: string): string {
  return createHash("sha256").update(Buffer.from(publicKey, "base64url")).digest("hex").slice(0, 16);
}

function publicFromPrivate(privateKey: KeyObject): string {
  const jwk = createPublicKey(privateKey).export({ format: "jwk" }) as { x?: string };
  if (!jwk.x) throw new Error("could not derive the public key");
  return jwk.x;
}

function fromPrivate(privateKey: KeyObject): SigningKey {
  const publicKey = publicFromPrivate(privateKey);
  return { privateKey, publicKey, keyId: keyIdOf(publicKey) };
}

/** Where the signing key lives for a data directory (ONEMEMORY_ATTEST_KEY_FILE overrides). */
export function attestKeyPath(dataDir: string): string {
  return process.env.ONEMEMORY_ATTEST_KEY_FILE || join(dataDir, ATTEST_KEY_FILENAME);
}

/** A key pair that lives only in memory (an in-memory database has nowhere to keep one). */
export function ephemeralKey(): SigningKey {
  return fromPrivate(generateKeyPairSync("ed25519").privateKey);
}

/**
 * Load this data directory's signing key, creating it on first use. The file is
 * written atomically (temp file, then a rename that never replaces an existing
 * key) with mode 0600; a corrupt file throws rather than being replaced, so a
 * damaged key can never silently turn into a new identity.
 */
export function loadOrCreateSigningKey(dataDir: string): SigningKey {
  const p = attestKeyPath(dataDir);
  if (existsSync(p)) {
    try {
      return fromPrivate(createPrivateKey(readFileSync(p)));
    } catch (e) {
      throw new Error(`the attestation key ${p} is unreadable (${(e as Error).message}); restore it or move it aside to create a new one`);
    }
  }
  mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
  const { privateKey } = generateKeyPairSync("ed25519");
  const pem = privateKey.export({ format: "pem", type: "pkcs8" });
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, pem, { mode: 0o600, flag: "wx" });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    /* windows */
  }
  try {
    // No-clobber publish: a hard link fails if another process created the key first, and then theirs wins.
    try {
      linkSync(tmp, p);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") return fromPrivate(createPrivateKey(readFileSync(p)));
      if (existsSync(p)) return fromPrivate(createPrivateKey(readFileSync(p)));
      renameSync(tmp, p); // a file system without hard links
    }
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      /* already renamed or removed */
    }
  }
  try {
    chmodSync(p, 0o600);
  } catch {
    /* windows */
  }
  return fromPrivate(privateKey);
}

/** Attest one note as `serverId`. */
export function signRecord(key: SigningKey, serverId: string, r: AttestedRecord): Attestation {
  const hash = contentHash(r.title, r.body, r.tags);
  const sig = sign(null, signedBytes(serverId, r, hash), key.privateKey).toString("base64url");
  return { v: ATTEST_VERSION, server_id: serverId, key_id: key.keyId, content_hash: hash, sig };
}

/** One public key the importer trusts. */
export interface TrustedAttester {
  public_key: string;
  /** Pin: only attestations naming this server id verify under the key. Empty = any server id except this database's own. */
  server_id: string;
  label: string;
}

export type VerifyReason =
  | "no attestation"
  | "malformed attestation"
  | "attester key not trusted"
  | "server id does not match the trusted key"
  | "signature does not match the note";

export type VerifyResult = { ok: true; attester: Attestation; label: string } | { ok: false; reason: VerifyReason; key_id?: string; server_id?: string };

/**
 * Check a note's attestation against the trusted keys (`trusted` is keyed by
 * key id). `own` is this database's own key, trusted for its own server id only.
 */
export function verifyRecord(
  a: unknown,
  r: AttestedRecord,
  trusted: ReadonlyMap<string, TrustedAttester>,
  own: { keyId: string; publicKey: string; serverId: string } | null
): VerifyResult {
  if (a === undefined || a === null) return { ok: false, reason: "no attestation" };
  const x = a as Partial<Attestation>;
  if (
    typeof a !== "object" ||
    x.v !== ATTEST_VERSION ||
    typeof x.server_id !== "string" ||
    !x.server_id ||
    typeof x.key_id !== "string" ||
    !/^[0-9a-f]{16}$/.test(x.key_id) ||
    typeof x.sig !== "string" ||
    typeof x.content_hash !== "string"
  ) {
    return { ok: false, reason: "malformed attestation" };
  }
  const att = x as Attestation;
  let pub: string | undefined;
  let label = "";
  if (own && att.key_id === own.keyId) {
    // Our own key speaks only for our own server id (a restore of our own export).
    if (att.server_id !== own.serverId) return { ok: false, reason: "server id does not match the trusted key", key_id: att.key_id, server_id: att.server_id };
    pub = own.publicKey;
    label = "this server";
  } else {
    const t = trusted.get(att.key_id);
    if (!t) return { ok: false, reason: "attester key not trusted", key_id: att.key_id, server_id: att.server_id };
    if (t.server_id ? t.server_id !== att.server_id : own !== null && att.server_id === own.serverId) {
      return { ok: false, reason: "server id does not match the trusted key", key_id: att.key_id, server_id: att.server_id };
    }
    pub = t.public_key;
    label = t.label;
  }
  const recomputed = contentHash(r.title, r.body, r.tags);
  try {
    const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: pub }, format: "jwk" });
    const ok =
      recomputed === att.content_hash && verify(null, signedBytes(att.server_id, r, recomputed), key, Buffer.from(att.sig, "base64url"));
    return ok ? { ok: true, attester: att, label } : { ok: false, reason: "signature does not match the note", key_id: att.key_id, server_id: att.server_id };
  } catch {
    return { ok: false, reason: "signature does not match the note", key_id: att.key_id, server_id: att.server_id };
  }
}

/** Is `s` a plausible raw Ed25519 public key (32 bytes, base64url)? */
export function isPublicKey(s: unknown): s is string {
  return typeof s === "string" && /^[A-Za-z0-9_-]{43}$/.test(s);
}

/**
 * ONEMEMORY_TRUSTED_ATTESTERS: entries separated by commas, whitespace or
 * semicolons, each `<public key>` or `<server id>=<public key>` (keys are the
 * base64url public key printed by `onememory trust identity`). Malformed
 * entries are skipped.
 */
export function parseTrustedAttestersEnv(raw: string | undefined): TrustedAttester[] {
  const out: TrustedAttester[] = [];
  for (const part of (raw ?? "").split(/[\s,;]+/)) {
    if (!part) continue;
    const eq = part.indexOf("=");
    const sid = eq >= 0 ? part.slice(0, eq).trim().toLowerCase() : "";
    const key = (eq >= 0 ? part.slice(eq + 1) : part).trim();
    if (!isPublicKey(key)) continue;
    if (sid && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(sid)) continue;
    out.push({ public_key: key, server_id: sid, label: "env" });
  }
  return out;
}
