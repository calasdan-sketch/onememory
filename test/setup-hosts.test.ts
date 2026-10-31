// setup for Codex CLI, Gemini CLI, Muse, VS Code and Zed: fresh install, idempotent re-run, foreign content kept, --undo
// restores the exact bytes, and the capture hooks for the agents that have hooks. Everything runs in a temp HOME.
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseJsonc } from "../src/jsonc-edit.js";
import { normalizeHookInput } from "../src/capture.js";
import { DEFAULT_OPTIONS, detectClients, runSetup, type SetupEnv, type SetupIO, type SetupOptions } from "../src/setup.js";
import { findTable, removeTable, setTable } from "../src/toml-table.js";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.js");
const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

type Host = { id: string; rel: string; foreign: string; entry: (text: string) => Record<string, unknown> | undefined };
const json = (key: string) => (t: string) => ((parseJsonc(t) as Record<string, Record<string, Record<string, unknown>>>)[key] ?? {}).onememory;
const HOSTS: Host[] = [
  {
    id: "codex",
    rel: ".codex/config.toml",
    foreign: '# my codex\nmodel = "o5"\n\n[mcp_servers.other]\ncommand = "x"\nargs = ["a"]\n\n# trusted projects\n[projects."/work/onememory"]\ntrust_level = "trusted"\n',
    entry: (t) => (findTable(t, ["mcp_servers", "onememory"]) ? { command: /command = "([^"]+)"/.exec(t.slice(findTable(t, ["mcp_servers", "onememory"])!.start))![1] } : undefined),
  },
  { id: "gemini", rel: ".gemini/settings.json", foreign: '{\n  "theme": "GitHub",\n  "mcpServers": {\n    "other": { "command": "x" }\n  }\n}\n', entry: json("mcpServers") },
  { id: "muse", rel: ".config/muse/settings.json", foreign: '{\n  "schema_version": 1,\n  "mcpServers": {\n    "other": { "transport": "stdio", "command": "x" }\n  }\n}\n', entry: json("mcpServers") },
  { id: "vscode", rel: ".config/Code/User/mcp.json", foreign: '{\n\t"servers": {\n\t\t"other": { "type": "stdio", "command": "x" }\n\t},\n\t"inputs": []\n}\n', entry: json("servers") },
  { id: "zed", rel: ".config/zed/settings.json", foreign: '// Zed settings\n{\n  "theme": "One Dark", // dark\n  "context_servers": {\n    "other": { "command": "x", "args": [] },\n  },\n}\n', entry: json("context_servers") },
];

function sandbox(): { e: SetupEnv; home: string; db: string } {
  const root = mkdtempSync(join(tmpdir(), "om-hosts-"));
  roots.push(root);
  const home = join(root, "home");
  for (const h of HOSTS) mkdirSync(dirname(join(home, h.rel)), { recursive: true });
  return {
    home,
    db: join(root, "data", "state.db"),
    e: { home, platform: "linux", env: { HOME: home, ONEMEMORY_HOME: join(root, "om") }, cwd: root, nodeVersion: "24.4.1", execPath: process.execPath, cliPath: CLI, version: "2.0.0", now: () => new Date("2026-10-31T12:00:00Z") },
  };
}
const io = (): SetupIO => ({ interactive: false, out: () => {}, err: () => {}, ask: async () => "" });
const opts = (s: { db: string }, o: Partial<SetupOptions> = {}): SetupOptions => ({ ...DEFAULT_OPTIONS, noDoctor: true, noTestNote: true, yes: true, db: s.db, ...o });

