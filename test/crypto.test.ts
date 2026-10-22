// At-rest encryption: AES-256-GCM envelope round-trip, key management, and
// the store integration (body sealed to body_enc, FTS index left plaintext,
// decryption at the read chokepoint).
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { Store } from "../src/store.js";
import {
  encrypt,
  decrypt,
  decryptIfEncrypted,
  isEncrypted,
  ensureKey,
  loadKey,
  keyPath,
  encryptionEnabled,
  ENC_PREFIX,
} from "../src/crypto.js";

const DAY_MS = 86_400_000;

describe("crypto: envelope round-trip", () => {
  let dir: string;
  let key: Buffer;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "om-crypto-"));
    key = ensureKey(dir);
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  test("round-trips unicode and empty strings", () => {
    for (const s of ["", "hello", "héllo wörld — 日本語 🚀", "line1\nline2\ttabbed"]) {
      assert.equal(decrypt(encrypt(s, key), key), s);
    }
  });

  test("ciphertext is prefixed v1: and does not contain the plaintext", () => {
    const env = encrypt("super secret body", key);
    assert.ok(isEncrypted(env));
    assert.ok(env.startsWith(ENC_PREFIX));
    assert.ok(!env.includes("super secret body"));
  });

  test("same plaintext encrypts to different ciphertext (fresh IV each call)", () => {
    const a = encrypt("same text", key);
    const b = encrypt("same text", key);
    assert.notEqual(a, b);
    // Both still decrypt to the same thing.
    assert.equal(decrypt(a, key), "same text");
    assert.equal(decrypt(b, key), "same text");
  });

  test("wrong key fails loudly (GCM auth tag) rather than returning garbage", () => {
    const env = encrypt("important", key);
    const wrongKey = Buffer.alloc(32, 7);
    assert.throws(() => decrypt(env, wrongKey), /unable to authenticate|bad decrypt|Unsupported state/i);
  });

  test("tampered ciphertext throws instead of silently corrupting a note", () => {
    const env = encrypt("important", key);
    const parts = env.slice(ENC_PREFIX.length).split(":");
    // Flip a bit in the ciphertext body.
    const ct = Buffer.from(parts[2], "base64");
    ct[0] ^= 0xff;
    const tampered = `${ENC_PREFIX}${parts[0]}:${parts[1]}:${ct.toString("base64")}`;
    assert.throws(() => decrypt(tampered, key));
  });

  test("decrypt on a plaintext value is rejected (missing envelope prefix)", () => {
    assert.throws(() => decrypt("not encrypted", key), /not an encrypted value/);
  });

  test("decryptIfEncrypted passes plaintext through untouched", () => {
    assert.equal(decryptIfEncrypted("plain note", key), "plain note");
  });

  test("decryptIfEncrypted throws on an envelope when no key is present", () => {
    const env = encrypt("secret", key);
    assert.throws(() => decryptIfEncrypted(env, null), /no key file is present/);
  });
});

describe("crypto: key management", () => {
  let dir: string;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "om-key-"));
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  test("ensureKey creates a 32-byte key file and is idempotent", () => {
    const k1 = ensureKey(dir);
    assert.equal(k1.length, 32);
    assert.ok(existsSync(keyPath(dir)));
    const k2 = ensureKey(dir);
    assert.equal(k1.toString("hex"), k2.toString("hex"), "second call must not rotate the key");
  });

  test("encryptionEnabled tracks key-file presence", () => {
    const noKeyDir = mkdtempSync(join(tmpdir(), "om-nokey-"));
    try {
      process.env.ONEMEMORY_ENCRYPT = "";
      assert.equal(encryptionEnabled(noKeyDir), false, "no key file = off");
      ensureKey(noKeyDir);
      assert.equal(encryptionEnabled(noKeyDir), true, "key file = on");
    } finally {
      delete process.env.ONEMEMORY_ENCRYPT;
      rmSync(noKeyDir, { recursive: true, force: true });
    }
  });

  test("loadKey throws on a corrupt (wrong-size) key file rather than degrading", () => {
    const badDir = mkdtempSync(join(tmpdir(), "om-badkey-"));
    try {
      writeFileSync(join(badDir, ".key"), Buffer.alloc(16, 1)); // 16 bytes, not 32
      assert.throws(() => loadKey(badDir), /is 16 bytes, expected 32/);
    } finally {
      rmSync(badDir, { recursive: true, force: true });
    }
  });
});

describe("crypto: store integration", () => {
  let dir: string;
  let prevKeyFile: string | undefined;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "om-store-enc-"));
    prevKeyFile = process.env.ONEMEMORY_KEY_FILE;
    process.env.ONEMEMORY_KEY_FILE = join(dir, ".key");
  });
  after(() => {
    if (prevKeyFile === undefined) delete process.env.ONEMEMORY_KEY_FILE;
    else process.env.ONEMEMORY_KEY_FILE = prevKeyFile;
    rmSync(dir, { recursive: true, force: true });
  });

  function rawBody(store: Store, id: number): { body: string; body_enc: string | null } {
    const db = (store as unknown as { db: DatabaseSync }).db;
    return db.prepare("SELECT body, body_enc FROM notes WHERE id = ?").get(id) as {
      body: string;
      body_enc: string | null;
    };
  }

  test("encrypted store: ciphertext in body_enc, body empty (FTS-safe), read returns plaintext", () => {
    ensureKey(dir);
    const store = new Store(join(dir, "state.db"));
    try {
      const note = store.create({ title: "Secret", body: "the actual secret body" });
      // Read back decrypts transparently.
      assert.equal(note.body, "the actual secret body");
      const raw = rawBody(store, note.id);
      assert.equal(raw.body, "", "FTS-indexed body column must stay empty so ciphertext is never indexed");
      assert.ok(raw.body_enc && isEncrypted(raw.body_enc), "body_enc holds the envelope");
      assert.ok(!raw.body_enc.includes("the actual secret body"));
      assert.equal(note.encrypted, true, "record is flagged encrypted");
    } finally {
      store.close();
    }
  });

  test("update re-seals the body and still decrypts on read", () => {
    ensureKey(dir);
    const store = new Store(join(dir, "state.db"));
    try {
      const note = store.create({ title: "N", body: "v1" });
      store.update(note.id, { body: "v2" });
      assert.equal(store.read(note.id)!.body, "v2");
      const raw = rawBody(store, note.id);
      assert.ok(isEncrypted(raw.body_enc ?? ""));
      assert.equal(raw.body, "");
    } finally {
      store.close();
    }
  });

  test("plaintext store (no key): body column plaintext, no ciphertext, byte-identical to before", () => {
    const plainDir = mkdtempSync(join(tmpdir(), "om-plain-"));
    const saved = process.env.ONEMEMORY_KEY_FILE;
    try {
      // Point at a non-existent key file so encryptionEnabled() is false.
      process.env.ONEMEMORY_KEY_FILE = join(plainDir, "no-such-key");
      const store = new Store(join(plainDir, "state.db"));
      const note = store.create({ title: "P", body: "plaintext body" });
      const raw = rawBody(store, note.id);
      assert.equal(raw.body, "plaintext body");
      assert.equal(raw.body_enc, null);
      assert.equal(note.encrypted, undefined, "no encrypted flag on plaintext notes");
      assert.equal(note.body, "plaintext body");
      store.close();
    } finally {
      if (saved === undefined) delete process.env.ONEMEMORY_KEY_FILE;
      else process.env.ONEMEMORY_KEY_FILE = saved;
      rmSync(plainDir, { recursive: true, force: true });
    }
  });
});
