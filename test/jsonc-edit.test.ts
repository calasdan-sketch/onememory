// The config editor must change ONLY what it is asked to, in any reasonable file layout.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { applyOps, getPath, JsonEditError, parseDoc, removeArrayItem, detectEol, detectIndent, isStrictJson } from "../src/jsonc-edit.js";

const ENTRY = { command: "node", args: ["C:\\Program Files\\x\\cli.js", "mcp"], env: { A: "1" } };
const SET = [{ op: "set" as const, path: ["mcpServers"], key: "onememory", value: ENTRY }];

function servers(text: string): Record<string, unknown> {
  return (JSON.parse(text.replace(/^\uFEFF/, "")) as { mcpServers: Record<string, unknown> }).mcpServers;
}

describe("jsonc-edit: what it must not change", () => {
  test("every byte outside the new entry stays exactly as it was", () => {
    const before = '{\n  "numStartups": 12,\n  "mcpServers": {\n    "other": { "command": "x" }\n  },\n  "tail": [1, 2,   3]\n}\n';
    const after = applyOps(before, SET);
    assert.ok(after.startsWith('{\n  "numStartups": 12,\n  "mcpServers": {\n    "other": { "command": "x" },\n'));
    assert.ok(after.endsWith('  },\n  "tail": [1, 2,   3]\n}\n'));
    assert.deepEqual(Object.keys(servers(after)), ["other", "onememory"]);
  });

  test("numbers keep the way they were written (1.0, huge ids)", () => {
    const before = '{"a": 1.0, "big": 12345678901234567890, "e": 1E5, "mcpServers": {}}';
    const after = applyOps(before, SET);
    assert.ok(after.includes('"a": 1.0'));
    assert.ok(after.includes("12345678901234567890"));
    assert.ok(after.includes("1E5"));
  });

  test("a file with comments keeps its comments", () => {
    const before = '{\n  // my servers\n  "mcpServers": {\n    /* old */ "a": { "command": "x" }\n  }\n}\n';
    const after = applyOps(before, SET);
    assert.ok(after.includes("// my servers"));
    assert.ok(after.includes("/* old */"));
    assert.equal(isStrictJson(after), false);
    assert.equal(parseDoc(after).root.kind, "object");
  });

  test("trailing commas are respected, not turned into errors", () => {
    const before = '{\n  "mcpServers": {\n    "a": { "command": "x" },\n  },\n}\n';
    const after = applyOps(before, SET);
    assert.ok(after.includes('"onememory"'));
    assert.ok(parseDoc(after));
  });

  test("CRLF files stay CRLF everywhere (no bare LF is introduced)", () => {
    const before = '{\r\n  "x": 1,\r\n  "mcpServers": {\r\n    "a": 1\r\n  }\r\n}\r\n';
    const after = applyOps(before, SET);
    assert.equal(after.replace(/\r\n/g, "").includes("\n"), false);
    assert.equal(detectEol(after), "\r\n");
  });

  test("a byte-order mark is kept", () => {
    const before = '\uFEFF{\n  "mcpServers": {}\n}\n';
    const after = applyOps(before, SET);
    assert.equal(after.charCodeAt(0), 0xfeff);
    assert.deepEqual(Object.keys(servers(after)), ["onememory"]);
  });

  test("tabs stay tabs, four spaces stay four spaces", () => {
    assert.equal(detectIndent('{\n\t"a": 1\n}'), "\t");
    assert.equal(detectIndent('{\n    "a": 1\n}'), "    ");
    const tabbed = applyOps('{\n\t"mcpServers": {\n\t\t"a": 1\n\t}\n}\n', SET);
    assert.ok(/\n\t\t"onememory": \{\n\t\t\t"command"/.test(tabbed));
    const four = applyOps('{\n    "mcpServers": {\n        "a": 1\n    }\n}\n', SET);
    assert.ok(/\n        "onememory": \{\n            "command"/.test(four));
  });

  test("a one-line file stays valid", () => {
    const after = applyOps('{"mcpServers":{"a":{"command":"x"}},"z":1}', SET);
    assert.deepEqual(Object.keys(servers(after)), ["a", "onememory"]);
    assert.equal((JSON.parse(after) as { z: number }).z, 1);
  });

  test("a missing, empty or whitespace-only file becomes a valid config", () => {
    for (const before of ["", "  \n", "{}", "{\n}\n"]) {
      const after = applyOps(before, SET);
      assert.deepEqual(servers(after).onememory, ENTRY);
    }
  });

  test("a missing mcpServers object is created at the top level", () => {
    const after = applyOps('{\n  "theme": "dark"\n}\n', SET);
    assert.equal((JSON.parse(after) as { theme: string }).theme, "dark");
    assert.deepEqual(servers(after).onememory, ENTRY);
  });

  test("a nested path (a project's own servers) is created when missing", () => {
    const before = '{ "projects": { "/p": { "allowedTools": [] } } }';
    const after = applyOps(before, [{ op: "set", path: ["projects", "/p", "mcpServers"], key: "onememory", value: ENTRY }]);
    const j = JSON.parse(after) as { projects: Record<string, { allowedTools: unknown[]; mcpServers: Record<string, unknown> }> };
    assert.deepEqual(j.projects["/p"].allowedTools, []);
    assert.deepEqual(j.projects["/p"].mcpServers.onememory, ENTRY);
  });

  test("keys with odd characters and escapes survive", () => {
    const before = '{"\\u00e9\\"q": 1, "path\\\\x": "C:\\\\a", "mcpServers": {}}';
    const after = applyOps(before, SET);
    assert.deepEqual(JSON.parse(after)["é\"q"], 1);
    assert.equal(JSON.parse(after)["path\\x"], "C:\\a");
  });
});

describe("jsonc-edit: removing and renaming", () => {
  const three = '{\n  "mcpServers": {\n    "a": 1,\n    "b": 2,\n    "c": 3\n  }\n}\n';
  for (const [k, left] of [["a", ["b", "c"]], ["b", ["a", "c"]], ["c", ["a", "b"]]] as const) {
    test(`removing "${k}" (first/middle/last) leaves valid JSON with the others`, () => {
      const after = applyOps(three, [{ op: "remove", path: ["mcpServers"], key: k }]);
      assert.deepEqual(Object.keys(servers(after)), left);
      assert.equal(isStrictJson(after), true);
    });
  }

  test("removing the only member leaves an empty object", () => {
    const after = applyOps('{\n  "mcpServers": {\n    "a": 1\n  }\n}\n', [{ op: "remove", path: ["mcpServers"], key: "a" }]);
    assert.deepEqual(servers(after), {});
  });

  test("removing a key that is not there changes nothing", () => {
    assert.equal(applyOps(three, [{ op: "remove", path: ["mcpServers"], key: "zzz" }]), three);
  });

  test("renaming keeps the position and replaces the value", () => {
    const before = '{\n  "mcpServers": {\n    "a": 1,\n    "old": { "command": "n" },\n    "c": 3\n  }\n}\n';
    const after = applyOps(before, [{ op: "rename", path: ["mcpServers"], key: "old", newKey: "onememory", value: ENTRY }]);
    assert.deepEqual(Object.keys(servers(after)), ["a", "onememory", "c"]);
    assert.deepEqual(servers(after).onememory, ENTRY);
  });

  test("renaming onto an existing name is refused", () => {
    assert.throws(() => applyOps(three, [{ op: "rename", path: ["mcpServers"], key: "a", newKey: "b", value: 1 }]), JsonEditError);
  });

  test("a rename can be reversed to give back the original value", () => {
    const before = '{"mcpServers": {"claude-bridge": {"command": "n"}}}';
    const fwd = applyOps(before, [{ op: "rename", path: ["mcpServers"], key: "claude-bridge", newKey: "onememory", value: ENTRY }]);
    const back = applyOps(fwd, [{ op: "rename", path: ["mcpServers"], key: "onememory", newKey: "claude-bridge", value: { command: "n" } }]);
    assert.deepEqual(JSON.parse(back), JSON.parse(before));
  });
});

describe("jsonc-edit: lists (hooks)", () => {
  const item = { matcher: "startup|clear", hooks: [{ type: "command", command: "node cli.js recall --budget-ms 800" }] };
  test("appending to an existing list keeps the other items", () => {
    const before = '{\n  "hooks": {\n    "SessionStart": [\n      { "matcher": "x", "hooks": [] }\n    ],\n    "Stop": []\n  }\n}\n';
    const after = applyOps(before, [{ op: "append", path: ["hooks"], key: "SessionStart", value: item }]);
    const j = JSON.parse(after) as { hooks: { SessionStart: unknown[]; Stop: unknown[] } };
    assert.equal(j.hooks.SessionStart.length, 2);
    assert.deepEqual(j.hooks.Stop, []);
  });
  test("a list that does not exist is created, with its parents", () => {
    const j = JSON.parse(applyOps("{}", [{ op: "append", path: ["hooks"], key: "SessionStart", value: item }])) as { hooks: { SessionStart: unknown[] } };
    assert.equal(j.hooks.SessionStart.length, 1);
  });
  test("an empty list gets its first item", () => {
    const j = JSON.parse(applyOps('{"hooks":{"SessionStart":[]}}', [{ op: "append", path: ["hooks"], key: "SessionStart", value: item }])) as { hooks: { SessionStart: unknown[] } };
    assert.equal(j.hooks.SessionStart.length, 1);
  });
  test("a list that is really something else is refused, not overwritten", () => {
    assert.throws(() => applyOps('{"hooks":{"SessionStart":"nope"}}', [{ op: "append", path: ["hooks"], key: "SessionStart", value: item }]), JsonEditError);
  });
  test("unappend removes only our item", () => {
    const mine = applyOps('{"hooks":{"SessionStart":[{"matcher":"x","hooks":[]}]}}', [{ op: "append", path: ["hooks"], key: "SessionStart", value: item }]);
    const back = applyOps(mine, [{ op: "unappend", path: ["hooks"], key: "SessionStart", marker: "recall --budget-ms" }]);
    assert.deepEqual(JSON.parse(back), { hooks: { SessionStart: [{ matcher: "x", hooks: [] }] } });
    assert.equal(removeArrayItem('{"a":[1]}', [], "a", "zzz"), '{"a":[1]}');
  });
});

describe("jsonc-edit: refusing what it cannot place", () => {
  test("broken JSON is refused with a line number, nothing is produced", () => {
    assert.throws(() => applyOps('{\n  "a": 1,\n  "b": \n}', SET), /line \d+/);
  });
  test("a top-level array is refused", () => {
    assert.throws(() => applyOps("[1,2]", SET), JsonEditError);
  });
  test("mcpServers that is not an object is refused", () => {
    assert.throws(() => applyOps('{"mcpServers": []}', SET), /not an object/);
  });
  test("the same key twice in the object we edit is refused", () => {
    assert.throws(() => applyOps('{"mcpServers": {"onememory": 1, "onememory": 2}}', SET), /more than once/);
  });
  test("text after the document is refused", () => {
    assert.throws(() => parseDoc('{"a":1} x'), JsonEditError);
  });
  test("absurd nesting is refused instead of overflowing", () => {
    assert.throws(() => parseDoc("[".repeat(200) + "]".repeat(200)), /deeply/);
  });
  test("setting a value twice is a no-op the second time", () => {
    const once = applyOps('{"mcpServers":{}}', SET);
    assert.equal(applyOps(once, SET), once);
  });
  test("getPath finds nested objects and returns undefined for gaps", () => {
    const d = parseDoc('{"a":{"b":{}}}');
    assert.ok(getPath(d, ["a", "b"]));
    assert.equal(getPath(d, ["a", "x"]), undefined);
  });
});

describe("jsonc-edit: a real-sized ~/.claude.json", () => {
  test("a multi-megabyte file is edited in a few seconds and everything else is untouched", () => {
    const projects: Record<string, unknown> = {};
    for (let i = 0; i < 800; i++) projects[`/work/p${i}`] = { allowedTools: [], history: Array.from({ length: 25 }, (_, k) => ({ display: `message ${k} `.repeat(3), pastedContents: {} })), mcpServers: {} };
    const text = JSON.stringify({ numStartups: 3, projects, mcpServers: { a: { command: "x" } } }, null, 2) + "\n";
    assert.ok(text.length > 1_500_000, "fixture is large");
    const t0 = Date.now();
    const out = applyOps(text, SET);
    assert.ok(Date.now() - t0 < 5000, `took ${Date.now() - t0} ms`);
    assert.equal(out.length - text.length, out.indexOf('"onememory"') > 0 ? out.length - text.length : 0);
    assert.equal(JSON.stringify(Object.keys(servers(out))), '["a","onememory"]');
    const back = applyOps(out, [{ op: "remove", path: ["mcpServers"], key: "onememory" }]);
    assert.equal(back, text, "adding then removing gives the original text back exactly");
  });
});