describe("setup: more hosts", () => {
  test("detects each host at its documented path", () => {
    const s = sandbox();
    const found = detectClients(s.e);
    for (const h of HOSTS) {
      const t = found.find((x) => x.id === h.id)!;
      assert.equal(t.file, join(s.home, h.rel), h.id);
      assert.equal(t.present, true, h.id);
    }
    const win = detectClients({ ...s.e, platform: "win32", env: { ...s.e.env, APPDATA: "C:/AD" } });
    assert.equal(win.find((x) => x.id === "vscode")!.file, join("C:/AD", "Code", "User", "mcp.json"));
    assert.equal(win.find((x) => x.id === "zed")!.file, join("C:/AD", "Zed", "settings.json"));
  });

  for (const h of HOSTS) {
    test(`${h.id}: fresh install, idempotent, undo removes the file it created`, async () => {
      const s = sandbox();
      const file = join(s.home, h.rel);
      assert.equal(await runSetup(s.e, io(), opts(s, { only: [h.id] })), 0);
      const text = readFileSync(file, "utf8");
      assert.ok(h.entry(text.replace(/"mcp_servers"/, '"mcpServers"')), "onememory entry written");
      if (h.id === "muse") {
        const v = parseJsonc(text) as { schema_version: number; mcp_servers: { onememory: Record<string, unknown> } };
        assert.equal(v.schema_version, 1);
        assert.equal(v.mcp_servers.onememory.transport, "stdio");
        assert.equal(v.mcp_servers.onememory.mode, "optional");
      }
      if (h.id === "vscode") assert.equal((h.entry(text) as { type: string }).type, "stdio");
      assert.equal(await runSetup(s.e, io(), opts(s, { only: [h.id] })), 0);
      assert.equal(readFileSync(file, "utf8"), text, "second run changes nothing");
      assert.equal(await runSetup(s.e, io(), opts(s, { undo: true })), 0);
      assert.equal(existsSync(file), false);
    });

    test(`${h.id}: keeps foreign content and undo restores the exact bytes`, async () => {
      const s = sandbox();
      const file = join(s.home, h.rel);
      writeFileSync(file, h.foreign);
      assert.equal(await runSetup(s.e, io(), opts(s, { only: [h.id] })), 0);
      const text = readFileSync(file, "utf8");
      assert.ok(h.entry(text), "entry added next to the existing servers");
      assert.ok(text.includes('"other"') || text.includes("[mcp_servers.other]"));
      if (h.id === "codex") assert.ok(text.startsWith(h.foreign), "TOML: everything before our table is byte-identical");
      if (h.id === "zed") assert.match(text, /\/\/ Zed settings[\s\S]*\/\/ dark/, "comments kept");
      if (h.id === "muse") assert.ok(!text.includes('"mcp_servers"'), "existing mcpServers spelling reused");
      assert.equal(await runSetup(s.e, io(), opts(s, { undo: true })), 0);
      assert.equal(readFileSync(file, "utf8"), h.foreign);
    });
  }

  test("codex: undo after the user edited the file takes out only our table", async () => {
    const s = sandbox();
    const file = join(s.home, ".codex/config.toml");
    writeFileSync(file, HOSTS[0].foreign);
    assert.equal(await runSetup(s.e, io(), opts(s, { only: ["codex"] })), 0);
    writeFileSync(file, "approval_policy = \"never\"\n" + readFileSync(file, "utf8"));
    assert.equal(await runSetup(s.e, io(), opts(s, { undo: true })), 0);
    assert.equal(readFileSync(file, "utf8"), 'approval_policy = "never"\n' + HOSTS[0].foreign);
  });

  test("toml-table: replace in the middle keeps the comment that leads into the next table", () => {
    const t = '[mcp_servers.onememory]\ncommand = "old"\n\n# next\n[x]\ny = 1\n';
    const out = setTable(t, ["mcp_servers", "onememory"], { command: "new", args: ["a b", 'q"'], env: { K: "v" } });
    assert.equal(out, '[mcp_servers.onememory]\ncommand = "new"\nargs = ["a b", "q\\""]\nenv = { K = "v" }\n\n# next\n[x]\ny = 1\n');
    assert.equal(removeTable(out, ["mcp_servers", "onememory"]), "\n# next\n[x]\ny = 1\n");
  });

  test("--capture wires the hooks of Codex, Gemini CLI and Muse; undo takes them out", async () => {
    const s = sandbox();
    const muse = join(s.home, ".config/muse/settings.json");
    writeFileSync(muse, HOSTS[2].foreign);
    assert.equal(await runSetup(s.e, io(), opts(s, { only: ["codex", "gemini", "muse"], hook: "yes", capture: "yes" })), 0);
    const cmds = (v: { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> }, on: string): string => v.hooks[on].map((g) => g.hooks[0].command).join("\n");
    const codex = JSON.parse(readFileSync(join(s.home, ".codex/hooks.json"), "utf8"));
    for (const [on, ev] of [["SessionStart", "session-start"], ["UserPromptSubmit", "user-prompt"], ["PostToolUse", "post-tool"], ["Stop", "stop"]]) assert.match(cmds(codex, on), new RegExp(`hook ${ev}`), on);
    const gem = JSON.parse(readFileSync(join(s.home, ".gemini/settings.json"), "utf8"));
    assert.ok(gem.mcpServers.onememory, "gemini MCP and hooks share settings.json");
    for (const [on, ev] of [["SessionStart", "session-start"], ["BeforeAgent", "user-prompt"], ["AfterTool", "post-tool"], ["AfterAgent", "stop"], ["SessionEnd", "session-end"]]) assert.match(cmds(gem, on), new RegExp(`hook ${ev}`), on);
    assert.equal(gem.hooks.SessionStart[0].matcher, undefined, "lifecycle matchers must match exactly in Gemini: none");
    const m = JSON.parse(readFileSync(muse, "utf8"));
    assert.equal(m.schema_version, 1);
    for (const on of ["SessionStart", "UserPromptSubmit", "PostToolUse", "PostToolUseFailure", "Stop", "SubagentStop", "SessionEnd"]) {
      assert.deepEqual(Object.keys(m.hooks[on][0]), ["hooks"], `${on}: no extra group keys (Muse drops those)`);
      assert.deepEqual(Object.keys(m.hooks[on][0].hooks[0]), ["type", "command"]);
    }
    assert.equal(await runSetup(s.e, io(), opts(s, { only: ["codex", "gemini", "muse"], hook: "yes", capture: "yes" })), 0);
    assert.deepEqual(JSON.parse(readFileSync(muse, "utf8")), m, "idempotent");
    assert.equal(await runSetup(s.e, io(), opts(s, { undo: true })), 0);
    assert.equal(readFileSync(muse, "utf8"), HOSTS[2].foreign);
    assert.equal(existsSync(join(s.home, ".codex/hooks.json")), false);
    assert.equal(existsSync(join(s.home, ".gemini/settings.json")), false);
  });

  test("hook input: Gemini AfterAgent prompt_response is the stop text", () => {
    assert.equal(normalizeHookInput("stop", { session_id: "s", cwd: "/w", prompt_response: "all done" }).input, "all done");
  });
});
