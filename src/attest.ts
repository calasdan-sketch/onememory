// Signed writer attestations (1.4.0).
//
// Each database has one Ed25519 key pair. The private key lives in a file
// beside the at-rest key (`.attest-key`, mode 0600) and is NEVER exported,
// backed up or sent anywhere; the public key and its key id go in the header
// of every export. An export signs, for every note, a detached attestation
// over the exporting server's own record of it:
//
//   v1: { server_id, note id, namespace, content hash, written_by, created_by,
//         updated_at, attested_writer, attested_by, merged_from_writers }
//   v2: v1 plus created_at, source, expires_at, archived_at, rev and the
//       export time (`exported_at`, which `not_after` rotation compares against).
// Exports sign v2; the verifier accepts both versions.
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

/** The version a new export signs. The verifier accepts every version in SUPPORTED_VERSIONS. */
export const ATTEST_VERSION = 2;
export const SUPPORTED_VERSIONS: readonly number[] = [1, 2];
export const ATTEST_KEY_FILENAME = ".attest-key";
const DOMAIN_V1 = "onememory-attest-v1";
const DOMAIN_V2 = "onememory-attest-v2";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
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
  /** v2: when the exporting server signed this record (ISO-8601, inside the signed bytes). */
  exported_at?: string;
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
  /** v2 only (signed there; ignored for v1). */
  created_at?: string;
  source?: string;
  expires_at?: string | null;
  archived_at?: string | null;
  rev?: number;
}

/** sha256 of the canonical form of a note's content: title, body and the sorted, de-duplicated tags. */
export function contentHash(title: string, body: string, tags: readonly string[]): string {
  const t = [...new Set(tags.map((x) => String(x).trim()).filter(Boolean))].sort();
  return createHash("sha256").update(JSON.stringify([CONTENT_DOMAIN, title, body, t])).digest("hex");
}

/** Builders of the exact bytes each attestation version signs (add a version here, not a new code path). */
const SIGNED_BYTES: Record<number, (serverId: string, r: AttestedRecord, hash: string, exportedAt: string) => Buffer> = {
  1: (serverId, r, hash) =>
    Buffer.from(
      JSON.stringify([
        DOMAIN_V1,
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
    ),
  2: (serverId, r, hash, exportedAt) =>
    Buffer.from(
      JSON.stringify([
        DOMAIN_V2,
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
        r.created_at ?? "",
        r.source ?? "",
        r.expires_at ?? "",
        r.archived_at ?? "",
        Number.isFinite(r.rev) ? r.rev : 0,
        exportedAt,
      ])
    ),
};

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

/** The key if the file already exists and is readable; never creates one, never throws. */
export function peekSigningKey(dataDir: string): SigningKey | null {
  const p = attestKeyPath(dataDir);
  try {
    return existsSync(p) ? fromPrivate(createPrivateKey(readFileSync(p))) : null;
  } catch {
    return null;
  }
}

/** Tighten the key file to 0600 if it exists (a sync tool or restore may have left it wider). Best effort. */
export function tightenKeyFile(dataDir: string): void {
  try {
    const p = attestKeyPath(dataDir);
    if (existsSync(p)) chmodSync(p, 0o600);
  } catch {
    /* windows / read-only */
  }
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
  try {
    mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
  } catch (e) {
    const where = process.env.ONEMEMORY_ATTEST_KEY_FILE ? `ONEMEMORY_ATTEST_KEY_FILE=${p}` : p;
    throw new Error(`cannot create the attestation key location for ${where}: ${(e as Error).message}`);
  }
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

/** Attest one note as `serverId` (always the current version). `exportedAt` is signed too. */
export function signRecord(key: SigningKey, serverId: string, r: AttestedRecord, exportedAt: string = new Date().toISOString()): Attestation {
  const hash = contentHash(r.title, r.body, r.tags);
  const sig = sign(null, SIGNED_BYTES[ATTEST_VERSION](serverId, r, hash, exportedAt), key.privateKey).toString("base64url");
  return { v: ATTEST_VERSION, server_id: serverId, key_id: key.keyId, content_hash: hash, sig, exported_at: exportedAt };
}

/** One public key the importer trusts. */
export interface TrustedAttester {
  public_key: string;
  /** Pin: only attestations naming this server id verify under the key. Empty = any server id except this database's own. */
  server_id: string;
  label: string;
  /** Planned rotation: exports signed after this time (by the signed `exported_at`) are not believed. ISO-8601 or empty. */
  not_after?: string;
}

export type VerifyReason =
  | "no attestation"
  | "malformed attestation"
  | "attester key not trusted"
  | "server id does not match the trusted key"
  | "attester key expired"
  | "signature does not match the note";

export type VerifyResult = { ok: true; attester: Attestation; label: string } | { ok: false; reason: VerifyReason; key_id?: string; server_id?: string };

/** Parsed public keys, cached by their base64url text: building a KeyObject costs more than the verify itself. */
const PUBLIC_KEY_CACHE = new Map<string, KeyObject>();
function publicKeyObject(pub: string): KeyObject {
  let k = PUBLIC_KEY_CACHE.get(pub);
  if (!k) {
    k = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: pub }, format: "jwk" });
    if (PUBLIC_KEY_CACHE.size >= 64) PUBLIC_KEY_CACHE.delete(PUBLIC_KEY_CACHE.keys().next().value as string);
    PUBLIC_KEY_CACHE.set(pub, k);
  }
  return k;
}

