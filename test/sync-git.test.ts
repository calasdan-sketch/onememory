// `onememory sync --git`: two "computers" (two databases) and a private "remote" (a local bare repository).
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blobName, isInside, openFile, runGitSync, safeRelPath, sealFile, syncKeyPath, type GitSyncOptions } from "../src/sync-git.js";
import { Store } from "../src/store.js";
import { createHash, randomBytes } from "node:crypto";

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

interface Dev {
  name: string;
  repo: string;
  dataDir: string;
  db: string;
}

function world() {
  const root = mkdtempSync(join(tmpdir(), "om-gsync-"));
  roots.push(root);
  const remote = join(root, "remote.git");
  mkdirSync(remote);
  g(remote, "init", "--bare", "-b", "main");
  const device = (name: string): Dev => {
    const repo = join(root, name, "repo");
    mkdirSync(join(root, name), { recursive: true });
    g(join(root, name), "clone", remote, "repo");
    g(repo, "checkout", "-B", "main");
    return { name, repo, dataDir: join(root, name, "data"), db: join(root, name, "data", "state.db") };
  };
  return { root, remote, a: device("a"), b: device("b") };
}

function io() {
  const lines: string[] = [];
  const errs: string[] = [];
  return { lines, errs, interactive: false, out: (l: string) => void lines.push(l), err: (l: string) => void errs.push(l), ask: async () => "", all: () => [...lines, ...errs].join("\n") };
}
const sync = (d: Dev, o: Partial<GitSyncOptions> = {}) => {
  const x = io();
  return runGitSync(x, { repo: d.repo, encrypt: false, dryRun: false, noPush: false, yes: true, dataDir: d.dataDir, dbPath: d.db, env: GITENV, ...o }).then((code) => ({ code, x }));
};
const notes = (d: Dev) => {
  const s = new Store(d.db);
  try {
    return s.list({ limit: 500 }).notes;
  } finally {
    s.close();
  }
};
const put = (d: Dev, title: string, body: string): void => {
  mkdirSync(d.dataDir, { recursive: true });
  const s = new Store(d.db);
  s.create({ title, body });
  s.close();
};
const skip = !haveGit ? "git is not installed" : false;

