// `onememory setup`: every test runs against a temporary HOME / APPDATA. No real configuration is ever read or written.
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import {
  buildHookCommand,
  buildServerEntry,
  classifyEntry,
  DEFAULT_OPTIONS,
  detectClients,
  lineDiff,
  listBackups,
  migrateEntry,
  planFile,
  readHistory,
  realEnv,
  redact,
  runSetup,
  writeChange,
  type SetupEnv,
  type SetupIO,
  type SetupOptions,
} from "../src/setup.js";
import { Store, SCHEMA_VERSION } from "../src/store.js";
import { downgradeTo } from "./legacy-db.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "src", "cli.js");
const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function sandbox(over: Partial<SetupEnv> = {}, envVars: NodeJS.ProcessEnv = {}) {
  const root = mkdtempSync(join(tmpdir(), "om-setup-"));
  roots.push(root);
  const home = join(root, "home dir"); // a space on purpose
  mkdirSync(home, { recursive: true });
  const proj = join(root, "proj");
  mkdirSync(proj);
  const e: SetupEnv = {
    home,
    platform: "linux",
    env: { HOME: home, ONEMEMORY_HOME: join(root, "om-home"), ...envVars },
    cwd: proj,
    nodeVersion: "24.4.1",
    execPath: "/usr/local/bin/node",
    cliPath: CLI,
    version: "1.7.0",
    now: () => new Date("2026-10-25T12:00:00Z"),
    ...over,
  };
  return { root, home, proj, e, db: join(root, "data dir", "state.db") };
}

function makeIO(answers: string[] = [], interactive = true): SetupIO & { lines: string[]; errs: string[]; all: () => string; asked: string[] } {
  const lines: string[] = [];
  const errs: string[] = [];
  const asked: string[] = [];
  return {
    lines,
    errs,
    asked,
    interactive,
    out: (l) => void lines.push(l),
    err: (l) => void errs.push(l),
    ask: async (p) => {
      asked.push(p);
      return answers.shift() ?? "";
    },
    all: () => [...lines, ...errs].join("\n"),
  };
}

const opts = (o: Partial<SetupOptions> = {}): SetupOptions => ({ ...DEFAULT_OPTIONS, noDoctor: true, ...o });
const ccFile = (home: string): string => join(home, ".claude.json");
const write = (p: string, s: string): void => {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, s);
};
const json = (p: string): any => JSON.parse(readFileSync(p, "utf8").replace(/^\uFEFF/, ""));

const REAL_CLAUDE_JSON =
  '{\n  "numStartups": 12,\n  "bigId": 12345678901234567890,\n  "mcpServers": {\n    "other": {\n      "type": "stdio",\n      "command": "npx",\n      "args": ["-y", "something"]\n    }\n  },\n  "projects": {\n    "/work/a": { "allowedTools": [], "history": [1, 2, 3] }\n  }\n}\n';

describe("setup: finding the apps", () => {
  test("Linux paths", () => {
    const s = sandbox();
    const t = detectClients(s.e);
    assert.equal(t.find((x) => x.id === "claude-code")!.file, join(s.home, ".claude.json"));
    assert.equal(t.find((x) => x.id === "claude-desktop")!.file, join(s.home, ".config", "Claude", "claude_desktop_config.json"));
    assert.equal(t.find((x) => x.id === "cursor")!.file, join(s.home, ".cursor", "mcp.json"));
  });
  test("Windows: Claude Desktop lives under APPDATA", () => {
    const s = sandbox({ platform: "win32" }, { APPDATA: "C:/Users/danie/AppData/Roaming" });
    assert.match(detectClients(s.e).find((x) => x.id === "claude-desktop")!.file.replace(/\\/g, "/"), /C:\/Users\/danie\/AppData\/Roaming\/Claude\/claude_desktop_config\.json$/);
  });
  test("Windows without APPDATA falls back to AppData\\Roaming in the home folder", () => {
    const s = sandbox({ platform: "win32" });
    assert.match(detectClients(s.e).find((x) => x.id === "claude-desktop")!.file.replace(/\\/g, "/"), /home dir\/AppData\/Roaming\/Claude\/claude_desktop_config\.json$/);
  });
  test("macOS path", () => {
    const s = sandbox({ platform: "darwin" });
    assert.match(detectClients(s.e).find((x) => x.id === "claude-desktop")!.file.replace(/\\/g, "/"), /Library\/Application Support\/Claude\/claude_desktop_config\.json$/);
  });
  test("CLAUDE_CONFIG_DIR moves the Claude Code config", () => {
    const s = sandbox({}, { CLAUDE_CONFIG_DIR: "/tmp/elsewhere" });
    assert.equal(detectClients(s.e).find((x) => x.id === "claude-code")!.file, join(resolve("/tmp/elsewhere"), ".claude.json"));
  });
  test("an app that is not installed is not touched; naming it creates its config", async () => {
    const s = sandbox();
    const io = makeIO();
    assert.equal(await runSetup(s.e, io, opts({ dryRun: true, db: s.db })), 0);
    assert.match(io.all(), /I found no app to connect/);
    const io2 = makeIO();
    assert.equal(await runSetup(s.e, io2, opts({ dryRun: true, db: s.db, only: ["cursor"] })), 0);
    assert.match(io2.all(), /\.cursor/);
  });
  test("an unknown client name is refused with the list", async () => {
    const s = sandbox();
    const io = makeIO();
    assert.equal(await runSetup(s.e, io, opts({ only: ["vscode"] })), 1);
    assert.match(io.all(), /Unknown client: vscode/);
  });
});

