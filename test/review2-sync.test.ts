// 1.7.1: git sync stays quiet once both computers agree, and its dry run creates nothing.
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGitSync, scrubUrls, type GitSyncOptions } from "../src/sync-git.js";
import { Store } from "../src/store.js";
import { actorStore } from "../src/actor.js";

const haveGit = spawnSync("git", ["--version"]).status === 0;
const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});
const GITENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } as NodeJS.ProcessEnv;
const g = (cwd: string, ...args: string[]): string => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: GITENV });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};
interface Dev { repo: string; dataDir: string; db: string; writer: string }
function world() {
  const root = mkdtempSync(join(tmpdir(), "om-gs2-"));
  roots.push(root);
  const remote = join(root, "remote.git");
  mkdirSync(remote);
  g(remote, "init", "--bare", "-b", "main");
  const device = (name: string): Dev => {
    mkdirSync(join(root, name), { recursive: true });
    g(join(root, name), "clone", remote, "repo");
    const repo = join(root, name, "repo");
    g(repo, "checkout", "-B", "main");
    return { repo, dataDir: join(root, name, "data"), db: join(root, name, "data", "state.db"), writer: `${name}-store/cli` };
  };
  return { root, remote, a: device("a"), b: device("b") };
}
const sync = async (d: Dev, o: Partial<GitSyncOptions> = {}) => {
  const lines: string[] = [];
  // each computer has its own writer name, like the real "<store id>/cli"
  const code = await actorStore.run({ label: d.writer, authed: true }, () => runGitSync(
    { interactive: false, out: (l) => void lines.push(l), err: (l) => void lines.push(l), ask: async () => "" },
    { repo: d.repo, encrypt: false, dryRun: false, noPush: false, yes: true, dataDir: d.dataDir, dbPath: d.db, env: GITENV, ...o }
  ));
  return { code, text: lines.join("\n") };
};
const put = (d: Dev, title: string, body: string): void => {
  mkdirSync(d.dataDir, { recursive: true });
  const s = new Store(d.db);
  actorStore.run({ label: d.writer, authed: true }, () => s.create({ title, body }));
  s.close();
};
const skip = !haveGit ? "git is not installed" : false;

describe("sync --git: two computers settle", { skip }, () => {
  test("after a few rounds nobody has anything new to commit (plain)", async () => {
    const w = world();
    put(w.a, "From A", "a body");
    put(w.b, "From B", "b body");
    for (const d of [w.a, w.b, w.a, w.b, w.a, w.b]) assert.equal((await sync(d)).code, 0);
    const heads = [g(w.a.repo, "rev-parse", "HEAD"), g(w.b.repo, "rev-parse", "HEAD")];
    for (let i = 0; i < 3; i++) {
      for (const d of [w.a, w.b]) {
        const r = await sync(d);
        assert.equal(r.code, 0, r.text);
        assert.match(r.text, /nothing new to commit/, `round ${i}: ${r.text}`);
      }
    }
    assert.equal(g(w.a.repo, "rev-parse", "HEAD"), g(w.b.repo, "rev-parse", "HEAD"));
    assert.ok(heads[0].length > 0);
  });
  test("the same holds when the files are sealed", async () => {
    const w = world();
    const keyA = join(w.root, "keyA");
    put(w.a, "From A", "a body");
    assert.equal((await sync(w.a, { encrypt: true, keyFile: keyA })).code, 0);
    writeFileSync(join(w.root, "keyB"), readFileSync(keyA));
    put(w.b, "From B", "b body");
    for (const [d, k] of [[w.b, "keyB"], [w.a, "keyA"], [w.b, "keyB"], [w.a, "keyA"]] as const) assert.equal((await sync(d, { encrypt: true, keyFile: join(w.root, k) })).code, 0);
    for (let i = 0; i < 2; i++)
      for (const [d, k] of [[w.a, "keyA"], [w.b, "keyB"]] as const) {
        const r = await sync(d, { encrypt: true, keyFile: join(w.root, k) });
        assert.match(r.text, /nothing new to commit/, r.text);
      }
  });
  test("an imported note keeps the writer name its file came with", async () => {
    const w = world();
    put(w.a, "Origin note", "x");
    await sync(w.a);
    await sync(w.b);
    const f = readdirSync(join(w.a.repo, "onememory"), { recursive: true }).map(String).find((x) => x.endsWith(".md"))!;
    const text = readFileSync(join(w.a.repo, "onememory", f), "utf8");
    const claim = /origin_writer: (".*")/.exec(text)![1];
    for (const d of [w.b, w.a, w.b]) await sync(d);
    const after = readFileSync(join(w.a.repo, "onememory", f), "utf8");
    assert.equal(/origin_writer: (".*")/.exec(after)![1], claim);
    assert.notEqual(JSON.parse(claim), "", "never blank");
  });
});