describe("sync --git: plain files", { skip }, () => {
  test("a note written on one computer shows up on the other, and edits travel back", async () => {
    const w = world();
    put(w.a, "Release cadence", "Ship on Thursdays");
    const a1 = await sync(w.a);
    assert.equal(a1.code, 0, a1.x.all());
    assert.match(a1.x.all(), /pushed to origin\/main/);
    const b1 = await sync(w.b);
    assert.equal(b1.code, 0, b1.x.all());
    assert.deepEqual(notes(w.b).map((n) => n.title), ["Release cadence"]);
    // edit on B
    const sb = new Store(w.b.db);
    const n = sb.list({}).notes[0];
    sb.update(n.id, { body: "Ship on Fridays now" });
    sb.close();
    assert.equal((await sync(w.b)).code, 0);
    assert.equal((await sync(w.a)).code, 0);
    assert.equal(notes(w.a)[0].body.trim(), "Ship on Fridays now");
  });
  test("both computers adding different notes converge to the same set", async () => {
    const w = world();
    put(w.a, "From A", "a");
    put(w.b, "From B", "b");
    await sync(w.a);
    await sync(w.b);
    await sync(w.a);
    assert.deepEqual(notes(w.a).map((n) => n.title).sort(), ["From A", "From B"]);
    assert.deepEqual(notes(w.b).map((n) => n.title).sort(), ["From A", "From B"]);
  });
  test("a second sync with nothing new changes nothing and commits nothing", async () => {
    const w = world();
    put(w.a, "x", "y");
    await sync(w.a);
    const head = g(w.a.repo, "rev-parse", "HEAD");
    const r = await sync(w.a);
    assert.equal(r.code, 0);
    assert.match(r.x.all(), /nothing new to commit/);
    assert.equal(g(w.a.repo, "rev-parse", "HEAD"), head);
  });
  test("a deletion removes the file from the repository; it does not delete the note on the other computer (by design), and is not resurrected", async () => {
    const w = world();
    put(w.a, "Temporary", "gone soon");
    await sync(w.a);
    await sync(w.b);
    assert.equal(notes(w.b).length, 1);
    const sa = new Store(w.a.db);
    sa.delete(sa.list({}).notes[0].id);
    sa.close();
    await sync(w.a);
    assert.ok(!g(w.a.repo, "ls-files").includes("temporary"), "the file left the repository");
    await sync(w.b);
    assert.equal(notes(w.b).length, 1, "import never deletes notes (docs/file-sync.md)");
    await sync(w.b);
    await sync(w.a);
    assert.equal(notes(w.a).length, 0, "and the deleted note did not come back on the computer that deleted it");
  });
  test("the same note edited on both computers: nothing is lost, the losing text is kept aside", async () => {
    const w = world();
    put(w.a, "Shared", "line one\n\nline two\n\nline three");
    await sync(w.a);
    await sync(w.b);
    const edit = (d: Dev, body: string): void => {
      const s = new Store(d.db);
      s.update(s.list({}).notes[0].id, { body });
      s.close();
    };
    edit(w.a, "A changed everything");
    edit(w.b, "B changed everything differently");
    await sync(w.a);
    const r = await sync(w.b);
    assert.equal(r.code, 0, r.x.all());
    const winner = notes(w.b)[0].body;
    assert.ok(/A changed everything|B changed everything differently/.test(winner));
    const loser = /A changed/.test(winner) ? "B changed everything differently" : "A changed everything";
    const saved = existsSync(join(w.b.dataDir, "sync-conflicts")) ? [...readdirSync(join(w.b.dataDir, "sync-conflicts"), { recursive: true, withFileTypes: true })].filter((e) => e.isFile()).map((e) => readFileSync(join(e.parentPath, e.name), "utf8")) : [];
    assert.ok(saved.some((t) => t.includes(loser)) || winner.includes(loser), `the losing text survives somewhere; output: ${r.x.all()}`);
  });
  test("--no-push commits locally and never touches the remote", async () => {
    const w = world();
    put(w.a, "local", "only");
    const r = await sync(w.a, { noPush: true });
    assert.equal(r.code, 0, r.x.all());
    assert.equal(spawnSync("git", ["rev-parse", "--verify", "-q", "main"], { cwd: w.remote }).status, 1, "the remote still has no branch");
    assert.match(g(w.a.repo, "log", "--oneline"), /onememory sync/);
  });
  test("a repository with no remote is committed to locally", async () => {
    const root = mkdtempSync(join(tmpdir(), "om-gsync-nr-"));
    roots.push(root);
    const repo = join(root, "r");
    mkdirSync(repo);
    g(repo, "init", "-b", "main");
    const d = { name: "x", repo, dataDir: join(root, "d"), db: join(root, "d", "state.db") };
    put(d, "n", "b");
    const r = await sync(d);
    assert.equal(r.code, 0, r.x.all());
    assert.match(r.x.all(), /no remote/);
  });
  test("a folder that is not a git repository is refused with a plain message", async () => {
    const root = mkdtempSync(join(tmpdir(), "om-gsync-ng-"));
    roots.push(root);
    const d = { name: "x", repo: root, dataDir: join(root, "d"), db: join(root, "d", "state.db") };
    const r = await sync(d);
    assert.equal(r.code, 1);
    assert.match(r.x.all(), /is not a git repository/);
    assert.equal(existsSync(d.db), false, "no database was created");
  });
  test("a missing folder is refused", async () => {
    const root = mkdtempSync(join(tmpdir(), "om-gsync-nf-"));
    roots.push(root);
    const r = await sync({ name: "x", repo: join(root, "nope"), dataDir: root, db: join(root, "s.db") });
    assert.equal(r.code, 1);
    assert.match(r.x.all(), /Not found/);
  });
  test("plain-text sync from a script needs --yes (it asks if the repository is private)", async () => {
    const w = world();
    put(w.a, "x", "y");
    const r = await sync(w.a, { yes: false });
    assert.equal(r.code, 1);
    assert.match(r.x.all(), /--encrypt, or --yes/);
  });
  test("--dry-run fetches, merges, writes, commits and pushes nothing", async () => {
    const w = world();
    put(w.a, "x", "y");
    const r = await sync(w.a, { dryRun: true });
    assert.equal(r.code, 0, r.x.all());
    assert.match(r.x.all(), /Dry run/);
    assert.equal(existsSync(join(w.a.repo, "onememory")), false);
    assert.equal(spawnSync("git", ["log"], { cwd: w.a.repo }).status !== 0 || g(w.a.repo, "log", "--oneline") === "", true);
  });
  test("a git-level conflict aborts cleanly and leaves the memory alone", async () => {
    const w = world();
    put(w.a, "Shared", "base");
    await sync(w.a);
    await sync(w.b);
    // hand-edit the SAME file differently in both repos and commit, so git itself cannot merge
    const fileOf = (d: Dev): string => {
      const dir = join(d.repo, "onememory", "default");
      return join(dir, readdirSync(dir)[0]);
    };
    writeFileSync(fileOf(w.a), readFileSync(fileOf(w.a), "utf8") + "\nA line\n");
    g(w.a.repo, "commit", "-am", "a edit");
    g(w.a.repo, "push", "origin", "main");
    writeFileSync(fileOf(w.b), readFileSync(fileOf(w.b), "utf8") + "\nB line\n");
    g(w.b.repo, "commit", "-am", "b edit");
    const before = JSON.stringify(notes(w.b));
    const r = await sync(w.b);
    assert.equal(r.code, 1);
    assert.match(r.x.all(), /could not merge/);
    assert.equal(JSON.stringify(notes(w.b)), before);
    assert.equal(g(w.b.repo, "status", "--porcelain"), "", "the half-done merge was aborted");
  });
  test("only the onememory/ folder is ever committed; other files in the repository are left alone", async () => {
    const w = world();
    writeFileSync(join(w.a.repo, "README.md"), "mine");
    g(w.a.repo, "add", "README.md");
    g(w.a.repo, "commit", "-m", "readme");
    writeFileSync(join(w.a.repo, "scratch.txt"), "untracked and unrelated");
    put(w.a, "n", "b");
    await sync(w.a);
    assert.ok(!g(w.a.repo, "ls-files").includes("scratch.txt"));
    assert.match(g(w.a.repo, "ls-files"), /onememory\/default\//);
  });
});

describe("sync --git: encrypted", { skip }, () => {
  test("the repository holds no readable title, text or key", async () => {
    const w = world();
    put(w.a, "Dentist appointment SECRETWORD", "bring the insurance card UNIQUEBODY");
    const r = await sync(w.a, { encrypt: true });
    assert.equal(r.code, 0, r.x.all());
    const key = readFileSync(join(w.a.dataDir, ".sync-key"));
    let found = 0;
    for (const f of readdirSync(w.a.repo, { recursive: true, withFileTypes: true })) {
      if (!f.isFile() || f.parentPath.includes(`${join(w.a.repo, ".git")}`)) continue;
      const bytes = readFileSync(join(f.parentPath, f.name));
      found++;
      assert.ok(!bytes.includes("SECRETWORD") && !bytes.includes("UNIQUEBODY"), `${f.name} leaks text`);
      assert.ok(!bytes.includes(key) && !bytes.includes(key.toString("base64")) && !bytes.includes(key.toString("hex")), `${f.name} holds the key`);
      assert.ok(!f.name.includes("Dentist") && !f.name.toLowerCase().includes("dentist"), "file names are opaque");
    }
    assert.ok(found > 0);
    // and not in git history either
    const all = g(w.a.repo, "log", "-p", "--all");
    assert.ok(!all.includes("SECRETWORD") && !all.includes(key.toString("base64")));
    assert.match(readdirSync(join(w.a.repo, "onememory-enc"))[0], /^[0-9a-f]{32}\.enc$/);
  });
  test("the key stays out of the repository: a key file inside it is refused", async () => {
    const w = world();
    put(w.a, "x", "y");
    const r = await sync(w.a, { encrypt: true, keyFile: join(w.a.repo, "key.bin") });
    assert.equal(r.code, 1);
    assert.match(r.x.all(), /inside the repository/);
    assert.equal(existsSync(join(w.a.repo, "key.bin")), false, "and it was not created there");
  });
  test("a second computer with a copy of the key converges; the plain text never touches the repo", async () => {
    const w = world();
    put(w.a, "Shared secret plan", "details here");
    assert.equal((await sync(w.a, { encrypt: true })).code, 0);
    mkdirSync(w.b.dataDir, { recursive: true });
    writeFileSync(join(w.b.dataDir, ".sync-key"), readFileSync(join(w.a.dataDir, ".sync-key")));
    const r = await sync(w.b, { encrypt: true });
    assert.equal(r.code, 0, r.x.all());
    assert.deepEqual(notes(w.b).map((n) => n.title), ["Shared secret plan"]);
    put(w.b, "Reply from B", "yes");
    await sync(w.b, { encrypt: true });
    await sync(w.a, { encrypt: true });
    assert.deepEqual(notes(w.a).map((n) => n.title).sort(), ["Reply from B", "Shared secret plan"]);
  });
  test("a second computer WITHOUT the key is told so and never invents a new one over existing sealed notes", async () => {
    const w = world();
    put(w.a, "x", "y");
    await sync(w.a, { encrypt: true });
    const r = await sync(w.b, { encrypt: true });
    assert.equal(r.code, 1);
    assert.match(r.x.all(), /no key at .*Copy the key file/);
    assert.equal(existsSync(join(w.b.dataDir, ".sync-key")), false);
    assert.equal(existsSync(w.b.db), false, "the database was not touched");
  });
  test("the wrong key stops everything before the database is changed", async () => {
    const w = world();
    put(w.a, "x", "y");
    await sync(w.a, { encrypt: true });
    mkdirSync(w.b.dataDir, { recursive: true });
    writeFileSync(join(w.b.dataDir, ".sync-key"), randomBytes(32));
    const r = await sync(w.b, { encrypt: true });
    assert.equal(r.code, 1);
    assert.match(r.x.all(), /could not open the sealed file .*right key/);
    assert.equal(existsSync(w.b.db), false);
  });
  test("an unchanged store makes no new commit (sealed bytes are only rewritten when the text changes)", async () => {
    const w = world();
    put(w.a, "x", "y");
    await sync(w.a, { encrypt: true });
    const head = g(w.a.repo, "rev-parse", "HEAD");
    const r = await sync(w.a, { encrypt: true });
    assert.match(r.x.all(), /nothing new to commit/);
    assert.equal(g(w.a.repo, "rev-parse", "HEAD"), head);
  });
  test("plain and sealed folders are never mixed in one repository", async () => {
    const w = world();
    put(w.a, "x", "y");
    await sync(w.a);
    const r = await sync(w.a, { encrypt: true });
    assert.equal(r.code, 1);
    assert.match(r.x.all(), /already uses onememory\//);
  });
  test("when at-rest encryption is on, its key is reused (one key to look after)", () => {
    const keyFile = join(tmpdir(), "nonexistent-dir-for-test", ".key");
    const p = syncKeyPath({ dataDir: "/data", env: {}, keyFile });
    assert.equal(p, keyFile);
    assert.equal(syncKeyPath({ dataDir: "/data", env: {} }).replace(/\\/g, "/"), "/data/.sync-key");
    assert.equal(syncKeyPath({ dataDir: "/data", env: { ONEMEMORY_SYNC_KEY_FILE: "/k/x" } }).replace(/\\/g, "/").endsWith("/k/x"), true);
  });
  test("the work folder with readable notes is removed afterwards", async () => {
    const w = world();
    put(w.a, "x", "y");
    await sync(w.a, { encrypt: true });
    assert.deepEqual(readdirSync(w.a.dataDir).filter((f) => f.startsWith(".sync-work")), []);
  });
});

describe("sync --git: the sealed-file format", () => {
  const key = randomBytes(32);
  test("sealing and opening round-trips; the name is bound to the path", () => {
    const blob = sealFile("default/note--1.md", "hello", key);
    const name = (blob && blobName("default/note--1.md", key));
    const opened = openFile(name, blob, key);
    assert.deepEqual(opened, { rel: "default/note--1.md", text: "hello" });
  });
  test("a sealed file renamed to another name will not open (swap protection)", () => {
    const blob = sealFile("a/b.md", "x", key);
    assert.throws(() => openFile("0".repeat(32) + ".enc", blob, key));
  });
  test("file names depend on the key, so a known note path cannot be recognised from the repository", () => {
    const k2 = randomBytes(32);
    assert.notEqual(blobName("a/b.md", key), blobName("a/b.md", k2));
    assert.notEqual(blobName("a/b.md", key), createHash("sha256").update("a/b.md").digest("hex").slice(0, 32) + ".enc");
    assert.match(blobName("a/b.md", key), /^[0-9a-f]{32}\.enc$/);
  });
  test("a different key will not open it", () => {
    const blob = sealFile("a/b.md", "x", key);
    assert.throws(() => openFile(blobName("a/b.md", key), blob, randomBytes(32)));
  });
  test("paths coming out of a sealed file are checked (no .., absolute, drive letters, dot folders)", () => {
    for (const bad of ["../x.md", "/etc/x.md", "C:/x.md", "a\\b.md", ".conflicts/x.md", "a/b/c/d.md", "x.txt", "", "a//b.md", "a/./b.md"]) assert.equal(safeRelPath(bad), null, bad);
    assert.equal(safeRelPath("default/ok--1.md"), "default/ok--1.md");
  });
  test("isInside is true for children and false for siblings and parents", () => {
    const base = mkdtempSync(join(tmpdir(), "om-inside-"));
    roots.push(base);
    mkdirSync(join(base, "a", "b"), { recursive: true });
    assert.equal(isInside(join(base, "a"), join(base, "a", "b", "f")), true);
    assert.equal(isInside(join(base, "a"), join(base, "a")), true);
    assert.equal(isInside(join(base, "a"), join(base, "ab")), false);
    assert.equal(isInside(join(base, "a"), base), false);
  });
});