describe("setup: the entry it writes", () => {
  test("a normal install runs node with the absolute path of cli.js (no PATH needed)", () => {
    const s = sandbox();
    const en = buildServerEntry(s.e, { command: "auto" });
    assert.equal(en.command, "/usr/local/bin/node");
    assert.deepEqual(en.args, [CLI, "mcp"]);
  });
  test("from the npx cache it uses a version-pinned npx, not a path that will be deleted", () => {
    const s = sandbox({ cliPath: "/home/x/.npm/_npx/abc123/node_modules/onememory-mcp/dist/src/cli.js" });
    const en = buildServerEntry(s.e, { command: "auto" });
    assert.equal(en.command, "npx");
    assert.deepEqual(en.args, ["-y", "onememory-mcp@1.7.0", "mcp"]);
  });
  test("on Windows npx is wrapped in cmd /c", () => {
    const s = sandbox({ platform: "win32", cliPath: "C:\\Users\\danie\\AppData\\Local\\npm-cache\\_npx\\1\\node_modules\\onememory-mcp\\dist\\src\\cli.js" });
    const en = buildServerEntry(s.e, { command: "auto" });
    assert.equal(en.command, "cmd");
    assert.deepEqual(en.args, ["/c", "npx", "-y", "onememory-mcp@1.7.0", "mcp"]);
  });
  test("--command node forces the path form even from the npx cache", () => {
    const s = sandbox({ cliPath: "/x/_npx/1/cli.js" });
    assert.equal(buildServerEntry(s.e, { command: "node" }).command, "/usr/local/bin/node");
  });
  test("a Windows path with spaces and an 8.3 name is kept exactly as given", () => {
    const s = sandbox({ platform: "win32", execPath: "C:\\Program Files\\nodejs\\node.exe", cliPath: "C:\\PROGRA~1\\My Tools\\onememory\\dist\\src\\cli.js" });
    const en = buildServerEntry(s.e, { command: "auto" });
    assert.equal(en.command, "C:\\Program Files\\nodejs\\node.exe");
    assert.deepEqual(en.args, ["C:\\PROGRA~1\\My Tools\\onememory\\dist\\src\\cli.js", "mcp"]);
    // and it survives being written into a config and read back
    const file = join(s.root, "c.json");
    writeFileSync(file, "{}");
    writeChange(s.e, { client: "cursor", label: "t", file, before: "{}", ops: [{ op: "set", path: ["mcpServers"], key: "onememory", value: en }], lines: [], inverse: [] });
    assert.deepEqual(json(file).mcpServers.onememory.args, en.args);
  });
  test("the hook command is shell-safe: bare node, forward slashes, quoted path", () => {
    const s = sandbox({ platform: "win32", cliPath: "C:\\Users\\Dan Calas\\x\\dist\\src\\cli.js" });
    assert.equal(buildHookCommand(s.e, { command: "auto" }), 'node "C:/Users/Dan Calas/x/dist/src/cli.js" recall --budget-ms 800');
    assert.match(buildHookCommand(s.e, { command: "auto" }, "D:\\data\\state.db"), /--db "D:\/data\/state\.db"$/);
  });
});