describe("sync --git: a dry run creates nothing", { skip }, () => {
  test("no data folder, no database, no upgrade of an old database", async () => {
    const w = world();
    put(w.a, "From A", "x");
    assert.equal((await sync(w.a)).code, 0);
    g(w.b.repo, "pull", "origin", "main");
    const r = await sync(w.b, { dryRun: true });
    assert.equal(r.code, 0, r.text);
    assert.match(r.text, /Dry run/);
    assert.ok(!existsSync(w.b.dataDir), "no data folder was created");
    assert.ok(!existsSync(w.b.db), "no database was created");
  });
  test("an existing old-schema database is left at its version", async () => {
    const w = world();
    put(w.a, "From A", "x");
    assert.equal((await sync(w.a)).code, 0);
    g(w.b.repo, "pull", "origin", "main");
    mkdirSync(w.b.dataDir, { recursive: true });
    const { DatabaseSync } = await import("node:sqlite");
    const raw = new DatabaseSync(w.b.db);
    raw.exec("CREATE TABLE notes(id INTEGER PRIMARY KEY, title TEXT); INSERT INTO notes(title) VALUES ('old'); PRAGMA user_version = 13");
    raw.close();
    const r = await sync(w.b, { dryRun: true });
    assert.equal(r.code, 0, r.text);
    assert.match(r.text, /older schema \(v13\)/);
    assert.equal(Store.peekSchemaVersion(w.b.db), 13);
    assert.deepEqual(readdirSync(w.b.dataDir).sort(), ["state.db"], "nothing beside it, no backup");
  });
});

describe("sync --git: credentials in remote URLs", { skip }, () => {
  test("scrubUrls hides user:password@ and tokens in userinfo", () => {
    assert.equal(scrubUrls("fatal: unable to access 'https://bob:s3cret@github.com/x/y.git/'"), "fatal: unable to access 'https://***@github.com/x/y.git/'");
    assert.equal(scrubUrls("https://ghp_abcdefghijklmnopqrstuvwxyz0123456789@github.com/x"), "https://***@github.com/x");
    assert.equal(scrubUrls("ssh://git@host/x.git"), "ssh://***@host/x.git");
    assert.equal(scrubUrls("https://example.com/path"), "https://example.com/path");
  });
  test("scrubUrls is fast on hostile text", () => {
    const t0 = Date.now();
    scrubUrls("http://" + "a:".repeat(300_000));
    scrubUrls("a".repeat(1_000_000) + "://");
    assert.ok(Date.now() - t0 < 3000);
  });
  test("a remote whose URL carries a password is refused and the password is never printed", async () => {
    const w = world();
    g(w.a.repo, "remote", "set-url", "origin", "https://bob:hunter2pw@example.invalid/x.git");
    put(w.a, "n", "b");
    const r = await sync(w.a);
    assert.equal(r.code, 1);
    assert.match(r.text, /password or token inside its address/);
    assert.doesNotMatch(r.text, /hunter2pw/);
  });
  test("git error text is scrubbed", async () => {
    const w = world();
    g(w.a.repo, "remote", "set-url", "origin", "https://example.invalid/x.git");
    put(w.a, "n", "b");
    const r = await sync(w.a);
    assert.doesNotMatch(r.text, /:\/\/[^\s/@]+@/);
  });
});
