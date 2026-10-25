// Surgical edits of a JSON configuration file, for `onememory setup`.
//
// Why not JSON.parse + JSON.stringify: Claude Code rewrites ~/.claude.json itself, and it holds a lot (history,
// projects, numbers, other tools' servers). Re-serialising the whole file would reformat it, lose comments in a
// .mcp.json that has them, round large numbers and re-order keys. So this module finds the exact byte range of the one
// thing we change and splices only that. Everything else in the file stays byte for byte as it was: comments, tabs
// or spaces, CRLF or LF, a BOM, a trailing newline, keys it has never heard of.
//
// It reads JSON with comments and trailing commas (what VS Code-style config files allow). It never throws on
// valid input and refuses (JsonEditError) on anything it cannot place exactly, so a caller can stop BEFORE writing.

export class JsonEditError extends Error {}

export type JKind = "object" | "array" | "string" | "number" | "literal";

export interface JMember {
  key: string;
  keyStart: number;
  value: JNode;
}

export interface JNode {
  kind: JKind;
  start: number;
  end: number;
  members?: JMember[]; // objects
  items?: JNode[]; // arrays
  /** Position of each comma that follows member/item i (or -1). */
  commas?: number[];
}

export interface Parsed {
  text: string;
  /** Length of a leading byte-order mark (0 or 1 character). */
  bom: number;
  root: JNode;
}

class Reader {
  i: number;
  constructor(
    readonly s: string,
    start: number
  ) {
    this.i = start;
  }
  err(msg: string): never {
    // 1-based line/column, for a message a person can act on.
    let line = 1;
    let col = 1;
    for (let k = 0; k < this.i && k < this.s.length; k++) {
      if (this.s[k] === "\n") {
        line++;
        col = 1;
      } else col++;
    }
    throw new JsonEditError(`${msg} (line ${line}, column ${col})`);
  }
  ws(): void {
    const s = this.s;
    for (;;) {
      const c = s[this.i];
      if (c === " " || c === "\t" || c === "\n" || c === "\r") this.i++;
      else if (c === "/" && s[this.i + 1] === "/") {
        while (this.i < s.length && s[this.i] !== "\n") this.i++;
      } else if (c === "/" && s[this.i + 1] === "*") {
        const e = s.indexOf("*/", this.i + 2);
        if (e < 0) this.err("unterminated comment");
        this.i = e + 2;
      } else return;
    }
  }
  string(): string {
    const s = this.s;
    const start = this.i;
    this.i++; // opening quote
    while (this.i < s.length) {
      const c = s[this.i];
      if (c === "\\") this.i += 2;
      else if (c === '"') {
        this.i++;
        try {
          return JSON.parse(s.slice(start, this.i)) as string;
        } catch {
          this.i = start;
          this.err("invalid string");
        }
      } else if (c === "\n" || c === "\r") break;
      else this.i++;
    }
    this.i = start;
    return this.err("unterminated string");
  }
  value(depth: number): JNode {
    if (depth > 64) this.err("nested too deeply");
    this.ws();
    const s = this.s;
    const start = this.i;
    const c = s[this.i];
    if (c === "{") {
      this.i++;
      const members: JMember[] = [];
      const commas: number[] = [];
      for (;;) {
        this.ws();
        if (s[this.i] === "}") {
          this.i++;
          break;
        }
        if (s[this.i] !== '"') this.err("expected a property name in double quotes");
        const keyStart = this.i;
        const key = this.string();
        this.ws();
        if (s[this.i] !== ":") this.err("expected ':'");
        this.i++;
        const value = this.value(depth + 1);
        members.push({ key, keyStart, value });
        this.ws();
        if (s[this.i] === ",") {
          commas.push(this.i);
          this.i++;
        } else {
          commas.push(-1);
          this.ws();
          if (s[this.i] === "}") {
            this.i++;
            break;
          }
          this.err("expected ',' or '}'");
        }
      }
      return { kind: "object", start, end: this.i, members, commas };
    }
    if (c === "[") {
      this.i++;
      const items: JNode[] = [];
      const commas: number[] = [];
      for (;;) {
        this.ws();
        if (s[this.i] === "]") {
          this.i++;
          break;
        }
        items.push(this.value(depth + 1));
        this.ws();
        if (s[this.i] === ",") {
          commas.push(this.i);
          this.i++;
        } else {
          commas.push(-1);
          this.ws();
          if (s[this.i] === "]") {
            this.i++;
            break;
          }
          this.err("expected ',' or ']'");
        }
      }
      return { kind: "array", start, end: this.i, items, commas };
    }
    if (c === '"') {
      this.string();
      return { kind: "string", start, end: this.i };
    }
    const m = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(s.slice(this.i, this.i + 400));
    if (m) {
      this.i += m[0].length;
      return { kind: "number", start, end: this.i };
    }
    const lit = /^(?:true|false|null)/.exec(s.slice(this.i, this.i + 5));
    if (lit) {
      this.i += lit[0].length;
      return { kind: "literal", start, end: this.i };
    }
    return this.err("unexpected character");
  }
}