describe("setup: recognising the old claude-bridge entry", () => {
  test("by name, by path, and by CLAUDE_BRIDGE_ variables", () => {
    assert.equal(classifyEntry("claude-bridge", { command: "node" }), "legacy");
    assert.equal(classifyEntry("memory", { command: "node", args: ["C:\\Users\\danie\\my-agent\\claude-bridge\\dist\\src\\mcp-stdio.js"] }), "legacy");
    assert.equal(classifyEntry("m", { command: "node", env: { CLAUDE_BRIDGE_DB_PATH: "x" } }), "legacy");
  });
  test("OneMemory in any name is recognised; other servers are left alone", () => {
    assert.equal(classifyEntry("onememory", {}), "onememory");
    assert.equal(classifyEntry("mem", { command: "npx", args: ["-y", "onememory-mcp", "mcp"] }), "onememory");
    assert.equal(classifyEntry("github", { command: "npx", args: ["-y", "@x/github"] }), "other");
  });
  test("migrating renames CLAUDE_BRIDGE_ variables, keeps the database path and any extra setting", () => {
    const s = sandbox();
    const m = migrateEntry(s.e, { command: "auto" }, { type: "stdio", command: "node", args: ["x"], env: { CLAUDE_BRIDGE_DB_PATH: "C:\\Users\\danie\\data\\state.db", FOO: "1" }, timeout: 5000 }, true);
    assert.equal(m.entry.env!.ONEMEMORY_DB_PATH, "C:\\Users\\danie\\data\\state.db");
    assert.equal(m.entry.env!.FOO, "1");
    assert.equal(m.entry.env!.CLAUDE_BRIDGE_DB_PATH, undefined);
    assert.equal(m.entry.timeout, 5000);
    assert.equal(m.db, "C:\\Users\\danie\\data\\state.db");
  });
  test("with no database named it looks beside the old install, and says so", () => {
    const s = sandbox();
    const old = join(s.root, "my agent", "claude-bridge");
    mkdirSync(join(old, "dist", "src"), { recursive: true });
    mkdirSync(join(old, "data"), { recursive: true });
    writeFileSync(join(old, "data", "state.db"), "x");
    const m = migrateEntry(s.e, { command: "auto" }, { command: "node", args: [join(old, "dist", "src", "mcp-stdio.js")] }, false);
    assert.equal(m.entry.env!.ONEMEMORY_DB_PATH, join(old, "data", "state.db"));
    assert.match(m.notes.join(" "), /found one at/);
  });
  test("with nothing to find it warns that the new store starts empty", () => {
    const s = sandbox();
    const m = migrateEntry(s.e, { command: "auto" }, { command: "node", args: ["/nowhere/dist/src/mcp-stdio.js"] }, false);
    assert.equal(m.entry.env, undefined);
    assert.match(m.notes.join(" "), /start with the standard location/);
  });
});

