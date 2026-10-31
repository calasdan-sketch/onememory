// redact.ts: <private> stripping and secret redaction for everything the capture hooks record.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { stripPrivate, redactSecrets, redact } from "../src/redact.js";
import { scanForSecrets } from "../src/security.js";

describe("stripPrivate", () => {
  test("drops a block, keeps the rest", () => {
    assert.equal(stripPrivate("a <private>secret</private> b"), "a  b");
    assert.equal(stripPrivate("a <PRIVATE note='x'>s</Private> b"), "a  b");
  });
  test("nested blocks go as one", () => {
    assert.equal(stripPrivate("x<private>1<private>2</private>3</private>y"), "xy");
  });
  test("an unclosed block drops everything after it", () => {
    assert.equal(stripPrivate("keep <private>the rest is hidden"), "keep ");
    assert.equal(stripPrivate("a <private>b <private>c</private> d"), "a ");
  });
  test("a stray close tag is dropped alone; text without tags is untouched", () => {
    assert.equal(stripPrivate("a </private> b"), "a  b");
    assert.equal(stripPrivate("privately nothing here"), "privately nothing here");
    assert.equal(stripPrivate(""), "");
  });
});

describe("redactSecrets", () => {
  const samples: Array<[string, string]> = [
    ["AWS access key", "key AKIAIOSFODNN7EXAMPLE here"],
    ["GitHub token", "token ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8 end"],
    ["Stripe key", "sk_live_" + "4eC39HqLyjWDarjtT1zdp7dc"],
    ["OpenAI/Anthropic key", "export K=sk-ant-api03-" + "Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4zAb7cDe0fGh"],
  ];
  for (const [label, text] of samples) {
    test(`replaces a ${label}`, () => {
      const r = redactSecrets(text);
      assert.ok(r.labels.includes(label), JSON.stringify(r));
      assert.match(r.text, new RegExp(`\\[REDACTED:${label.replace("/", "\\/")}\\]`));
      assert.equal(scanForSecrets(r.text), null, "nothing the linter would refuse is left");
    });
  }
  test("a whole PEM private key block goes", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nabc\n-----END RSA PRIVATE KEY-----";
    const r = redactSecrets(`before\n${pem}\nafter`);
    assert.equal(r.text, "before\n[REDACTED:private key block]\nafter");
  });
  test("every occurrence is replaced, ordinary text is untouched", () => {
    const r = redactSecrets("AKIAIOSFODNN7EXAMPLE and AKIAIOSFODNN7EXAMPLF");
    assert.equal(r.text, "[REDACTED:AWS access key] and [REDACTED:AWS access key]");
    const plain = "npm test passed in src/store.ts at commit 3f2a9c1e";
    assert.deepEqual(redactSecrets(plain), { text: plain, labels: [] });
  });
  test("redact strips private blocks first", () => {
    const r = redact("<private>AKIAIOSFODNN7EXAMPLE</private>ok");
    assert.deepEqual(r, { text: "ok", labels: [] });
  });
});
