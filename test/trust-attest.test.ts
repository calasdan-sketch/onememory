// Signed writer attestations (1.4.0): an export signs each note's record with
// the exporting server's Ed25519 key; an import believes the signature only for
// keys the importing admin chose to trust. These tests pin what it does prove
// (the record was not altered) and the ways it must NOT be fooled.
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import type { AddressInfo } from "node:net";
import { Store, type ImportNote, type ImportReport, type AttestationReport } from "../src/store.js";
import { actorStore } from "../src/actor.js";
import { createApiServer } from "../src/api.js";
import { loadOrCreateSigningKey, ATTEST_KEY_FILENAME, contentHash, parseTrustedAttestersEnv, isPublicKey, keyIdOf } from "../src/attest.js";

const as = <T>(label: string, fn: () => T): T => actorStore.run({ label, authed: true }, fn);
const exported = (s: Store): ImportNote[] => s.exportBatch(0, 1000, { attest: true }) as unknown as ImportNote[];

async function importInto(b: Store, notes: ImportNote[]): Promise<{ created: Awaited<ReturnType<Store["importNotes"]>>; att: AttestationReport }> {
  const report: ImportReport = { quarantined: [], rejected: [] };
  const created = await b.importNotes(structuredClone(notes), { report });
  return { created, att: report.attestations! };
}