describe("setup: looking before changing", () => {
  test("--dry-run shows the plan and the exact lines, and changes nothing", async () => {
    const s = sandbox();
    write(ccFile(s.home), REAL_CLAUDE_JSON);
    const io = makeIO();
    assert.equal(await runSetup(s.e, io, opts({ dryRun: true, db: s.db })), 0);
    const text = io.all();
    assert.match(text, /What I will do:/);
    assert.match(text, /add the "onememory" memory server/);
    assert.match(text, /\+\s+"onememory": \{/);
    assert.match(text, /Dry run: nothing was changed/);
    assert.equal(readFileSync(ccFile(s.home), "utf8"), REAL_CLAUDE_JSON);
    assert.deepEqual(listBackups(ccFile(s.home)), []);
    assert.equal(existsSync(s.db), false, "no database was created");
    assert.equal(existsSync(join(s.root, "om-home")), false, "no history folder was created");
  });
  test("secrets in an old entry are masked in the diff", () => {
    assert.match(redact('"CLAUDE_BRIDGE_TOKEN": "abcdef0123456789abcdef0123456789"'), /"\*\*\*"/);
    assert.equal(redact('"command": "node"'), '"command": "node"');
    const d = lineDiff('{\n "a": 1,\n "API_KEY": "sekrit"\n}', '{\n "a": 2,\n "API_KEY": "sekrit"\n}', "f").join("\n");
    assert.ok(!d.includes("sekrit"));
  });
  test("nothing is written without a typed y", async () => {
    const s = sandbox();
    write(ccFile(s.home), REAL_CLAUDE_JSON);
    const io = makeIO(["n"]);
    assert.equal(await runSetup(s.e, io, opts({ db: s.db })), 0);
    assert.match(io.all(), /Cancelled/);
    assert.equal(readFileSync(ccFile(s.home), "utf8"), REAL_CLAUDE_JSON);
    assert.equal(existsSync(s.db), false);
  });
  test("from a script (no terminal) it refuses to guess and says how to proceed", async () => {
    const s = sandbox();
    write(ccFile(s.home), REAL_CLAUDE_JSON);
    const io = makeIO([], false);
    assert.equal(await runSetup(s.e, io, opts({ db: s.db })), 1);
    assert.match(io.all(), /--yes/);
    assert.equal(readFileSync(ccFile(s.home), "utf8"), REAL_CLAUDE_JSON);
  });
  test("a Node that is too old gets a clear message and nothing is touched", async () => {
    const s = sandbox({ nodeVersion: "22.11.0" });
    write(ccFile(s.home), REAL_CLAUDE_JSON);
    const io = makeIO();
    assert.equal(await runSetup(s.e, io, opts({ yes: true })), 1);
    assert.match(io.all(), /needs Node\.js 24 or newer, and this computer has Node 22\.11\.0/);
    assert.match(io.all(), /node -v/);
    assert.equal(readFileSync(ccFile(s.home), "utf8"), REAL_CLAUDE_JSON);
  });
  test("a config file that is not valid JSON stops everything before any change", async () => {
    const s = sandbox();
    write(ccFile(s.home), '{ "mcpServers": { "a": ');
    const io = makeIO();
    assert.equal(await runSetup(s.e, io, opts({ yes: true, db: s.db })), 1);
    assert.match(io.all(), /could not read a configuration file safely/);
    assert.equal(readFileSync(ccFile(s.home), "utf8"), '{ "mcpServers": { "a": ');
    assert.equal(existsSync(s.db), false);
  });
});

describe("setup: making the change", () => {
  test("adds onememory, keeps everything else byte for byte, saves a backup, writes a test note", async () => {
    const s = sandbox();
    write(ccFile(s.home), REAL_CLAUDE_JSON);
    const io = makeIO();
    assert.equal(await runSetup(s.e, io, opts({ yes: true, db: s.db })), 0);
    const after = readFileSync(ccFile(s.home), "utf8");
    assert.ok(after.includes('"bigId": 12345678901234567890'));
    assert.ok(after.includes('"history": [1, 2, 3]'));
    const j = json(ccFile(s.home));
    assert.equal(j.mcpServers.other.command, "npx");
    assert.equal(j.mcpServers.onememory.command, "/usr/local/bin/node");
    assert.equal(j.mcpServers.onememory.type, "stdio");
    assert.deepEqual(j.mcpServers.onememory.env, { ONEMEMORY_DB_PATH: s.db });
    const b = listBackups(ccFile(s.home));
    assert.equal(b.length, 1);
    assert.equal(readFileSync(b[0], "utf8"), REAL_CLAUDE_JSON, "the backup is the original, byte for byte");
    const store = new Store(s.db);
    try {
      const notes = store.list({ withTags: ["setup-check"] }).notes;
      assert.equal(notes.length, 1);
      assert.equal(notes[0].title, "OneMemory is connected");
    } finally {
      store.close();
    }
    assert.match(io.all(), /test note #\d+ written and read back/);
    assert.match(io.all(), /\/mcp/);
    assert.match(io.all(), /onememory setup --undo/);
  });
  test("running it again changes nothing and makes no new backup", async () => {
    const s = sandbox();
    write(ccFile(s.home), REAL_CLAUDE_JSON);
    await runSetup(s.e, makeIO(), opts({ yes: true, db: s.db }));
    const once = readFileSync(ccFile(s.home), "utf8");
    const io = makeIO();
    assert.equal(await runSetup(s.e, io, opts({ yes: true, db: s.db })), 0);
    assert.equal(readFileSync(ccFile(s.home), "utf8"), once);
    assert.equal(listBackups(ccFile(s.home)).length, 1);
    assert.match(io.all(), /already set up/);
  });
  test("the test note is written once, not on every run", async () => {
    const s = sandbox();
    write(ccFile(s.home), REAL_CLAUDE_JSON);
    await runSetup(s.e, makeIO(), opts({ yes: true, db: s.db }));
    await runSetup(s.e, makeIO(), opts({ yes: true, db: s.db, only: ["claude-code"] }));
    const store = new Store(s.db);
    try {
      assert.equal(store.list({ withTags: ["setup-check"] }).total, 1);
    } finally {
      store.close();
    }
  });
  test("--no-test-note skips it", async () => {
    const s = sandbox();
    write(ccFile(s.home), REAL_CLAUDE_JSON);
    await runSetup(s.e, makeIO(), opts({ yes: true, db: s.db, noTestNote: true }));
    const store = new Store(s.db);
    try {
      assert.equal(store.list({}).total, 0);
    } finally {
      store.close();
    }
  });
  test("a typed y goes ahead", async () => {
    const s = sandbox();
    write(ccFile(s.home), REAL_CLAUDE_JSON);
    const io = makeIO(["y", "n"]);
    assert.equal(await runSetup(s.e, io, opts({ db: s.db, noTestNote: true })), 0);
    assert.ok(json(ccFile(s.home)).mcpServers.onememory);
    assert.match(io.asked[0], /Type y/);
  });
  test("Claude Desktop and Cursor are configured when present, each in its own file", async () => {
    const s = sandbox();
    write(join(s.home, ".config", "Claude", "claude_desktop_config.json"), '{\n  "mcpServers": { "files": { "command": "x" } }\n}\n');
    mkdirSync(join(s.home, ".cursor"));
    const io = makeIO();
    assert.equal(await runSetup(s.e, io, opts({ yes: true, db: s.db, noTestNote: true })), 0);
    const desk = json(join(s.home, ".config", "Claude", "claude_desktop_config.json"));
    assert.deepEqual(Object.keys(desk.mcpServers), ["files", "onememory"]);
    assert.equal(desk.mcpServers.onememory.type, undefined, "Desktop entries carry no type");
    assert.ok(json(join(s.home, ".cursor", "mcp.json")).mcpServers.onememory);
  });
  test("a CRLF file with a BOM keeps both", async () => {
    const s = sandbox();
    const orig = '\uFEFF{\r\n  "x": 1,\r\n  "mcpServers": {}\r\n}\r\n';
    write(ccFile(s.home), orig);
    await runSetup(s.e, makeIO(), opts({ yes: true, db: s.db, noTestNote: true }));
    const after = readFileSync(ccFile(s.home), "utf8");
    assert.equal(after.charCodeAt(0), 0xfeff);
    assert.equal(after.replace(/\r\n/g, "").includes("\n"), false);
  });
  test("file permissions are kept (POSIX)", { skip: process.platform === "win32" }, async () => {
    const s = sandbox();
    write(ccFile(s.home), REAL_CLAUDE_JSON);
    chmodSync(ccFile(s.home), 0o600);
    await runSetup(s.e, makeIO(), opts({ yes: true, db: s.db, noTestNote: true }));
    assert.equal(statSync(ccFile(s.home)).mode & 0o777, 0o600);
  });
  test("a symlinked config stays a symlink and its target is the file that changes", { skip: process.platform === "win32" }, async () => {
    const s = sandbox();
    const real = join(s.root, "dotfiles", "claude.json");
    write(real, REAL_CLAUDE_JSON);
    symlinkSync(real, ccFile(s.home));
    await runSetup(s.e, makeIO(), opts({ yes: true, db: s.db, noTestNote: true }));
    assert.ok(lstatSync(ccFile(s.home)).isSymbolicLink(), "still a link");
    assert.ok(json(real).mcpServers.onememory, "the target holds the entry");
    assert.equal(listBackups(real).length, 1, "the backup sits beside the target");
  });
  test("a database that cannot be opened stops BEFORE any config is touched", async () => {
    const s = sandbox();
    write(ccFile(s.home), REAL_CLAUDE_JSON);
    mkdirSync(s.db, { recursive: true }); // a folder where the database file should be
    const io = makeIO();
    assert.equal(await runSetup(s.e, io, opts({ yes: true, db: s.db })), 1);
    assert.match(io.all(), /changed NO configuration/);
    assert.equal(readFileSync(ccFile(s.home), "utf8"), REAL_CLAUDE_JSON);
  });
  test("a database from a NEWER release is never opened", async () => {
    const s = sandbox();
    write(ccFile(s.home), REAL_CLAUDE_JSON);
    mkdirSync(dirname(s.db), { recursive: true });
    const raw = new DatabaseSync(s.db);
    raw.exec(`CREATE TABLE notes(id INTEGER); PRAGMA user_version = ${SCHEMA_VERSION + 5}`);
    raw.close();
    const io = makeIO();
    assert.equal(await runSetup(s.e, io, opts({ yes: true, db: s.db })), 1);
    assert.match(io.all(), /newer than this version/);
    assert.equal(readFileSync(ccFile(s.home), "utf8"), REAL_CLAUDE_JSON);
  });
  test("it runs onememory doctor when asked (a real child process)", async () => {
    const s = sandbox({ env: { HOME: "", ONEMEMORY_HOME: "" } as NodeJS.ProcessEnv });
    s.e.env = { ...process.env, HOME: s.home, USERPROFILE: s.home, ONEMEMORY_HOME: join(s.root, "om-home") };
    write(ccFile(s.home), REAL_CLAUDE_JSON);
    s.e.execPath = process.execPath;
    const io = makeIO();
    assert.equal(await runSetup(s.e, io, { ...opts({ yes: true, db: s.db, noTestNote: true }), noDoctor: false }), 0);
    assert.match(io.all(), /onememory doctor:/);
    assert.match(io.all(), /Node 24/);
    assert.match(io.all(), /database OK at/);
  });
});

describe("setup: undo", () => {
  test("puts the original bytes back", async () => {
    const s = sandbox();
    write(ccFile(s.home), REAL_CLAUDE_JSON);
    await runSetup(s.e, makeIO(), opts({ yes: true, db: s.db, noTestNote: true }));
    assert.notEqual(readFileSync(ccFile(s.home), "utf8"), REAL_CLAUDE_JSON);
    const io = makeIO();
    assert.equal(await runSetup(s.e, io, opts({ undo: true })), 0);
    assert.equal(readFileSync(ccFile(s.home), "utf8"), REAL_CLAUDE_JSON);
    assert.match(io.all(), /restored from/);
    assert.equal(readHistory(s.e)[0].undone, true);
  });
  test("if Claude Code changed the file since, only OUR change comes out", async () => {
    const s = sandbox();
    write(ccFile(s.home), REAL_CLAUDE_JSON);
    await runSetup(s.e, makeIO(), opts({ yes: true, db: s.db, noTestNote: true }));
    const mid = readFileSync(ccFile(s.home), "utf8").replace('"numStartups": 12', '"numStartups": 13');
    writeFileSync(ccFile(s.home), mid);
    const io = makeIO();
    assert.equal(await runSetup(s.e, io, opts({ undo: true })), 0);
    const j = json(ccFile(s.home));
    assert.equal(j.numStartups, 13, "their change is kept");
    assert.equal(j.mcpServers.onememory, undefined, "ours is gone");
    assert.equal(j.mcpServers.other.command, "npx");
    assert.match(io.all(), /only the OneMemory change was taken out/);
  });
  test("a file that setup created is removed again", async () => {
    const s = sandbox();
    mkdirSync(join(s.home, ".cursor"));
    await runSetup(s.e, makeIO(), opts({ yes: true, db: s.db, noTestNote: true }));
    assert.ok(existsSync(join(s.home, ".cursor", "mcp.json")));
    await runSetup(s.e, makeIO(), opts({ undo: true }));
    assert.equal(existsSync(join(s.home, ".cursor", "mcp.json")), false);
  });
  test("nothing to undo says so", async () => {
    const s = sandbox();
    const io = makeIO();
    assert.equal(await runSetup(s.e, io, opts({ undo: true })), 0);
    assert.match(io.all(), /Nothing to undo/);
  });
  test("undo never touches the database", async () => {
    const s = sandbox();
    write(ccFile(s.home), REAL_CLAUDE_JSON);
    await runSetup(s.e, makeIO(), opts({ yes: true, db: s.db }));
    await runSetup(s.e, makeIO(), opts({ undo: true }));
    const store = new Store(s.db);
    try {
      assert.equal(store.list({}).total, 1);
    } finally {
      store.close();
    }
  });
});

describe("setup: moving from claude-bridge", () => {
  function legacyHome(s: ReturnType<typeof sandbox>, env: Record<string, string>) {
    const oldInstall = join(s.root, "my-agent", "claude-bridge");
    mkdirSync(join(oldInstall, "dist", "src"), { recursive: true });
    writeFileSync(join(oldInstall, "dist", "src", "mcp-stdio.js"), "// old build");
    const oldDb = join(oldInstall, "data", "state.db");
    // an old database: real notes, shaped like an earlier release
    mkdirSync(dirname(oldDb), { recursive: true });
    const st = new Store(oldDb);
    for (const t of ["Wi-Fi password location", "Release cadence", "Dentist"]) st.create({ title: t, body: `body of ${t}` });
    st.close();
    downgradeTo(oldDb, 13);
    write(
      ccFile(s.home),
      JSON.stringify({ mcpServers: { "claude-bridge": { type: "stdio", command: "node", args: [join(oldInstall, "dist", "src", "mcp-stdio.js")], env: { CLAUDE_BRIDGE_DB_PATH: oldDb, ...env } }, keep: { command: "k" } } }, null, 2) + "\n"
    );
    return { oldInstall, oldDb };
  }
  const tree = (d: string): string[] => {
    const out: string[] = [];
    const walk = (p: string): void => {
      for (const e of readdirSync(p, { withFileTypes: true })) {
        const f = join(p, e.name);
        if (e.isDirectory()) walk(f);
        else out.push(`${f}:${statSync(f).size}`);
      }
    };
    walk(d);
    return out.sort();
  };

  test("the old entry is replaced by onememory with the same database; notes survive; a verified safety copy is made", async () => {
    const s = sandbox();
    const { oldInstall, oldDb } = legacyHome(s, { CLAUDE_BRIDGE_TOKEN: "x".repeat(40) });
    const installBefore = tree(oldInstall).filter((x) => !x.includes("state.db"));
    const io = makeIO();
    assert.equal(await runSetup(s.e, io, opts({ yes: true })), 0);
    const j = json(ccFile(s.home));
    assert.equal(j.mcpServers["claude-bridge"], undefined);
    assert.equal(j.mcpServers.onememory.env.ONEMEMORY_DB_PATH, oldDb);
    assert.equal(j.mcpServers.onememory.env.ONEMEMORY_TOKEN, "x".repeat(40));
    assert.equal(j.mcpServers.keep.command, "k", "other servers untouched");
    assert.deepEqual(Object.keys(j.mcpServers), ["onememory", "keep"], "same position");
    assert.ok(!io.all().includes("x".repeat(40)), "the token is never printed");
    const back = oldDb + `.pre-v${SCHEMA_VERSION}-backup`;
    assert.ok(existsSync(back), "the pre-upgrade copy exists");
    assert.equal(Store.peekSchemaVersion(back), 13, "and it is still the OLD format");
    const st = new Store(oldDb);
    try {
      assert.equal(st.list({}).total, 4, "3 old notes + the test note");
      assert.ok(st.list({}).notes.some((n) => n.title === "Release cadence"));
    } finally {
      st.close();
    }
    assert.deepEqual(tree(oldInstall).filter((x) => !x.includes("state.db")), installBefore, "the old install folder is untouched");
  });
  test("the plan tells the person the upgrade is one-way and names the safety copy", async () => {
    const s = sandbox();
    const { oldDb } = legacyHome(s, {});
    const io = makeIO();
    await runSetup(s.e, io, opts({ dryRun: true }));
    assert.match(io.all(), /schema v13; this version upgrades it to v16/);
    assert.match(io.all(), /pre-v16-backup/);
    assert.match(io.all(), /close Claude Code/i);
    assert.equal(Store.peekSchemaVersion(oldDb), 13, "a dry run did not upgrade it");
  });
  test("undo brings the claude-bridge entry back exactly", async () => {
    const s = sandbox();
    legacyHome(s, {});
    const orig = readFileSync(ccFile(s.home), "utf8");
    await runSetup(s.e, makeIO(), opts({ yes: true, noTestNote: true }));
    await runSetup(s.e, makeIO(), opts({ undo: true }));
    assert.equal(readFileSync(ccFile(s.home), "utf8"), orig);
  });
  test("a legacy entry under a project (local scope) is migrated in place", async () => {
    const s = sandbox();
    const oldDb = join(s.root, "old", "state.db");
    mkdirSync(dirname(oldDb), { recursive: true });
    new Store(oldDb).close();
    write(ccFile(s.home), JSON.stringify({ projects: { "/w/a": { mcpServers: { "claude-bridge": { command: "node", args: ["/x/claude-bridge/dist/src/mcp-stdio.js"], env: { CLAUDE_BRIDGE_DB_PATH: oldDb } } } } } }, null, 2));
    assert.equal(await runSetup(s.e, makeIO(), opts({ yes: true, noTestNote: true })), 0);
    const j = json(ccFile(s.home));
    assert.equal(j.projects["/w/a"].mcpServers.onememory.env.ONEMEMORY_DB_PATH, oldDb);
    assert.equal(j.mcpServers, undefined, "no second entry was added at the top");
  });
  test("both claude-bridge and onememory present: it stops and explains, changing nothing", async () => {
    const s = sandbox();
    const orig = JSON.stringify({ mcpServers: { "claude-bridge": { command: "node" }, onememory: { command: "x" } } }, null, 2);
    write(ccFile(s.home), orig);
    const io = makeIO();
    assert.equal(await runSetup(s.e, io, opts({ yes: true, db: s.db })), 1);
    assert.match(io.all(), /both "claude-bridge" and "onememory" exist/);
    assert.equal(readFileSync(ccFile(s.home), "utf8"), orig);
  });
  test("a shell that still has CLAUDE_BRIDGE_DB_PATH set carries it into the new entry", async () => {
    const s = sandbox({}, { CLAUDE_BRIDGE_DB_PATH: join(dirname(sandbox().db), "shell.db") });
    write(ccFile(s.home), "{}");
    await runSetup(s.e, makeIO(), opts({ yes: true, noTestNote: true }));
    assert.match(json(ccFile(s.home)).mcpServers.onememory.env.ONEMEMORY_DB_PATH, /shell\.db$/);
  });
});

describe("setup: the start-of-session hook", () => {
  const SETTINGS = '{\n  // my settings\n  "theme": "dark",\n  "hooks": {\n    "SessionStart": [\n      { "matcher": "resume", "hooks": [{ "type": "command", "command": "echo hi" }] }\n    ],\n    "Stop": [ { "hooks": [] } ]\n  }\n}\n';
  test("--hook merges into existing hooks without disturbing them (comments too)", async () => {
    const s = sandbox();
    write(ccFile(s.home), "{}");
    write(join(s.home, ".claude", "settings.json"), SETTINGS);
    assert.equal(await runSetup(s.e, makeIO(), opts({ yes: true, hook: "yes", db: s.db, noTestNote: true })), 0);
    const text = readFileSync(join(s.home, ".claude", "settings.json"), "utf8");
    assert.ok(text.includes("// my settings"));
    const j = JSON.parse(text.replace(/\/\/[^\n]*/g, ""));
    assert.equal(j.hooks.SessionStart.length, 2);
    assert.equal(j.hooks.SessionStart[0].hooks[0].command, "echo hi");
    assert.match(j.hooks.SessionStart[1].hooks[0].command, /recall --budget-ms 800 --db "/);
    assert.equal(j.hooks.Stop.length, 1);
    assert.equal(j.theme, "dark");
    assert.equal(listBackups(join(s.home, ".claude", "settings.json")).length, 1);
  });
  test("--yes alone never adds a hook", async () => {
    const s = sandbox();
    write(ccFile(s.home), "{}");
    write(join(s.home, ".claude", "settings.json"), SETTINGS);
    await runSetup(s.e, makeIO(), opts({ yes: true, db: s.db, noTestNote: true }));
    assert.equal(readFileSync(join(s.home, ".claude", "settings.json"), "utf8"), SETTINGS);
  });
  test("--no-hook never offers it", async () => {
    const s = sandbox();
    write(ccFile(s.home), "{}");
    const io = makeIO(["y"]);
    await runSetup(s.e, io, opts({ hook: "no", db: s.db, noTestNote: true }));
    assert.equal(io.asked.length, 1);
    assert.equal(existsSync(join(s.home, ".claude", "settings.json")), false);
  });
  test("interactively it asks separately, and a no leaves settings.json alone", async () => {
    const s = sandbox();
    write(ccFile(s.home), "{}");
    write(join(s.home, ".claude", "settings.json"), SETTINGS);
    const io = makeIO(["y", "n"]);
    await runSetup(s.e, io, opts({ db: s.db, noTestNote: true }));
    assert.equal(io.asked.length, 2);
    assert.match(io.asked[1], /start-of-session hook/);
    assert.equal(readFileSync(join(s.home, ".claude", "settings.json"), "utf8"), SETTINGS);
  });
  test("an existing onememory hook is recognised and not duplicated", async () => {
    const s = sandbox();
    write(ccFile(s.home), "{}");
    write(join(s.home, ".claude", "settings.json"), '{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"onememory recall --budget-ms 800"}]}]}}');
    const before = readFileSync(join(s.home, ".claude", "settings.json"), "utf8");
    const io = makeIO();
    await runSetup(s.e, io, opts({ yes: true, hook: "yes", db: s.db, noTestNote: true }));
    assert.equal(readFileSync(join(s.home, ".claude", "settings.json"), "utf8"), before);
    assert.match(io.all(), /hook is already installed/);
  });
  test("undo takes the hook out again and keeps the user's own hooks", async () => {
    const s = sandbox();
    write(ccFile(s.home), "{}");
    write(join(s.home, ".claude", "settings.json"), SETTINGS);
    await runSetup(s.e, makeIO(), opts({ yes: true, hook: "yes", db: s.db, noTestNote: true }));
    await runSetup(s.e, makeIO(), opts({ undo: true }));
    assert.equal(readFileSync(join(s.home, ".claude", "settings.json"), "utf8"), SETTINGS);
  });
  test("doctor sees a hook written by setup as wired", () => {
    const s = sandbox();
    const cmd = buildHookCommand(s.e, { command: "auto" });
    assert.ok(/(onememory|cli\.js)[\s\S]{0,60}\brecall\b/.test(JSON.stringify([{ hooks: [{ command: cmd }] }])));
  });
});

describe("setup: Claude Code rewriting its file while we work", () => {
  test("a change made between the plan and the write is kept, ours is added to the newer text", () => {
    const s = sandbox();
    write(ccFile(s.home), REAL_CLAUDE_JSON);
    const target = detectClients(s.e)[0];
    const planned = planFile(s.e, DEFAULT_OPTIONS, target, { dbs: new Set() });
    assert.ok(planned.change);
    // Claude Code writes while the person is reading the plan
    const theirs = REAL_CLAUDE_JSON.replace('"numStartups": 12', '"numStartups": 99');
    writeFileSync(ccFile(s.home), theirs);
    const w = writeChange(s.e, planned.change!);
    assert.ok(w);
    const j = json(ccFile(s.home));
    assert.equal(j.numStartups, 99, "their newer value survived");
    assert.ok(j.mcpServers.onememory, "our entry is there");
    assert.equal(readFileSync(w!.backup!, "utf8"), theirs, "and the backup is the NEWER file, not the stale one we planned from");
  });
  test("if someone already added the same entry, the write is a no-op", () => {
    const s = sandbox();
    write(ccFile(s.home), "{}");
    const target = detectClients(s.e)[0];
    const change = planFile(s.e, DEFAULT_OPTIONS, target, { dbs: new Set() }).change!;
    assert.ok(writeChange(s.e, change));
    const before = readFileSync(ccFile(s.home), "utf8");
    assert.equal(writeChange(s.e, change), null);
    assert.equal(readFileSync(ccFile(s.home), "utf8"), before);
    assert.equal(listBackups(ccFile(s.home)).length, 1);
  });
  test("no temp file is left behind", () => {
    const s = sandbox();
    write(ccFile(s.home), REAL_CLAUDE_JSON);
    const target = detectClients(s.e)[0];
    writeChange(s.e, planFile(s.e, DEFAULT_OPTIONS, target, { dbs: new Set() }).change!);
    assert.deepEqual(readdirSync(s.home).filter((f) => f.includes("tmp")), []);
  });
  test("a file that is not UTF-8 text is refused rather than corrupted", () => {
    const s = sandbox();
    writeFileSync(ccFile(s.home), Buffer.from([0x7b, 0xff, 0xfe, 0x7d]));
    assert.throws(() => planFile(s.e, DEFAULT_OPTIONS, detectClients(s.e)[0], { dbs: new Set() }), /not valid UTF-8/);
  });
});

describe("setup: wiring", () => {
  test("`onememory help` lists setup and the new import and sync forms", async () => {
    const { spawnSync } = await import("node:child_process");
    const r = spawnSync(process.execPath, [CLI, "help"], { encoding: "utf8" });
    assert.match(r.stdout, /setup \[--dry-run\]/);
    assert.match(r.stdout, /import --claude/);
    assert.match(r.stdout, /sync --git/);
  });
  test("`onememory setup --dry-run` runs from the command line against a temporary home", async () => {
    const { spawnSync } = await import("node:child_process");
    const s = sandbox();
    write(ccFile(s.home), REAL_CLAUDE_JSON);
    const r = spawnSync(process.execPath, [CLI, "setup", "--dry-run"], { encoding: "utf8", env: { ...process.env, HOME: s.home, USERPROFILE: s.home, ONEMEMORY_HOME: join(s.root, "om-home") } });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Dry run: nothing was changed/);
    assert.equal(readFileSync(ccFile(s.home), "utf8"), REAL_CLAUDE_JSON);
  });
  test("realEnv reports this process", () => {
    const e = realEnv("9.9.9", CLI);
    assert.equal(e.version, "9.9.9");
    assert.equal(e.platform, process.platform);
  });
});
