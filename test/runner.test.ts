// Runner tests. The three security gates (signature, freshness, allowlist)
// get adversarial cases, not just happy paths -- this is the component that
// turns a note from the public internet into a process on Dan's PC.
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, type NoteRecord } from "../src/store.js";
import {
  CLAIMED_TAG,
  Ledger,
  INTROSPECT_ACTION,
  RESULT_TAG,
  RUNNER,
  acquireLock,
  beat,
  buildCommand,
  canonicalString,
  claimNote,
  loadAllowlist,
  pollOnce,
  processNote,
  pruneOld,
  releaseLock,
  resetHeartbeat,
  resolveAction,
  runCommand,
  runnerId,
  signCommand,
  startRunner,
  truncate,
  verifyCommand,
  type Allowlist,
} from "../src/runner.js";

const SECRET = "test-runner-secret";

function post(store: Store, body: string): NoteRecord {
  return store.create({ namespace: RUNNER.namespace, title: "cmd", body });
}

function results(store: Store): NoteRecord[] {
  return store.list({ namespace: RUNNER.resultsNamespace, limit: 100 }).notes;
}

describe("signature gate", () => {
  test("a correctly signed command verifies", () => {
    const cmd = buildCommand(SECRET, "echo", {});
    const v = verifyCommand(SECRET, JSON.stringify(cmd));
    assert.equal(v.ok, true);
  });

  test("an unsigned note is rejected", () => {
    const v = verifyCommand(SECRET, JSON.stringify({ cmd_id: "a", action: "echo" }));
    assert.equal(v.ok, false);
  });

  test("a note signed with the wrong secret is rejected", () => {
    const cmd = buildCommand("attacker-secret", "echo", {});
    const v = verifyCommand(SECRET, JSON.stringify(cmd));
    assert.equal(v.ok, false);
    assert.match((v as { reason: string }).reason, /bad signature/);
  });

  test("tampering with the action after signing is caught", () => {
    const cmd = buildCommand(SECRET, "echo", {});
    cmd.action = "wipe-disk";
    const v = verifyCommand(SECRET, JSON.stringify(cmd));
    assert.equal(v.ok, false);
    assert.match((v as { reason: string }).reason, /bad signature/);
  });

  test("tampering with a param after signing is caught", () => {
    const cmd = buildCommand(SECRET, "git-pull", { repo: "calas-site" });
    cmd.params = { repo: "something-else" };
    const v = verifyCommand(SECRET, JSON.stringify(cmd));
    assert.equal(v.ok, false);
  });

  test("param key order does not change the signature", () => {
    const a = canonicalString({
      cmd_id: "1", action: "x", params: { b: "2", a: "1" },
      issued_at: "2026-01-01T00:00:00Z", nonce: "n",
    });
    const b = canonicalString({
      cmd_id: "1", action: "x", params: { a: "1", b: "2" },
      issued_at: "2026-01-01T00:00:00Z", nonce: "n",
    });
    assert.equal(a, b);
  });

  test("garbage body does not throw", () => {
    assert.equal(verifyCommand(SECRET, "not json{{").ok, false);
    assert.equal(verifyCommand(SECRET, "[]").ok, false);
  });
});

describe("freshness gate", () => {
  test("a stale signed command is rejected", () => {
    const base = {
      cmd_id: "old", action: "echo", params: {},
      issued_at: new Date(Date.now() - 86_400_000).toISOString(), nonce: "n",
    };
    const cmd = { v: 2, ...base, sig: signCommand(SECRET, base) };
    const v = verifyCommand(SECRET, JSON.stringify(cmd));
    assert.equal(v.ok, false);
    assert.match((v as { reason: string }).reason, /stale/);
  });

  test("a future-dated command is rejected", () => {
    const base = {
      cmd_id: "future", action: "echo", params: {},
      issued_at: new Date(Date.now() + 86_400_000).toISOString(), nonce: "n",
    };
    const cmd = { v: 2, ...base, sig: signCommand(SECRET, base) };
    const v = verifyCommand(SECRET, JSON.stringify(cmd));
    assert.equal(v.ok, false);
    assert.match((v as { reason: string }).reason, /future/);
  });
});

