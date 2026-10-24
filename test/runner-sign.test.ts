// Argument parsing for the signing CLI. Worth testing because a mis-parsed
// parameter produces a valid signature over the WRONG command — it runs, just
// not the thing you meant.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseArgs } from "../src/runner-sign.js";

describe("runner:sign argument parsing", () => {
  test("action only", () => {
    assert.deepEqual(parseArgs(["status"]), {
      action: "status", params: {}, target: "", post: false,
    });
  });

  test("params and target", () => {
    assert.deepEqual(parseArgs(["pull", "repo=calas-site", "--target", "DANITA"]), {
      action: "pull", params: { repo: "calas-site" }, target: "DANITA", post: false,
    });
  });

  test("--target=NAME form works too", () => {
    const p = parseArgs(["pull", "--target=BOX"]);
    assert.equal((p as { target: string }).target, "BOX");
  });

  test("a value may itself contain an equals sign", () => {
    const p = parseArgs(["run", "q=a=b"]);
    assert.deepEqual((p as { params: Record<string, string> }).params, { q: "a=b" });
  });

  test("a bare word after the action is an error, not a silent drop", () => {
    assert.ok("error" in parseArgs(["run", "oops"]));
  });

  test("no action is an error", () => {
    assert.ok("error" in parseArgs([]));
  });

  test("an unknown flag is an error", () => {
    assert.ok("error" in parseArgs(["run", "--yolo"]));
  });
});
