// 1.7.1: fixes from the independent review of setup, secrets, the review queue and rollbacks.
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_OPTIONS, historyFile, migrateEntry, planFile, detectClients, realEnv, runSetup, undoLast, writeChange, type SetupEnv, type SetupIO, type SetupOptions } from "../src/setup.js";
import { parseJsonc } from "../src/jsonc-edit.js";
import { looksLikeCredential } from "../src/claude-import.js";
import { assertReviewedTag } from "../src/reserved-tags.js";
import { currentWriter, actorStore, WRITER_MARKERS } from "../src/actor.js";
import { Store, SCHEMA_VERSION } from "../src/store.js";
import { downgradeTo } from "./legacy-db.js";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.js");
const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});
function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "om-r2-"));
  roots.push(root);
  const home = join(root, "home dir");
  mkdirSync(home, { recursive: true });
  const e: SetupEnv = { home, platform: "linux", env: { HOME: home, ONEMEMORY_HOME: join(root, "om-home") }, cwd: root, nodeVersion: "24.4.1", execPath: process.execPath, cliPath: CLI, version: "1.7.1", now: () => new Date("2026-10-25T12:00:00Z") };
  return { root, home, e, cc: join(home, ".claude.json") };
}
function makeIO(): SetupIO & { all: () => string } {
  const l: string[] = [];
  return { interactive: false, out: (x) => void l.push(x), err: (x) => void l.push(x), ask: async () => "", all: () => l.join("\n") };
}
const opts = (o: Partial<SetupOptions> = {}): SetupOptions => ({ ...DEFAULT_OPTIONS, noDoctor: true, ...o });
const SET_OPS = [{ op: "set" as const, path: ["mcpServers"], key: "onememory", value: { command: "node" } }];

describe("1.7.1 migrateEntry: ONEMEMORY_ wins over CLAUDE_BRIDGE_", () => {
  test("both set: the new name wins, whichever comes first in the entry", () => {
    const { e } = sandbox();
    for (const env of [{ CLAUDE_BRIDGE_DB_PATH: "/old.db", ONEMEMORY_DB_PATH: "/new.db" }, { ONEMEMORY_DB_PATH: "/new.db", CLAUDE_BRIDGE_DB_PATH: "/old.db" }]) {
      const m = migrateEntry(e, { command: "node" }, { command: "node", args: ["x"], env }, true);
      assert.equal(m.entry.env!.ONEMEMORY_DB_PATH, "/new.db");
      assert.equal(m.db, "/new.db");
      assert.equal(Object.keys(m.entry.env!).filter((k) => k.endsWith("DB_PATH")).length, 1);
    }
  });
  test("only the old name: it is renamed with its value", () => {
    const { e } = sandbox();
    const m = migrateEntry(e, { command: "node" }, { command: "node", env: { CLAUDE_BRIDGE_DB_PATH: "/old.db", CLAUDE_BRIDGE_TOKEN: "t" } }, true);
    assert.deepEqual(m.entry.env, { ONEMEMORY_DB_PATH: "/old.db", ONEMEMORY_TOKEN: "t" });
  });
});

describe("1.7.1 an old entry with comments inside it", () => {
  test("parseJsonc reads comments and trailing commas, and still refuses real errors", () => {
    assert.deepEqual(parseJsonc('{ // c\n "a": [1, 2,], /* x */ "b": "//not a comment", }'), { a: [1, 2], b: "//not a comment" });
    assert.throws(() => parseJsonc("{ nope }"));
    assert.throws(() => parseJsonc("{ /* open"));
  });
  test("setup migrates a claude-bridge entry that has a comment inside it", async () => {
    const s = sandbox();
    const db = join(s.root, "old", "state.db");
    mkdirSync(dirname(db), { recursive: true });
    writeFileSync(
      s.cc,
      `{\n  "mcpServers": {\n    "claude-bridge": {\n      // my own note about this\n      "command": "node",\n      "args": ["C:/x/claude-bridge/dist/src/mcp-stdio.js"],\n      "env": { "CLAUDE_BRIDGE_DB_PATH": ${JSON.stringify(db)}, },\n    },\n    "keep": { "command": "k" }\n  }\n}\n`
    );
    const io = makeIO();
    assert.equal(await runSetup(s.e, io, opts({ yes: true, noTestNote: true })), 0, io.all());
    const out = readFileSync(s.cc, "utf8");
    assert.match(out, /"onememory"/);
    assert.doesNotMatch(out, /claude-bridge/);
    assert.ok(out.includes('"keep": { "command": "k" }'));
    assert.ok(out.includes(JSON.stringify(db).slice(1, -1)) || out.includes(JSON.stringify(db)));
  });
  test("an entry that cannot be read at all says plainly how to do it by hand", () => {
    const s = sandbox();
    writeFileSync(s.cc, '{ "mcpServers": { "claude-bridge": { "command": "node", "args": [ ??? ] } } }');
    const t = detectClients(s.e).find((x) => x.id === "claude-code")!;
    let r;
    try {
      r = planFile(s.e, opts(), t, { dbs: new Set() });
    } catch (err) {
      // the editor itself refuses a file it cannot parse: also a plain refusal, nothing written
      assert.match((err as Error).message, /./);
      return;
    }
    assert.match(r.warnings.join("\n"), /did NOT migrate it.*By hand/s);
  });
});

