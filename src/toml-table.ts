// Just enough TOML for `setup` to own ONE table in Codex's ~/.codex/config.toml ([mcp_servers.onememory]): render it,
// find it, replace or append it, take it out. Every byte outside that table stays as it was. This is not a TOML parser.
// ponytail: headers are found line by line, so a line starting with "[" inside a multi-line string would be misread;
// fine for Codex config files, switch to a real TOML parser if that ever matters.
import type { Op } from "./jsonc-edit.js";

const key = (s: string): string => (/^[A-Za-z0-9_-]+$/.test(s) ? s : JSON.stringify(s));

function value(x: unknown): string {
  // JSON string escapes are all valid TOML basic-string escapes; DEL is the one TOML forbids that JSON leaves raw.
  if (typeof x === "string") return JSON.stringify(x).replace(/\x7f/g, "\\u007F");
  if (typeof x === "number" || typeof x === "boolean") return String(x);
  if (Array.isArray(x)) return `[${x.map(value).join(", ")}]`;
  if (x && typeof x === "object") return `{ ${Object.entries(x).map(([k, v]) => `${key(k)} = ${value(v)}`).join(", ")} }`;
  throw new Error(`cannot write ${String(x)} as TOML`);
}

export function renderTable(table: readonly string[], v: Record<string, unknown>, eol: string): string {
  return [`[${table.map(key).join(".")}]`, ...Object.entries(v).map(([k, x]) => `${key(k)} = ${value(x)}`)].join(eol) + eol;
}

const eolOf = (t: string): string => (t.includes("\r\n") ? "\r\n" : "\n");
const HEADER = /^[ \t]*\[\[?([^\]\r\n]*)\]\]?[ \t]*(?:#.*)?$/;
const norm = (h: string): string => h.trim().replace(/\s*\.\s*/g, ".").replace(/["']/g, "");

/** [start, end) of the table and its sub-tables, without the blank and comment lines that lead into the next table. */
export function findTable(text: string, table: readonly string[]): { start: number; end: number } | null {
  const name = table.join(".");
  let start = -1;
  let end = -1;
  let pos = 0;
  for (const line of text.split("\n")) {
    const next = pos + line.length + 1;
    const h = HEADER.exec(line.replace(/\r$/, ""));
    if (h) {
      const n = norm(h[1]);
      const ours = n === name || n.startsWith(name + ".");
      if (start >= 0 && !ours) break;
      if (start < 0 && ours) start = pos;
    }
    if (start >= 0 && line.trim() !== "" && !line.trim().startsWith("#")) end = Math.min(next, text.length);
    pos = next;
  }
  return start < 0 ? null : { start, end };
}

export function setTable(text: string, table: readonly string[], v: Record<string, unknown>): string {
  const block = renderTable(table, v, eolOf(text));
  const at = findTable(text, table);
  if (at) return text.slice(0, at.start) + block + text.slice(at.end);
  if (text.trim() === "") return text + block;
  const eol = eolOf(text);
  return text + (text.endsWith("\n") ? "" : eol) + eol + block;
}

export function removeTable(text: string, table: readonly string[]): string {
  const at = findTable(text, table);
  if (!at) return text;
  let start = at.start;
  const eol = eolOf(text);
  // At the end of the file: also drop the blank line setTable put before it.
  if (at.end >= text.length && text.slice(0, start).endsWith(eol + eol)) start -= eol.length;
  return text.slice(0, start) + text.slice(at.end);
}

/** "onememory" is configured in some form: its own table, or `onememory = { ... }` under [mcp_servers]. */
export function hasServer(text: string, name: string): boolean {
  return !!findTable(text, ["mcp_servers", name]) || new RegExp(`^\\s*(?:mcp_servers\\.)?"?${name}"?\\s*=\\s*\\{`, "m").test(text);
}

/** The JSON-edit ops setup records (set/remove of path+key), applied to TOML tables. */
export function applyTomlOps(text: string, ops: readonly Op[]): string {
  let out = text;
  for (const o of ops) {
    if (o.op === "set") out = setTable(out, [...o.path, o.key], o.value as Record<string, unknown>);
    else if (o.op === "remove") out = removeTable(out, [...o.path, o.key]);
    else throw new Error(`TOML edit "${o.op}" is not supported`);
  }
  return out;
}

export function tomlOpsApplied(text: string, ops: readonly Op[]): boolean {
  return ops.every((o) => {
    const at = findTable(text, [...o.path, o.key]);
    if (o.op === "remove") return !at;
    return !!at && o.op === "set" && text.slice(at.start, at.end) === renderTable([...o.path, o.key], o.value as Record<string, unknown>, eolOf(text));
  });
}
