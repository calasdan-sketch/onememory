// Regression tests for the runner security review (round 5). Each block maps
// to one finding: flood budget, unauthenticated claims/results/heartbeat,
// shell-interpreter allowlist entries, canonical-format ambiguity.
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac } from "node:crypto";
import { Store, type NoteRecord } from "../src/store.js";
import { PROJECT_ROOT } from "../src/config.js";
import {
  CLAIMED_TAG,
  Ledger,
  RUNNER,
  beat,
  buildCommand,
  canonicalString,
  pollOnce,
  resetHeartbeat,
  resolveAction,
  signCommand,
  signedBody,
  validateAllowlist,
  verifyCommand,
  verifyResult,
  type Allowlist,
} from "../src/runner.js";
import { verifyResultCli } from "../src/runner-sign.js";

const SECRET = "hardening-secret";
const allow: Allowlist = { status: { file: "echo", args: ["ok"] } };

function post(store: Store, body: string, tags: string[] = []): NoteRecord {
  return store.create({ namespace: RUNNER.namespace, title: "cmd", body, tags });
}
function results(store: Store): NoteRecord[] {
  return store.list({ namespace: RUNNER.resultsNamespace, limit: 500 }).notes;
}

describe("finding 1: junk cannot spend the flood budget", () => {
  let store: Store;
  let dir: string;
  let ledger: Ledger;
  const prevRejects = RUNNER.maxRejectsPerPoll;
  beforeEach(() => {
    store = new Store(":memory:");
    dir = mkdtempSync(join(tmpdir(), "runner-h1-"));
    ledger = new Ledger(join(dir, "seen.json"));
  });
  afterEach(() => {
    (RUNNER as { maxRejectsPerPoll: number }).maxRejectsPerPoll = prevRejects;
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("a real command runs on the first pass behind a pile of unsigned junk", async () => {
    const real = buildCommand(SECRET, "status", {});
    post(store, JSON.stringify(real));
    for (let i = 0; i < RUNNER.maxPerPoll * 3; i++) {
      post(store, i % 2 ? "junk" : JSON.stringify(buildCommand("no-secret", "status", {})));
    }
    const deps = { store, secret: SECRET, allow, ledger, recent: [] as number[] };
    await pollOnce(deps);
    assert.ok(
      results(store).some((n) => n.body.includes(real.cmd_id)),
      "the signed command must run despite the junk"
    );
    assert.equal(deps.recent.length, 1, "only the verified command counts toward the budget");
  });

  test("unverified notes examined per pass are capped, and never re-examined", async () => {
    (RUNNER as { maxRejectsPerPoll: number }).maxRejectsPerPoll = 5;
    for (let i = 0; i < 12; i++) post(store, "junk " + i);
    const deps = { store, secret: SECRET, allow, ledger };
    assert.equal(await pollOnce(deps), 5);
    assert.equal(await pollOnce(deps), 5);
    assert.equal(await pollOnce(deps), 2);
    assert.equal(await pollOnce(deps), 0, "rejected notes stay rejected");
  });

  test("rejected notes are remembered across a restart", async () => {
    post(store, "junk");
    await pollOnce({ store, secret: SECRET, allow, ledger });
    const reloaded = new Ledger(join(dir, "seen.json"));
    assert.equal(await pollOnce({ store, secret: SECRET, allow, ledger: reloaded }), 0);
  });
});

describe("finding 2: claims, results and heartbeat are not forgeable", () => {
  let store: Store;
  let dir: string;
  let ledger: Ledger;
  beforeEach(() => {
    store = new Store(":memory:");
    dir = mkdtempSync(join(tmpdir(), "runner-h2-"));
    ledger = new Ledger(join(dir, "seen.json"));
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("a command pre-tagged `claimed` by a token holder still runs", async () => {
    const cmd = buildCommand(SECRET, "status", {});
    post(store, JSON.stringify(cmd), [CLAIMED_TAG]);
    await pollOnce({ store, secret: SECRET, allow, ledger });
    const res = results(store).find((n) => n.body.includes(cmd.cmd_id));
    assert.ok(res, "the claimed tag is a hint, not the source of truth");
    assert.equal((JSON.parse(res.body) as { status: string }).status, "ok");
  });

  test("a command whose rev is bumped by someone else still runs", async () => {
    const cmd = buildCommand(SECRET, "status", {});
    const note = post(store, JSON.stringify(cmd));
    store.update(note.id, { title: "touched by attacker" });
    await pollOnce({ store, secret: SECRET, allow, ledger });
    assert.ok(results(store).some((n) => n.body.includes(cmd.cmd_id)));
  });

  test("results written by the runner verify; a forged one does not", async () => {
    const cmd = buildCommand(SECRET, "status", {});
    post(store, JSON.stringify(cmd));
    await pollOnce({ store, secret: SECRET, allow, ledger });
    const real = results(store)[0];
    const v = verifyResult(SECRET, real.body);
    assert.equal(v.ok, true);
    assert.equal((v as { payload: Record<string, unknown> }).payload.cmd_id, cmd.cmd_id);

    const forged = JSON.stringify({ kind: "result", cmd_id: cmd.cmd_id, status: "ok", sig: "00".repeat(32) });
    assert.equal(verifyResult(SECRET, forged).ok, false);

    const tampered = JSON.parse(real.body) as Record<string, unknown>;
    tampered.status = "failed";
    assert.equal(verifyResult(SECRET, JSON.stringify(tampered)).ok, false);
  });

  test("the heartbeat is signed", () => {
    resetHeartbeat();
    beat(store, SECRET, new Date().toISOString());
    const [hb] = store.list({ namespace: "runner", limit: 10 }).notes;
    const v = verifyResult(SECRET, hb.body);
    assert.equal(v.ok, true);
    assert.equal((v as { kind: string }).kind, "heartbeat");
    assert.equal(verifyResult("other-secret", hb.body).ok, false);
  });

  test("result signing is domain-separated from command signing", () => {
    // Same secret, same fields: the result MAC must differ from a command MAC
    // over the same bytes, so neither can stand in for the other.
    const body = JSON.parse(signedBody(SECRET, "result", { cmd_id: "x" })) as { sig: string };
    const cmdMac = createHmac("sha256", SECRET)
      .update(canonicalString({ cmd_id: "x", action: "", issued_at: "", nonce: "" }))
      .digest("hex");
    assert.notEqual(body.sig, cmdMac);
    assert.ok(canonicalString({ cmd_id: "x", action: "a", issued_at: "t", nonce: "n" }).startsWith("onememory-cmd-v2\n"));
  });

  test("an unsigned note naming a real cmd_id gets no reply", async () => {
    const real = buildCommand(SECRET, "status", {});
    // Malformed params used to be answered before the signature was checked,
    // letting a token holder plant "rejected" results against real ids.
    post(store, JSON.stringify({ ...real, params: "nope" }));
    await pollOnce({ store, secret: SECRET, allow, ledger });
    assert.equal(results(store).length, 0);
  });

  test("runner:sign verify-result reports authentic vs forged", () => {
    const good = signedBody(SECRET, "result", { cmd_id: "c1", status: "ok" });
    const log = console.log;
    console.log = () => {};
    try {
      assert.equal(verifyResultCli(SECRET, [good]), 0);
      assert.equal(verifyResultCli("wrong", [good]), 2);
      assert.equal(verifyResultCli(SECRET, []), 1);
    } finally {
      console.log = log;
    }
  });
});

describe("finding 3: shell-interpreter allowlist entries", () => {
  test("cmd/powershell/pwsh with a metachar-accepting pattern are refused", () => {
    const { allow: ok, errors } = validateAllowlist({
      a: { file: "C:\\Windows\\System32\\cmd.exe", args: ["/c"], params: { x: ".*" }, paramArgs: ["{x}"] },
      b: { file: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\POWERSHELL.EXE", params: { x: "[^/]+" }, paramArgs: ["{x}"] },
      c: { file: "/usr/bin/pwsh", params: { x: "[a-z&]{2,5}" }, paramArgs: ["{x}"] },
      d: { file: "C:\\scripts\\deploy.BAT", params: { x: "\\S+" }, paramArgs: ["{x}"] },
      e: { file: "C:/Windows/System32/cmd.exe", params: { x: "[a-z0-9-]{1,40}" }, paramArgs: ["{x}"] },
    });
    assert.deepEqual(Object.keys(ok), ["e"], "only the tight pattern survives");
    assert.equal(errors.length, 4);
  });

  test("bare program names are refused, except param-less bare cmd", () => {
    const { allow: ok } = validateAllowlist({
      git: { file: "git", args: ["status"] },
      echo: { file: "cmd", args: ["/c", "echo hi"] },
      echoParam: { file: "cmd", args: ["/c"], params: { n: "[a-z]+" }, paramArgs: ["{n}"] },
      abs: { file: "/usr/bin/git", args: ["status"] },
    });
    assert.deepEqual(Object.keys(ok).sort(), ["abs", "echo"]);
  });

  test("the shipped example allowlist passes its own loader", () => {
    const raw = JSON.parse(
      readFileSync(join(PROJECT_ROOT, "data", "runner-allow.example.json"), "utf8")
    ) as Record<string, unknown>;
    const { allow: ok, errors } = validateAllowlist(raw);
    assert.deepEqual(errors, []);
    assert.equal(Object.keys(ok).length, Object.keys(raw).length);
  });

  test("at run time a metacharacter never reaches an interpreter", () => {
    const lax: Allowlist = {
      run: { file: "cmd.exe", args: ["/c"], params: { x: ".*" }, paramArgs: ["{x}"] },
    };
    const r = resolveAction(lax, "run", { x: "a & del /q *" });
    assert.equal(r.ok, false);
    assert.match((r as { reason: string }).reason, /shell would interpret/);
  });
});

describe("finding 4: canonical format v2", () => {
  const base = { cmd_id: "1", action: "x", issued_at: "2026-01-01T00:00:00Z", nonce: "n" };

  test("values that used to collide under k=v&k=v now sign differently", () => {
    const a = canonicalString({ ...base, params: { a: "1&b=2" } });
    const b = canonicalString({ ...base, params: { a: "1", b: "2" } });
    assert.notEqual(a, b);
  });

  test("a v1 (unversioned) command is refused", () => {
    const now = new Date().toISOString();
    const v1 = { ...base, issued_at: now, params: {} };
    const body = JSON.stringify({ ...v1, sig: signCommand(SECRET, v1) }); // no `v`
    const v = verifyCommand(SECRET, body);
    assert.equal(v.ok, false);
    assert.match((v as { reason: string }).reason, /unsupported command format/);
  });

  test("control characters are refused, even when correctly signed", () => {
    const fields = { ...base, issued_at: new Date().toISOString(), params: { p: "a\nb" } };
    const body = JSON.stringify({ v: 2, ...fields, sig: signCommand(SECRET, fields) });
    const v = verifyCommand(SECRET, body);
    assert.equal(v.ok, false);
    assert.match((v as { reason: string }).reason, /control characters/);
    assert.throws(() => buildCommand(SECRET, "x", { p: "a\u0000" }));
  });
});

describe("ledger format", () => {
  test("a legacy (array) ledger still blocks replays", () => {
    const dir = mkdtempSync(join(tmpdir(), "runner-ledger-"));
    const p = join(dir, "seen.json");
    writeFileSync(p, JSON.stringify(["old-cmd"]));
    const l = new Ledger(p);
    assert.equal(l.has("old-cmd"), true);
    l.markNote(7);
    l.flush();
    assert.equal(new Ledger(p).hasNote(7), true);
    rmSync(dir, { recursive: true, force: true });
  });
});