/** Parse a document. Accepts a BOM, comments and trailing commas. Throws JsonEditError otherwise. */
export function parseDoc(text: string): Parsed {
  const bom = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const r = new Reader(text, bom);
  const root = r.value(0);
  r.ws();
  if (r.i < text.length) r.err("unexpected text after the end of the JSON value");
  return { text, bom, root };
}

/** Does the document use comments or trailing commas (so JSON.parse would refuse it)? */
export function isStrictJson(text: string): boolean {
  try {
    JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    return true;
  } catch {
    return false;
  }
}

export function getMember(obj: JNode, key: string): JMember | undefined {
  if (obj.kind !== "object") return undefined;
  const hits = obj.members!.filter((m) => m.key === key);
  if (hits.length > 1) throw new JsonEditError(`the key "${key}" appears more than once in the same object; fix the file by hand first`);
  return hits[0];
}

/** Walk object keys from the root. Returns undefined when any step is missing or not an object. */
export function getPath(doc: Parsed, path: readonly string[]): JNode | undefined {
  let n: JNode | undefined = doc.root;
  for (const k of path) {
    if (!n || n.kind !== "object") return undefined;
    n = getMember(n, k)?.value;
  }
  return n;
}

/** The value of a node as plain data (numbers keep their written form as {n: "1.0"} so comparing is exact). */
export function plain(doc: Parsed, n: JNode): unknown {
  const raw = doc.text.slice(n.start, n.end);
  switch (n.kind) {
    case "object":
      return { o: n.members!.map((m) => [m.key, plain(doc, m.value)]) };
    case "array":
      return { a: n.items!.map((i) => plain(doc, i)) };
    case "string":
      return JSON.parse(raw) as string;
    case "number":
      return { n: raw };
    default:
      return { l: raw };
  }
}

// ---- layout detection -----------------------------------------------------------------------------------------------

