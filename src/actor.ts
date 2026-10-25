// Who is writing? The label of the token (or MCP connection) behind the call,
// carried through async code so the store can stamp it on the change_log row
// of every write (change_log.actor) and, since 1.3.3, on the note itself
// (notes.written_by / created_by). It is NOT the note's `source` (provenance
// a client can set freely): exclude_self filters on the actor.
//
// A per-request holder object (not a bare string) lets the HTTP API open the
// context before it has authenticated and fill the label in afterwards.
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";

export interface ActorRef {
  label: string;
  /**
   * True once the label comes from an authenticated token (HTTP API, MCP over
   * HTTP). Only then does it count as a server-verified writer identity; a
   * bare label (tests, scripts) never becomes `written_by` on its own.
   */
  authed?: boolean;
}

export const actorStore = new AsyncLocalStorage<ActorRef>();

/** The writer's label for the current call, or "" (CLI, scripts, unknown). */
export function currentActor(): string {
  return actorStore.getStore()?.label ?? "";
}

/**
 * Fixed markers for writers that have no token. They are set by the entry
 * point (never by a client): `stdio` = the local MCP stdio server, `cli` =
 * an `onememory` command run by the machine owner, `server` = the server's
 * own background jobs, `runner` = the command runner process (it writes the
 * heartbeat that runner_status trusts). A token labelled like one of these is stored as
 * `token:<label>` so it cannot impersonate a marker.
 */
export const WRITER_MARKERS = ["stdio", "cli", "server", "runner"] as const;
export type WriterMarker = (typeof WRITER_MARKERS)[number];

let processWriter = "";

/** Set once by an entry point (mcp-stdio, cli, start) for writes with no token. */
export function setProcessWriter(marker: WriterMarker | ""): void {
  processWriter = marker;
}

/** Longest stored writer identity (labels are operator-chosen; this is a backstop). */
export const WRITER_MAX = 100;

/** The whitespace/control-character part of cleanWriter, without the length cap. */
export function squashWriter(s: unknown): string {
  if (typeof s !== "string") return "";
  // NFKC first, so a rule, a filter and a stored label spelled with different but canonically
  // equivalent characters ("e" + combining accent vs the precomposed letter, full-width letters)
  // are the same label; then invisible format characters (zero-width space/joiner, bidi marks, BOM)
  // go, so they cannot make two labels that look identical differ. Letter case is NOT folded:
  // labels are exact (`Alice` and `alice` are two writers).
  // Dropping a format character can make a base letter and a combining mark adjacent ("e" + ZWSP + U+0301), which a second NFKC
  // would then recompose; so the pass repeats until nothing changes (it settles in two rounds), which makes this idempotent:
  // squash(squash(x)) === squash(x), and a rule typed with or without the invisible character matches the same stored label.
  let t = s;
  for (let i = 0; i < 6; i++) {
    // eslint-disable-next-line no-control-regex
    const next = t.normalize("NFKC").replace(/\p{Cf}/gu, "").replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\s]+/g, " ").trim();
    if (next === t) break;
    t = next;
  }
  return t;
}

/**
 * One printable line: control characters and line breaks become spaces, runs
 * of whitespace collapse, ends are trimmed. A label longer than WRITER_MAX is
 * shortened to a prefix plus "~" and 12 hex digits of its SHA-256, so two
 * long labels sharing a prefix stay distinct and the SAME function applied to
 * a filter value finds the stored one. Idempotent.
 */
export function cleanWriter(s: unknown): string {
  const t = squashWriter(s);
  if (t.length <= WRITER_MAX) return t;
  return t.slice(0, WRITER_MAX - 13) + "~" + createHash("sha256").update(t).digest("hex").slice(0, 12);
}

/**
 * The server-verified identity of the current writer, for `written_by`:
 * the authenticated token's label, else the entry point's fixed marker,
 * else "" (unknown: a library caller or an old row). Never derived from
 * anything the client sent in the request body.
 *
 * A token label that equals a marker (any letter case) or already starts with
 * `token:` is stored as `token:<label>`, so no label can impersonate a marker
 * or another token's escaped form.
 */
export function currentWriter(): string {
  const a = actorStore.getStore();
  if (a?.authed) {
    const label = cleanWriter(a.label) || "(unlabeled)";
    const lower = label.toLowerCase();
    return (WRITER_MARKERS as readonly string[]).includes(lower) || lower.startsWith("token:") ? cleanWriter(`token:${label}`) : label;
  }
  return processWriter;
}
