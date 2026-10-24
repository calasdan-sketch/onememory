// Trust policy primitives (1.4.0): stable writer ids, the per-namespace
// `distrust_writers` list, and the one place that turns the list into a
// predicate (in JS) and a SQL fragment, so every read path asks the same
// question the same way.
//
// Vocabulary
//   label       what a token is called (the server-stamped `written_by`).
//   server_id   a random id minted once per database (never changes).
//   writer_id   `<server_id>/<label>`: a label that stays unambiguous when a
//               note moves to another server.
//   distrusted  a writer an admin has put on a namespace's distrust list.
//
// A note counts as touched by a writer when ANY of these names it:
//   - its current `written_by` (last content writer);
//   - its `attested_writer` (a verified original author carried in from
//     another server, see attest.ts);
//   - its `merged_from_writers` (writers of the notes a consolidation merged).
// `created_by` and the unverified `imported_written_by` claim do NOT count:
// a later content edit by someone else makes THEM the author, and a claim is
// only a claim. (Documented in docs/trust.md.)
import { cleanWriter, squashWriter } from "./actor.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Wildcard namespace of a distrust rule: applies in every namespace. */
export const ALL_NAMESPACES = "*";
/** Most rules one store keeps (keeps the SQL fragment and the per-query cost bounded). */
export const MAX_DISTRUST_RULES = 500;
/** Most rules one namespace (or the `*` bucket) keeps, so one tenant's admin cannot use up everybody's room. */
export const MAX_DISTRUST_RULES_PER_NAMESPACE = 50;
/** Trust-log rows kept (older rows are pruned on write). */
export const MAX_TRUST_LOG_ROWS = 1000;

/** `<server_id>/<label>`, or "" when either part is missing (an unknown writer has no id). */
export function makeWriterId(serverId: string, label: string): string {
  const l = cleanWriter(label);
  return serverId && l ? `${serverId}/${l}` : "";
}

export interface WriterRef {
  /** "" for a bare label. */
  serverId: string;
  label: string;
}

/**
 * Split a distrust entry or filter value into server id and label. A value is
 * an id only when it starts with a UUID and a slash; anything else is a bare
 * label (labels may contain slashes). The UUID prefix is split off BEFORE the
 * label is normalised, so a long label (a writer_id can be 36 + 1 + 100
 * characters) is shortened exactly the way the stored `written_by` was, and a
 * rule written from a note's `writer_id` keeps matching.
 */
export function parseWriterRef(raw: unknown): WriterRef {
  const s = squashWriter(raw);
  if (s.length > 37 && s[36] === "/" && UUID_RE.test(s.slice(0, 36))) {
    const label = cleanWriter(s.slice(37));
    if (label) return { serverId: s.slice(0, 36).toLowerCase(), label };
  }
  return { serverId: "", label: cleanWriter(s) };
}

/**
 * The canonical stored form of a rule's writer (`label` or `<server_id>/label`),
 * or an error text when the rule could never match anything: an empty value, or
 * a value that looks like a writer_id but has no label.
 */
export function canonicalRuleWriter(raw: unknown): { ok: true; writer: string; ref: WriterRef } | { ok: false; error: string } {
  const ref = parseWriterRef(raw);
  if (!ref.label) return { ok: false, error: "writer is required: a token label or a writer_id (<server_id>/<label>)" };
  const s = squashWriter(raw);
  if (ref.serverId === "" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/?$/i.test(s)) {
    return { ok: false, error: "that is a server id without a label: use <server_id>/<label>, or just the label" };
  }
  return { ok: true, writer: ref.serverId ? `${ref.serverId}/${ref.label}` : ref.label, ref };
}

export interface DistrustRule {
  /** A namespace, or "*" for all. */
  namespace: string;
  /** A label, or a writer_id (`<server_id>/<label>`). */
  writer: string;
  added_at: string;
  added_by: string;
}

/** The writer facts of a note (or of a deleted note's log row) that the policy looks at. */
export interface WriterFacts {
  namespace: string;
  written_by: string;
  attested_writer?: string;
  attested_by?: string;
  merged_from_writers?: string[];
}