export function detectEol(text: string): "\r\n" | "\n" {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

/** The indent unit the file already uses ("\t", "  ", "    "), default two spaces. */
export function detectIndent(text: string): string {
  const m = /\n([ \t]+)["{}\][]/.exec(text.replace(/\r\n/g, "\n"));
  if (!m) return "  ";
  if (m[1].includes("\t")) return "\t";
  return m[1].length >= 1 && m[1].length <= 8 ? m[1] : "  ";
}

/** Leading whitespace of the line that contains `pos`. */
function lineIndent(text: string, pos: number): string {
  const ls = text.lastIndexOf("\n", pos - 1) + 1;
  const m = /^[ \t]*/.exec(text.slice(ls, pos));
  return m ? m[0] : "";
}

function onlyWsBefore(text: string, pos: number): boolean {
  const ls = text.lastIndexOf("\n", pos - 1) + 1;
  return /^[ \t]*$/.test(text.slice(ls, pos));
}

/** Pretty-print `value` as JSON whose lines continue at `baseIndent`, with the file's EOL. */
export function renderValue(value: unknown, baseIndent: string, unit: string, eol: string): string {
  const lines = JSON.stringify(value, null, unit === "\t" ? "\t" : unit.length).split("\n");
  return lines.map((l, i) => (i === 0 ? l : baseIndent + l)).join(eol);
}

// ---- edits ----------------------------------------------------------------------------------------------------------

function fresh(text: string): { text: string; wasEmpty: boolean } {
  // Empty / whitespace-only file: treat as an empty object.
  const body = text.replace(/^﻿/, "");
  const bare = body.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, "").trim();
  if (bare !== "") return { text, wasEmpty: false };
  if (body.trim() === "") return { text: (text.startsWith("\ufeff") ? "\ufeff" : "") + "{}" + (body.endsWith("\n") ? "\n" : ""), wasEmpty: true };
  // Only comments in the file: keep them, add the empty object after them.
  const eol = detectEol(text);
  return { text: text + (/\n$/.test(text) ? "" : eol) + "{}" + eol, wasEmpty: true };
}

/**
 * Set `path`/`key` to `value` (any JSON value), creating missing objects on the way. Replaces an existing value in
 * place (keeping its key and position) or appends a new member at the end of its object.
 */
export function setIn(textIn: string, path: readonly string[], key: string, value: unknown): string {
  const { text } = fresh(textIn);
  const eol = detectEol(text);
  const unit = detectIndent(text);
  const doc = parseDoc(text);
  if (doc.root.kind !== "object") throw new JsonEditError("the file is not a JSON object at the top level");
  // Deepest existing object along the path.
  let obj = doc.root;
  let depth = 0;
  while (depth < path.length) {
    const next = getMember(obj, path[depth]);
    if (!next) break;
    if (next.value.kind !== "object") throw new JsonEditError(`"${path.slice(0, depth + 1).join(".")}" exists but is not an object; fix the file by hand first`);
    obj = next.value;
    depth++;
  }
  // What to insert at `obj`: the remaining path wrapped around key: value.
  const rest = [...path.slice(depth), key];
  const existing = depth === path.length ? getMember(obj, key) : undefined;
  if (existing) {
    const indent = lineIndent(text, existing.keyStart);
    const rendered = renderValue(value, indent, unit, eol);
    return text.slice(0, existing.value.start) + rendered + text.slice(existing.value.end);
  }
  let wrapped: unknown = value;
  for (let i = rest.length - 1; i >= 1; i--) wrapped = { [rest[i]]: wrapped };
  return insertMember(text, obj, rest[0], wrapped, eol, unit);
}

function insertMember(text: string, obj: JNode, key: string, value: unknown, eol: string, unit: string): string {
  const members = obj.members!;
  const closePos = obj.end - 1; // the "}"
  const multiline = text.slice(obj.start, obj.end).includes("\n");
  if (members.length === 0) {
    const outer = lineIndent(text, obj.start);
    const inner = outer + unit;
    const body = `${JSON.stringify(key)}: ${renderValue(value, inner, unit, eol)}`;
    return text.slice(0, obj.start + 1) + eol + inner + body + eol + outer + "}" + text.slice(obj.end);
  }
  const last = members[members.length - 1];
  const lastComma = obj.commas![obj.commas!.length - 1];
  const memberIndent = onlyWsBefore(text, last.keyStart) ? lineIndent(text, last.keyStart) : null;
  const afterLast = lastComma >= 0 ? lastComma + 1 : last.value.end;
  if (memberIndent === null || !multiline) {
    // One-line object: { "a": 1 } -> { "a": 1, "b": 2 }
    const sep = lastComma >= 0 ? " " : ", ";
    return text.slice(0, afterLast) + sep + `${JSON.stringify(key)}: ${renderValue(value, "", unit, eol)}` + text.slice(afterLast);
  }
  const rendered = `${JSON.stringify(key)}: ${renderValue(value, memberIndent, unit, eol)}`;
  void closePos;
  if (lastComma >= 0) return text.slice(0, afterLast) + eol + memberIndent + rendered + "," + text.slice(afterLast);
  return text.slice(0, afterLast) + "," + eol + memberIndent + rendered + text.slice(afterLast);
}

/**
 * Cut entry `idx` (a member or a list item spanning [from, to)) out of `container`, with its comma, leaving the
 * neighbours' layout alone.
 */
function cutEntry(text: string, container: JNode, idx: number, from0: number, to0: number, count: number): string {
  const comma = container.commas![idx];
  if (count === 1) {
    const multiline = text.slice(container.start, container.end).includes("\n");
    const outer = lineIndent(text, container.start);
    const close = text[container.end - 1];
    return text.slice(0, container.start + 1) + (multiline ? detectEol(text) + outer : "") + close + text.slice(container.end);
  }
  if (idx < count - 1 || comma >= 0) {
    const lineStart = text.lastIndexOf("\n", from0 - 1) + 1;
    const alone = onlyWsBefore(text, from0);
    const from = alone ? lineStart : from0;
    let to = comma >= 0 ? comma + 1 : to0;
    const tail = /^[ \t]*(\r?\n)?/.exec(text.slice(to));
    if (alone && tail && tail[1]) to += tail[0].length;
    else if (!alone && tail) to += /^[ \t]*/.exec(text.slice(to))![0].length;
    return text.slice(0, from) + text.slice(to);
  }
  // Last entry, no trailing comma: remove the comma that precedes it.
  return text.slice(0, container.commas![idx - 1]) + text.slice(to0);
}

/** Remove `path`/`key` (and its comma). A missing key is returned unchanged. */
export function removeIn(text: string, path: readonly string[], key: string): string {
  const doc = parseDoc(text);
  const parent = getPath(doc, path);
  if (!parent || parent.kind !== "object") return text;
  const idx = parent.members!.findIndex((m) => m.key === key);
  if (idx < 0) return text;
  getMember(parent, key); // refuses duplicates
  const m = parent.members![idx];
  return cutEntry(text, parent, idx, m.keyStart, m.value.end, parent.members!.length);
}

/** Remove the first item of the list at `path`/`key` whose written form contains `marker`. Returns the text unchanged if none. */
export function removeArrayItem(text: string, path: readonly string[], key: string, marker: string): string {
  const doc = parseDoc(text);
  const arr = getPath(doc, [...path, key]);
  if (!arr || arr.kind !== "array") return text;
  const idx = arr.items!.findIndex((i) => text.slice(i.start, i.end).includes(marker));
  if (idx < 0) return text;
  const it = arr.items![idx];
  return cutEntry(text, arr, idx, it.start, it.end, arr.items!.length);
}

/** Rename a member in place (same position) and give it a new value. The new key must not already exist. */
export function renameIn(text: string, path: readonly string[], oldKey: string, newKey: string, value: unknown): string {
  const doc = parseDoc(text);
  const parent = getPath(doc, path);
  if (!parent || parent.kind !== "object") throw new JsonEditError(`nothing at ${path.join(".") || "(top level)"}`);
  const m = getMember(parent, oldKey);
  if (!m) throw new JsonEditError(`"${oldKey}" not found`);
  if (newKey !== oldKey && getMember(parent, newKey)) throw new JsonEditError(`"${newKey}" already exists next to "${oldKey}"`);
  const indent = lineIndent(text, m.keyStart);
  const rendered = renderValue(value, indent, detectIndent(text), detectEol(text));
  const keyEnd = m.keyStart + rawKeyLength(text, m);
  return text.slice(0, m.keyStart) + JSON.stringify(newKey) + text.slice(keyEnd, m.value.start) + rendered + text.slice(m.value.end);
}

/** Length of the key as written (it may use escapes), so the text between key and value is kept. */
function rawKeyLength(text: string, m: JMember): number {
  let i = m.keyStart + 1;
  while (i < text.length) {
    if (text[i] === "\\") i += 2;
    else if (text[i] === '"') return i + 1 - m.keyStart;
    else i++;
  }
  return 0;
}

/** Append `item` to the array at `path`/`key` (created if missing). */
export function appendToArray(textIn: string, path: readonly string[], key: string, item: unknown): string {
  const { text } = fresh(textIn);
  const doc = parseDoc(text);
  const arrNode = getPath(doc, [...path, key]);
  if (!arrNode) return setIn(text, path, key, [item]);
  if (arrNode.kind !== "array") throw new JsonEditError(`"${[...path, key].join(".")}" exists but is not a list; fix the file by hand first`);
  const eol = detectEol(text);
  const unit = detectIndent(text);
  const items = arrNode.items!;
  const outer = lineIndent(text, arrNode.start);
  if (items.length === 0) {
    const inner = outer + unit;
    return text.slice(0, arrNode.start + 1) + eol + inner + renderValue(item, inner, unit, eol) + eol + outer + "]" + text.slice(arrNode.end);
  }
  const last = items[items.length - 1];
  const lastComma = arrNode.commas![arrNode.commas!.length - 1];
  const multiline = text.slice(arrNode.start, arrNode.end).includes("\n") && onlyWsBefore(text, last.start);
  const afterLast = lastComma >= 0 ? lastComma + 1 : last.end;
  if (!multiline) {
    const sep = lastComma >= 0 ? " " : ", ";
    return text.slice(0, afterLast) + sep + renderValue(item, "", unit, eol) + text.slice(afterLast);
  }
  const ind = lineIndent(text, last.start);
  const rendered = renderValue(item, ind, unit, eol);
  if (lastComma >= 0) return text.slice(0, afterLast) + eol + ind + rendered + "," + text.slice(afterLast);
  return text.slice(0, afterLast) + "," + eol + ind + rendered + text.slice(afterLast);
}

// ---- expected-result check ------------------------------------------------------------------------------------------

type P = { o: Array<[string, unknown]> } | { a: unknown[] } | { n: string } | { l: string } | string;

function expectSet(root: P, path: readonly string[], key: string, value: P): P {
  if (typeof root !== "object" || !("o" in root)) throw new JsonEditError("not an object");
  const o = root.o.map(([k, v]) => [k, v] as [string, unknown]);
  if (path.length === 0) {
    const i = o.findIndex(([k]) => k === key);
    if (i >= 0) o[i] = [key, value];
    else o.push([key, value]);
    return { o };
  }
  const i = o.findIndex(([k]) => k === path[0]);
  if (i >= 0) o[i] = [path[0], expectSet(o[i][1] as P, path.slice(1), key, value)];
  else o.push([path[0], expectSet({ o: [] }, path.slice(1), key, value)]);
  return { o };
}

function expectRemove(root: P, path: readonly string[], key: string): P {
  if (typeof root !== "object" || !("o" in root)) return root;
  if (path.length === 0) return { o: root.o.filter(([k]) => k !== key) };
  return { o: root.o.map(([k, v]) => (k === path[0] ? ([k, expectRemove(v as P, path.slice(1), key)] as [string, unknown]) : [k, v])) };
}

/** Convert plain JS data (as we pass to setIn) into the same "plain" shape parseDoc produces. */
export function toPlain(v: unknown): P {
  if (Array.isArray(v)) return { a: v.map(toPlain) };
  if (v && typeof v === "object") return { o: Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, toPlain(x)]) };
  if (typeof v === "string") return v;
  if (typeof v === "number") return { n: String(v) };
  return { l: String(v) };
}