describe("attestations: signing and verifying", () => {
  let dir: string;
  let a: Store;
  let b: Store;
  const prevEnv = process.env.ONEMEMORY_TRUSTED_ATTESTERS;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "om-attest-"));
    a = new Store(join(dir, "a.db"));
    b = new Store(":memory:");
    delete process.env.ONEMEMORY_TRUSTED_ATTESTERS;
  });
  afterEach(() => {
    a.close();
    b.close();
    if (prevEnv === undefined) delete process.env.ONEMEMORY_TRUSTED_ATTESTERS;
    else process.env.ONEMEMORY_TRUSTED_ATTESTERS = prevEnv;
    rmSync(dir, { recursive: true, force: true });
  });

  const trustA = (): void => {
    const id = a.identity();
    b.attesterAdd({ public_key: id.public_key, server_id: id.server_id, label: "server a" });
  };

  test("the signing key lives beside the database with strict permissions and is never exported", () => {
    const id = a.identity();
    const keyPath = join(dir, ATTEST_KEY_FILENAME);
    assert.ok(existsSync(keyPath));
    if (process.platform !== "win32") assert.equal(statSync(keyPath).mode & 0o777, 0o600);
    const pem = readFileSync(keyPath, "utf8");
    assert.match(pem, /PRIVATE KEY/);
    as("alice", () => a.create({ title: "n", body: "b" }));
    const text = JSON.stringify(exported(a)) + JSON.stringify(a.exportHeader());
    assert.ok(!text.includes(pem.replace(/-----[A-Z ]+-----|\s/g, "")), "the private key is nowhere in the export");
    assert.ok(!text.includes("PRIVATE"));
    assert.equal(id.algorithm, "ed25519");
    assert.equal(id.key_id, keyIdOf(id.public_key));
    assert.ok(isPublicKey(id.public_key));
  });

  test("the key is created once and reused; a corrupt key file is an error, never a silent new identity", () => {
    const first = loadOrCreateSigningKey(dir);
    const again = loadOrCreateSigningKey(dir);
    assert.equal(first.publicKey, again.publicKey);
    const keyPath = join(dir, ATTEST_KEY_FILENAME);
    writeFileSync(keyPath, "not a key");
    assert.throws(() => loadOrCreateSigningKey(dir), /unreadable/);
    assert.equal(readFileSync(keyPath, "utf8"), "not a key", "the damaged file was not replaced");
  });

  test("the export header names the server, key id and public key", () => {
    const h = a.exportHeader();
    assert.equal(h.format, "onememory-export");
    assert.equal(h.server_id, a.serverId());
    assert.equal(h.public_key, a.identity().public_key);
    assert.equal(h.key_id, a.identity().key_id);
  });

  test("an in-memory database can still export (its key lives only in memory)", () => {
    const m = new Store(":memory:");
    as("x", () => m.create({ title: "t" }));
    assert.ok(exported(m)[0].attestation);
    m.close();
  });

  test("a trusted attestation keeps the original writer in attested_writer; the importer is the stamped writer", async () => {
    trustA();
    const n = as("alice", () => a.create({ namespace: "work", title: "decision", body: "use sqlite", tags: ["x"] }));
    const { created, att } = await importInto(b, exported(a));
    assert.deepEqual({ v: att.verified, u: att.unverified }, { v: 1, u: 0 });
    const got = b.read(created[0].id)!;
    assert.equal(got.attested_writer, "alice");
    assert.equal(got.attested_by, a.serverId());
    assert.equal(got.attested_writer_id, `${a.serverId()}/alice`);
    assert.equal(got.imported_written_by, "alice", "the claim is still recorded");
    assert.equal(got.written_by, "", "the importing process here has no token, so the stamp is empty: never the payload's value");
    const as2 = await (async () => {
      const b2 = new Store(":memory:");
      b2.attesterAdd({ public_key: a.identity().public_key, server_id: a.serverId() });
      const r = await actorStore.run({ label: "importer", authed: true }, () => b2.importNotes(structuredClone(exported(a))));
      const w = b2.read(r[0].id)!;
      b2.close();
      return w;
    })();
    assert.equal(as2.written_by, "importer", "stamped with the admin who imported");
    assert.equal(as2.attested_writer, "alice");
    void n;
  });

  test("an unverified note imports exactly as before: stamped with the importer, payload value only a claim", async () => {
    as("alice", () => a.create({ title: "decision", body: "x" }));
    const { created, att } = await importInto(b, exported(a)); // b trusts nobody
    assert.equal(att.verified, 0);
    assert.equal(att.unverified, 1);
    assert.deepEqual(att.reasons, { "attester key not trusted": 1 });
    assert.deepEqual(att.untrusted_keys, [{ key_id: a.identity().key_id, server_id: a.serverId(), notes: 1 }]);
    const got = b.read(created[0].id)!;
    assert.equal(got.attested_writer, undefined);
    assert.equal(got.imported_written_by, "alice");
  });

  test("a note without an attestation (an old backup) is unverified, 'no attestation'", async () => {
    as("alice", () => a.create({ title: "decision", body: "x" }));
    const plain = a.exportBatch(0, 100) as unknown as ImportNote[];
    assert.equal(plain[0].attestation, undefined, "attestations are opt-in at the store level");
    const { att } = await importInto(b, plain);
    assert.deepEqual(att.reasons, { "no attestation": 1 });
  });

  describe("tampering must fail verification", () => {
    beforeEach(() => {
      trustA();
      as("alice", () => a.create({ namespace: "work", title: "decision", body: "use sqlite", tags: ["x", "y"] }));
    });
    const tampered = async (edit: (n: ImportNote) => void): Promise<AttestationReport> => {
      const notes = exported(a);
      edit(notes[0]);
      const r = await importInto(b, notes);
      return r.att;
    };

    test("control: the untouched export verifies", async () => {
      assert.equal((await tampered(() => {})).verified, 1);
    });
    test("content: title", async () => assert.deepEqual((await tampered((n) => (n.title = "decision!"))).reasons, { "signature does not match the note": 1 }));
    test("content: body", async () => assert.equal((await tampered((n) => (n.body = "use postgres"))).verified, 0));
    test("content: tags", async () => assert.equal((await tampered((n) => (n.tags = ["x"]))).verified, 0));
    test("writer: written_by", async () => assert.equal((await tampered((n) => ((n as any).written_by = "admin"))).verified, 0));
    test("writer: created_by", async () => assert.equal((await tampered((n) => ((n as any).created_by = "admin"))).verified, 0));
    test("namespace", async () => assert.equal((await tampered((n) => (n.namespace = "other"))).verified, 0));
    test("updated_at", async () => assert.equal((await tampered((n) => (n.updated_at = "2001-01-01T00:00:00.000Z"))).verified, 0));
    test("note id (a signature cannot be moved onto another note)", async () => assert.equal((await tampered((n) => (n.id = 999))).verified, 0));
    test("merged_from_writers added to launder", async () => assert.equal((await tampered((n) => ((n as any).merged_from_writers = ["x"]))).verified, 0));
    test("the signature itself", async () => assert.equal((await tampered((n) => (n.attestation!.sig = "A".repeat(86)))).verified, 0));
    test("the content hash field", async () => assert.equal((await tampered((n) => (n.attestation!.content_hash = "0".repeat(64)))).verified, 0));
    test("a swapped server id", async () => {
      const r = await tampered((n) => (n.attestation!.server_id = "99999999-9999-4999-8999-999999999999"));
      assert.deepEqual(r.reasons, { "server id does not match the trusted key": 1 });
    });
    test("a malformed attestation", async () => {
      const r = await tampered((n) => ((n as any).attestation = { v: 1, sig: 5 }));
      assert.deepEqual(r.reasons, { "malformed attestation": 1 });
    });
    test("a tampered note is imported anyway, just as an unverified one", async () => {
      const notes = exported(a);
      notes[0].body = "use postgres";
      const r = await importInto(b, notes);
      assert.equal(r.created.length, 1);
      assert.equal(b.read(r.created[0].id)!.attested_writer, undefined);
    });
  });

  test("the namespace a token is pinned to cannot ride a signed note out of its namespace (REST import)", async () => {
    trustA();
    as("alice", () => a.create({ namespace: "work", title: "decision", body: "x" }));
    const payload = exported(a);
    const server = createApiServer(b, [{ token: "pin", scope: "admin", label: "pinned", namespace: "other" }]);
    await new Promise<void>((r) => server.listen(0, r));
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const res = await fetch(base + "/import", { method: "POST", headers: { Authorization: "Bearer pin", "Content-Type": "application/json" }, body: JSON.stringify({ notes: payload }) });
      const j: any = await res.json();
      assert.equal(j.imported, 1);
      assert.equal(j.attestations.verified, 0, "the namespace was forced, so the signed record no longer matches");
      assert.equal(b.list({ namespace: "other" }).notes.length, 1);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  test("trust list: admin-added keys, the env list, and the server-id pin", async () => {
    as("alice", () => a.create({ title: "decision", body: "x" }));
    const notes = exported(a);
    const id = a.identity();
    const realErr = console.error;
    const warned: string[] = [];
    console.error = (...x: unknown[]) => void warned.push(x.join(" "));
    try {
      // a bare key (no server id) is refused: it could claim to be any server
      process.env.ONEMEMORY_TRUSTED_ATTESTERS = id.public_key;
      assert.equal((await importInto(b, notes)).att.verified, 0);
      assert.ok(warned.some((w) => /no usable entry/.test(w)), "a variable that yields nothing is reported loudly");
      // env var pinned to a different server id: not believed
      process.env.ONEMEMORY_TRUSTED_ATTESTERS = `99999999-9999-4999-8999-999999999999=${id.public_key}`;
      assert.deepEqual((await importInto(b, notes)).att.reasons, { "server id does not match the trusted key": 1 });
      process.env.ONEMEMORY_TRUSTED_ATTESTERS = `${id.server_id}=${id.public_key}, garbage;;`;
      assert.equal((await importInto(b, notes)).att.verified, 1);
      // the documented JSON array form
      process.env.ONEMEMORY_TRUSTED_ATTESTERS = JSON.stringify([{ public_key: id.public_key, server_id: id.server_id, label: "a" }]);
      assert.equal((await importInto(b, notes)).att.verified, 1);
    } finally {
      console.error = realErr;
    }
    delete process.env.ONEMEMORY_TRUSTED_ATTESTERS;
    assert.equal((await importInto(b, notes)).att.verified, 0);
    // admin list, then removal
    b.attesterAdd({ public_key: id.public_key, server_id: id.server_id, label: "a" });
    assert.equal((await importInto(b, notes)).att.verified, 1);
    assert.equal(b.attesterRemove(id.key_id), true);
    assert.equal((await importInto(b, notes)).att.verified, 0);
    assert.deepEqual(parseTrustedAttestersEnv("nonsense"), []);
  });

  test("attester-add validates input and refuses to let a peer speak for this server", () => {
    assert.throws(() => b.attesterAdd({ public_key: "short" }), /public_key/);
    assert.throws(() => b.attesterAdd({ public_key: a.identity().public_key, server_id: "nope" }), /UUID/);
    // A key pinned to THIS server's own id is a "retired own key" (a rotation, or a restore that lost the key file): allowed,
    // the same way an ONEMEMORY_TRUSTED_ATTESTERS entry naming this server's id is. Its CURRENT key is refused.
    const retired = b.attesterAdd({ public_key: a.identity().public_key, server_id: b.serverId() });
    assert.equal(retired.server_id, b.serverId());
    assert.equal(b.attesterRemove(retired.key_id), true);
    assert.throws(() => b.attesterAdd({ public_key: b.identity().public_key, server_id: b.serverId() }), /current key/);
    assert.throws(() => b.attesterAdd({ public_key: a.identity().public_key, server_id: "00000000-0000-4000-8000-000000000000", not_after: "1" }), /ISO-8601/);
    assert.throws(() => b.attesterRemove("zz"), /key_id/);
    assert.throws(() => b.attesterAdd({ public_key: a.identity().public_key, label: "pal" }), /server_id is required/, "a key must be pinned to a server");
    assert.throws(() => b.attesterAdd({ public_key: a.identity().public_key, server_id: a.serverId(), not_after: "never" }), /not_after/);
    const added = b.attesterAdd({ public_key: a.identity().public_key, label: "pal", any_server: true });
    assert.equal(added.key_id, a.identity().key_id);
    assert.deepEqual(b.trustLog(5).map((l) => l.action), ["attester-add", "attester-remove", "attester-add"]);
    assert.match(b.trustLog(1)[0].subject, /ANY-SERVER/);
    // re-adding with a pin replaces the entry and says so
    const pinned = b.attesterAdd({ public_key: a.identity().public_key, server_id: a.serverId() });
    assert.deepEqual(pinned.replaced, { server_id: "", not_after: "" });
  });

  test("a key trusted without a server id can never vouch for this server's own id", async () => {
    // Someone cannot make a foreign key "be" us: notes claiming OUR server id under a foreign key fail.
    const c = new Store(":memory:");
    as("alice", () => c.create({ title: "n", body: "b" }));
    const notes = exported(c);
    notes[0].attestation!.server_id = b.serverId();
    b.attesterAdd({ public_key: c.identity().public_key, any_server: true });
    const r = await importInto(b, notes);
    assert.equal(r.att.verified, 0);
    c.close();
  });

  test("restoring a server's own export verifies against its own key (and only for its own server id)", async () => {
    as("alice", () => a.create({ title: "mine", body: "x" }));
    const notes = exported(a);
    const r = await importInto(a, notes); // a imports its own export; nobody added any trust
    assert.equal(r.att.verified, 1);
    assert.equal(a.read(r.created[0].id)!.attested_by, a.serverId());
  });

  test("a later edit clears the attestation: the editor is the writer now", async () => {
    trustA();
    as("alice", () => a.create({ title: "decision", body: "x" }));
    const { created } = await importInto(b, exported(a));
    assert.equal(b.read(created[0].id)!.attested_writer, "alice");
    as("bob", () => b.update(created[0].id, { body: "changed" }));
    const after = b.read(created[0].id)!;
    assert.equal(after.attested_writer, undefined);
    assert.equal(after.written_by, "bob");
    // a metadata-only change keeps it (it does not change the content)
    const { created: c2 } = await importInto(b, exported(a));
    as("bob", () => b.update(c2[0].id, { tags: ["new-tag"] }));
    assert.equal(b.read(c2[0].id)!.attested_writer, "alice");
  });

  test("what the attestation covers, in one place: content hash is stable over tag order and duplicates", () => {
    assert.equal(contentHash("t", "b", ["y", "x", "x"]), contentHash("t", "b", ["x", "y"]));
    assert.notEqual(contentHash("t", "b", []), contentHash("t", "b2", []));
  });

  test("attested chains: a note that passed through two servers keeps the first author as a merged source", async () => {
    // a -> b (b trusts a) -> c (c trusts b): c sees b as the attester and a's author in merged_from_writers
    trustA();
    as("alice", () => a.create({ title: "chain", body: "x" }));
    const { created } = await actorStore.run({ label: "b-admin", authed: true }, () => importInto(b, exported(a)));
    const onB = b.read(created[0].id)!;
    assert.equal(onB.attested_writer, "alice");
    assert.equal(onB.written_by, "b-admin");
    const c = new Store(":memory:");
    c.attesterAdd({ public_key: b.identity().public_key, server_id: b.serverId() });
    const rb = await importInto(c, exported(b));
    const onC = c.read(rb.created[0].id)!;
    assert.equal(onC.attested_by, b.serverId());
    assert.equal(onC.attested_writer, "b-admin", "b vouches for whoever stamped the note on b (the admin who imported it there)");
    assert.ok(onC.merged_from_writers!.includes("alice") && onC.merged_from_writers!.includes(`${a.serverId()}/alice`), "the original author is not lost");
    c.distrustAdd("default", `${a.serverId()}/alice`);
    assert.equal(c.list().notes.length, 0, "distrusting the first author follows the content through the chain");
    c.close();
  });

  test("distrust follows a verified original author, by label or by writer_id; not_written_by treats the note as touched by them", async () => {
    trustA();
    as("alice", () => a.create({ title: "decision", body: "x" }));
    const { created } = await importInto(b, exported(a));
    const id = created[0].id;
    assert.equal(b.list({ writtenBy: `${a.serverId()}/alice` }).notes.length, 1, "foreign writer_id matches the attested author");
    assert.equal(b.list({ notWrittenBy: "alice" }).notes.length, 0);
    assert.equal(b.list({ notWrittenBy: `${a.serverId()}/alice` }).notes.length, 0);
    assert.equal(b.list({ notWrittenBy: `${a.serverId()}/bob` }).notes.length, 1);
    b.distrustAdd("default", `${a.serverId()}/alice`);
    assert.equal(b.list().notes.length, 0);
    assert.equal(b.read(id)!.distrusted, undefined, "plain read of a record is not annotated; the lists are what filter");
    b.distrustRemove("default", `${a.serverId()}/alice`);
    // another server's writer with the same label is a different writer
    b.distrustAdd("default", `99999999-9999-4999-8999-999999999999/alice`);
    assert.equal(b.list().notes.length, 1);
    // an UNVERIFIED claim cannot make anything MORE trusted, but it can only ADD taint: a distrusted
    // writer's name in an unattested file still hides the note (stripping the attestation launders nothing)
    const c = new Store(":memory:");
    const plain = a.exportBatch(0, 100) as unknown as ImportNote[];
    const r = await c.importNotes(plain);
    c.distrustAdd("default", "bob");
    assert.equal(c.list().notes.length, r.length, "a rule naming someone the file does not mention hides nothing");
    c.distrustAdd("default", "alice");
    assert.equal(c.list().notes.length, 0, "the claimed writer 'alice' is in the taint set, so the rule applies");
    c.close();
  });
});