describe("allowlist gate", () => {
  const allow: Allowlist = {
    "git-pull": {
      file: "git",
      args: ["pull"],
      params: { repo: "[a-z0-9-]{1,40}" },
      paramArgs: ["--repo={repo}"],
    },
    status: { file: "echo", args: ["ok"] },
  };

  test("an unknown action is refused and lists what is allowed", () => {
    const r = resolveAction(allow, "rm-rf", {});
    assert.equal(r.ok, false);
    assert.match((r as { reason: string }).reason, /not allowed/);
    assert.match((r as { reason: string }).reason, /git-pull/);
  });

  test("an allowed action resolves to argv", () => {
    const r = resolveAction(allow, "git-pull", { repo: "calas-site" });
    assert.equal(r.ok, true);
    assert.deepEqual((r as { args: string[] }).args, ["pull", "--repo=calas-site"]);
  });

  test("an undeclared parameter is refused", () => {
    const r = resolveAction(allow, "status", { sneaky: "x" });
    assert.equal(r.ok, false);
  });

  test("a param failing its pattern is refused", () => {
    const r = resolveAction(allow, "git-pull", { repo: "repo; rm -rf /" });
    assert.equal(r.ok, false);
    assert.match((r as { reason: string }).reason, /does not match/);
  });

  test("patterns are anchored — a partial match is not enough", () => {
    const r = resolveAction(allow, "git-pull", { repo: "good../../../etc" });
    assert.equal(r.ok, false);
  });

  test("an empty allowlist refuses everything", () => {
    assert.equal(resolveAction({}, "status", {}).ok, false);
  });
});

describe("execution", () => {
  test("argv is never shell-interpreted", async () => {
    // If this were run through a shell, the subshell would execute and the
    // output would differ. Passed as argv, it is a literal string.
    const out = await runCommand("echo", ["$(id -u)"], { timeoutMs: 10_000 });
    assert.equal(out.exit_code, 0);
    assert.match(out.stdout, /\$\(id -u\)/);
  });

  test("a failing command reports a non-zero exit code", async () => {
    const out = await runCommand("sh", ["-c", "exit 3"], { timeoutMs: 10_000 });
    assert.equal(out.exit_code, 3);
  });

  test("a hanging command is killed by the timeout", async () => {
    const out = await runCommand("sleep", ["30"], { timeoutMs: 700 });
    assert.notEqual(out.exit_code, 0);
    assert.ok(out.duration_ms < 10_000);
  });

  test("the runner secret is stripped from the child environment", async () => {
    process.env.ONEMEMORY_RUNNER_SECRET = "super-secret-value";
    const out = await runCommand("sh", ["-c", "echo [$ONEMEMORY_RUNNER_SECRET]"], {
      timeoutMs: 10_000,
    });
    delete process.env.ONEMEMORY_RUNNER_SECRET;
    assert.match(out.stdout, /\[\]/);
  });

  test("output is truncated rather than unbounded", () => {
    const big = "x".repeat(RUNNER.outputChars + 500);
    const t = truncate(big);
    assert.ok(t.length < big.length);
    assert.match(t, /truncated/);
  });
});