export type Op =
  | { op: "set"; path: readonly string[]; key: string; value: unknown }
  | { op: "remove"; path: readonly string[]; key: string }
  | { op: "rename"; path: readonly string[]; key: string; newKey: string; value: unknown }
  | { op: "append"; path: readonly string[]; key: string; value: unknown }
  | { op: "unappend"; path: readonly string[]; key: string; marker: string };

/**
 * Apply `ops` in order and PROVE the result: the new text must parse, and equal the old document with exactly those
 * changes applied (numbers compared as written). Throws JsonEditError if not, so nothing wrong is ever written.
 */
export function applyOps(textIn: string, ops: readonly Op[]): string {
  const base = fresh(textIn).text;
  let expected = plain(parseDoc(base), parseDoc(base).root) as P;
  let out = base;
  for (const o of ops) {
    if (o.op === "set") {
      out = setIn(out, o.path, o.key, o.value);
      expected = expectSet(expected, o.path, o.key, toPlain(o.value));
    } else if (o.op === "remove") {
      out = removeIn(out, o.path, o.key);
      expected = expectRemove(expected, o.path, o.key);
    } else if (o.op === "rename") {
      // in place, keeping order: expected is the same list with that one pair replaced
      out = renameIn(out, o.path, o.key, o.newKey, o.value);
      const swap = (node: P, p: readonly string[]): P => {
        if (typeof node !== "object" || !("o" in node)) return node;
        if (p.length === 0) return { o: node.o.map(([k, v]) => (k === o.key ? ([o.newKey, toPlain(o.value)] as [string, unknown]) : [k, v])) };
        return { o: node.o.map(([k, v]) => (k === p[0] ? ([k, swap(v as P, p.slice(1))] as [string, unknown]) : [k, v])) };
      };
      expected = swap(expected, o.path);
    } else if (o.op === "unappend") {
      out = removeArrayItem(out, o.path, o.key, o.marker);
      // Expected: the same document without the first list item containing the marker (compared in plain form).
      const drop = (node: P, p: readonly string[]): P => {
        if (typeof node !== "object" || !("o" in node)) return node;
        if (p.length === 0) {
          return {
            o: node.o.map(([k, v]) => {
              if (k !== o.key || typeof v !== "object" || !v || !("a" in (v as object))) return [k, v] as [string, unknown];
              const arr = (v as { a: unknown[] }).a;
              const i = arr.findIndex((x) => JSON.stringify(x).includes(o.marker.replace(/\\/g, "\\\\")));
              return [k, { a: i < 0 ? arr : arr.filter((_, j) => j !== i) }] as [string, unknown];
            }),
          };
        }
        return { o: node.o.map(([k, v]) => (k === p[0] ? ([k, drop(v as P, p.slice(1))] as [string, unknown]) : [k, v])) };
      };
      expected = drop(expected, o.path);
    } else {
      out = appendToArray(out, o.path, o.key, o.value);
      const app = (node: P, p: readonly string[]): P => {
        if (typeof node !== "object" || !("o" in node)) return node;
        if (p.length === 0) {
          const i = node.o.findIndex(([k]) => k === o.key);
          if (i < 0) return { o: [...node.o, [o.key, { a: [toPlain(o.value)] }]] };
          const cur = node.o[i][1] as P;
          if (typeof cur !== "object" || !("a" in cur)) throw new JsonEditError("not a list");
          const o2 = node.o.map((e) => [e[0], e[1]] as [string, unknown]);
          o2[i] = [o.key, { a: [...cur.a, toPlain(o.value)] }];
          return { o: o2 };
        }
        const i = node.o.findIndex(([k]) => k === p[0]);
        if (i < 0) return { o: [...node.o, [p[0], app({ o: [] }, p.slice(1))] as [string, unknown]] };
        const o2 = node.o.map((e) => [e[0], e[1]] as [string, unknown]);
        o2[i] = [p[0], app(node.o[i][1] as P, p.slice(1))];
        return { o: o2 };
      };
      expected = app(expected, o.path);
    }
  }
  let got: unknown;
  try {
    const d = parseDoc(out);
    got = plain(d, d.root);
  } catch (e) {
    throw new JsonEditError(`internal check failed, the edited file would not be valid (${(e as Error).message}); nothing was written`);
  }
  if (JSON.stringify(got) !== JSON.stringify(expected)) {
    throw new JsonEditError("internal check failed: the edit would change more than intended; nothing was written");
  }
  return out;
}

