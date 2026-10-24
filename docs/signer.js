// Browser-side command signer and result checker, used by sign.html.
//
// This is plain JS with no build step so it runs straight off a phone, and it
// uses WebCrypto, which both browsers and Node provide. Your runner secret is
// used here and nowhere else -- it is never sent to the store, only the
// resulting signature is.
//
// The canonical format MUST stay identical to canonicalJson()/canonicalString()
// in src/runner.ts. A parity test in test/signer-parity.test.ts imports both
// and fails if they ever drift, because a silent mismatch would show up as
// every command being ignored with no explanation.

export const COMMAND_FORMAT = 2;
export const COMMAND_DOMAIN = "onememory-cmd-v2";
export const RESULT_DOMAIN = "onememory-result-v1";

/** Deterministic JSON: sorted keys, no whitespace, undefined members dropped. */
export function canonicalJson(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return "[" + v.map(canonicalJson).join(",") + "]";
  return (
    "{" +
    Object.keys(v)
      .filter((k) => v[k] !== undefined)
      .sort()
      .map((k) => JSON.stringify(k) + ":" + canonicalJson(v[k]))
      .join(",") +
    "}"
  );
}

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export function hasControlChars(cmd) {
  const strs = [cmd.cmd_id, cmd.action, cmd.target ?? "", cmd.issued_at, cmd.nonce];
  for (const [k, val] of Object.entries(cmd.params ?? {})) strs.push(k, val);
  return strs.some((x) => CONTROL_CHARS.test(x));
}

/** Exactly the bytes the runner verifies. */
export function canonicalString(cmd) {
  return (
    COMMAND_DOMAIN +
    "\n" +
    canonicalJson({
      v: COMMAND_FORMAT,
      cmd_id: cmd.cmd_id,
      action: cmd.action,
      params: cmd.params ?? {},
      target: cmd.target ?? "",
      issued_at: cmd.issued_at,
      nonce: cmd.nonce,
    })
  );
}

function toHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function hmacKey(secret, usage) {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    [usage]
  );
}

export async function signCommand(secret, cmd) {
  const key = await hmacKey(secret, "sign");
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(canonicalString(cmd)));
  return toHex(sig);
}

export async function buildCommand(secret, action, params = {}, target = "") {
  const base = {
    cmd_id: crypto.randomUUID(),
    action,
    params,
    target,
    issued_at: new Date().toISOString(),
    nonce: crypto.randomUUID(),
  };
  if (hasControlChars(base)) throw new Error("control characters are not allowed in a command");
  return { v: COMMAND_FORMAT, ...base, sig: await signCommand(secret, base) };
}

/**
 * Check a result or heartbeat note body written by the runner. Resolves to
 * { ok: true, kind, payload } or { ok: false, reason }. The comparison is
 * done by WebCrypto's verify(), which is constant-time.
 */
export async function verifyResult(secret, body) {
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { ok: false, reason: "body is not valid JSON" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "body is not an object" };
  }
  const { sig, ...rest } = parsed;
  if (typeof sig !== "string" || !sig) return { ok: false, reason: "not signed" };
  if (rest.kind !== "result" && rest.kind !== "heartbeat") {
    return { ok: false, reason: "unknown kind" };
  }
  if (!/^[0-9a-f]{64}$/.test(sig)) return { ok: false, reason: "bad signature" };
  const sigBytes = new Uint8Array(sig.match(/../g).map((h) => parseInt(h, 16)));
  const key = await hmacKey(secret, "verify");
  const data = new TextEncoder().encode(RESULT_DOMAIN + "\n" + canonicalJson(rest));
  const good = await crypto.subtle.verify("HMAC", key, sigBytes, data);
  return good ? { ok: true, kind: rest.kind, payload: rest } : { ok: false, reason: "bad signature" };
}
