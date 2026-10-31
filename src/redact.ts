// What the capture hooks remove before anything they record reaches the database.
//
//  - stripPrivate: everything between <private> and </private> is dropped (case-insensitive, attributes allowed).
//    Nested blocks are dropped as one; an unclosed <private> drops everything after it (the safe reading: the writer
//    meant to hide the rest); a stray </private> is dropped on its own.
//  - redactSecrets: every credential the memory linter would refuse is replaced with [REDACTED:<label>]. The pattern
//    list is security.ts's (single source of truth), plus the high-entropy heuristic, which the linter only warns on
//    but capture redacts: nobody reviews a captured event before it is stored.
import { SECRET_PATTERNS, hasOpenAiAnthropicKey, hasJwt, hasHighEntropyToken, HIGH_ENTROPY_LABEL } from "./security.js";

const PRIVATE_TAG = /<(\/?)private\b[^>]*>/gi;

export function stripPrivate(text: string): string {
  if (!text || !/<\/?private\b/i.test(text)) return text;
  let out = "";
  let depth = 0;
  let last = 0;
  for (const m of text.matchAll(PRIVATE_TAG)) {
    const at = m.index ?? 0;
    if (m[1] === "/") {
      if (depth === 0) {
        out += text.slice(last, at); // a stray close: drop just the tag
      } else if (--depth > 0) {
        continue;
      }
      last = at + m[0].length;
    } else {
      if (depth++ === 0) out += text.slice(last, at);
      last = at + m[0].length;
    }
  }
  return depth > 0 ? out : out + text.slice(last);
}

const PRIVATE_KEY_BLOCK =
  /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----|$)/g;
/** Candidate tokens for the shape-checked detectors (sk- keys, JWTs, random-looking tokens). */
const TOKEN = /[A-Za-z0-9_.+=/-]{20,}/g;

export interface Redacted {
  text: string;
  /** Labels of what was replaced (empty when nothing was). */
  labels: string[];
}

export function redactSecrets(text: string): Redacted {
  const labels = new Set<string>();
  if (!text) return { text, labels: [] };
  const mark = (label: string): string => {
    labels.add(label);
    return `[REDACTED:${label}]`;
  };
  let t = text.replace(PRIVATE_KEY_BLOCK, () => mark("private key block"));
  for (const [label, re] of SECRET_PATTERNS) {
    if (label === "private key block") continue;
    t = t.replace(new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g"), () => mark(label));
  }
  t = t.replace(TOKEN, (tok) => {
    if (hasOpenAiAnthropicKey(tok)) return mark("OpenAI/Anthropic key");
    if (hasJwt(tok)) return mark("JWT");
    if (hasHighEntropyToken(tok)) return mark(HIGH_ENTROPY_LABEL);
    return tok;
  });
  return { text: t, labels: [...labels] };
}

/** stripPrivate, then redactSecrets: the one call the capture path makes on every recorded field. */
export function redact(text: string): Redacted {
  return redactSecrets(stripPrivate(text));
}