/** Entries of a note's `merged_from_writers` as stored (a JSON array of strings, or ""). */
export function parseMerged(raw: unknown): string[] {
  if (typeof raw !== "string" || !raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** The stored form: a sorted JSON array, or "" when empty. */
export function mergedToStorage(list: Iterable<string>): string {
  const u = [...new Set([...list].map((x) => cleanWriter(x)).filter(Boolean))].sort();
  return u.length ? JSON.stringify(u) : "";
}

function ruleApplies(rule: DistrustRule, namespace: string): boolean {
  return rule.namespace === ALL_NAMESPACES || rule.namespace === namespace;
}

/** Does `rule` name a writer that touched these facts? `localId` is this database's server_id. */
export function ruleMatches(rule: DistrustRule, f: WriterFacts, localId: string): boolean {
  if (!ruleApplies(rule, f.namespace)) return false;
  const ref = parseWriterRef(rule.writer);
  if (!ref.label) return false;
  const merged = f.merged_from_writers ?? [];
  if (ref.serverId === "") {
    return f.written_by === ref.label || f.attested_writer === ref.label || merged.includes(ref.label);
  }
  if (ref.serverId === localId.toLowerCase()) {
    return f.written_by === ref.label || merged.includes(ref.label) || (f.attested_by === ref.serverId && f.attested_writer === ref.label);
  }
  return (f.attested_by === ref.serverId && f.attested_writer === ref.label) || merged.includes(`${ref.serverId}/${ref.label}`);
}

export function matchesDistrust(rules: readonly DistrustRule[], f: WriterFacts, localId: string): boolean {
  return rules.some((r) => ruleMatches(r, f, localId));
}

/** Column expressions the SQL builder reads (a notes alias, or a change_log row joined to notes). */
export interface WriterColumns {
  ns: string;
  writer: string;
  attWriter: string;
  attBy: string;
  merged: string;
}

export const NOTE_COLUMNS: WriterColumns = {
  ns: "notes.namespace",
  writer: "notes.written_by",
  attWriter: "notes.attested_writer",
  attBy: "notes.attested_by",
  merged: "notes.merged_from_writers",
};

/**
 * "Is `token` an element of the JSON array in column `col`?" with the SAME
 * exactness as `Array.includes`. `instr` is only a cheap pre-test (it can hit
 * inside another element's escaped quotes); `json_each` decides. Two bound
 * parameters: the JSON-encoded token, then the token itself.
 */
export function mergedHasSql(col: string): string {
  return `(instr(${col}, ?) > 0 AND EXISTS (SELECT 1 FROM json_each(CASE WHEN ${col} <> '' THEN ${col} ELSE '[]' END) WHERE value = ?))`;
}

/**
 * `" AND NOT (...)"` hiding every row a distrust rule matches, plus its bound
 * parameters; `{ sql: "", params: [] }` when no rule applies (the default,
 * so an empty policy changes nothing). `namespaces` narrows the rules to the
 * ones that can matter for a query confined to those namespaces.
 */
export function distrustSql(
  rules: readonly DistrustRule[],
  localId: string,
  cols: WriterColumns = NOTE_COLUMNS,
  namespaces?: readonly string[]
): { sql: string; params: string[] } {
  const live = rules.filter((r) => !namespaces || r.namespace === ALL_NAMESPACES || namespaces.includes(r.namespace));
  if (live.length === 0) return { sql: "", params: [] };
  const byNs = new Map<string, DistrustRule[]>();
  for (const r of live) byNs.set(r.namespace, [...(byNs.get(r.namespace) ?? []), r]);
  const groups: string[] = [];
  const params: string[] = [];
  for (const [ns, rs] of byNs) {
    const labels = new Set<string>(); // match written_by
    const bare = new Set<string>(); // also match attested_writer
    const foreign: Array<{ sid: string; label: string }> = [];
    const tokens = new Set<string>(); // match inside merged_from_writers
    for (const r of rs) {
      const ref = parseWriterRef(r.writer);
      if (!ref.label) continue;
      if (ref.serverId === "") {
        labels.add(ref.label);
        bare.add(ref.label);
        tokens.add(ref.label);
      } else if (ref.serverId === localId.toLowerCase()) {
        labels.add(ref.label);
        tokens.add(ref.label);
        foreign.push({ sid: ref.serverId, label: ref.label }); // a restored own export: attested_by is this server
      } else {
        foreign.push({ sid: ref.serverId, label: ref.label });
        tokens.add(`${ref.serverId}/${ref.label}`);
      }
    }
    const parts: string[] = [];
    const gp: string[] = [];
    if (labels.size) {
      parts.push(`${cols.writer} IN (${[...labels].map(() => "?").join(",")})`);
      gp.push(...labels);
    }
    if (bare.size) {
      parts.push(`${cols.attWriter} IN (${[...bare].map(() => "?").join(",")})`);
      gp.push(...bare);
    }
    for (const f of foreign) {
      parts.push(`(${cols.attBy} = ? AND ${cols.attWriter} = ?)`);
      gp.push(f.sid, f.label);
    }
    for (const t of tokens) {
      parts.push(mergedHasSql(cols.merged));
      gp.push(JSON.stringify(t), t);
    }
    if (!parts.length) continue;
    const any = `(${parts.join(" OR ")})`;
    groups.push(ns === ALL_NAMESPACES ? any : `(${cols.ns} = ? AND ${any})`);
    if (ns !== ALL_NAMESPACES) params.push(ns);
    params.push(...gp);
  }
  if (!groups.length) return { sql: "", params: [] };
  // No COALESCE wrapper: SQLite evaluates a COALESCE operand as a value and
  // cannot short-circuit it (measured 6-10x slower at 100 rules). Every column
  // the predicate reads is NOT NULL (notes) or COALESCE(note, log) of two NOT
  // NULL columns, so no row evaluates to NULL.
  return { sql: ` AND NOT ${groups.length === 1 ? groups[0] : `(${groups.join(" OR ")})`}`, params };
}

/** `?include_distrusted=1` and friends. */
export function truthyParam(v: string | null | undefined): boolean {
  return ["1", "true", "yes"].includes((v ?? "").toLowerCase());
}

/**
 * SQL for the `written_by` / `not_written_by` filters, as one parenthesised
 * expression plus its parameters.
 *
 *   is  X   the note's LAST content writer is X. A foreign writer_id
 *           (`<other server>/<label>`) matches the verified original author an
 *           import carried in (`attested_writer`).
 *   not X   safety filter: drops a note X touched in ANY recorded way: X is its
 *           last content writer, its verified original author, or one of the
 *           writers its text was merged from. (Unknown writers, "", are not
 *           excluded: nobody can say who they were.)
 *
 * `value` may be a bare label or a writer_id; both are normalised.
 */
export function writerFilterSql(
  cols: WriterColumns,
  value: string,
  mode: "is" | "not",
  localId: string
): { sql: string; params: string[] } {
  const ref = parseWriterRef(value);
  const foreign = ref.serverId !== "" && ref.serverId !== localId.toLowerCase();
  if (mode === "is") {
    return foreign
      ? { sql: `(${cols.attBy} = ? AND ${cols.attWriter} = ?)`, params: [ref.serverId, ref.label] }
      : { sql: `${cols.writer} = ?`, params: [ref.label] };
  }
  return foreign
    ? {
        sql: `(NOT (${cols.attBy} = ? AND ${cols.attWriter} = ?) AND NOT ${mergedHasSql(cols.merged)})`,
        params: [ref.serverId, ref.label, JSON.stringify(`${ref.serverId}/${ref.label}`), `${ref.serverId}/${ref.label}`],
      }
    : {
        sql: `(${cols.writer} <> ? AND ${cols.attWriter} <> ? AND NOT ${mergedHasSql(cols.merged)})`,
        params: [ref.label, ref.label, JSON.stringify(ref.label), ref.label],
      };
}

/**
 * The part of the `not` filter that looks beyond the writer column (verified
 * original author, merged sources). The change feed's `not_written_by` already
 * matches each change event's own writer; this adds the note-level taint.
 */
export function writerTaintFilterSql(cols: WriterColumns, value: string, localId: string): { sql: string; params: string[] } {
  const ref = parseWriterRef(value);
  const foreign = ref.serverId !== "" && ref.serverId !== localId.toLowerCase();
  return foreign
    ? {
        sql: `(NOT (${cols.attBy} = ? AND ${cols.attWriter} = ?) AND NOT ${mergedHasSql(cols.merged)})`,
        params: [ref.serverId, ref.label, JSON.stringify(`${ref.serverId}/${ref.label}`), `${ref.serverId}/${ref.label}`],
      }
    : { sql: `(${cols.attWriter} <> ? AND NOT ${mergedHasSql(cols.merged)})`, params: [ref.label, JSON.stringify(ref.label), ref.label] };
}