/** Is `t` an ISO-8601 time that Date can read? */
function isIso(t: unknown): t is string {
  return typeof t === "string" && t.length >= 10 && t.length <= 40 && !Number.isNaN(Date.parse(t));
}

/**
 * Check a note's attestation against the trusted keys (`trusted` is keyed by
 * key id). `own` is this database's own key, trusted for its own server id
 * only; it may be null (no key on disk yet: nothing of ours can be verified)
 * or a function evaluated at most once when an attestation names a key.
 */
export function verifyRecord(
  a: unknown,
  r: AttestedRecord,
  trusted: ReadonlyMap<string, TrustedAttester>,
  own: { keyId: string; publicKey: string; serverId: string } | null | (() => { keyId: string; publicKey: string; serverId: string } | null)
): VerifyResult {
  if (a === undefined || a === null) return { ok: false, reason: "no attestation" };
  const x = a as Partial<Attestation>;
  if (
    typeof a !== "object" ||
    typeof x.v !== "number" ||
    !SUPPORTED_VERSIONS.includes(x.v) ||
    typeof x.server_id !== "string" ||
    !UUID_RE.test(x.server_id) ||
    typeof x.key_id !== "string" ||
    !/^[0-9a-f]{16}$/.test(x.key_id) ||
    typeof x.sig !== "string" ||
    typeof x.content_hash !== "string" ||
    (x.v >= 2 && !isIso(x.exported_at))
  ) {
    return { ok: false, reason: "malformed attestation" };
  }
  const att = x as Attestation;
  const ownKey = typeof own === "function" ? own() : own;
  let pub: string | undefined;
  let label = "";
  if (ownKey && att.key_id === ownKey.keyId) {
    // Our own key speaks only for our own server id (a restore of our own export).
    if (att.server_id !== ownKey.serverId) return { ok: false, reason: "server id does not match the trusted key", key_id: att.key_id, server_id: att.server_id };
    pub = ownKey.publicKey;
    label = "this server";
  } else {
    const t = trusted.get(att.key_id);
    if (!t) return { ok: false, reason: "attester key not trusted", key_id: att.key_id, server_id: att.server_id };
    // A pinned key speaks for its one server. An UNPINNED entry (explicit any-server) may name any server except this one.
    if (t.server_id ? t.server_id !== att.server_id : ownKey !== null && att.server_id === ownKey.serverId) {
      return { ok: false, reason: "server id does not match the trusted key", key_id: att.key_id, server_id: att.server_id };
    }
    if (t.not_after) {
      // Rotation: only a v2 attestation carries a signed export time to compare; an older one under an expiring key is refused.
      const cutoff = Date.parse(t.not_after);
      if (att.v < 2 || !att.exported_at || (!Number.isNaN(cutoff) && Date.parse(att.exported_at) > cutoff)) {
        return { ok: false, reason: "attester key expired", key_id: att.key_id, server_id: att.server_id };
      }
    }
    pub = t.public_key;
    label = t.label;
  }
  const recomputed = contentHash(r.title, r.body, r.tags);
  try {
    const key = publicKeyObject(pub);
    const bytes = SIGNED_BYTES[att.v](att.server_id, r, recomputed, att.exported_at ?? "");
    const ok = recomputed === att.content_hash && verify(null, bytes, key, Buffer.from(att.sig, "base64url"));
    return ok ? { ok: true, attester: att, label } : { ok: false, reason: "signature does not match the note", key_id: att.key_id, server_id: att.server_id };
  } catch {
    return { ok: false, reason: "signature does not match the note", key_id: att.key_id, server_id: att.server_id };
  }
}