describe("claiming and replay", () => {
  let store: Store;
  let dir: string;
  let ledger: Ledger;

  beforeEach(() => {
    store = new Store(":memory:");
    dir = mkdtempSync(join(tmpdir(), "runner-"));
    ledger = new Ledger(join(dir, "seen.json"));
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("a note can only be claimed once", () => {
    const note = post(store, "{}");
    assert.equal(claimNote(store, note), true);
    // Second attempt with the SAME stale snapshot — the compare-and-swap must
    // reject it. This is the two-runners-racing case.
    assert.equal(claimNote(store, note), false);
  });

  test("the same command id is refused a second time", async () => {
    const allow: Allowlist = { status: { file: "echo", args: ["ok"] } };
    const cmd = buildCommand(SECRET, "status", {});
    const first = post(store, JSON.stringify(cmd));
    await processNote({ store, secret: SECRET, allow, ledger }, first);

    const replay = post(store, JSON.stringify(cmd));
    const verdict = await processNote({ store, secret: SECRET, allow, ledger }, replay);
    assert.match(verdict, /replay/);
    const refusal = results(store).find((n) => n.body.includes("already been executed"));
    assert.ok(refusal, "a replay must be answered in writing");
  });

  test("the ledger survives a restart", () => {
    const p = join(dir, "seen.json");
    new Ledger(p).add("abc");
    assert.equal(new Ledger(p).has("abc"), true);
  });

  test("a corrupt ledger file does not crash the runner", () => {
    const p = join(dir, "corrupt.json");
    writeFileSync(p, "{{{not json");
    assert.equal(new Ledger(p).has("anything"), false);
  });
});

describe("end to end through the store", () => {
  let store: Store;
  let dir: string;
  let ledger: Ledger;
  const allow: Allowlist = {
    status: { file: "echo", args: ["all good"] },
    boom: { file: "sh", args: ["-c", "echo bad >&2; exit 2"] },
  };

  beforeEach(() => {
    store = new Store(":memory:");
    dir = mkdtempSync(join(tmpdir(), "runner-e2e-"));
    ledger = new Ledger(join(dir, "seen.json"));
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("a valid command runs and the result is readable", async () => {
    post(store, JSON.stringify(buildCommand(SECRET, "status", {})));
    const handled = await pollOnce({ store, secret: SECRET, allow, ledger });
    assert.equal(handled, 1);

    const [res] = results(store);
    assert.ok(res, "a result note must exist");
    const parsed = JSON.parse(res.body) as { status: string; stdout: string };
    assert.equal(parsed.status, "ok");
    assert.match(parsed.stdout, /all good/);
  });

  test("a failing command is reported as failed, not silently dropped", async () => {
    post(store, JSON.stringify(buildCommand(SECRET, "boom", {})));
    await pollOnce({ store, secret: SECRET, allow, ledger });
    const parsed = JSON.parse(results(store)[0].body) as { status: string; exit_code: number };
    assert.equal(parsed.status, "failed");
    assert.equal(parsed.exit_code, 2);
  });

  test("a disallowed action is refused in writing", async () => {
    post(store, JSON.stringify(buildCommand(SECRET, "format-c-drive", {})));
    await pollOnce({ store, secret: SECRET, allow, ledger });
    const parsed = JSON.parse(results(store)[0].body) as { status: string; reason: string };
    assert.equal(parsed.status, "refused");
    assert.match(parsed.reason, /not allowed/);
  });

  test("a forged note gets silence, not an oracle reply", async () => {
    post(store, JSON.stringify(buildCommand("wrong-secret", "status", {})));
    await pollOnce({ store, secret: SECRET, allow, ledger });
    assert.equal(results(store).length, 0, "a bad signature must not be answered");
  });

  test("a forged note is still claimed so it is not re-read every poll", async () => {
    post(store, JSON.stringify(buildCommand("wrong-secret", "status", {})));
    await pollOnce({ store, secret: SECRET, allow, ledger });
    const [note] = store.list({ namespace: RUNNER.namespace, limit: 10 }).notes;
    assert.ok(note.tags.includes(CLAIMED_TAG));
  });

  test("a second poll does not re-run an already handled command", async () => {
    post(store, JSON.stringify(buildCommand(SECRET, "status", {})));
    await pollOnce({ store, secret: SECRET, allow, ledger });
    const handledAgain = await pollOnce({ store, secret: SECRET, allow, ledger });
    assert.equal(handledAgain, 0);
    assert.equal(results(store).length, 1);
  });

  test("commands run oldest first", async () => {
    const a = buildCommand(SECRET, "status", {});
    const b = buildCommand(SECRET, "status", {});
    post(store, JSON.stringify(a));
    post(store, JSON.stringify(b));
    await pollOnce({ store, secret: SECRET, allow, ledger });
    const order = results(store)
      .map((n) => (JSON.parse(n.body) as { cmd_id: string }).cmd_id)
      .reverse(); // list() is newest-first
    assert.deepEqual(order, [a.cmd_id, b.cmd_id]);
  });

  test("one bad note does not stop the rest of the queue", async () => {
    post(store, "total garbage, not even json");
    post(store, JSON.stringify(buildCommand(SECRET, "status", {})));
    const handled = await pollOnce({ store, secret: SECRET, allow, ledger });
    assert.equal(handled, 2);
    assert.ok(results(store).some((n) => n.body.includes('"ok"')));
  });
});

describe("single instance lock", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "runner-lock-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("a live lock blocks a second runner", () => {
    const p = join(dir, "runner.lock");
    assert.equal(acquireLock(p), true);
    writeFileSync(p, String(process.pid)); // held by this live process
    assert.equal(acquireLock(p), false);
  });

  test("a stale lock from a dead process is reclaimed", () => {
    const p = join(dir, "runner.lock");
    writeFileSync(p, "999999999"); // pid that cannot be running
    assert.equal(acquireLock(p), true);
  });

  test("releasing removes the lock", () => {
    const p = join(dir, "runner.lock");
    acquireLock(p);
    releaseLock(p);
    assert.equal(existsSync(p), false);
  });
});

describe("allowlist loading", () => {
  afterEach(() => delete process.env.ONEMEMORY_RUNNER_ALLOW);

  test("invalid JSON yields an empty (deny-all) allowlist", () => {
    process.env.ONEMEMORY_RUNNER_ALLOW = "{{{";
    assert.deepEqual(loadAllowlist(), {});
  });

  test("a JSON array is rejected as an allowlist", () => {
    process.env.ONEMEMORY_RUNNER_ALLOW = "[]";
    assert.deepEqual(loadAllowlist(), {});
  });
});

describe("queue fairness under a backlog", () => {
  test("an old pending command is not starved by newer handled ones", async () => {
    // Regression guard for the starvation bug: list() is newest-first and
    // claiming bumps updated_at, so a single 50-note window would bury this
    // first command behind the 120 that follow it.
    const store = new Store(":memory:");
    const dir = mkdtempSync(join(tmpdir(), "runner-backlog-"));
    const ledger = new Ledger(join(dir, "seen.json"));
    const allow: Allowlist = { status: { file: "echo", args: ["ok"] } };

    const first = buildCommand(SECRET, "status", {});
    post(store, JSON.stringify(first));
    for (let i = 0; i < 120; i++) {
      store.create({
        namespace: RUNNER.namespace,
        title: `noise ${i}`,
        body: "{}",
        tags: [CLAIMED_TAG],
      });
    }

    await pollOnce({ store, secret: SECRET, allow, ledger });
    const ran = results(store).some((n) => n.body.includes(first.cmd_id));
    assert.ok(ran, "the oldest pending command must still run behind a backlog");

    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("result lifecycle (round 2)", () => {
  let store: Store;
  let dir: string;
  let ledger: Ledger;
  const allow: Allowlist = { slow: { file: "sleep", args: ["0.4"] } };

  beforeEach(() => {
    store = new Store(":memory:");
    dir = mkdtempSync(join(tmpdir(), "runner-r2-"));
    ledger = new Ledger(join(dir, "seen.json"));
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("a result note exists WHILE the command is still running", async () => {
    const cmd = buildCommand(SECRET, "slow", {});
    const note = post(store, JSON.stringify(cmd));
    const inflight = processNote({ store, secret: SECRET, allow, ledger }, note);

    // Mid-flight: the operator must be able to see "running", not silence.
    await new Promise((r) => setTimeout(r, 150));
    const during = results(store)[0];
    assert.ok(during, "a note must exist before the command finishes");
    assert.equal((JSON.parse(during.body) as { status: string }).status, "running");

    await inflight;
    const after = results(store);
    assert.equal(after.length, 1, "the running note is closed, not duplicated");
    assert.equal((JSON.parse(after[0].body) as { status: string }).status, "ok");
  });

  test("introspection lists the allowed actions without running anything", async () => {
    post(store, JSON.stringify(buildCommand(SECRET, INTROSPECT_ACTION, {})));
    await pollOnce({ store, secret: SECRET, allow, ledger });
    const parsed = JSON.parse(results(store)[0].body) as {
      status: string;
      actions: { action: string }[];
    };
    assert.equal(parsed.status, "ok");
    assert.deepEqual(parsed.actions.map((a) => a.action), ["slow"]);
  });

  test("introspection works even with an empty allowlist", async () => {
    post(store, JSON.stringify(buildCommand(SECRET, INTROSPECT_ACTION, {})));
    await pollOnce({ store, secret: SECRET, allow: {}, ledger });
    const parsed = JSON.parse(results(store)[0].body) as { count: number };
    assert.equal(parsed.count, 0);
  });
});

describe("flood control (round 2)", () => {
  let store: Store;
  let dir: string;
  let ledger: Ledger;
  const allow: Allowlist = { status: { file: "echo", args: ["ok"] } };

  beforeEach(() => {
    store = new Store(":memory:");
    dir = mkdtempSync(join(tmpdir(), "runner-flood-"));
    ledger = new Ledger(join(dir, "seen.json"));
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("a burst is capped per poll but nothing is lost", async () => {
    for (let i = 0; i < RUNNER.maxPerPoll + 4; i++) {
      post(store, JSON.stringify(buildCommand(SECRET, "status", {})));
    }
    const deps = { store, secret: SECRET, allow, ledger, recent: [] as number[] };

    const first = await pollOnce(deps);
    assert.equal(first, RUNNER.maxPerPoll, "the first pass must be capped");

    const second = await pollOnce(deps);
    assert.equal(second, 4, "the overflow must run on the next pass, not vanish");
  });
});

describe("retention pruning (round 2)", () => {
  test("old handled notes are pruned, fresh and unhandled ones are kept", () => {
    const store = new Store(":memory:");
    const old = store.create({
      namespace: RUNNER.resultsNamespace,
      title: "ancient result",
      body: "{}",
      tags: [RESULT_TAG],
    });
    const fresh = store.create({
      namespace: RUNNER.resultsNamespace,
      title: "todays result",
      body: "{}",
      tags: [RESULT_TAG],
    });
    const unhandled = store.create({
      namespace: RUNNER.namespace,
      title: "still waiting",
      body: "{}",
    });

    // Prune as if we were 40 days in the future: the two of those notes that
    // are "handled" go, and the unclaimed command must survive regardless.
    const future = Date.now() + 40 * 86_400_000;
    pruneOld(store, 30, future);

    assert.equal(store.read(old.id), null);
    assert.equal(store.read(fresh.id), null);
    assert.ok(store.read(unhandled.id), "an unclaimed command must never be pruned");

    // And with retention disabled, nothing is touched.
    const keep = store.create({
      namespace: RUNNER.resultsNamespace,
      title: "keep me",
      body: "{}",
      tags: [RESULT_TAG],
    });
    pruneOld(store, 0, future);
    assert.ok(store.read(keep.id));
    store.close();
  });
});

describe("heartbeat (round 2)", () => {
  test("repeated beats update one note instead of piling up duplicates", () => {
    const store = new Store(":memory:");
    resetHeartbeat();
    beat(store, SECRET, new Date().toISOString());
    beat(store, SECRET, new Date().toISOString());
    beat(store, SECRET, new Date().toISOString());
    const beats = store.list({ namespace: "runner", limit: 100 }).notes;
    assert.equal(beats.length, 1, "exactly one heartbeat note");
    const parsed = JSON.parse(beats[0].body) as { alive_at: string; pid: number };
    assert.ok(parsed.alive_at);
    assert.equal(parsed.pid, process.pid);
    store.close();
  });
});

describe("round 3 fixes", () => {
  test("pruning reaches OLD notes, not just the newest page", () => {
    // Regression guard: list() is newest-first, so an earlier version read
    // only the first page and concluded there was nothing to prune. With 250
    // notes, the stale ones sit well past page one.
    const store = new Store(":memory:");
    for (let i = 0; i < 250; i++) {
      store.create({
        namespace: RUNNER.resultsNamespace,
        title: `result ${i}`,
        body: "{}",
        tags: [RESULT_TAG],
      });
    }
    const future = Date.now() + 40 * 86_400_000;
    const removed = pruneOld(store, 30, future);
    assert.equal(removed, 250, "every stale note must be pruned, not just page one");
    assert.equal(store.list({ namespace: RUNNER.resultsNamespace }).total, 0);
    store.close();
  });

  test("credential-shaped env vars do not reach the child", async () => {
    process.env.MY_API_KEY = "leak-me";
    process.env.DB_PASSWORD = "leak-me-too";
    process.env.HARMLESS_SETTING = "fine";
    const out = await runCommand(
      "sh",
      ["-c", "echo [$MY_API_KEY][$DB_PASSWORD][$HARMLESS_SETTING]"],
      { timeoutMs: 10_000 }
    );
    delete process.env.MY_API_KEY;
    delete process.env.DB_PASSWORD;
    delete process.env.HARMLESS_SETTING;
    assert.match(out.stdout, /\[\]\[\]\[fine\]/, "secrets stripped, normal vars kept");
  });

  test("a command addressed to another machine is left for that machine", async () => {
    const store = new Store(":memory:");
    const dir = mkdtempSync(join(tmpdir(), "runner-target-"));
    const ledger = new Ledger(join(dir, "seen.json"));
    const allow: Allowlist = { status: { file: "echo", args: ["ok"] } };

    const note = post(store, JSON.stringify(buildCommand(SECRET, "status", {}, "OTHER-PC")));
    const verdict = await processNote(
      { store, secret: SECRET, allow, ledger, runnerId: "DANITA" },
      note
    );
    assert.match(verdict, /addressed to OTHER-PC/);
    assert.equal(results(store).length, 0, "no result — it is not ours to answer");
    assert.equal(
      store.read(note.id)!.tags.includes(CLAIMED_TAG),
      false,
      "and crucially it must stay unclaimed for the real target"
    );
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("a command addressed to THIS machine still runs", async () => {
    const store = new Store(":memory:");
    const dir = mkdtempSync(join(tmpdir(), "runner-target2-"));
    const ledger = new Ledger(join(dir, "seen.json"));
    const allow: Allowlist = { status: { file: "echo", args: ["ok"] } };

    post(store, JSON.stringify(buildCommand(SECRET, "status", {}, "DANITA")));
    await pollOnce({ store, secret: SECRET, allow, ledger, runnerId: "DANITA" });
    assert.equal((JSON.parse(results(store)[0].body) as { status: string }).status, "ok");
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("re-targeting a captured command breaks its signature", () => {
    const cmd = buildCommand(SECRET, "status", {}, "DANITA");
    cmd.target = "ATTACKER-PC";
    assert.equal(verifyCommand(SECRET, JSON.stringify(cmd)).ok, false);
  });
});

describe("round 4 — prune throttling", () => {
  test("pruning does not re-run on every heartbeat", async () => {
    // The heartbeat fires every few minutes; walking both namespaces to the
    // end that often is wasted work. Drive several beats quickly and assert
    // the sweep happened at most once.
    const store = new Store(":memory:");
    resetHeartbeat();
    const dir = mkdtempSync(join(tmpdir(), "runner-prune-"));
    const ledger = new Ledger(join(dir, "seen.json"));

    let sweeps = 0;
    const realList = store.list.bind(store);
    // Count only pruneOld's paging reads: limit 200 over the command/result
    // namespaces. The heartbeat also reads with limit 200, so matching on the
    // limit alone would count that too and make this test lie.
    (store as unknown as { list: typeof store.list }).list = ((opts = {}) => {
      const ns = opts.namespace;
      const pruneRead =
        opts.limit === 200 && (ns === RUNNER.namespace || ns === RUNNER.resultsNamespace);
      if (pruneRead) sweeps++;
      return realList(opts);
    }) as typeof store.list;

    const prevBeat = RUNNER.heartbeatMs;
    (RUNNER as { heartbeatMs: number }).heartbeatMs = 20;
    const handle = startRunner({ store, secret: SECRET, allow: {}, ledger });
    await new Promise((r) => setTimeout(r, 160)); // ~8 heartbeats
    handle.stop();
    (RUNNER as { heartbeatMs: number }).heartbeatMs = prevBeat;

    // One sweep = one paging read per namespace = 2. More than that means the
    // throttle is not holding across heartbeats.
    assert.ok(sweeps <= 2, `expected one sweep (2 reads), saw ${sweeps}`);
    assert.ok(sweeps > 0, "the first heartbeat should still prune once");
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