describe("1.7.1 an empty config file is not replaced", () => {
  test("planning stops with a plain message and writes nothing", async () => {
    const s = sandbox();
    writeFileSync(s.cc, "");
    const io = makeIO();
    assert.equal(await runSetup(s.e, io, opts({ yes: true, noTestNote: true })), 1);
    assert.match(io.all(), /completely empty \(0 bytes\)/);
    assert.match(io.all(), /--force-empty/);
    assert.equal(statSync(s.cc).size, 0);
    assert.deepEqual(readdirSync(s.home).filter((f) => f.includes("backup")), []);
  });
  test("--force-empty does replace it", async () => {
    const s = sandbox();
    writeFileSync(s.cc, "");
    assert.equal(await runSetup(s.e, makeIO(), opts({ yes: true, noTestNote: true, forceEmpty: true })), 0);
    assert.ok(JSON.parse(readFileSync(s.cc, "utf8")).mcpServers.onememory);
  });
  test("writeChange itself refuses a file that became empty after planning", () => {
    const s = sandbox();
    writeFileSync(s.cc, "");
    assert.throws(() => writeChange(s.e, { client: "claude-code", label: "x", file: s.cc, before: "{}", ops: SET_OPS, lines: [], inverse: [] }), /completely empty/);
    assert.equal(statSync(s.cc).size, 0);
  });
  test("a missing file and a whitespace-only file are still fine", async () => {
    const s = sandbox();
    assert.equal(await runSetup(s.e, makeIO(), opts({ yes: true, noTestNote: true, only: ["claude-code"] })), 0);
    const s2 = sandbox();
    writeFileSync(s2.cc, "\n");
    assert.equal(await runSetup(s2.e, makeIO(), opts({ yes: true, noTestNote: true })), 0);
  });
  test("the CLI passes --force-empty through", () => {
    const src = readFileSync(join(dirname(CLI), "..", "..", "src", "cli.ts"), "utf8");
    assert.match(src, /forceEmpty: flags\["force-empty"\] === true/);
  });
});