/** Is `s` a plausible raw Ed25519 public key (32 bytes, base64url)? */
export function isPublicKey(s: unknown): s is string {
  return typeof s === "string" && /^[A-Za-z0-9_-]{43}$/.test(s);
}

/** Is `s` a lower- or upper-case UUID (a server id)? */
export function isServerId(s: unknown): s is string {
  return typeof s === "string" && UUID_RE.test(s.toLowerCase());
}

/** What parseTrustedAttestersEnv could not use, for a loud startup warning. */
export interface EnvAttesterIssue {
  entry: string;
  problem: string;
}

/**
 * ONEMEMORY_TRUSTED_ATTESTERS. Two forms:
 *   `<server id>=<public key>` entries separated by commas, whitespace or
 *       semicolons (keys are the base64url key printed by `onememory trust identity`);
 *   a JSON array `[{"public_key":"...","server_id":"...","label":"...","not_after":"..."}]`.
 * Every entry must name the server id it speaks for; a bare key (no server
 * id) is refused, because such a key could claim to be any peer. Entries
 * that cannot be used are returned in `issues`, never silently dropped.
 */
export function parseTrustedAttestersEnvDetailed(raw: string | undefined): { attesters: TrustedAttester[]; issues: EnvAttesterIssue[] } {
  const attesters: TrustedAttester[] = [];
  const issues: EnvAttesterIssue[] = [];
  const text = (raw ?? "").trim();
  if (!text) return { attesters, issues };
  const accept = (entry: string, key: unknown, sid: unknown, label: unknown, notAfter: unknown): void => {
    const k = typeof key === "string" ? key.trim() : "";
    const sidS = typeof sid === "string" ? sid.trim().toLowerCase() : "";
    if (!isPublicKey(k)) return void issues.push({ entry, problem: "not a 43-character base64url public key" });
    if (!sidS) return void issues.push({ entry, problem: "no server id: write <server id>=<public key> (a key without a pin could claim to be any server)" });
    if (!isServerId(sidS)) return void issues.push({ entry, problem: "the server id is not a UUID" });
    if (notAfter !== undefined && notAfter !== "" && !isIso(notAfter)) return void issues.push({ entry, problem: "not_after is not an ISO-8601 time" });
    attesters.push({
      public_key: k,
      server_id: sidS,
      label: typeof label === "string" && label ? label.slice(0, 100) : "env",
      ...(typeof notAfter === "string" && notAfter ? { not_after: notAfter } : {}),
    });
  };
  if (text.startsWith("[") || text.startsWith("{")) {
    try {
      const v = JSON.parse(text) as unknown;
      const list = Array.isArray(v) ? v : [v];
      for (const e of list) {
        const o = (e && typeof e === "object" ? e : {}) as Record<string, unknown>;
        accept(typeof o.public_key === "string" ? o.public_key.slice(0, 12) + "..." : "(entry)", o.public_key, o.server_id, o.label, o.not_after);
      }
    } catch {
      issues.push({ entry: text.slice(0, 20), problem: "looks like JSON but does not parse" });
    }
    return { attesters, issues };
  }
  for (const part of text.split(/[\s,;]+/)) {
    if (!part) continue;
    const eq = part.indexOf("=");
    accept(part.slice(0, 60), eq >= 0 ? part.slice(eq + 1) : part, eq >= 0 ? part.slice(0, eq) : "", "env", undefined);
  }
  return { attesters, issues };
}

/** The usable entries of ONEMEMORY_TRUSTED_ATTESTERS (see parseTrustedAttestersEnvDetailed). */
export function parseTrustedAttestersEnv(raw: string | undefined): TrustedAttester[] {
  return parseTrustedAttestersEnvDetailed(raw).attesters;
}
