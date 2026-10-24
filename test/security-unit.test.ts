// Unit tests for the security module: the rate limiter, the DNS-rebinding
// Origin check, client-IP resolution (spoofing defense), the secret scanner,
// size caps, scope math, and bearer-token authentication. These are the
// controls that sit in front of a tunnel-exposed service, so they get direct
// coverage here rather than only being exercised incidentally.
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import {
  RateLimiter,
  originAllowed,
  clientKey,
  scanForSecrets,
  checkSizes,
  scopeAllows,
  authenticate,
  LIMITS,
} from "../src/security.js";
import type { TokenEntry } from "../src/config.js";

// Minimal fake request: only the fields these helpers read.
function req(headers: Record<string, string> = {}, remoteAddress = "203.0.113.7"): IncomingMessage {
  return { headers, socket: { remoteAddress } } as unknown as IncomingMessage;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("RateLimiter", () => {
  test("allows up to `max` per window, then blocks", () => {
    const rl = new RateLimiter(3, 10_000);
    assert.equal(rl.check("k"), true);
    assert.equal(rl.check("k"), true);
    assert.equal(rl.check("k"), true);
    assert.equal(rl.check("k"), false); // 4th over the limit of 3
  });

  test("separate keys have separate buckets", () => {
    const rl = new RateLimiter(1, 10_000);
    assert.equal(rl.check("a"), true);
    assert.equal(rl.check("b"), true); // different key, not blocked by a
    assert.equal(rl.check("a"), false);
  });

  test("the window resets", async () => {
    const rl = new RateLimiter(1, 40);
    assert.equal(rl.check("k"), true);
    assert.equal(rl.check("k"), false);
    await sleep(60);
    assert.equal(rl.check("k"), true); // fresh window
  });
});

describe("originAllowed (DNS-rebinding defense)", () => {
  const SAVE = process.env.ONEMEMORY_ALLOWED_ORIGINS;
  afterEach(() => {
    if (SAVE === undefined) delete process.env.ONEMEMORY_ALLOWED_ORIGINS;
    else process.env.ONEMEMORY_ALLOWED_ORIGINS = SAVE;
  });

  test("no Origin header (non-browser client) is allowed", () => {
    assert.equal(originAllowed(req({})), true);
  });

  test("a loopback Origin (the local dashboard) is allowed", () => {
    assert.equal(originAllowed(req({ origin: "http://127.0.0.1:8790" })), true);
    assert.equal(originAllowed(req({ origin: "http://localhost:8790" })), true);
    assert.equal(originAllowed(req({ origin: "http://[::1]:8790" })), true);
  });

  test("an unlisted browser Origin is blocked", () => {
    delete process.env.ONEMEMORY_ALLOWED_ORIGINS;
    assert.equal(originAllowed(req({ origin: "http://evil.com" })), false);
  });

  test("a rebinding request (Origin==Host, both attacker-controlled) is still blocked", () => {
    delete process.env.ONEMEMORY_ALLOWED_ORIGINS;
    // The old same-origin shortcut would have waved this through.
    assert.equal(
      originAllowed(req({ origin: "http://evil.com", host: "evil.com" })),
      false
    );
  });

  test("an explicitly allowlisted Origin is allowed; others still blocked", () => {
    process.env.ONEMEMORY_ALLOWED_ORIGINS = "https://notes.example.com, https://ok.test";
    assert.equal(originAllowed(req({ origin: "https://notes.example.com" })), true);
    assert.equal(originAllowed(req({ origin: "https://ok.test" })), true);
    assert.equal(originAllowed(req({ origin: "https://nope.example.com" })), false);
  });

  test("a malformed Origin is blocked", () => {
    delete process.env.ONEMEMORY_ALLOWED_ORIGINS;
    assert.equal(originAllowed(req({ origin: "@@not a url@@" })), false);
  });
});

describe("clientKey (rate-limit key / IP-spoofing defense)", () => {
  const SAVE = {
    cf: process.env.ONEMEMORY_TRUST_CLOUDFLARE,
    px: process.env.ONEMEMORY_TRUST_PROXY,
  };
  afterEach(() => {
    for (const [k, v] of [
      ["ONEMEMORY_TRUST_CLOUDFLARE", SAVE.cf],
      ["ONEMEMORY_TRUST_PROXY", SAVE.px],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  test("defaults to the socket address, ignoring forwarded headers", () => {
    delete process.env.ONEMEMORY_TRUST_CLOUDFLARE;
    delete process.env.ONEMEMORY_TRUST_PROXY;
    const key = clientKey(
      req({ "cf-connecting-ip": "1.1.1.1", "x-forwarded-for": "2.2.2.2" }, "10.0.0.5")
    );
    assert.equal(key, "10.0.0.5"); // forged headers do not get their own bucket
  });

  test("trusts cf-connecting-ip only when ONEMEMORY_TRUST_CLOUDFLARE=1", () => {
    process.env.ONEMEMORY_TRUST_CLOUDFLARE = "1";
    assert.equal(clientKey(req({ "cf-connecting-ip": "9.9.9.9" }, "10.0.0.5")), "9.9.9.9");
  });

  test("trusts the first x-forwarded-for hop only when ONEMEMORY_TRUST_PROXY=1", () => {
    process.env.ONEMEMORY_TRUST_PROXY = "1";
    assert.equal(
      clientKey(req({ "x-forwarded-for": "8.8.8.8, 7.7.7.7" }, "10.0.0.5")),
      "8.8.8.8"
    );
  });
});

describe("scanForSecrets", () => {
  // Assemble each fixture from fragments so no credential-shaped literal ever
  // appears verbatim in this source file (GitHub push protection / secret
  // scanners match raw text). scanForSecrets still sees the full joined string
  // at runtime, so the scanner is exercised exactly as in production.
  const j = (...parts: string[]): string => parts.join("");
  const cases: [string, string][] = [
    ["AWS access key", j("AKIA", "1234567890ABCD12")],
    ["private key block", j("-----BEGIN RSA PRIVATE ", "KEY-----")],
    ["OpenAI/Anthropic key", j("sk", "-", "T3BlbkFJaBcD1eFgH2iJkL3mNoP4qRsT5uVwX6yZaB7cD8eF")],
    ["OpenAI/Anthropic key", j("sk", "-proj-", "Ab3dEf6hIj9lMn0pQr3tUv6xYz9AbCdEf2hIj5lMn8")],
    ["OpenAI/Anthropic key", j("sk-ant", "-api03-", "Ab3dEf6hIj9lMn0pQr3tUv6xYz9AbCdEf2hIj5lMn8pQr1tUv4xYz7")],
    ["GitHub token", j("ghp", "_", "0123456789abcdefghijklmnopqrstuvwxyz")],
    ["Google API key", j("AIza", "SyA1234567890abcdefghijklmnopqrstuv")],
    ["Slack token", j("xoxb", "-", "1234567890-abcdefghijklmno")],
  ];
  for (const [label, text] of cases) {
    test(`detects ${label}`, () => {
      assert.equal(scanForSecrets(text), label);
    });
  }
  test("ordinary prose is not flagged", () => {
    assert.equal(scanForSecrets("we deploy on Fly.io, not Render"), null);
    assert.equal(scanForSecrets(undefined), null);
  });
});

describe("checkSizes", () => {
  test("accepts within-limit input", () => {
    assert.equal(checkSizes({ title: "ok", body: "fine", tags: ["a", "b"] }), null);
  });
  test("rejects an over-long title", () => {
    assert.match(checkSizes({ title: "x".repeat(LIMITS.title + 1) }) ?? "", /title exceeds/);
  });
  test("rejects an over-long body", () => {
    assert.match(checkSizes({ body: "x".repeat(LIMITS.body + 1) }) ?? "", /body exceeds/);
  });
  test("rejects too many tags", () => {
    const tags = Array.from({ length: LIMITS.tagCount + 1 }, (_, i) => `t${i}`);
    assert.match(checkSizes({ tags }) ?? "", /too many tags/);
  });
  test("rejects an over-long tag", () => {
    assert.match(checkSizes({ tags: ["x".repeat(LIMITS.tagLen + 1)] }) ?? "", /tag exceeds/);
  });
});

describe("scopeAllows", () => {
  test("ranks read < write < admin", () => {
    assert.equal(scopeAllows("admin", "read"), true);
    assert.equal(scopeAllows("admin", "write"), true);
    assert.equal(scopeAllows("admin", "admin"), true);
    assert.equal(scopeAllows("write", "read"), true);
    assert.equal(scopeAllows("write", "admin"), false);
    assert.equal(scopeAllows("read", "write"), false);
    assert.equal(scopeAllows("read", "admin"), false);
  });
});

describe("authenticate", () => {
  const tokens: TokenEntry[] = [
    { token: "ADMINTOK", scope: "admin", label: "primary" },
    { token: "READTOK", scope: "read", label: "reader" },
  ];
  test("returns the matched token's scope", () => {
    assert.equal(authenticate(req({ authorization: "Bearer ADMINTOK" }), tokens), "admin");
    assert.equal(authenticate(req({ authorization: "Bearer READTOK" }), tokens), "read");
  });
  test("is case-insensitive on the Bearer keyword", () => {
    assert.equal(authenticate(req({ authorization: "bearer READTOK" }), tokens), "read");
  });
  test("rejects unknown, missing, or malformed credentials", () => {
    assert.equal(authenticate(req({ authorization: "Bearer NOPE" }), tokens), null);
    assert.equal(authenticate(req({}), tokens), null);
    assert.equal(authenticate(req({ authorization: "Basic abc" }), tokens), null);
  });
});
