// Fixes from the self-review of 1.7.0: each one has a test that fails without the fix.
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyOps } from "../src/jsonc-edit.js";
import { DEFAULT_OPTIONS, longPath, planHook, redact, runSetup, writeChange, type SetupEnv, type SetupIO, type SetupOptions } from "../src/setup.js";
import { runGitSync } from "../src/sync-git.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "src", "cli.js");
const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});
const tmp = (): string => {
  const r = mkdtempSync(join(tmpdir(), "om-rev-"));
  roots.push(r);
  return r;
};
function env(): { root: string; e: SetupEnv; db: string } {
  const root = tmp();
  const home = join(root, "home");
  mkdirSync(home);
  return {
    root,
    db: join(root, "data", "state.db"),
    e: { home, platform: "linux", env: { HOME: home, ONEMEMORY_HOME: join(root, "om") }, cwd: root, nodeVersion: "24.4.1", execPath: process.execPath, cliPath: CLI, version: "1.7.0", now: () => new Date("2026-10-25T12:00:00Z") },
  };
}
function io(): SetupIO & { all: () => string } {
  const l: string[] = [];
  return { interactive: false, out: (x) => void l.push(x), err: (x) => void l.push(x), ask: async () => "", all: () => l.join("\n") };
}
const opts = (o: Partial<SetupOptions> = {}): SetupOptions => ({ ...DEFAULT_OPTIONS, noDoctor: true, noTestNote: true, ...o });
const SET = [{ op: "set" as const, path: ["mcpServers"], key: "onememory", value: { command: "node" } }];

describe("review: old Node gets a plain message, not a stack trace", () => {
  test("a fake old Node version prints the fix and changes nothing", () => {
    // Run the CLI with process.versions.node overridden before it loads.
    const root = tmp();
    const shim = join(root, "shim.mjs");
    writeFileSync(shim, `Object.defineProperty(process.versions, "node", { value: "22.1.0" });\nawait import(${JSON.stringify("file://" + CLI.replace(/\\/g, "/"))});\n`);
    const r = spawnSync(process.execPath, [shim, "setup", "--dry-run"], { encoding: "utf8", env: { ...process.env, HOME: root, USERPROFILE: root, ONEMEMORY_HOME: join(root, "om") } });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /needs Node\.js 24 or newer.*Node 22\.1\.0/s);
    assert.doesNotMatch(r.stderr, /node:sqlite|at .*\.js:\d+/);
    assert.ok(!existsSync(join(root, "om")), "nothing created");
  });
  test("help still works on old Node", () => {
    const root = tmp();
    const shim = join(root, "shim.mjs");
    writeFileSync(shim, `Object.defineProperty(process.versions, "node", { value: "22.1.0" });\nawait import(${JSON.stringify("file://" + CLI.replace(/\\/g, "/"))});\n`);
    const r = spawnSync(process.execPath, [shim, "help"], { encoding: "utf8", env: { ...process.env, HOME: root, ONEMEMORY_HOME: join(root, "om") } });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /setup/);
  });
});