describe("attestations: HTTP export / import and the CLI", () => {
  test("GET /export is the plain {notes} body by default; ?attest=1 adds the header and an attestation per note; the import reports counts", async () => {
    const a = new Store(":memory:");
    const b = new Store(":memory:");
    as("alice", () => a.create({ title: "one", body: "x" }));
    as("alice", () => a.create({ title: "two", body: "y" }));
    b.attesterAdd({ public_key: a.identity().public_key, server_id: a.serverId() });
    const sa = createApiServer(a, [{ token: "adm", scope: "admin", label: "a-admin" }]);
    const sb = createApiServer(b, [{ token: "adm", scope: "admin", label: "b-admin" }]);
    await Promise.all([new Promise<void>((r) => sa.listen(0, r)), new Promise<void>((r) => sb.listen(0, r))]);
    const urlA = `http://127.0.0.1:${(sa.address() as AddressInfo).port}`;
    const urlB = `http://127.0.0.1:${(sb.address() as AddressInfo).port}`;
    const h = { Authorization: "Bearer adm", "Content-Type": "application/json" };
    try {
      const dump: any = await (await fetch(urlA + "/export?attest=1", { headers: h })).json();
      assert.equal(dump.export.server_id, a.serverId());
      assert.equal(dump.export.public_key, a.identity().public_key);
      assert.ok(dump.notes.every((n: any) => n.attestation && n.attestation.key_id === dump.export.key_id));
      const plain: any = await (await fetch(urlA + "/export", { headers: h })).json();
      assert.equal(plain.export, undefined, "the default body is the pre-1.4.0 {notes:[...]} envelope");
      assert.deepEqual(Object.keys(plain), ["notes"]);
      assert.deepEqual((await (await fetch(urlA + "/export?attest=0", { headers: h })).json()) as any, plain, "?attest=0 is the same plain body");
      assert.ok(plain.notes.every((n: any) => n.attestation === undefined));
      const res: any = await (await fetch(urlB + "/import", { method: "POST", headers: h, body: JSON.stringify(dump) })).json();
      assert.equal(res.imported, 2);
      assert.deepEqual({ v: res.attestations.verified, u: res.attestations.unverified }, { v: 2, u: 0 });
      assert.equal(b.list({ writtenBy: `${a.serverId()}/alice` }).notes.length, 2);
      // a plain import keeps the old response shape
      const res2: any = await (await fetch(urlB + "/import", { method: "POST", headers: h, body: JSON.stringify(plain) })).json();
      assert.equal(res2.attestations, undefined);
    } finally {
      await Promise.all([new Promise<void>((r) => sa.close(() => r())), new Promise<void>((r) => sb.close(() => r()))]);
      a.close();
      b.close();
    }
  });

  test("an export still succeeds when the signing key cannot be created (read-only data directory)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "om-attest-ro-"));
    const prev = process.env.ONEMEMORY_ATTEST_KEY_FILE;
    try {
      const s = new Store(join(dir, "s.db"));
      s.create({ title: "n", body: "b" });
      // point the key at a path that cannot be created (a file used as a directory)
      writeFileSync(join(dir, "blocker"), "x");
      process.env.ONEMEMORY_ATTEST_KEY_FILE = join(dir, "blocker", "key");
      const server = createApiServer(s, [{ token: "adm", scope: "admin", label: "a" }]);
      await new Promise<void>((r) => server.listen(0, r));
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const res = await fetch(base + "/export?attest=1", { headers: { Authorization: "Bearer adm" } });
      assert.equal(res.status, 200);
      const j: any = await res.json();
      assert.equal(j.notes.length, 1);
      assert.equal(j.export, undefined, "no header, no attestations: a plain backup");
      await new Promise<void>((r) => server.close(() => r()));
      s.close();
    } finally {
      if (prev === undefined) delete process.env.ONEMEMORY_ATTEST_KEY_FILE;
      else process.env.ONEMEMORY_ATTEST_KEY_FILE = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("CLI: trust identity / attester-add / distrust, export --format json, import --file", () => {
    const dir = mkdtempSync(join(tmpdir(), "om-attest-cli-"));
    try {
      const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.js");
      const run = (db: string, ...args: string[]) =>
        spawnSync(process.execPath, [cli, ...args], {
          // one data directory per database: the signing key lives beside the db file
          env: { ...process.env, ONEMEMORY_DB_PATH: join(dir, db, "state.db"), ONEMEMORY_HOME: join(dir, "home-" + db) },
          encoding: "utf8",
          timeout: 60000,
        });
      const a = new Store(join(dir, "a.db", "state.db"));
      as("alice", () => a.create({ title: "from a", body: "hello" }));
      const aid = a.identity();
      a.close();
      const ident = run("a.db", "trust", "identity", "--json");
      assert.equal(ident.status, 0, ident.stderr);
      assert.equal(JSON.parse(ident.stdout).public_key, aid.public_key);
      const out = join(dir, "dump.json");
      const ex = run("a.db", "export", "--format", "json", "--attest", "--out", out);
      assert.equal(ex.status, 0, ex.stderr);
      const dump = JSON.parse(readFileSync(out, "utf8"));
      assert.equal(dump.export.server_id, aid.server_id);
      assert.ok(dump.notes[0].attestation);
      if (process.platform !== "win32") assert.equal(statSync(out).mode & 0o777, 0o600);
      // not trusted yet
      const first = run("b.db", "import", "--file", out, "--json");
      assert.equal(first.status, 0, first.stderr);
      assert.equal(JSON.parse(first.stdout).attestations.verified, 0);
      const unpinned = run("b.db", "trust", "attester-add", "--public-key", aid.public_key);
      assert.equal(unpinned.status, 1, "a key without a server id is refused");
      assert.match(unpinned.stderr, /server_id is required/);
      const add = run("b.db", "trust", "attester-add", aid.public_key, "--server-id", aid.server_id, "--label", "a");
      assert.equal(add.status, 0, add.stderr + add.stdout);
      const second = run("b.db", "import", "--file", out, "--json");
      assert.equal(JSON.parse(second.stdout).attestations.verified, 1);
      assert.equal(run("b.db", "trust", "distrust", "alice", "--namespace", "*").status, 0);
      const list = JSON.parse(run("b.db", "trust", "list", "--json").stdout);
      assert.equal(list.distrust[0].writer, "alice");
      assert.equal(list.attesters[0].key_id, aid.key_id);
      assert.equal(run("b.db", "trust", "distrust", "alice").status, 1, "a namespace is required");
      // a base64url key (and a label) may start with "-": it must not be read as an option
      const dashKey = Buffer.from([0xfb, 0xef, ...new Array(30).fill(7)]).toString("base64url");
      assert.ok(dashKey.startsWith("-"));
      assert.equal(run("b.db", "trust", "attester-add", dashKey).status, 1, "bare, it is an unknown option (clear error, not a crash)");
      assert.equal(run("b.db", "trust", "attester-add", "--public-key", dashKey, "--label", "dash", "--any-server").status, 0);
      assert.equal(run("b.db", "trust", "attester-add", "--any-server", "--", dashKey).status, 0, "after -- it is positional (already present: idempotent)");
      assert.equal(run("b.db", "trust", "distrust", "--writer", "-odd", "--namespace", "*").status, 0);
      assert.ok(JSON.parse(run("b.db", "trust", "list", "--json").stdout).distrust.some((r: any) => r.writer === "-odd"));
      const plainOut = run("a.db", "export", "--format", "json");
      assert.equal(JSON.parse(plainOut.stdout).export, undefined, "plain by default");
      assert.deepEqual(Object.keys(JSON.parse(plainOut.stdout)), ["notes"]);
      const noAttest = run("a.db", "export", "--format", "json", "--no-attest");
      assert.equal(JSON.parse(noAttest.stdout).export, undefined, "--no-attest is still accepted");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
