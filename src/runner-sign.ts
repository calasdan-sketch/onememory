// `npm run runner:sign -- <action> [key=value ...] [--target NAME]`
//
// Prints a ready-to-post signed command. Exists because hand-building the
// JSON and computing an HMAC by hand is miserable and easy to get wrong --
// and a mis-signed command just gets silently ignored, which is the most
// confusing possible failure when you are away from the machine.
//
// The secret never leaves this process: it is read from the environment and
// only the resulting signature is printed.

import { readFileSync } from "node:fs";
import { buildCommand, INTROSPECT_ACTION, verifyResult } from "./runner.js";

export interface ParsedArgs {
  action: string;
  params: Record<string, string>;
  target: string;
  post: boolean;
}

/** Parse argv into an action, params and flags. Exported so it can be tested. */
export function parseArgs(argv: string[]): ParsedArgs | { error: string } {
  const params: Record<string, string> = {};
  let action = "";
  let target = "";
  let post = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--target") {
      const v = argv[++i];
      if (!v) return { error: "--target needs a machine name" };
      target = v;
    } else if (a.startsWith("--target=")) {
      target = a.slice("--target=".length);
    } else if (a === "--post") {
      post = true;
    } else if (a.startsWith("--")) {
      return { error: `unknown flag ${a}` };
    } else if (!action) {
      action = a;
    } else {
      // Split on the FIRST "=" only, so a value may itself contain one.
      const eq = a.indexOf("=");
      if (eq <= 0) return { error: `expected key=value, got "${a}"` };
      params[a.slice(0, eq)] = a.slice(eq + 1);
    }
  }

  if (!action) return { error: "no action given" };
  return { action, params, target, post };
}

const USAGE = `Usage: npm run runner:sign -- <action> [key=value ...] [--target NAME] [--post]
       npm run runner:sign -- verify-result <note-body-json | ->

  <action>      an allowlisted action, or ${INTROSPECT_ACTION} to ask the PC what it allows
  key=value     a parameter the action declares
  --target      only let the machine with this runner id execute it
  --post        send it to the store instead of just printing it
                (needs ONEMEMORY_URL and ONEMEMORY_TOKEN)

  verify-result checks that a result or heartbeat note body was really
  written by your runner (pass the JSON, or - to read it from stdin).

Requires ONEMEMORY_RUNNER_SECRET to be set.`;

/**
 * `verify-result`: is this result/heartbeat body really from the runner?
 * Exit 0 = authentic, 2 = not authentic, 1 = usage error.
 */
export function verifyResultCli(secret: string, args: string[]): number {
  if (args.length === 0) {
    console.error("verify-result needs the note body (JSON), or - to read stdin.");
    return 1;
  }
  const body = args.length === 1 && args[0] === "-" ? readFileSync(0, "utf8") : args.join(" ");
  const v = verifyResult(secret, body);
  if (!v.ok) {
    console.log(`NOT AUTHENTIC: ${v.reason}`);
    return 2;
  }
  const p = v.payload;
  console.log(
    v.kind === "heartbeat"
      ? `authentic heartbeat from ${String(p.runner ?? p.host)}, alive at ${String(p.alive_at)}`
      : `authentic result for ${String(p.cmd_id)}: ${String(p.status)}`
  );
  return 0;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const secret = process.env.ONEMEMORY_RUNNER_SECRET?.trim();
  if (!secret) {
    console.error("ONEMEMORY_RUNNER_SECRET is not set — cannot sign anything.\n");
    console.error(USAGE);
    return 1;
  }
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    console.error(USAGE);
    return argv.length === 0 ? 1 : 0;
  }

  if (argv[0] === "verify-result") return verifyResultCli(secret, argv.slice(1));

  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    console.error(`${parsed.error}\n`);
    console.error(USAGE);
    return 1;
  }

  const cmd = buildCommand(secret, parsed.action, parsed.params, parsed.target);
  const body = JSON.stringify(cmd, null, 2);

  if (!parsed.post) {
    console.log(body);
    return 0;
  }

  const url = process.env.ONEMEMORY_URL;
  const token = process.env.ONEMEMORY_TOKEN;
  if (!url || !token) {
    console.error("--post needs ONEMEMORY_URL and ONEMEMORY_TOKEN set.");
    return 1;
  }
  const res = await fetch(`${url.replace(/\/$/, "")}/notes`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      namespace: process.env.ONEMEMORY_RUNNER_NAMESPACE || "commands",
      title: `cmd ${parsed.action}`,
      body,
      tags: ["command"],
      source: "runner-sign",
    }),
  });
  if (!res.ok) {
    console.error(`posting failed: ${res.status} ${await res.text()}`);
    return 1;
  }
  console.log(`sent. watch for result ${cmd.cmd_id} in the results namespace.`);
  return 0;
}
