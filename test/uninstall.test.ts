// `onememory uninstall`: --dry-run changes nothing; a full uninstall leaves every config byte-identical to before setup
// (a file setup created is deleted); --purge deletes the data folder only after the final backup worked. Temp HOME only.
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_OPTIONS, readHistory, runSetup, type SetupEnv, type SetupIO } from "../src/setup.js";
import { runUninstall, type UninstallOptions } from "../src/uninstall.js";
import { Store } from "../src/store.js";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.js");
const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

const GEMINI = '{\n  "theme": "GitHub",\n  "mcpServers": {\n    "other": { "command": "x" }\n  }\n}\n';

function sandbox(): { e: SetupEnv; home: string; om: string; gemini: string; codex: string; claude: string } {
  const root = mkdtempSync(join(tmpdir(), "om-uninst-"));
  roots.push(root);
  const home = join(root, "home");
  const om = join(root, "om");
  for (const d of [".gemini", ".codex", ".claude"]) mkdirSync(join(home, d), { recursive: true });
  const gemini = join(home, ".gemini", "settings.json");
  writeFileSync(gemini, GEMINI);
  return {
    home,
    om,
    gemini,
    codex: join(home, ".codex", "config.toml"),
    claude: join(home, ".claude", "settings.json"),
    e: { home, platform: "linux", env: { HOME: home, ONEMEMORY_HOME: om }, cwd: root, nodeVersion: "24.4.1", execPath: process.execPath, cliPath: CLI, version: "2.0.0", now: () => new Date("2026-10-31T12:00:00Z") },
  };
}
const lines: string[] = [];
const io = (): SetupIO => ({ interactive: false, out: (l) => void lines.push(l), err: (l) => void lines.push(l), ask: async () => "" });
const opts = (o: Partial<UninstallOptions> = {}): UninstallOptions => ({ dryRun: false, yes: true, purge: false, noBackup: false, ...o });

/** Every file under `dir` with its bytes. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string): void => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else out[p] = readFileSync(p, "latin1");
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

async function setUp(s: ReturnType<typeof sandbox>): Promise<void> {
  const o = { ...DEFAULT_OPTIONS, noDoctor: true, noTestNote: true, yes: true, db: join(s.om, "state.db"), only: ["gemini", "codex", "claude-code"], hook: "yes" as const, capture: "yes" as const };
  assert.equal(await runSetup(s.e, io(), o), 0);
  assert.match(readFileSync(s.gemini, "utf8"), /onememory/);
  assert.ok(existsSync(s.codex) && existsSync(s.claude));
}

describe("uninstall", () => {
  test("--dry-run changes nothing", async () => {
    const s = sandbox();
    await setUp(s);
    const before = { ...snapshot(s.home), ...snapshot(s.om) };
    assert.equal(await runUninstall(s.e, io(), opts({ dryRun: true, purge: true })), 0);
    assert.deepEqual({ ...snapshot(s.home), ...snapshot(s.om) }, before);
  });

  test("full uninstall: configs byte-identical to before setup, files setup created removed, data kept", async () => {
    const s = sandbox();
    const pre = snapshot(s.home);
    await setUp(s);
    const db = new Store(join(s.om, "state.db"));
    db.create({ title: "keep me", body: "x" });
    db.close();
    assert.equal(await runUninstall(s.e, io(), opts()), 0);
    const post = snapshot(s.home);
    for (const f of Object.keys(post)) if (/\.onememory-backup-/.test(f)) delete post[f]; // setup's copies stay unless --purge
    assert.deepEqual(post, pre);
    assert.equal(readFileSync(s.gemini, "utf8"), GEMINI);
    assert.ok(!existsSync(s.codex) && !existsSync(s.claude));
    assert.ok(existsSync(join(s.om, "state.db")), "data kept without --purge");
    assert.ok(readHistory(s.e).every((h) => h.undone));
    assert.equal(await runUninstall(s.e, io(), opts()), 0, "a second run has nothing to do");
  });

  test("--purge: final backup first, then the data folder and setup's copies are deleted", async () => {
    const s = sandbox();
    await setUp(s);
    const db = new Store(join(s.om, "state.db"));
    db.create({ title: "precious", body: "x" });
    db.close();
    writeFileSync(join(s.om, "spaces.json"), "{}");
    assert.equal(await runUninstall(s.e, io(), opts({ purge: true })), 0);
    assert.ok(!existsSync(s.om), "data folder deleted");
    assert.equal(readFileSync(s.gemini, "utf8"), GEMINI);
    assert.deepEqual(readdirSync(dirname(s.gemini)), ["settings.json"], "setup's backup copy deleted too");
    const bak = join(s.home, "onememory-final-backup-20261031T120000Z");
    assert.ok(existsSync(join(bak, "spaces.json")) && existsSync(join(bak, "setup-history.json")));
    const restored = new Store(join(bak, "state.db"));
    assert.equal(restored.list({ limit: 5 }).notes[0].title, "precious");
    restored.close();
  });

  test("--purge keeps the data when the final backup fails", async () => {
    const s = sandbox();
    await setUp(s);
    new Store(join(s.om, "state.db")).close();
    const bak = join(s.home, "onememory-final-backup-20261031T120000Z");
    mkdirSync(bak);
    writeFileSync(join(bak, "state.db"), "in the way"); // backups never overwrite
    assert.equal(await runUninstall(s.e, io(), opts({ purge: true })), 1);
    assert.ok(existsSync(join(s.om, "state.db")), "nothing deleted");
  });

  test("--purge --no-backup deletes without a backup; a hand-made entry is listed, never touched", async () => {
    const s = sandbox();
    const cur = join(s.home, ".cursor", "mcp.json");
    mkdirSync(dirname(cur), { recursive: true });
    const mine = '{ "mcpServers": { "onememory": { "command": "mine" } } }\n';
    writeFileSync(cur, mine);
    mkdirSync(s.om, { recursive: true });
    writeFileSync(join(s.om, "capture-spool.jsonl"), "{}\n");
    lines.length = 0;
    assert.equal(await runUninstall(s.e, io(), opts({ purge: true, noBackup: true })), 0);
    assert.ok(!existsSync(s.om));
    assert.ok(!readdirSync(s.home).some((f) => f.startsWith("onememory-final-backup")));
    assert.equal(readFileSync(cur, "utf8"), mine);
    assert.ok(lines.some((l) => l.includes("(left alone)") && l.includes(cur)));
  });
});