describe("review: a file with only comments keeps them", () => {
  test("// and /* */ comments survive the first edit", () => {
    const before = "// my notes\r\n/* keep me */\r\n";
    const after = applyOps(before, SET);
    assert.ok(after.startsWith(before), "the comments are still the first bytes");
    assert.deepEqual(JSON.parse(after.replace(/\/\/.*|\/\*[\s\S]*?\*\//g, "")), { mcpServers: { onememory: { command: "node" } } });
    assert.match(after, /\r\n/);
    assert.doesNotMatch(after.replace(/\r\n/g, ""), /\n/, "line endings stay CRLF");
  });
  test("a comment without a final newline still gets a valid file", () => {
    const after = applyOps("// hi", SET);
    assert.ok(after.startsWith("// hi"));
    assert.ok(JSON.parse(after.replace(/\/\/.*/g, "")).mcpServers.onememory);
  });
  test("an empty file and a BOM-only file still work", () => {
    assert.ok(JSON.parse(applyOps("", SET)).mcpServers.onememory);
    const b = applyOps("\uFEFF", SET);
    assert.ok(b.startsWith("\uFEFF"));
    assert.ok(JSON.parse(b.slice(1)).mcpServers.onememory);
  });
});

describe("review: a dangling symlink is refused", { skip: process.platform === "win32" }, () => {
  test("writeChange will not replace a broken link with a regular file", () => {
    const { root, e } = env();
    const f = join(e.home, ".claude.json");
    symlinkSync(join(root, "gone", "claude.json"), f);
    assert.throws(() => writeChange(e, { client: "claude-code", label: "x", file: f, before: null, ops: SET, lines: [], inverse: [] }), /link to a file that does not exist/);
    assert.ok(lstatSync(f).isSymbolicLink(), "the link is still a link");
  });
  test("a missing file (no link) is still created", () => {
    const { e } = env();
    const f = join(e.home, "sub", ".claude.json");
    writeChange(e, { client: "claude-code", label: "x", file: f, before: null, ops: SET, lines: [], inverse: [] });
    assert.ok(JSON.parse(readFileSync(f, "utf8")).mcpServers.onememory);
  });
});

describe("review: paths are expanded to their real long form", () => {
  test("longPath returns an existing path unchanged in meaning and tolerates a missing one", () => {
    const root = tmp();
    assert.equal(longPath(root), longPath(longPath(root)), "idempotent");
    const missing = join(root, "no", "such.js");
    assert.equal(longPath(missing), missing);
  });
  test("a symlinked install folder resolves to the real one", { skip: process.platform === "win32" }, () => {
    const root = tmp();
    mkdirSync(join(root, "real"));
    writeFileSync(join(root, "real", "cli.js"), "");
    symlinkSync(join(root, "real"), join(root, "link"));
    assert.equal(longPath(join(root, "link", "cli.js")), longPath(join(root, "real", "cli.js")));
  });
});

describe("review: the diff on screen hides more secrets", () => {
  test("any ALL_CAPS env value is masked unless it is a plain path/port/host", () => {
    assert.match(redact('"OPENAI_API_KEY": "sk-abc"'), /"\*\*\*"/);
    assert.match(redact('"STRIPE_SECRET": "x"'), /"\*\*\*"/);
    assert.match(redact('"DB_URL": "x"'), /"\*\*\*"/);
    assert.match(redact('"MY_CRED": "hunter2"'), /"\*\*\*"/);
    assert.doesNotMatch(redact('"SOME_VENDOR_ID": "abc123"'), /abc123/);
  });
  test("paths, ports and the like stay readable so the diff is useful", () => {
    assert.equal(redact('"ONEMEMORY_DB_PATH": "C:\\\\x\\\\state.db"'), '"ONEMEMORY_DB_PATH": "C:\\\\x\\\\state.db"');
    assert.equal(redact('"ONEMEMORY_PORT": "8080"'), '"ONEMEMORY_PORT": "8080"');
    assert.equal(redact('"ONEMEMORY_HOME": "/h"'), '"ONEMEMORY_HOME": "/h"');
    assert.equal(redact('"command": "node"'), '"command": "node"');
  });
  test("passwords inside URLs are masked", () => {
    const out = redact('"args": ["https://bob:s3cret@example.com/x"]');
    assert.doesNotMatch(out, /s3cret/);
    assert.match(out, /bob:\*\*\*@example\.com/);
  });
  test("a URL without credentials is left alone", () => {
    assert.equal(redact('"u": "https://example.com/a:b@c"'), '"u": "https://example.com/a:b@c"');
  });
});

describe("review: only our own hook counts as 'already installed'", () => {
  function withSettings(text: string) {
    const x = env();
    mkdirSync(join(x.e.home, ".claude"), { recursive: true });
    writeFileSync(join(x.e.home, ".claude", "settings.json"), text);
    return x;
  }
  test("another tool's recall hook that merely mentions cli.js is NOT ours", () => {
    const x = withSettings('{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"node other/cli.js recall --everything"}]}]}}');
    const r = planHook(x.e, opts());
    assert.equal(r.already, false);
    assert.ok(r.change);
  });
  test("our own command is recognised", () => {
    const x = withSettings('{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"node \\"/a/dist/src/cli.js\\" recall --budget-ms 800"}]}]}}');
    assert.equal(planHook(x.e, opts()).already, true);
  });
  test("an npx-style onememory recall line is recognised", () => {
    const x = withSettings('{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"npx -y onememory-mcp@1.7.0 recall"}]}]}}');
    assert.equal(planHook(x.e, opts()).already, true);
  });
  test("an unrelated hook gets ours added next to it", () => {
    const x = withSettings('{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"echo hi"}]}]}}');
    const r = planHook(x.e, opts());
    assert.equal(r.already, false);
    const after = JSON.parse(applyOps(r.change!.before ?? "", r.change!.ops));
    assert.equal(after.hooks.SessionStart.length, 2);
  });
});

describe("review: setup with nothing to do is short", () => {
  test("already connected prints a short message and no plan", async () => {
    const x = env();
    writeFileSync(join(x.e.home, ".claude.json"), "{}\n");
    assert.equal(await runSetup(x.e, io(), opts({ yes: true, db: x.db, hook: "no", only: ["claude-code"] })), 0);
    const o = io();
    assert.equal(await runSetup(x.e, o, opts({ yes: true, db: x.db, hook: "no", only: ["claude-code"] })), 0);
    assert.match(o.all(), /Nothing to change: OneMemory is already connected/);
    assert.doesNotMatch(o.all(), /What I will do/);
    assert.doesNotMatch(o.all(), /The exact change/);
  });
  test("no app found says so and does not print a plan", async () => {
    const x = env();
    const o = io();
    assert.equal(await runSetup(x.e, o, opts({ yes: true, db: x.db })), 0);
    assert.match(o.all(), /found no app to connect/);
    assert.doesNotMatch(o.all(), /What I will do/);
  });
});

describe("review: dry runs create nothing", () => {
  const run = (root: string, ...args: string[]) =>
    spawnSync(process.execPath, [CLI, ...args], {
      encoding: "utf8",
      env: { ...process.env, HOME: join(root, "h"), USERPROFILE: join(root, "h"), ONEMEMORY_HOME: join(root, "om"), ONEMEMORY_DB_PATH: join(root, "om", "state.db") },
    });
  test("import --claude --dry-run leaves the data folder absent", () => {
    const root = tmp();
    mkdirSync(join(root, "h", ".claude"), { recursive: true });
    writeFileSync(join(root, "h", ".claude", "CLAUDE.md"), "# Rules\n\nUse tabs.\n");
    const r = run(root, "import", "--claude", "--dry-run");
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!existsSync(join(root, "om")), "no data folder was made");
  });
  test("sync --git --dry-run leaves the data folder absent", () => {
    const root = tmp();
    mkdirSync(join(root, "repo"));
    spawnSync("git", ["init", "-q", "-b", "main"], { cwd: join(root, "repo") });
    const r = run(root, "sync", "--git", join(root, "repo"), "--dry-run");
    assert.ok(r.status === 0 || r.status === 1, r.stderr);
    assert.ok(!existsSync(join(root, "om")), "no data folder was made");
  });
});

const haveGit = spawnSync("git", ["--version"]).status === 0;
describe("review: a hostile repository cannot make sync follow links", { skip: !haveGit || process.platform === "win32" }, () => {
  const GITENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } as NodeJS.ProcessEnv;
  function repoWithLink(name: string) {
    const root = tmp();
    const repo = join(root, "repo");
    mkdirSync(repo);
    spawnSync("git", ["init", "-q", "-b", "main"], { cwd: repo, env: GITENV });
    const outside = join(root, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "secret.md"), "---\ntitle: x\n---\nbody\n");
    symlinkSync(outside, join(repo, name));
    return { root, repo, outside };
  }
  const go = async (root: string, repo: string, encrypt: boolean) => {
    const l: string[] = [];
    const code = await runGitSync(
      { interactive: false, out: (x) => void l.push(x), err: (x) => void l.push(x), ask: async () => "" },
      { repo, encrypt, dryRun: false, noPush: true, yes: true, dataDir: join(root, "d"), dbPath: join(root, "d", "state.db"), env: GITENV, keyFile: join(root, "key") }
    );
    return { code, text: l.join("\n") };
  };
  test("a symlinked plain vault folder is refused", async () => {
    const t = repoWithLink("onememory");
    const r = await go(t.root, t.repo, false);
    assert.equal(r.code, 1);
    assert.match(r.text, /will not follow/);
    assert.deepEqual(readFileSync(join(t.outside, "secret.md"), "utf8"), "---\ntitle: x\n---\nbody\n", "target untouched");
  });
  test("a symlinked sealed vault folder is refused", async () => {
    const t = repoWithLink("onememory-enc");
    const r = await go(t.root, t.repo, true);
    assert.equal(r.code, 1);
    assert.match(r.text, /will not follow/);
  });
  test("a symlink named like the OTHER mode's folder is refused too", async () => {
    const t = repoWithLink("onememory-enc");
    const r = await go(t.root, t.repo, false);
    assert.equal(r.code, 1);
    assert.match(r.text, /will not follow/);
  });
  test("a .enc entry that is a link is skipped, not read", async () => {
    const root = tmp();
    const repo = join(root, "repo");
    mkdirSync(join(repo, "onememory-enc"), { recursive: true });
    spawnSync("git", ["init", "-q", "-b", "main"], { cwd: repo, env: GITENV });
    const first = await go(root, repo, true); // creates the key
    assert.equal(first.code, 0, first.text);
    const target = join(root, "target.txt");
    writeFileSync(target, "not a sealed file");
    symlinkSync(target, join(repo, "onememory-enc", "a".repeat(32) + ".enc"));
    const r = await go(root, repo, true);
    assert.doesNotMatch(r.text, /could not open the sealed file/);
    assert.equal(r.code, 0, r.text);
  });
});