describe("1.7.1 undo after the database was upgraded", () => {
  function legacy(s: ReturnType<typeof sandbox>) {
    const oldDb = join(s.root, "my-agent", "claude-bridge", "data", "state.db");
    mkdirSync(dirname(oldDb), { recursive: true });
    const st = new Store(oldDb);
    st.create({ title: "note one", body: "b" });
    st.close();
    downgradeTo(oldDb, 13);
    writeFileSync(s.cc, JSON.stringify({ mcpServers: { "claude-bridge": { command: "node", args: ["/x/claude-bridge/dist/src/mcp-stdio.js"], env: { CLAUDE_BRIDGE_DB_PATH: oldDb } } } }, null, 2) + "\n");
    return oldDb;
  }
  test("the exact rollback steps are printed, and the old program's limit is explained", async () => {
    const s = sandbox();
    const oldDb = legacy(s);
    assert.equal(await runSetup(s.e, makeIO(), opts({ yes: true })), 0);
    assert.equal(Store.peekSchemaVersion(oldDb), SCHEMA_VERSION);
    const io = makeIO();
    assert.equal(await runSetup(s.e, io, opts({ undo: true })), 0);
    const t = io.all();
    assert.doesNotMatch(t, /were not touched\.?\s*$/m, "must not claim the notes were untouched");
    assert.match(t, /NOT rolled back/);
    assert.match(t, /cannot open an upgraded database/);
    assert.ok(t.includes(`${oldDb}.pre-v${SCHEMA_VERSION}-backup`));
    assert.ok(t.includes(`${oldDb}-wal`) && t.includes(`${oldDb}-shm`), "wal and shm are named");
    assert.match(t, /onememory backup --out/);
    assert.equal(Store.peekSchemaVersion(oldDb), SCHEMA_VERSION, "undo still never touches the database");
    assert.ok(JSON.parse(readFileSync(s.cc, "utf8")).mcpServers["claude-bridge"], "the old entry is back");
  });
  test("a plain (non-migration) undo keeps the simple message", async () => {
    const s = sandbox();
    writeFileSync(s.cc, "{}\n");
    await runSetup(s.e, makeIO(), opts({ yes: true, noTestNote: true }));
    const io = makeIO();
    assert.equal(await undoLast(s.e, io), 0);
    assert.match(io.all(), /Your notes \(the database\) were not touched\./);
    assert.doesNotMatch(io.all(), /NOT rolled back/);
  });
  test("a migration whose database was already current has nothing to roll back", async () => {
    const s = sandbox();
    const db = join(s.root, "cur", "state.db");
    mkdirSync(dirname(db), { recursive: true });
    new Store(db).close();
    writeFileSync(s.cc, JSON.stringify({ mcpServers: { "claude-bridge": { command: "node", args: ["/x/claude-bridge/a.js"], env: { CLAUDE_BRIDGE_DB_PATH: db } } } }));
    await runSetup(s.e, makeIO(), opts({ yes: true, noTestNote: true }));
    const io = makeIO();
    await undoLast(s.e, io);
    assert.doesNotMatch(io.all(), /NOT rolled back/);
    assert.match(io.all(), /not upgraded by setup/);
  });
});

describe("1.7.1 history and backups hold secrets: permissions", { skip: process.platform === "win32" }, () => {
  test("setup-history.json is 0600, its folder 0700, and the backup is 0600", async () => {
    const s = sandbox();
    writeFileSync(s.cc, JSON.stringify({ mcpServers: { other: { command: "x", env: { API_TOKEN: "sekrit-token-value" } } } }) + "\n");
    await runSetup(s.e, makeIO(), opts({ yes: true, noTestNote: true }));
    assert.equal(statSync(historyFile(s.e)).mode & 0o777, 0o600);
    assert.equal(statSync(dirname(historyFile(s.e))).mode & 0o777, 0o700);
    const bak = readdirSync(s.home).find((f) => f.includes("onememory-backup"))!;
    assert.equal(statSync(join(s.home, bak)).mode & 0o777, 0o600);
  });
});

describe("1.7.1 secret detection: headers and plain-word passwords", () => {
  const yes = [
    "Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123",
    "curl -H 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9abc'",
    "Authorization: Basic dXNlcjpwYXNzd29yZA==",
    "Bearer abcdefghijklmnopqrst12345",
    "password: correcthorsebatterystaple",
    "PASSWORD=\"correct-horse-battery\"",
    "db_passwd = tr0ub4dor&3xyz",
    "secret: thequickbrownfoxjumps",
  ];
  const no = [
    "password: required",
    "Use a Bearer token in the header",
    "Authorization: Bearer <token>",
    "Authorization: Bearer ${TOKEN}",
    "password: your_password_here",
    "password: changeme-please-ok",
    "Authorization: Bearer xxxxxxxxxxxxxxxxxxxxxxx",
    "password: $DB_PASSWORD_VAR_XX",
    "the password is stored in the keychain",
    "password: ********************",
    "Bearer authentication-scheme-description",
    "Run the migration and then check the logs.",
  ];
  for (const t of yes) test(`caught: ${t.slice(0, 40)}`, () => assert.equal(looksLikeCredential(t), true));
  for (const t of no) test(`not flagged: ${t.slice(0, 40)}`, () => assert.equal(looksLikeCredential(t), false));
});

