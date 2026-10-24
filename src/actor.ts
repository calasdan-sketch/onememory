// Who is writing? The label of the token (or MCP connection) behind the call,
// carried through async code so the store can stamp it on the change_log row
// of every write (change_log.actor) and, since 1.3.3, on the note itself
// (notes.written_by / created_by). It is NOT the note's `source` (provenance
// a client can set freely): exclude_self filters on the actor.
//
// A per-request holder object (not a bare string) lets the HTTP API open the
// context before it has authenticated and fill the label in afterwards.
import { AsyncLocalStorage } from "node:async_hooks";

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
 * own background jobs. A token labelled like one of these is stored as
 * `token:<label>` so it cannot impersonate a marker.
 */
export const WRITER_MARKERS = ["stdio", "cli", "server"] as const;
export type WriterMarker = (typeof WRITER_MARKERS)[number];

let processWriter = "";

/** Set once by an entry point (mcp-stdio, cli, start) for writes with no token. */
export function setProcessWriter(marker: WriterMarker | ""): void {
  processWriter = marker;
}

/** Longest stored writer identity (labels are operator-chosen; this is a backstop). */
export const WRITER_MAX = 100;

/** One printable line: no control characters / line breaks, bounded length. */
export function cleanWriter(s: unknown): string {
  if (typeof s !== "string") return "";
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").trim().slice(0, WRITER_MAX);
}

/**
 * The server-verified identity of the current writer, for `written_by`:
 * the authenticated token's label, else the entry point's fixed marker,
 * else "" (unknown: a library caller or an old row). Never derived from
 * anything the client sent in the request body.
 */
export function currentWriter(): string {
  const a = actorStore.getStore();
  if (a?.authed) {
    const label = cleanWriter(a.label) || "(unlabeled)";
    return (WRITER_MARKERS as readonly string[]).includes(label) ? `token:${label}` : label;
  }
  return processWriter;
}
