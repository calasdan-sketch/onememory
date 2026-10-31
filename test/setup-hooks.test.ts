// setup: the automatic memory hooks (planHooks) are appended next to the user's own hooks, are idempotent, need consent
// (--capture or a typed y; --yes alone never adds them), and come out again with --undo. Everything runs in temp dirs.
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyOps } from "../src/jsonc-edit.js";
import { CAPTURE_HOOKS, DEFAULT_OPTIONS, planHooks, runSetup, type SetupEnv, type SetupIO, type SetupOptions } from "../src/setup.js";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.js");
const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});
function sandbox(): { e: SetupEnv; settings: string; db: string } {
  const root = mkdtempSync(join(tmpdir(), "om-hooks-"));
  roots.push(root);
  const home = join(root, "home");
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude.json"), '{"mcpServers":{"onememory":{"type":"stdio","command":"onememory","args":["mcp"]}}}');
  return {
    settings: join(home, ".claude", "settings.json"),
    db: join(root, "data", "state.db"),
    e: { home, platform: "linux", env: { HOME: home, ONEMEMORY_HOME: join(root, "om") }, cwd: root, nodeVersion: "24.4.1", execPath: process.execPath, cliPath: CLI, version: "2.0.0", now: () => new Date("2026-10-30T12:00:00Z") },
  };
}
function io(answers: string[] = [], interactive = false): SetupIO & { all: () => string; asked: string[] } {
  const l: string[] = [];
  const asked: string[] = [];
  return { interactive, out: (x) => void l.push(x), err: (x) => void l.push(x), ask: async (p) => (asked.push(p), answers.shift() ?? ""), all: () => l.join("\n"), asked };
}
const opts = (o: Partial<SetupOptions> = {}): SetupOptions => ({ ...DEFAULT_OPTIONS, noDoctor: true, noTestNote: true, ...o });
const USER_HOOKS = JSON.stringify({ theme: "dark", hooks: { PostToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "prettier --write" }] }], Stop: [{ hooks: [{ type: "command", command: "say done" }] }] } }, null, 2);
const read = (p: string): any => JSON.parse(readFileSync(p, "utf8"));

describe("setup: automatic memory hooks", () => {
  test("planHooks appends one entry per event next to the user's hooks; async for the background ones", () => {
    const s = sandbox();
    writeFileSync(s.settings, USER_HOOKS);
    const r = planHooks(s.e, opts(), undefined, { recall: true, capture: true });
    assert.ok(r.change);
    const after = JSON.parse(applyOps(r.change!.before ?? "", r.change!.ops));
    assert.equal(after.theme, "dark");
    assert.equal(after.hooks.PostToolUse[0].hooks[0].command, "prettier --write", "the user's hook stays first and unchanged");
    assert.equal(after.hooks.Stop[0].hooks[0].command, "say done");
    assert.match(after.hooks.SessionStart[0].hooks[0].command, /hook session-start$/);
    assert.equal(after.hooks.SessionStart[0].hooks[0].async, undefined, "session-start is synchronous (its output is the context)");
    for (const h of CAPTURE_HOOKS) {
      const mine = after.hooks[h.on].at(-1).hooks[0];
      assert.match(mine.command, new RegExp(`cli\\.js" hook ${h.event}$`));
      assert.equal(mine.async === true, h.async, h.on);
    }
    assert.equal(after.hooks.UserPromptSubmit[0].hooks[0].async, undefined);
    assert.equal(after.hooks.PostToolUse.at(-1).hooks[0].async, true);
  });

  test("idempotent: once installed nothing more is planned; an existing recall hook is kept, not replaced", () => {
    const s = sandbox();
    writeFileSync(s.settings, USER_HOOKS);
    const r = planHooks(s.e, opts(), undefined, { recall: true, capture: true });
    writeFileSync(s.settings, applyOps(USER_HOOKS, r.change!.ops));
    assert.deepEqual(planHooks(s.e, opts(), undefined, { recall: true, capture: true }), { change: null, already: true });
    const s2 = sandbox();
    writeFileSync(s2.settings, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: `node "${CLI.replace(/\\/g, "/")}" recall --budget-ms 800` }] }] } }));
    const r2 = planHooks(s2.e, opts(), undefined, { recall: true, capture: true });
    const after = JSON.parse(applyOps(readFileSync(s2.settings, "utf8"), r2.change!.ops));
    assert.equal(after.hooks.SessionStart.length, 1, "the recall hook is enough at session start");
    assert.match(after.hooks.SessionStart[0].hooks[0].command, /recall --budget-ms/);
    assert.ok(after.hooks.PostToolUse);
  });

  test("runSetup: --yes alone adds no capture hooks; --yes --capture does; --undo takes only ours out", async () => {
    const s = sandbox();
    writeFileSync(s.settings, USER_HOOKS);
    assert.equal(await runSetup(s.e, io(), opts({ yes: true, db: s.db })), 0);
    assert.deepEqual(read(s.settings), JSON.parse(USER_HOOKS), "no consent, no hooks");
    const out = io();
    assert.equal(await runSetup(s.e, out, opts({ yes: true, db: s.db, hook: "yes", capture: "yes" })), 0, out.all());
    const after = read(s.settings);
    assert.ok(after.hooks.SessionStart && after.hooks.UserPromptSubmit && after.hooks.SessionEnd);
    assert.equal(after.hooks.PostToolUse.length, 2);
    assert.match(out.all(), /record what Claude does in this project/);
    // Running again changes nothing.
    const again = io();
    assert.equal(await runSetup(s.e, again, opts({ yes: true, db: s.db, hook: "yes", capture: "yes" })), 0);
    assert.deepEqual(read(s.settings), after);
    // The user edits their own hook in the meantime; undo keeps that and removes only ours.
    const edited = { ...after, theme: "light" };
    writeFileSync(s.settings, JSON.stringify(edited, null, 2));
    assert.equal(await runSetup(s.e, io(), opts({ undo: true })), 0);
    const back = read(s.settings);
    assert.equal(back.theme, "light");
    assert.deepEqual(back.hooks.PostToolUse, JSON.parse(USER_HOOKS).hooks.PostToolUse);
    assert.deepEqual(back.hooks.Stop, JSON.parse(USER_HOOKS).hooks.Stop);
    assert.ok(!JSON.stringify(back).includes(" hook "), "no onememory hook is left");
  });

  test("interactive: the consent question is asked and a no keeps capture out", async () => {
    const s = sandbox();
    writeFileSync(s.settings, USER_HOOKS);
    const t = io(["y", "y", "n"], true);
    assert.equal(await runSetup(s.e, t, opts({ db: s.db })), 0, t.all());
    assert.ok(t.asked.some((q) => q.startsWith("Also record what Claude does in this project (files, commands, errors), stored only on this machine?")));
    const after = read(s.settings);
    assert.ok(after.hooks.SessionStart, "the start-of-session hook was accepted");
    assert.equal(after.hooks.UserPromptSubmit, undefined, "capture was declined");
    assert.match(after.hooks.SessionStart[0].hooks[0].command, /recall --budget-ms/);
  });
});