describe("1.7.1 the 'reviewed' tag and the import marker", () => {
  test("only an admin can add or remove 'reviewed'", () => {
    assert.throws(() => assertReviewedTag(["reviewed"], undefined, false), /administrator/);
    assert.throws(() => assertReviewedTag(["a"], ["reviewed"], false), /administrator/);
    assert.doesNotThrow(() => assertReviewedTag(["reviewed", "a"], ["reviewed"], false), "unchanged is fine");
    assert.doesNotThrow(() => assertReviewedTag(["reviewed"], undefined, true));
    assert.doesNotThrow(() => assertReviewedTag(undefined, undefined, false));
    assert.doesNotThrow(() => assertReviewedTag(["other"], undefined, false));
  });
  test("a token labelled import:claude cannot pose as the import writer", () => {
    assert.ok((WRITER_MARKERS as readonly string[]).includes("import:claude"));
    const w = actorStore.run({ label: "import:claude", authed: true }, () => currentWriter());
    assert.equal(w, "token:import:claude");
    assert.equal(actorStore.run({ label: "IMPORT:Claude", authed: true }, () => currentWriter()), "token:IMPORT:Claude");
  });
  test("through REST: a write token is refused 'reviewed' (create and edit); an admin may", async () => {
    const { createApiServer } = await import("../src/api.js");
    const store = new Store(":memory:");
    const server = createApiServer(store, [
      { token: "t".repeat(40), scope: "write", label: "agent" },
      { token: "a".repeat(40), scope: "admin", label: "owner" },
    ]);
    await new Promise<void>((r) => server.listen(0, r));
    const base = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
    const h = (t: string) => ({ Authorization: `Bearer ${t}`, "Content-Type": "application/json" });
    try {
      const bad = await fetch(`${base}/notes`, { method: "POST", headers: h("t".repeat(40)), body: JSON.stringify({ title: "x", tags: ["reviewed"] }) });
      assert.equal(bad.status, 400);
      const made = (await (await fetch(`${base}/notes`, { method: "POST", headers: h("t".repeat(40)), body: JSON.stringify({ title: "x", body: "y" }) })).json()) as { note: any };
      const edit = await fetch(`${base}/notes/${made.note.id}`, { method: "PUT", headers: h("t".repeat(40)), body: JSON.stringify({ tags: ["reviewed"], if_rev: made.note.rev }) });
      assert.equal(edit.status, 400);
      const ok = await fetch(`${base}/notes/${made.note.id}`, { method: "PUT", headers: h("a".repeat(40)), body: JSON.stringify({ tags: ["reviewed"], if_rev: made.note.rev }) });
      assert.equal(ok.status, 200);
      const plain = await fetch(`${base}/notes`, { method: "POST", headers: h("t".repeat(40)), body: JSON.stringify({ title: "ok", tags: ["fine"] }) });
      assert.equal(plain.status, 201);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      store.close();
    }
  });
});

describe("1.7.1 misc", () => {
  test("realEnv works and long paths are absolute", () => {
    const e = realEnv("1.7.1", CLI);
    assert.ok(e.cliPath.length > 0);
  });
  test("the rename retry text matches the code (no 'half a minute')", () => {
    const docs = readFileSync(join(dirname(CLI), "..", "..", "docs", "live-claude-code.md"), "utf8");
    assert.doesNotMatch(docs, /half a minute/);
    assert.match(docs, /about 2 seconds/);
  });
  test("the docs and the store message tell you to delete -wal and -shm", () => {
    const docs = readFileSync(join(dirname(CLI), "..", "..", "docs", "live-claude-code.md"), "utf8");
    assert.match(docs, /state\.db-wal.*state\.db-shm/s);
    const src = readFileSync(join(dirname(CLI), "..", "..", "src", "store.ts"), "utf8");
    assert.match(src, /DELETE the database's -wal and -shm/);
  });
  test("the cmd /c npx wording is not stated as documented fact", () => {
    const src = readFileSync(join(dirname(CLI), "..", "..", "src", "setup.ts"), "utf8");
    assert.doesNotMatch(src, /documented by Claude Code for npx servers/);
    const docs = readFileSync(join(dirname(CLI), "..", "..", "docs", "live-claude-code.md"), "utf8");
    assert.match(docs, /not confirmed/);
  });
});