/** Are all of `ops` already in effect in `text`? (A check that is safe to repeat, unlike applying them again.) */
export function opsAreApplied(text: string, ops: readonly Op[]): boolean {
  let doc: Parsed;
  try {
    doc = parseDoc(text.trim() === "" ? "{}" : text);
  } catch {
    return false;
  }
  const same = (n: JNode, v: unknown): boolean => JSON.stringify(plain(doc, n)) === JSON.stringify(toPlain(v));
  for (const o of ops) {
    const parent = getPath(doc, o.path);
    const obj = parent && parent.kind === "object" ? parent : undefined;
    if (o.op === "set") {
      const m = obj ? getMember(obj, o.key) : undefined;
      if (!m || !same(m.value, o.value)) return false;
    } else if (o.op === "remove") {
      if (obj && getMember(obj, o.key)) return false;
    } else if (o.op === "rename") {
      if (!obj || getMember(obj, o.key) || !getMember(obj, o.newKey)) return false;
      if (!same(getMember(obj, o.newKey)!.value, o.value)) return false;
    } else if (o.op === "append") {
      const arr = obj ? getMember(obj, o.key)?.value : undefined;
      if (!arr || arr.kind !== "array" || !arr.items!.some((i) => same(i, o.value))) return false;
    } else {
      const arr = obj ? getMember(obj, o.key)?.value : undefined;
      if (arr && arr.kind === "array" && arr.items!.some((i) => text.slice(i.start, i.end).includes(o.marker))) return false;
    }
  }
  return true;
}
