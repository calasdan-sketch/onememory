// Minimal JSON/HTTP API over the shared Store. Deliberately built on plain
// node:http rather than a framework (Express etc.) -- five endpoints don't
// need a router library, and every extra dependency is extra attack
// surface for a service that's about to be exposed over a public tunnel.
//
// Auth: scoped bearer tokens (read/write/admin), checked on every route
// except the open /health and /ready probes and the dashboard page itself.
// Format: `Authorization: Bearer <token>`.

import { createServer, ServerResponse, Server, type IncomingMessage } from "node:http";
import { actorStore } from "./actor.js";
import {
  Store,
  NoteInput,
  NotePatch,
  NoteRecord,
  ValidationError,
  QuarantinedError,
  RebuildBusyError,
  StaleWriteError,
  NoteUnreadableError,
  type ImportReport,
  attestationsToShow,
  clampInt,
  resolveEdgeThreshold,
  REBUILD_CONFIRM_NOTE_COUNT,
  EXPORT_PAGE_SIZE,
  type ImportNote,
  validateForgetAfter,
  coerceNumeric,
  DEFAULT_NAMESPACE,
} from "./store.js";
import { truthyParam } from "./trust.js";
import { originAllowed, RateLimiter, AuthTarpit, clientKey, tokenKey, authenticateEntry, scopeAllows, LIMITS, audit } from "./security.js";
import { type Scope, type TokenEntry, TIME_ZONE, PROJECT_ROOT } from "./config.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The phone command page (docs/sign.html + docs/signer.js) is served from the
// API's own origin so a phone browser can POST /notes without a cross-origin
// request. Read once and cached; missing files simply 404.
// Off by default: the runner ships separately from the memory package, so a
// plain memory install exposes nothing runner-related. Set
// ONEMEMORY_ENABLE_SIGN_PAGE=1 to serve it; otherwise both paths 404.
const SIGN_PAGES: Record<string, { file: string; type: string }> = {
  "/sign": { file: "sign.html", type: "text/html; charset=utf-8" },
  "/signer.js": { file: "signer.js", type: "application/javascript; charset=utf-8" },
};
const signCache = new Map<string, string | null>();
function signAsset(file: string): string | null {
  if (process.env.ONEMEMORY_ENABLE_SIGN_PAGE !== "1") return null;
  if (!signCache.has(file)) {
    try {
      signCache.set(file, readFileSync(join(PROJECT_ROOT, "docs", file), "utf8"));
    } catch {
      signCache.set(file, null);
    }
  }
  return signCache.get(file) ?? null;
}
import { runnerStatus } from "./liveness.js";
import { PayloadTooLargeError, readBody, normalizeTokens, IMPORT_BODY_BYTES } from "./http-common.js";

/**
 * Import size above which the similarity-graph rebuild is DEFERRED rather
 * than done inline. Linking is O(n^2) and dominates bulk-restore time
 * (measured 88-97%), while only affecting neighbor ranking -- not search,
 * not the stored notes. 200 is where inline linking starts to cost seconds;
 * below it the graph is ready immediately, which matters more for a 1-note
 * import than the saved milliseconds.
 */
const IMPORT_EDGE_DEFER_THRESHOLD = 200;
import { DASHBOARD_HTML, DASHBOARD_JS } from "./dashboard.js";
import { runSearch, runSearchExplained, parseMode, maybeEmbed, runRelevantSearch, roundRobin, type ExplainedHit } from "./search-service.js";
import {
  type ServerNamespaceOpts,
  type ResolvedNamespace,
  type NsCtx,
  NS_DISABLED,
  resolveRequestNamespace,
  readableIn,
  ctxCanRead,
} from "./namespace.js";
import { parseTimePhrase } from "./time-parse.js";
import { annotateStaleness } from "./staleness.js";
import {
  putTask,
  listTasks,
  getTask,
  writeHandoff,
  listHandoffs,
  catchUp,
  claimTask,
  approveTask,
  TaskNotFoundError,
  ClaimConflictError,
} from "./tasks.js";
import { ackChanges } from "./changes.js";
import { SupersedeError, supersedePreview, supersedeConfirm, supersedeUndo, noteHistory, restoreVersion, purgeNoteHistory, type Caller } from "./supersede.js";
import { assertPlainWriteTags, assertReviewedTag } from "./reserved-tags.js";
import { waitForChanges, parseWait, WaitBusyError } from "./change-wait.js";
import type { LintFinding } from "./lint.js";
import { memoryIndex, memoryTimeline, memoryGet, sessionList, sessionGet, fileTimeline, type ReadScope } from "./progressive.js";
import { HOOK_EVENTS, type HookEvent, isOwnTool, recordEvent, cleanField } from "./capture.js";
import { distillSession } from "./extract.js";
import { meterStats } from "./meter.js";

// Minimum scope a request needs: deletes, imports and full /export are admin,
// creates/updates are write, everything else (read/search/list) is read.
function requiredScope(method: string | undefined, path: string): Scope {
  if (method === "DELETE") return "admin";
  if (method === "POST" && path === "/import") return "admin";
  // The trust policy (distrusted writers, trusted attesters) is admin-only,
  // reads included: it names who an operator does not trust.
  if (path === "/trust" || path.startsWith("/trust/")) return "admin";
  // A full-store dump is admin-only; a read token can still page /notes.
  if (method === "GET" && path === "/export") return "admin";
  // /relevant is a read despite the POST method (the message is a JSON body,
  // not a query string, because it can be long) -- same class as /search.
  if (method === "POST" && path === "/relevant") return "read";
  // POST /get (automatic memory: full notes by id) is a read too; POST /capture is a write (the default below).
  if (method === "POST" && path === "/get") return "read";
  // Acking a change-feed position moves only the caller's own consumer marker.
  if (method === "POST" && path === "/ack") return "read";
  // Approving a command task is the human gate in front of the runner.
  if (method === "POST" && /^\/tasks\/\d+\/approve$/.test(path)) return "admin";
  // /rebuild-edges rewrites the similarity graph: admin-only, like delete.
  if (method === "POST" && path === "/rebuild-edges") return "admin";
  // Retention: archiving hides a note from every read surface (a soft
  // delete) and the sweep archives many at once -- both admin, like DELETE.
  // Restoring is equally admin: it re-exposes a note an operator retired.
  if (method === "POST" && /^\/notes\/\d+\/(archive|restore)$/.test(path)) return "admin";
  if (method === "POST" && path === "/sweep-expired") return "admin";
  // A note's earlier versions can hold text that was taken out on purpose: administrators only, reads included.
  if (/^\/notes\/\d+\/history(\/restore)?$/.test(path)) return "admin";
  if (method === "POST" || method === "PUT") return "write";
  return "read";
}

// Map a thrown error to an HTTP response: caller-input problems (ValidationError)
// return 400 with the message; anything unexpected logs server-side and returns
// a generic 500 so SQL/internal details never leak to the client.
function sendError(res: ServerResponse, e: unknown): void {
  // A linter-held write was accepted for admin review, not rejected: 202.
  if (e instanceof QuarantinedError) {
    sendJson(res, 202, { quarantined: { id: e.quarantineId, reasons: e.findings } });
    return;
  }
  if (e instanceof SupersedeError) {
    sendJson(res, e.status, { error: e.message, ...(e.warning ? { warning: e.warning } : {}) });
  } else if (e instanceof StaleWriteError) {
    sendJson(res, 409, { error: e.message });
  } else if (e instanceof ValidationError) {
    sendJson(res, 400, { error: e.message });
  } else if (e instanceof NoteUnreadableError) {
    console.error("[onememory] " + e.message);
    sendJson(res, 500, { error: e.message, id: e.noteId });
  } else {
    console.error("[onememory] write error:", (e as Error).message);
    sendJson(res, 500, { error: "internal error" });
  }
}

function sendJson(
  res: ServerResponse,
  status: number,
  payload: unknown,
  opts: { cap?: boolean } = {}
): void {
  // Never write twice / to an already-finished response (e.g. after a client
  // aborted an oversized upload). Guard before touching headers.
  if (res.writableEnded || res.headersSent) return;
  let body = JSON.stringify(payload);
  // Cap response size so a huge store or broad query can't blow up an agent's
  // context window or the process memory. `/export` opts out (cap:false): it is
  // the explicit full-store backup path and must never be truncated.
  if (opts.cap !== false && Buffer.byteLength(body) > LIMITS.responseBytes) {
    status = 413;
    body = JSON.stringify({
      error: "response too large; narrow the query or use a smaller limit",
    });
  }
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

/** Strict non-negative integer query param; absent = undefined. */
/** ?ack_mode=manual|auto (default auto). */
function ackModeParam(url: URL): "auto" | "manual" | undefined {
  const v = url.searchParams.get("ack_mode");
  if (v === null || v === "") return undefined;
  if (v !== "auto" && v !== "manual") throw new ValidationError('ack_mode must be "auto" or "manual"');
  return v;
}

/**
 * `?written_by=` / `?not_written_by=` (the server-stamped last writer; a bare
 * label or a `<server_id>/<label>` writer id) and `?include_distrusted=1`
 * (show notes whose writer an admin distrusted, clearly marked).
 */
type WriterFilter = { writtenBy?: string; notWrittenBy?: string; includeDistrusted?: boolean };
function writerFilter(url: URL): WriterFilter {
  const is = url.searchParams.get("written_by");
  const not = url.searchParams.get("not_written_by");
  return {
    ...(is !== null && is !== "" ? { writtenBy: is } : {}),
    ...(not !== null && not !== "" ? { notWrittenBy: not } : {}),
    ...(flagParam(url, "include_distrusted") ? { includeDistrusted: true } : {}),
  };
}

/**
 * `?include_superseded=1` also lists notes a confirmed replacement retired (always labelled `status: "superseded"`);
 * `?superseded=1` lists only those. Both are read-scoped, like `includeArchived`: seeing that a note was replaced is not privileged.
 */
type SupersededFilter = { includeSuperseded?: boolean; supersededOnly?: boolean };
function supersededFilter(url: URL): SupersededFilter {
  return {
    ...(flagParam(url, "include_superseded") ? { includeSuperseded: true } : {}),
    ...(flagParam(url, "superseded") ? { supersededOnly: true } : {}),
  };
}

/** The change feed adds filters on the note's CURRENT writer (`note_written_by`). */
function feedWriterFilter(url: URL): WriterFilter & { noteWrittenBy?: string; notNoteWrittenBy?: string } {
  const is = url.searchParams.get("note_written_by");
  const not = url.searchParams.get("not_note_written_by");
  return {
    ...writerFilter(url),
    ...(is !== null && is !== "" ? { noteWrittenBy: is } : {}),
    ...(not !== null && not !== "" ? { notNoteWrittenBy: not } : {}),
  };
}

function flagParam(url: URL, name: string): boolean {
  return ["1", "true", "yes"].includes((url.searchParams.get(name) ?? "").toLowerCase());
}

/** Waiters are capped per namespace scope; a short stable key for it. */
function waitScopeKey(namespaces: string[] | undefined): string {
  return namespaces ? [...namespaces].sort().join(",") : "*";
}

function intParam(url: URL, name: string, min: number): number | undefined {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === "") return undefined;
  if (!/^\d{1,9}$/.test(raw) || Number(raw) < min) {
    throw new ValidationError(`${name} must be an integer >= ${min}`);
  }
  return Number(raw);
}

export function createApiServer(
  store: Store,
  token: string | TokenEntry[],
  opts: ServerNamespaceOpts = {}
): Server {
  const tokens = normalizeTokens(token);
  // Two buckets, neither of which lets garbage traffic lock out a valid
  // client sharing its IP (everyone behind one tunnel has the same socket IP):
  //  - authFailures: per client IP, counts FAILED authentications only
  //    (brute-force defence);
  //  - perToken: per authenticated token, counts that token's requests;
  //  - anon: per IP, for the few unauthenticated routes (/ready, dashboard).
  const authFailures = new RateLimiter();
  const tarpit = new AuthTarpit();
  const perToken = new RateLimiter();
  const anon = new RateLimiter();

  // Server-side namespace resolution, active only when the entry point
  // resolved a namespace at startup (see resolveStartupNamespace), OR when
  // the AUTHENTICATED TOKEN carries a namespace pin.
  //
  // Per-token pinning is what makes one shared bridge safe for several
  // agents: `resolveRequestNamespace` runs per REQUEST (not per process), so
  // a token pinned to "work" is confined to "work" even though the server
  // process resolved a different namespace from its cwd. Tokens with no pin
  // fall back to the server's resolution -- byte-identical legacy behavior.
  const serverNs: ResolvedNamespace | null =
    typeof opts.namespace === "string" && opts.namespace.length > 0
      ? { namespace: opts.namespace, readsFrom: opts.readsFrom ?? {} }
      : null;

  // The request-scoped namespace context is NOT declared here: it lives as a
  // local inside each request handler (see `ns` below), because this server
  // handles CONCURRENT requests and a factory-scoped `let` mutated per
  // request would be clobbered by an interleaved request while an earlier one
  // sits in an `await` -- which is exactly the cross-namespace leak per-token
  // pinning exists to prevent. The helpers below take the context as their
  // first argument for the same reason.

  const readable = (ctx: NsCtx): string[] => readableIn(ctx);
  const trustedHint = (ctx: NsCtx, hint: string | undefined): string | undefined =>
    hint && ctxCanRead(ctx, hint) ? hint : undefined;
  // 404 helper for a note outside the readable set (or missing): a distinct
  // 403 would let the caller probe which ids exist in other namespaces.
  // When namespace resolution is inactive there is no readable set to
  // enforce -- every note is readable (legacy behavior).
  const denyUnreadable = (
    ctx: NsCtx,
    res: ServerResponse,
    note: NoteRecord | null
  ): note is NoteRecord => {
    if (!note) {
      sendJson(res, 404, { error: "not found" });
      return false;
    }
    if (ctx.active && !ctxCanRead(ctx, note.namespace)) {
      sendJson(res, 404, { error: "not found" });
      return false;
    }
    return true;
  };
  // Write/delete access never crosses namespaces: the note must live in the
  // request's own namespace (a read grant confers no write access). Uniform
  // 404 again, so cross-namespace writes are no existence oracle either.
  const denyUnwritable = (
    ctx: NsCtx,
    res: ServerResponse,
    note: NoteRecord | null
  ): note is NoteRecord => {
    if (!note || note.namespace !== ctx.ownNamespace) {
      sendJson(res, 404, { error: "not found" });
      return false;
    }
    return true;
  };
  // List across every readable namespace, newest-first like store.list,
  // paged in SQL so total and deep offsets are exact.
  const listReadable = (
    ctx: NsCtx,
    limit?: number,
    offset?: number,
    includeArchived?: boolean,
    archivedOnly?: boolean,
    wf: WriterFilter & SupersededFilter = {}
  ): { notes: NoteRecord[]; total: number } =>
    store.list({ namespaces: readable(ctx), limit, offset, includeArchived, archivedOnly, ...wf });

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // Per-request namespace context. A LOCAL, not a factory-scoped mutable:
    // this server serves concurrent requests, and a shared `let` would be
    // overwritten by an interleaved request while an earlier one is parked in
    // an await (readBody) -- leaking one token's namespace into another's
    // response. Named `nsCtx` (not `ns`) so it can never be shadowed by the
    // `for (const ns of readable(nsCtx))` loop variables below.
    let nsCtx: NsCtx = serverNs
      ? { active: true, ownNamespace: serverNs.namespace, readsFrom: serverNs.readsFrom }
      : NS_DISABLED;
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname;

      // Health check is intentionally unauthenticated so infra (tunnel,
      // uptime monitor) can probe liveness without a credential.
      if (req.method === "GET" && path === "/health") {
        sendJson(res, 200, { status: "ok" });
        return;
      }

      // Everything past liveness goes through the DNS-rebinding Origin check and
      // the rate limiter first -- including /ready (which touches the DB) and
      // the dashboard, so an unauthenticated client can't hammer either.
      if (!originAllowed(req)) {
        sendJson(res, 403, { error: "origin not allowed" });
        return;
      }
      const ip = clientKey(req);
      const anonLimited = (): boolean => {
        if (anon.check(ip)) return false;
        sendJson(res, 429, { error: "rate limit exceeded" });
        return true;
      };

      // Readiness: unlike /health (liveness), this actually touches the DB so
      // an orchestrator/tunnel can tell a half-broken store from a live one.
      if (req.method === "GET" && path === "/ready") {
        if (anonLimited()) return;
        try {
          store.list({ limit: 1 });
          sendJson(res, 200, { status: "ready" });
        } catch {
          sendJson(res, 503, { status: "unavailable" });
        }
        return;
      }

      // Dashboard UI (no data in the page itself; its fetches carry the token).
      if (req.method === "GET" && (path === "/" || path === "/ui")) {
        if (anonLimited()) return;
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "X-Content-Type-Options": "nosniff",
          "X-Frame-Options": "DENY",
          // Keep the page self-contained: no external loads, no framing. Inline
          // styles/handlers are allowed because the dashboard uses them; this
          // still blocks exfiltration to third-party origins as a backstop to
          // the output escaping in dashboard.ts.
          "Content-Security-Policy":
            "default-src 'self'; style-src 'self' 'unsafe-inline'; " +
            "script-src 'self' 'unsafe-inline'; connect-src 'self'; " +
            "img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'",
        });
        res.end(DASHBOARD_HTML);
        return;
      }
      if (req.method === "GET" && path === "/dashboard.js") {
        if (anonLimited()) return;
        res.writeHead(200, {
          "Content-Type": "application/javascript; charset=utf-8",
          "X-Content-Type-Options": "nosniff",
        });
        res.end(DASHBOARD_JS);
        return;
      }
      // Phone command signer. No data in it; the secret never leaves the phone,
      // and its POST still needs a bearer token like any other write.
      if (req.method === "GET" && SIGN_PAGES[path]) {
        if (anonLimited()) return;
        const asset = SIGN_PAGES[path];
        const body = signAsset(asset.file);
        if (body === null) {
          sendJson(res, 404, { error: "not found" });
          return;
        }
        res.writeHead(200, {
          "Content-Type": asset.type,
          "X-Content-Type-Options": "nosniff",
          "X-Frame-Options": "DENY",
          "Cache-Control": "no-store",
          "Referrer-Policy": "no-referrer",
        });
        res.end(body);
        return;
      }

      const principal = authenticateEntry(req, tokens);
      if (!principal) {
        // Only failed authentications count toward the per-IP limit.
        // Escalating delay on repeated failures (valid tokens never reach here).
        const proceed = await tarpit.failed(ip);
        if (!proceed || !authFailures.check(ip)) sendJson(res, 429, { error: "rate limit exceeded" });
        else sendJson(res, 401, { error: "unauthorized" });
        return;
      }
      if (!perToken.check(tokenKey(principal.token))) {
        sendJson(res, 429, { error: "rate limit exceeded" });
        return;
      }
      const scope = principal.scope;
      const actorRef = actorStore.getStore();
      if (actorRef) {
        actorRef.label = principal.label;
        actorRef.authed = true; // written_by is the verified token label
      }
      // Per-request namespace: a token's own pin WINS over the server's
      // cwd-resolved namespace. This is the isolation boundary for this
      // request -- resolved here, once, so every gate below reads `ns`.
      nsCtx = resolveRequestNamespace(principal.namespace, serverNs);
      // Enforce the token's scope: a read-only token can't write/delete, etc.
      const need = requiredScope(req.method, path);
      if (!scopeAllows(scope, need)) {
        sendJson(res, 403, { error: `this token lacks the required '${need}' scope` });
        return;
      }

      // include_distrusted switches the trust policy OFF for the call, so it is an
      // admin decision: a read or write token (or an agent holding one that a hostile
      // note talked into asking) gets a clear refusal, never the hidden notes.
      const isAdmin = scopeAllows(scope, "admin");
      // A namespace-PINNED admin manages the rules of its OWN namespace only; the namespaces it merely has read grants on
      // belong to their own admins, so the opt-in is honoured for the token's own namespace and nowhere else (it must say
      // so with namespace=<own>, or name a note of its own namespace by id).
      const pinnedWithGrants = (): boolean => nsCtx.active && readable(nsCtx).some((n) => n !== nsCtx.ownNamespace);
      const refuseDistrustedOptIn = (nsHint?: string | null): boolean => {
        if (!isAdmin) {
          sendJson(res, 403, {
            error: "include_distrusted needs an admin token: it shows notes from writers the admin put on the distrust list",
          });
          return true;
        }
        if (pinnedWithGrants() && (nsHint ?? "") !== nsCtx.ownNamespace) {
          sendJson(res, 403, {
            error:
              `include_distrusted is honoured only for this token's own namespace ("${nsCtx.ownNamespace}"): pass namespace=${nsCtx.ownNamespace}. ` +
              "The namespaces this token can only read are governed by their own admins.",
          });
          return true;
        }
        return false;
      };
      // (By-id reads carry no namespace parameter: they are checked against the note's own namespace where they read it.)
      const byIdRead = req.method === "GET" && (/^\/notes\/\d+$/.test(path) || /^\/tasks\/\d+$/.test(path));
      if (flagParam(url, "include_distrusted") && (byIdRead ? !isAdmin && refuseDistrustedOptIn() : refuseDistrustedOptIn(url.searchParams.get("namespace")))) return;

      // POST /notes
      if (req.method === "POST" && path === "/notes") {
        const raw = await readBody(req);
        let parsed: NoteInput;
        try {
          parsed = JSON.parse(raw || "{}");
        } catch {
          sendJson(res, 400, { error: "invalid JSON body" });
          return;
        }
        if (!parsed.title || typeof parsed.title !== "string") {
          sendJson(res, 400, { error: "title is required" });
          return;
        }
        if (parsed.forget_after !== undefined) parsed.forget_after = coerceNumeric(parsed.forget_after) as number;
        if (parsed.confidence !== undefined) parsed.confidence = coerceNumeric(parsed.confidence) as number;
        try {
          // When namespace resolution is active the client-supplied namespace
          // is untrusted: writes always land in the server-resolved namespace.
          if (nsCtx.active) parsed.namespace = nsCtx.ownNamespace;
          assertPlainWriteTags(parsed.tags);
          assertReviewedTag(parsed.tags, undefined, isAdmin);
          const warnings: LintFinding[] = [];
          const note = store.create(parsed, { lintWarnings: warnings });
          await maybeEmbed(store, note);
          sendJson(res, 201, warnings.length ? { note, warnings } : { note });
        } catch (e) {
          sendError(res, e);
        }
        return;
      }

      // GET /notes/:id
      const idMatch = /^\/notes\/(\d+)$/.exec(path);
      if (req.method === "GET" && idMatch) {
        const id = Number(idMatch[1]);
        // BLOCKER 4: gate before tracking. The probe is an untracked read
        // (no writes, no neighbor work); only an authorized read bumps the
        // access counters, so a denied cross-namespace read can't pollute
        // importance weighting or search ranking. Without namespace
        // resolution there is no cross-namespace boundary, so the probe is
        // just a 404 check (denyUnreadable's canRead gate would 404 every
        // read when nsCtx.ownNamespace is "").
        const probe = store.read(id); // gate-ok: access probe: denyUnreadable/readVisible decide before anything is returned
        // A note whose writer an admin distrusts reads as "not found" unless
        // the caller opts in with ?include_distrusted=1 (admin only; then it is marked).
        const wantDistrusted = flagParam(url, "include_distrusted") && (!nsCtx.active || probe?.namespace === nsCtx.ownNamespace);
        if (nsCtx.active) {
          if (!denyUnreadable(nsCtx, res, probe)) return;
        } else if (!probe) {
          sendJson(res, 404, { error: "not found" });
          return;
        }
        // Authorized: the ONE gated read, with tracking so the returned
        // counters include this read. ?neighbors=true attaches up to 10
        // same-namespace similar notes with similarity scores (and their
        // staleness fields), mirroring the MCP state_read neighbors:true option.
        const withNeighbors = url.searchParams.get("neighbors") === "true";
        const note = store.readVisible(id, { trackAccess: true, withNeighbors, includeDistrusted: wantDistrusted });
        if (!note) {
          sendJson(res, 404, { error: "not found" });
          return;
        }
        // Round edge scores to 3 decimals for readability (stored raw in
        // SQLite), mirroring the MCP state_read tool. Neighbor entries
        // already carry their staleness fields (annotated in Store.read).
        const base = annotateStaleness(note);
        const outNote = note.neighbors
          ? {
              ...base,
              neighbors: note.neighbors.map((n) => ({
                ...n,
                score: Math.round(n.score * 1000) / 1000,
              })),
            }
          : base;
        sendJson(res, 200, { note: outNote });
        return;
      }

      // PUT /notes/:id
      if (req.method === "PUT" && idMatch) {
        const id = Number(idMatch[1]);
        const raw = await readBody(req);
        let parsed: NotePatch;
        try {
          parsed = JSON.parse(raw || "{}");
        } catch {
          sendJson(res, 400, { error: "invalid JSON body" });
          return;
        }
        if (parsed && parsed.forget_after !== undefined) parsed.forget_after = coerceNumeric(parsed.forget_after) as number;
        if (parsed && parsed.confidence !== undefined && parsed.confidence !== null) parsed.confidence = coerceNumeric(parsed.confidence) as number;
        // Compare-and-swap, as in the MCP tool state_write: `if_rev` is the revision the caller last read; the edit is
        // refused (409) when the note has moved on, instead of silently replacing a newer write.
        let ifRev: number | undefined;
        if (parsed && typeof parsed === "object" && "if_rev" in parsed) {
          const raw = coerceNumeric((parsed as { if_rev?: unknown }).if_rev);
          delete (parsed as { if_rev?: unknown }).if_rev;
          if (raw !== undefined && raw !== null) {
            if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1) {
              sendJson(res, 400, { error: "if_rev must be a whole number (the rev you last read)" });
              return;
            }
            ifRev = raw;
          }
        }
        try {
          if (nsCtx.active) {
            // The client-supplied namespace is dropped (the note keeps its
            // existing namespace), and the note must live in the server's
            // own namespace -- otherwise a PUT by id could rewrite a granted
            // namespace's notes (grants are read-only).
            const existing = store.read(id); // gate-ok: PUT: namespace check, then a hidden note reads as 404
            if (!denyUnwritable(nsCtx, res, existing)) return;
            delete parsed.namespace;
          }
          // A note the distrust list hides reads as missing to everyone but an admin (who may rewrite it under a trusted writer).
          if (!store.readVisible(id, { includeDistrusted: isAdmin })) {
            sendJson(res, 404, { error: "not found" });
            return;
          }
          if (parsed && parsed.tags !== undefined) {
            const currentTags = store.read(id)?.tags; // gate-ok: tag-guard lookup only (no content returned)
            assertPlainWriteTags(parsed.tags, currentTags);
            assertReviewedTag(parsed.tags, currentTags, isAdmin);
          }
          const warnings: LintFinding[] = [];
          const note = store.update(id, parsed, { lintWarnings: warnings, ...(ifRev !== undefined ? { ifRev } : {}) });
          if (!note) {
            sendJson(res, 404, { error: "not found" });
            return;
          }
          await maybeEmbed(store, note);
          sendJson(res, 200, warnings.length ? { note, warnings } : { note });
        } catch (e) {
          sendError(res, e);
        }
        return;
      }

      // DELETE /notes/:id
      if (req.method === "DELETE" && idMatch) {
        const id = Number(idMatch[1]);
        if (nsCtx.active) {
          // Same own-namespace rule as the MCP state_delete tool: a read
          // grant never confers delete access.
          if (!denyUnwritable(nsCtx, res, store.read(id))) return; // gate-ok: archive/restore: denyUnwritable probe, hidden note is 404
        }
        const removed = store.delete(id);
        if (!removed) {
          sendJson(res, 404, { error: "not found" });
          return;
        }
        sendJson(res, 200, { deleted: id });
        return;
      }

      // Retention: POST /notes/:id/archive -> soft-archive a note. It drops
      // out of list/search/recall but stays on disk and is restorable. This is
      // the reversible alternative to DELETE for "forget this".
      const archMatch = /^\/notes\/(\d+)\/archive$/.exec(path);
      if (req.method === "POST" && archMatch) {
        const id = Number(archMatch[1]);
        const note = store.readVisible(id, { includeDistrusted: isAdmin });
        if (!note) {
          sendJson(res, 404, { error: "not found" });
          return;
        }
        if (nsCtx.active && !denyUnwritable(nsCtx, res, note)) return;
        const archived = store.archive(id);
        sendJson(res, 200, { archived: id, note: annotateStaleness(archived!) });
        return;
      }

      // Retention: POST /notes/:id/restore -> bring an archived note back.
      const restoreMatch = /^\/notes\/(\d+)\/restore$/.exec(path);
      if (req.method === "POST" && restoreMatch) {
        const id = Number(restoreMatch[1]);
        const note = store.readVisible(id, { includeDistrusted: isAdmin });
        if (!note) {
          sendJson(res, 404, { error: "not found" });
          return;
        }
        if (nsCtx.active && !denyUnwritable(nsCtx, res, note)) return;
        // Optional body { forget_after } gives the restored note a fresh TTL;
        // without it the old (possibly already expired) deadline is cleared,
        // so the next sweep does not instantly re-archive the note.
        let ttl: number | undefined;
        const rawBody = await readBody(req);
        if (rawBody.trim()) {
          try {
            const b = JSON.parse(rawBody) as { forget_after?: unknown };
            const fa = coerceNumeric(b.forget_after);
            validateForgetAfter(fa);
            if (typeof fa === "number") ttl = fa;
          } catch (e) {
            sendError(res, e instanceof SyntaxError ? new ValidationError("invalid JSON body") : e);
            return;
          }
        }
        const restored = store.restore(id, ttl === undefined ? {} : { forget_after: ttl });
        sendJson(res, 200, { restored: id, note: annotateStaleness(restored!) });
        return;
      }

      // --- Replacing a memory (1.6.0): two steps, never silent, never destructive ---
      // POST /supersede/preview   { old_ids: [..], new_note: {title, body?, tags?, confidence?} | new_id }  -> writes NOTHING
      // POST /supersede/confirm   { token, new_note?, acknowledge_risk? }   the only call that changes anything
      // POST /supersede/undo      { id }                                   bring a replaced note back (recorded)
      // GET  /notes/:id/history   earlier versions (admin)        POST /notes/:id/history/restore { version, if_rev? } (admin)
      // DELETE /notes/:id/history forget the earlier versions (admin)
      if (path.startsWith("/supersede/") && req.method === "POST") {
        const step = path.slice("/supersede/".length);
        if (step !== "preview" && step !== "confirm" && step !== "undo") {
          sendJson(res, 404, { error: "no such route" });
          return;
        }
        const raw = await readBody(req);
        let b: Record<string, unknown>;
        try {
          const v = JSON.parse(raw || "{}") as unknown;
          if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("not an object");
          b = v as Record<string, unknown>;
        } catch {
          sendJson(res, 400, { error: "invalid JSON body (expected an object)" });
          return;
        }
        const caller: Caller = { scope, ...(nsCtx.active ? { ownNamespace: nsCtx.ownNamespace } : {}) };
        try {
          if (step === "preview") {
            const out = supersedePreview(
              store,
              caller,
              { old_ids: b.old_ids, new_note: b.new_note as never, new_id: b.new_id },
              "To go ahead, send POST /supersede/confirm with this code: {token}"
            );
            sendJson(res, 200, out);
          } else if (step === "confirm") {
            const out = supersedeConfirm(store, caller, { token: b.token, new_note: b.new_note as never, acknowledge_risk: b.acknowledge_risk });
            await maybeEmbed(store, out.replacement);
            sendJson(res, 200, out);
          } else {
            sendJson(res, 200, supersedeUndo(store, caller, coerceNumeric(b.id)));
          }
        } catch (e) {
          sendError(res, e);
        }
        return;
      }
      const histMatch = /^\/notes\/(\d+)\/history(\/restore)?$/.exec(path);
      if (histMatch) {
        const hid = Number(histMatch[1]);
        const caller: Caller = { scope, ...(nsCtx.active ? { ownNamespace: nsCtx.ownNamespace } : {}) };
        try {
          if (req.method === "GET" && !histMatch[2]) {
            sendJson(res, 200, noteHistory(store, caller, hid, { includeDistrusted: flagParam(url, "include_distrusted") }));
          } else if (req.method === "POST" && histMatch[2]) {
            const raw = await readBody(req);
            let b: { version?: unknown; if_rev?: unknown };
            try {
              b = JSON.parse(raw || "{}");
            } catch {
              sendJson(res, 400, { error: "invalid JSON body" });
              return;
            }
            const ifRev = b.if_rev === undefined || b.if_rev === null ? undefined : coerceNumeric(b.if_rev);
            if (ifRev !== undefined && (typeof ifRev !== "number" || !Number.isInteger(ifRev) || ifRev < 1)) {
              sendJson(res, 400, { error: "if_rev must be a whole number (the rev you last read)" });
              return;
            }
            const out = restoreVersion(store, caller, hid, coerceNumeric(b.version), ifRev !== undefined ? { ifRev: ifRev as number } : {});
            await maybeEmbed(store, out.note);
            sendJson(res, 200, out);
          } else if (req.method === "DELETE" && !histMatch[2]) {
            sendJson(res, 200, purgeNoteHistory(store, caller, hid));
          } else {
            sendJson(res, 404, { error: "no such route" });
          }
        } catch (e) {
          sendError(res, e);
        }
        return;
      }

      // Retention: POST /sweep-expired -> archive every note past its TTL.
      // Returns how many were archived. Safe to call on a timer/cron.
      if (req.method === "POST" && path === "/sweep-expired") {
        // A namespace-pinned principal may only retire its OWN namespace's notes.
        const archived = store.sweepExpired(Date.now(), nsCtx.active ? [nsCtx.ownNamespace] : undefined);
        sendJson(res, 200, { archived });
        return;
      }

      // GET /notes?namespace=&limit=&offset=&includeArchived=1&archived=1
      if (req.method === "GET" && path === "/notes") {
        const namespace = url.searchParams.get("namespace") ?? undefined;
        let limit: number | undefined;
        let offset: number | undefined;
        try {
          limit = intParam(url, "limit", 1);
          offset = intParam(url, "offset", 0);
        } catch (e) {
          sendError(res, e);
          return;
        }
        // Retention: archived notes are excluded by default. includeArchived
        // shows everything; archived=1 shows ONLY the archive (the restore
        // view). Both are read-scoped -- seeing that a note was archived is
        // not privileged, and the namespace filter still applies.
        const includeArchived = url.searchParams.get("includeArchived") === "1";
        const archivedOnly = url.searchParams.get("archived") === "1";
        const wf = { ...writerFilter(url), ...supersededFilter(url) };
        if (nsCtx.active) {
          // Untrusted hint intersected with the readable set, like the MCP
          // state_list tool.
          const hint = trustedHint(nsCtx, namespace);
          if (hint) {
            const result = store.list({
              namespace: hint,
              limit,
              offset,
              includeArchived,
              archivedOnly,
              ...wf,
            });
            sendJson(res, 200, { ...result, searchedNamespaces: [hint] });
            return;
          }
          sendJson(res, 200, {
            ...listReadable(
              nsCtx,
              limit,
              offset,
              includeArchived,
              archivedOnly,
              wf
            ),
            searchedNamespaces: readable(nsCtx),
          });
          return;
        }
        const result = store.list({
          namespace,
          limit,
          offset,
          includeArchived,
          archivedOnly,
          ...wf,
        });
        sendJson(res, 200, {
          ...result,
          searchedNamespaces: namespace ? [namespace] : [],
        });
        return;
      }

      // GET /search?q=&namespace=&limit=&mode=keyword|semantic|hybrid&when=
      if (req.method === "GET" && path === "/search") {
        const q = url.searchParams.get("q") ?? "";
        const namespace = url.searchParams.get("namespace") ?? undefined;
        let limit: number | undefined;
        try {
          limit = intParam(url, "limit", 1);
        } catch (e) {
          sendError(res, e);
          return;
        }
        const modeRaw = (url.searchParams.get("mode") ?? "").trim().toLowerCase();
        if (modeRaw && modeRaw !== "keyword" && modeRaw !== "semantic" && modeRaw !== "hybrid") {
          sendJson(res, 400, { error: "mode must be keyword, semantic or hybrid" });
          return;
        }
        const whenRaw = url.searchParams.get("when") ?? undefined;
        // Retrieval visibility: ?explain=1 swaps the plain search for the
        // explained twin and attaches a `breakdown` to each result, so the
        // caller sees the exact base relevance / access boost / staleness
        // factors that produced the ranking. Off by default to keep the
        // common response small and byte-compatible.
        const explainRaw = (url.searchParams.get("explain") ?? "").toLowerCase();
        const explain = explainRaw === "1" || explainRaw === "true";
        // Like the MCP tool, an unrecognized time phrase is ignored rather
        // than an error -- the query still runs unscoped.
        const timePhrase = whenRaw ? parseTimePhrase(whenRaw, { timeZone: TIME_ZONE }) : null;
        if (whenRaw && whenRaw.trim() && !timePhrase) {
          sendJson(res, 400, { error: `unrecognized time phrase "${whenRaw}" (try "yesterday", "last week", "in March")` });
          return;
        }
        if (!q.trim() && !timePhrase) {
          sendJson(res, 400, { error: "q is required" });
          return;
        }
        // Shape a hit for the wire: staleness annotation always, breakdown
        // only when explain=1. Shared by all three namespace branches.
        const shapeHit = (n: NoteRecord, breakdown?: unknown): Record<string, unknown> => ({
          ...annotateStaleness(n),
          ...(breakdown !== undefined ? { breakdown } : {}),
        });
        const toResults = (hits: ExplainedHit[]): Record<string, unknown>[] =>
          hits.map((h) => shapeHit(h.note, h.breakdown));
        if (nsCtx.active) {
          // Untrusted hint intersected with the readable set, like the MCP
          // state_search tool: fan out over every readable namespace when
          // the hint is missing or names something unreadable. The
          // per-namespace lists merge round-robin so a later namespace is
          // never starved by an earlier one's hits.
          const hint = trustedHint(nsCtx, namespace);
          const searchOpts = {
            limit,
            mode: parseMode(url.searchParams.get("mode")),
            timeRange: timePhrase ? { start: timePhrase.start, end: timePhrase.end } : undefined,
            ...writerFilter(url),
            ...(flagParam(url, "include_superseded") ? { includeSuperseded: true } : {}),
          };
          if (hint) {
            if (explain) {
              const hits = await runSearchExplained(store, q, { ...searchOpts, namespace: hint });
              sendJson(res, 200, {
                results: toResults(hits),
                timeRange: timePhrase ? timePhrase.label : null,
                searchedNamespaces: [hint],
              });
              return;
            }
            const results = await runSearch(store, q, { ...searchOpts, namespace: hint });
            sendJson(res, 200, {
              results: results.map((n) => annotateStaleness(n)),
              timeRange: timePhrase ? timePhrase.label : null,
              searchedNamespaces: [hint],
            });
            return;
          }
          const lim = clampInt(searchOpts.limit, 20, 1, 200);
          if (explain) {
            const perNs: ExplainedHit[][] = [];
            for (const ns of readable(nsCtx)) {
              perNs.push(await runSearchExplained(store, q, { ...searchOpts, namespace: ns }));
            }
            // Interleave the explained lists by note id, preserving each
            // list's internal order, then re-attach the breakdown by id.
            const merged = roundRobin(perNs.map((l) => l.map((h) => h.note)), lim);
            const byId = new Map<number, unknown>();
            for (const l of perNs) for (const h of l) byId.set(h.note.id, h.breakdown);
            sendJson(res, 200, {
              results: merged.map((n) => shapeHit(n, byId.get(n.id))),
              timeRange: timePhrase ? timePhrase.label : null,
              searchedNamespaces: readable(nsCtx),
            });
            return;
          }
          const lists: NoteRecord[][] = [];
          for (const ns of readable(nsCtx)) {
            lists.push(await runSearch(store, q, { ...searchOpts, namespace: ns }));
          }
          sendJson(res, 200, {
            results: roundRobin(lists, lim).map((n) => annotateStaleness(n)),
            timeRange: timePhrase ? timePhrase.label : null,
            searchedNamespaces: readable(nsCtx),
          });
          return;
        }
        const singleOpts = {
          namespace,
          limit,
          mode: parseMode(url.searchParams.get("mode")),
          timeRange: timePhrase ? { start: timePhrase.start, end: timePhrase.end } : undefined,
          ...writerFilter(url),
          ...(flagParam(url, "include_superseded") ? { includeSuperseded: true } : {}),
        };
        if (explain) {
          const hits = await runSearchExplained(store, q, singleOpts);
          sendJson(res, 200, {
            results: toResults(hits),
            timeRange: timePhrase ? timePhrase.label : null,
            searchedNamespaces: namespace ? [namespace] : [],
          });
          return;
        }
        const results = await runSearch(store, q, singleOpts);
        sendJson(res, 200, {
          results: results.map((n) => annotateStaleness(n)),
          timeRange: timePhrase ? timePhrase.label : null,
          searchedNamespaces: namespace ? [namespace] : [],
        });
        return;
      }

      // POST /relevant { message, limit?, namespace? } -> { keywords, results }
      // Mirrors the state_relevant MCP tool: keyword extraction from a
      // natural-language message, then a permissive (any-single-keyword-hit)
      // search. Namespace gating matches GET /search exactly.
      if (req.method === "POST" && path === "/relevant") {
        const raw = await readBody(req);
        let parsed: { message?: unknown; limit?: unknown; namespace?: unknown; written_by?: unknown; not_written_by?: unknown; include_distrusted?: unknown };
        try {
          parsed = JSON.parse(raw || "{}");
        } catch {
          sendJson(res, 400, { error: "invalid JSON body" });
          return;
        }
        if (typeof parsed.message !== "string" || !parsed.message.trim()) {
          sendJson(res, 400, { error: "message is required" });
          return;
        }
        // The MCP schema requires an integer limit; the REST layer used to
        // accept floats (floored) and strings (defaulted). Reject
        // non-integers with a 400 so both surfaces validate identically.
        if (parsed.limit !== undefined && !Number.isInteger(parsed.limit)) {
          sendJson(res, 400, { error: "limit must be an integer" });
          return;
        }
        // Same default as the MCP tool: a relevance probe returns a handful
        // of notes, not a page.
        const relLimit = typeof parsed.limit === "number" ? parsed.limit : 5;
        // ONE resolved namespace (body wins, then the query string) feeds BOTH the include_distrusted gate and the search, so
        // the gate can never judge one namespace while the search reads another.
        const relNs =
          typeof parsed.namespace === "string" ? parsed.namespace : url.searchParams.get("namespace") ?? undefined;
        // Writer / trust filters: in the JSON body, or (like /search) in the query string.
        const bodyStr = (k: string): string | undefined => {
          const v = (parsed as Record<string, unknown>)[k];
          return typeof v === "string" && v !== "" ? v : undefined;
        };
        const urlWf = writerFilter(url);
        const rwf: WriterFilter = {
          ...urlWf,
          ...(bodyStr("written_by") ? { writtenBy: bodyStr("written_by") } : {}),
          ...(bodyStr("not_written_by") ? { notWrittenBy: bodyStr("not_written_by") } : {}),
          ...(["1", "true", "yes"].includes(String((parsed as Record<string, unknown>).include_distrusted ?? "").toLowerCase()) ? { includeDistrusted: true } : {}),
        };
        if (rwf.includeDistrusted && refuseDistrustedOptIn(relNs)) return;
        // Results carry the same staleness fields as /search (the
        // vague-message path is the most likely to act on outdated facts).
        const withStaleness = (r: { keywords: string[]; results: NoteRecord[] }) => ({
          keywords: r.keywords,
          results: r.results.map((n) => annotateStaleness(n)),
        });
        if (nsCtx.active) {
          // Untrusted hint intersected with the readable set, like GET
          // /search: fan out over every readable namespace when the hint is
          // missing or names something unreadable. Round-robin merge so a
          // later namespace is never starved; searchedNamespaces echoes the
          // namespaces actually searched.
          const hint = trustedHint(nsCtx, relNs);
          if (hint) {
            const out = await runRelevantSearch(store, parsed.message, {
              namespace: hint,
              limit: relLimit,
              ...rwf,
            });
            sendJson(res, 200, {
              ...withStaleness(out),
              searchedNamespaces: [hint],
            });
            return;
          }
          const lists: NoteRecord[][] = [];
          let keywords: string[] = [];
          for (const ns of readable(nsCtx)) {
            const r = await runRelevantSearch(store, parsed.message, {
              namespace: ns,
              limit: relLimit,
              ...rwf,
            });
            keywords = r.keywords; // identical per namespace (from the message)
            lists.push(r.results);
          }
          const lim = clampInt(relLimit, 10, 1, 200);
          sendJson(res, 200, {
            keywords,
            results: roundRobin(lists, lim).map((n) => annotateStaleness(n)),
            searchedNamespaces: readable(nsCtx),
          });
          return;
        }
        const out = await runRelevantSearch(store, parsed.message, {
          namespace: relNs,
          limit: relLimit,
          ...rwf,
        });
        sendJson(res, 200, {
          ...withStaleness(out),
          searchedNamespaces: relNs ? [relNs] : [],
        });
        return;
      }

      // GET /stats?namespace= -> access-tracking stats, mirroring the
      // memory_stats MCP tool. Read scope; namespace gating matches the
      // tool exactly (readable-set counting under server-side resolution,
      // never the whole store).
      if (req.method === "GET" && path === "/stats") {
        const namespace = url.searchParams.get("namespace") ?? undefined;
        let namespaces: string[] | undefined;
        let searchedNamespaces: string[];
        if (nsCtx.active) {
          const hint = trustedHint(nsCtx, namespace);
          namespaces = hint ? [hint] : readable(nsCtx);
          searchedNamespaces = namespaces;
        } else {
          namespaces = namespace ? [namespace] : undefined;
          searchedNamespaces = namespace ? [namespace] : [];
        }
        sendJson(res, 200, {
          ...store.accessStats(namespaces, { hideDistrusted: !isAdmin }),
          meter: meterStats(store, namespaces),
          searchedNamespaces,
        });
        return;
      }

      // ---- Automatic memory (progressive.ts; the MCP tools memory_index / memory_timeline / memory_get / session_list) ----
      // Reads: GET /index, GET /timeline, POST /get (read scope despite the POST: the ids are a body), GET /sessions,
      // GET /sessions/:id, GET /files/timeline?path=. Write: POST /capture (a hook that could not open the local database).
      const capRead = (): ReadScope => {
        const hint = url.searchParams.get("namespace") ?? undefined;
        return {
          namespaces: nsCtx.active ? (trustedHint(nsCtx, hint) ? [hint!] : readable(nsCtx)) : hint ? [hint] : undefined,
          ...(flagParam(url, "include_distrusted") ? { includeDistrusted: true } : {}),
        };
      };
      const sessMatch = /^\/sessions\/([^/]+)$/.exec(path);
      if (
        (req.method === "GET" && path === "/index") ||
        (req.method === "GET" && path === "/timeline") ||
        (req.method === "GET" && path === "/sessions") ||
        (req.method === "GET" && path === "/files/timeline") ||
        (req.method === "GET" && sessMatch) ||
        (req.method === "POST" && path === "/get")
      ) {
        try {
          const q = (k: string): string | undefined => url.searchParams.get(k) ?? undefined;
          if (path === "/index") {
            sendJson(res, 200, memoryIndex(store, capRead(), { query: q("q") ?? q("query"), kind: q("kind"), obs_type: q("obs_type"), file: q("file"), session: q("session"), since: q("since"), limit: intParam(url, "limit", 1) }));
          } else if (path === "/timeline") {
            sendJson(res, 200, memoryTimeline(store, capRead(), { anchor: intParam(url, "anchor", 1), query: q("q") ?? q("query"), file: q("file"), session: q("session"), before: intParam(url, "before", 1), after: intParam(url, "after", 1) }));
          } else if (path === "/get") {
            let body: { ids?: unknown };
            try {
              body = JSON.parse((await readBody(req)) || "{}");
            } catch {
              sendJson(res, 400, { error: "invalid JSON body" });
              return;
            }
            sendJson(res, 200, memoryGet(store, capRead(), body.ids));
          } else if (path === "/sessions") {
            sendJson(res, 200, sessionList(store, capRead(), intParam(url, "limit", 1)));
          } else if (path === "/files/timeline") {
            sendJson(res, 200, fileTimeline(store, capRead(), q("path") ?? "", intParam(url, "limit", 1)));
          } else {
            const one = sessionGet(store, capRead(), decodeURIComponent(sessMatch![1]));
            if (one) sendJson(res, 200, one);
            else sendJson(res, 404, { error: "no such session" });
          }
        } catch (e) {
          sendError(res, e);
        }
        return;
      }

      // POST /capture: one hook event, from a capture hook that could not use the local database (ONEMEMORY_HOOK_URL).
      // The event is redacted AGAIN here (never trust the sender to have done it), lands in the token's own namespace
      // when namespaces are resolved, and cannot be appended to another namespace's session.
      if (req.method === "POST" && path === "/capture") {
        let b: Record<string, unknown>;
        try {
          b = JSON.parse((await readBody(req)) || "{}");
        } catch {
          sendJson(res, 400, { error: "invalid JSON body" });
          return;
        }
        if (!b || typeof b !== "object" || Array.isArray(b)) b = {};
        const ev = typeof b.event === "string" && (HOOK_EVENTS as readonly string[]).includes(b.event) ? (b.event as HookEvent) : null;
        if (!ev || typeof b.session_id !== "string" || !b.session_id.trim()) {
          sendJson(res, 400, { error: `event (one of ${HOOK_EVENTS.join(", ")}) and session_id are required` });
          return;
        }
        const s = (k: string, max: number): string => (typeof b[k] === "string" ? (b[k] as string) : "").slice(0, max);
        const capNs = nsCtx.active ? nsCtx.ownNamespace : s("namespace", 200).trim() || DEFAULT_NAMESPACE;
        try {
          const owner = store.captureDb().prepare("SELECT namespace FROM sessions WHERE id = ?").get(b.session_id) as { namespace: string } | undefined;
          if (owner && owner.namespace !== capNs) {
            sendJson(res, 409, { error: "that session belongs to another namespace" });
            return;
          }
          const tool = s("tool", 200);
          if (tool && isOwnTool(tool)) {
            sendJson(res, 202, { stored: false });
            return;
          }
          const input = s("input", 64 * 1024);
          const output = s("output", 64 * 1024);
          recordEvent(store, { session_id: b.session_id.slice(0, 200), cwd: s("cwd", 1000), event: ev, tool, input: cleanField(input), output: cleanField(output), ok: b.ok !== false, bytes: input.length + output.length, at: new Date().toISOString() }, capNs);
          if (ev === "stop" || ev === "session-end") distillSession(store, b.session_id.slice(0, 200));
          sendJson(res, 202, { stored: true });
        } catch (e) {
          sendError(res, e);
        }
        return;
      }

      // POST /rebuild-edges { threshold?, namespace?, confirm? } -> { created, removed }
      // Mirrors the memory_rebuild_edges MCP tool: recalculates the note
      // similarity graph from scratch. Admin scope; under server-side
      // namespace resolution the rebuild is confined to the server's own
      // namespace (writes stay local, like memory_consolidate). Runs the
      // cooperative chunked rebuild, so it yields to the event loop and
      // commits per chunk instead of freezing the server in one giant
      // transaction; an interrupted run resumes from its _meta marker.
      // Same confirmation gate as the MCP tool: above
      // REBUILD_CONFIRM_NOTE_COUNT notes in scope it answers 409 with the
      // workload unless the body carries confirm: true. One rebuild at a
      // time: a concurrent request gets 409.
      if (req.method === "POST" && path === "/rebuild-edges") {
        const raw = await readBody(req);
        let parsed: { threshold?: unknown; namespace?: unknown; confirm?: unknown };
        try {
          parsed = JSON.parse(raw || "{}");
        } catch {
          sendJson(res, 400, { error: "invalid JSON body" });
          return;
        }
        const threshold =
          parsed.threshold === undefined ? undefined : Number(parsed.threshold);
        const relNs =
          typeof parsed.namespace === "string" ? parsed.namespace : undefined;
        try {
          // resolveEdgeThreshold throws ValidationError on out-of-range
          // input -> 400 via sendError, never a 500.
          resolveEdgeThreshold(threshold);
          const scopeNs = nsCtx.active ? nsCtx.ownNamespace : relNs;
          const plan = store.rebuildPlan(scopeNs ? { namespace: scopeNs } : {});
          const notes = plan.reduce((s, g) => s + g.notes, 0);
          const pairs = plan.reduce((s, g) => s + g.pairs, 0);
          if (notes > REBUILD_CONFIRM_NOTE_COUNT && parsed.confirm !== true) {
            sendJson(res, 409, {
              error:
                `refusing: rebuilding edges would score ~${pairs.toLocaleString("en-US")} pairs ` +
                `across ${notes.toLocaleString("en-US")} notes (over the ` +
                `${REBUILD_CONFIRM_NOTE_COUNT}-note confirmation threshold); ` +
                "re-send with confirm: true to proceed",
              notes,
              pairs,
            });
            return;
          }
          const result = await store.rebuildEdgesCooperative({
            threshold,
            namespace: scopeNs,
          });
          sendJson(res, 200, {
            ...result,
            namespace: scopeNs ?? null,
          });
        } catch (e) {
          if (e instanceof RebuildBusyError) {
            sendJson(res, 409, { error: e.message });
            return;
          }
          sendError(res, e);
        }
        return;
      }

      // GET /changes?since=<ISO|24h|last>&cursor=&namespace=&source=&limit=&consumer=
      // Change feed, mirroring the memory_since MCP tool (read scope;
      // namespace gating identical to /stats).
      if (req.method === "GET" && path === "/changes") {
        const namespace = url.searchParams.get("namespace") ?? undefined;
        let namespaces: string[] | undefined;
        if (nsCtx.active) {
          const hint = trustedHint(nsCtx, namespace);
          namespaces = hint ? [hint] : readable(nsCtx);
        } else {
          namespaces = namespace ? [namespace] : undefined;
        }
        const limitRaw = url.searchParams.get("limit");
        if (limitRaw !== null && !/^\d+$/.test(limitRaw)) {
          sendJson(res, 400, { error: "limit must be an integer" });
          return;
        }
        // &wait=<seconds> (0-55): long-poll -- hold the request until the
        // feed has something new for this token's scope (see change-wait.ts).
        const abort = new AbortController();
        const onClose = (): void => abort.abort();
        res.once("close", onClose);
        try {
          const out = await waitForChanges(
            store,
            {
              since: url.searchParams.get("since") ?? undefined,
              cursor: url.searchParams.get("cursor") ?? undefined,
              namespaces,
              source: url.searchParams.get("source") ?? undefined,
              ...feedWriterFilter(url),
              limit: limitRaw !== null ? Number(limitRaw) : undefined,
              consumer: url.searchParams.get("consumer") ?? undefined,
              ackMode: ackModeParam(url),
              ackToken: url.searchParams.get("ack_token") ?? undefined,
              excludeSelf: flagParam(url, "exclude_self"),
            },
            {
              // `wait` and `wait_seconds` are the same thing (MCP spells it wait_seconds).
              waitSeconds: parseWait(url.searchParams.get("wait") ?? url.searchParams.get("wait_seconds")),
              signal: abort.signal,
              key: tokenKey(principal.token),
              scopeKey: waitScopeKey(namespaces),
            }
          );
          if (url.searchParams.get("ack_token")) audit({ op: "changes.ack", label: principal.label, kind: "changes", detail: `consumer=${out.consumer ?? ""}` });
          sendJson(res, 200, { ...out, searchedNamespaces: namespaces ?? [] });
        } catch (e) {
          if (e instanceof WaitBusyError) sendJson(res, 429, { error: e.message });
          else sendError(res, e);
        } finally {
          res.off("close", onClose);
        }
        return;
      }

      // --- Task board, handoffs, catch-up (conventions on notes; tasks.ts) ---
      // Same gating as the notes routes: GET = read, POST/PUT = write (see
      // requiredScope); writes land in the request's own namespace when
      // namespace resolution / a token pin is active; reads cover the
      // readable set, with ?namespace= as an untrusted hint.
      if (
        path === "/tasks" ||
        path === "/handoffs" ||
        path === "/catch-up" ||
        path === "/runner/status" ||
        path === "/ack" ||
        /^\/tasks\/\d+(\/(claim|approve))?$/.test(path)
      ) {
        const readNs = (): string[] | undefined => {
          const hint = url.searchParams.get("namespace") ?? undefined;
          if (nsCtx.active) {
            const t = trustedHint(nsCtx, hint);
            return t ? [t] : readable(nsCtx);
          }
          return hint ? [hint] : undefined;
        };
        const writeNs = nsCtx.active ? { namespace: nsCtx.ownNamespace } : {};
        const jsonBody = async (): Promise<Record<string, unknown> | null> => {
          const raw = await readBody(req);
          try {
            const v = JSON.parse(raw || "{}");
            if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
          } catch {
            /* fall through */
          }
          sendJson(res, 400, { error: "invalid JSON body (expected an object)" });
          return null;
        };
        try {
          if (req.method === "GET" && path === "/tasks") {
            const namespaces = readNs();
            const limit = intParam(url, "limit", 1);
            const { tasks, total } = listTasks(store, {
              namespaces,
              status: url.searchParams.get("status") ?? undefined,
              owner: url.searchParams.get("owner") ?? undefined,
              parent_id: intParam(url, "parent_id", 1),
              limit,
              ...writerFilter(url),
            });
            sendJson(res, 200, { tasks, total, searchedNamespaces: namespaces ?? [] });
            return;
          }
          const getId = /^\/tasks\/(\d+)$/.exec(path);
          if (req.method === "GET" && getId) {
            const namespaces = readNs();
            try {
              const wantDistrusted = flagParam(url, "include_distrusted");
              const tid = Number(getId[1]);
              if (wantDistrusted && nsCtx.active) {
                // A pinned admin sees hidden tasks of its OWN namespace only; a task of a namespace it merely reads is shown as for any reader.
                try {
                  sendJson(res, 200, { task: getTask(store, tid, [nsCtx.ownNamespace], { includeDistrusted: true }) });
                  return;
                } catch (e) {
                  if (!(e instanceof TaskNotFoundError)) throw e;
                }
                sendJson(res, 200, { task: getTask(store, tid, namespaces) });
                return;
              }
              sendJson(res, 200, { task: getTask(store, tid, namespaces, { includeDistrusted: wantDistrusted }) });
            } catch (e) {
              if (e instanceof TaskNotFoundError) sendJson(res, 404, { error: "not found" });
              else throw e;
            }
            return;
          }
          const sub = /^\/tasks\/(\d+)\/(claim|approve)$/.exec(path);
          if (req.method === "POST" && sub) {
            const body = await jsonBody();
            if (!body) return;
            try {
              if (sub[2] === "claim") {
                const r = claimTask(store, { ...(body as object), id: Number(sub[1]) } as never, writeNs);
                audit({ op: "task.claim", id: r.task.id, namespace: r.task.namespace, label: principal.label, kind: "task", detail: r.released ? "release" : r.heartbeat ? "heartbeat" : "claim" });
                sendJson(res, 200, r);
              } else {
                const task = approveTask(
                  store,
                  {
                    id: Number(sub[1]),
                    revoke: body.revoke === true,
                    command_hash: typeof body.command_hash === "string" ? body.command_hash : undefined,
                    if_rev: typeof body.if_rev === "number" ? body.if_rev : undefined,
                  },
                  writeNs
                );
                audit({ op: body.revoke === true ? "task.revoke" : "task.approve", id: task.id, namespace: task.namespace, label: principal.label, kind: "task" });
                sendJson(res, 200, { task });
              }
            } catch (e) {
              if (e instanceof TaskNotFoundError) sendJson(res, 404, { error: "not found" });
              else if (e instanceof ClaimConflictError) sendJson(res, 409, { error: e.message, holder: e.holder, until: e.until });
              else throw e;
            }
            return;
          }
          if (req.method === "POST" && path === "/ack") {
            const body = await jsonBody();
            if (!body) return;
            if (truthyParam(String(body.include_distrusted ?? "")) && refuseDistrustedOptIn(url.searchParams.get("namespace"))) return;
            const namespaces = readNs();
            const r = ackChanges(store, {
              ackToken: typeof body.ack_token === "string" ? body.ack_token : "",
              consumer: typeof body.consumer === "string" ? body.consumer : undefined,
              namespaces,
              source: typeof body.source === "string" ? body.source : undefined,
              ...(typeof body.written_by === "string" && body.written_by ? { writtenBy: body.written_by } : {}),
              ...(typeof body.not_written_by === "string" && body.not_written_by ? { notWrittenBy: body.not_written_by } : {}),
              ...(typeof body.note_written_by === "string" && body.note_written_by ? { noteWrittenBy: body.note_written_by } : {}),
              ...(typeof body.not_note_written_by === "string" && body.not_note_written_by ? { notNoteWrittenBy: body.not_note_written_by } : {}),
              ...(truthyParam(String(body.include_distrusted ?? "")) ? { includeDistrusted: true } : {}),
            });
            audit({ op: "changes.ack", label: principal.label, kind: "changes", detail: `consumer=${r.consumer} seq=${r.seq}` });
            sendJson(res, 200, { acked: true, ...r });
            return;
          }
          if (req.method === "POST" && path === "/tasks") {
            const body = await jsonBody();
            if (!body) return;
            if (body.id !== undefined) {
              sendJson(res, 400, { error: "POST /tasks creates; update with PUT /tasks/:id" });
              return;
            }
            const warnings: LintFinding[] = [];
            const wantApprove = body.approve === true;
            if (wantApprove && !scopeAllows(scope, "admin")) {
              sendJson(res, 403, { error: "approve:true needs an admin token; approve with POST /tasks/:id/approve (send the command_hash you read)" });
              return;
            }
            if (wantApprove && !body.command) {
              sendJson(res, 400, { error: "approve:true only applies to a command task (pass `command` and `target`)" });
              return;
            }
            const put = putTask(store, body as never, writeNs, warnings);
            await maybeEmbed(store, put.note);
            let task = put.task;
            if (wantApprove && !put.replayed) task = approveTask(store, { id: task.id, if_rev: task.rev }, writeNs);
            audit({ op: "task.put", id: task.id, namespace: task.namespace, label: principal.label, kind: task.command ? "command-task" : "task", detail: put.replayed ? "replay" : "create" });
            sendJson(res, put.replayed ? 200 : 201, {
              task,
              ...(put.replayed ? { replayed: true } : {}),
              ...(warnings.length ? { warnings } : {}),
            });
            return;
          }
          const tid = /^\/tasks\/(\d+)$/.exec(path);
          if (req.method === "PUT" && tid) {
            const body = await jsonBody();
            if (!body) return;
            const warnings: LintFinding[] = [];
            try {
              if (body.approve !== undefined) {
                sendJson(res, 400, { error: "approve applies when creating; approve an existing task with POST /tasks/:id/approve (admin)" });
                return;
              }
              const { task, note } = putTask(store, { ...(body as object), id: Number(tid[1]) } as never, writeNs, warnings);
              await maybeEmbed(store, note);
              audit({ op: "task.put", id: task.id, namespace: task.namespace, label: principal.label, kind: task.command ? "command-task" : "task", detail: "update" });
              sendJson(res, 200, warnings.length ? { task, warnings } : { task });
            } catch (e) {
              if (e instanceof TaskNotFoundError) sendJson(res, 404, { error: "not found" });
              else if (e instanceof ClaimConflictError) sendJson(res, 409, { error: e.message, holder: e.holder, until: e.until });
              else if (e instanceof ValidationError && e.message.startsWith("stale write:")) sendJson(res, 409, { error: e.message });
              else throw e;
            }
            return;
          }
          if (req.method === "POST" && path === "/handoffs") {
            const body = await jsonBody();
            if (!body) return;
            const warnings: LintFinding[] = [];
            const w = writeHandoff(store, body as never, writeNs, warnings);
            await maybeEmbed(store, w.note);
            audit({ op: "handoff.write", id: w.handoff.id, namespace: w.handoff.namespace, label: principal.label, kind: "handoff", detail: w.replayed ? "replay" : "create" });
            sendJson(res, w.replayed ? 200 : 201, {
              handoff: w.handoff,
              ...(w.replayed ? { replayed: true } : {}),
              ...(warnings.length ? { warnings } : {}),
            });
            return;
          }
          if (req.method === "GET" && path === "/handoffs") {
            const namespaces = readNs();
            const handoffs = listHandoffs(store, {
              namespaces,
              surface: url.searchParams.get("surface") ?? undefined,
              limit: intParam(url, "limit", 1),
              ...writerFilter(url),
            });
            sendJson(res, 200, { handoffs, searchedNamespaces: namespaces ?? [] });
            return;
          }
          if (req.method === "GET" && path === "/runner/status") {
            const namespaces = readNs();
            sendJson(res, 200, { ...runnerStatus(store, namespaces, undefined, { pinned: nsCtx.active }), searchedNamespaces: namespaces ?? [] });
            return;
          }
          if (req.method === "GET" && path === "/catch-up") {
            const namespaces = readNs();
            const out = catchUp(store, {
              namespaces,
              consumer: url.searchParams.get("consumer") ?? undefined,
              changes: !["0", "false"].includes((url.searchParams.get("changes") ?? "").toLowerCase()),
              tasks: intParam(url, "tasks", 1),
              handoffs: intParam(url, "handoffs", 1),
              ackMode: ackModeParam(url),
              ackToken: url.searchParams.get("ack_token") ?? undefined,
              excludeSelf: flagParam(url, "exclude_self"),
              ...feedWriterFilter(url),
            });
            if (out.changes) {
              audit({
                op: "catch_up",
                label: principal.label,
                kind: "changes",
                detail: `consumer=${out.changes.consumer} total=${out.changes.counts.total}${out.changes.ack_token ? " manual-ack" : " marker-advanced"}${out.changes.acked ? " acked" : ""}`,
              });
            }
            sendJson(res, 200, { ...out, searchedNamespaces: namespaces ?? [] });
            return;
          }
        } catch (e) {
          sendError(res, e);
          return;
        }
      }

      // GET /export -> all notes, for backup / migration. Exempt from the
      // response-size cap: a backup must dump the whole store, not a truncated
      // slice (there are no narrowing params on /export).
      //
      // STREAMED, not materialized: exportAll() would hold every row, every
      // decoded record, AND the full JSON string in memory at once (~3x the
      // backup size). With months of notes that is a real spike on a small
      // box. Instead we page through the store with exportBatch (keyset
      // pagination on the primary key) and write each page as it is built,
      // so peak memory is one page regardless of store size. The response
      // BODY is byte-identical to the old non-streaming form: {"notes":[...]}.
      if (req.method === "GET" && path === "/export") {
        if (res.writableEnded || res.headersSent) return;
        // ?skipUnreadable=1: a row whose body cannot be decrypted is written
        // as a body-less {"unreadable":true} entry instead of aborting the
        // backup. Default is fail-loud: the stream is cut so the client sees
        // an error, never a valid-looking but incomplete backup.
        const skipUnreadable = ["1", "true"].includes((url.searchParams.get("skipUnreadable") ?? "").toLowerCase());
        // Namespace filtering happens IN SQL (unreadable namespaces are never
        // selected, so a tampered row elsewhere cannot block this backup).
        const exportNs = nsCtx.active ? readable(nsCtx) : undefined;
        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          // No Content-Length: the length is not known up front when streaming.
          // Node falls back to chunked transfer-encoding, which every HTTP/1.1
          // client handles.
        });
        // Attestations are OPT-IN (?attest=1): the default body is byte-identical to
        // every release before 1.4.0, `{"notes":[...]}`, so scripts and older importers
        // keep working. With ?attest=1 the envelope gains an `export` header (this
        // server, its public key) and every note a detached signed attestation. If the
        // signing key cannot be created (read-only data dir) the export is still
        // written, just without them -- a backup must not fail over a signature.
        let attest = ["1", "true", "yes"].includes((url.searchParams.get("attest") ?? "").toLowerCase());
        let header = "";
        if (attest) {
          try {
            header = `"export":${JSON.stringify(store.exportHeader())},`;
          } catch (e) {
            attest = false;
            console.error("[onememory] export without attestations:", (e as Error).message);
          }
        }
        res.write(`{${header}"notes":[`);
        let afterId = 0;
        let first = true;
        try {
          for (;;) {
            const page = store.exportBatch(afterId, EXPORT_PAGE_SIZE, { namespaces: exportNs, skipUnreadable, attest, history: url.searchParams.get("history") !== "0" }); // gate-ok: GET /export is admin-only (a full backup)
            if (page.length === 0) break;
            afterId = page[page.length - 1].id;
            for (const note of page) {
              const chunk = (first ? "" : ",") + JSON.stringify(note);
              first = false;
              // Backpressure: if the socket buffer is full, wait for drain
              // rather than queueing the whole backup in the process.
              if (!res.write(chunk)) {
                await new Promise<void>((resolve) => res.once("drain", resolve));
              }
            }
            // A short page means we reached the end of the table.
            if (page.length < EXPORT_PAGE_SIZE) break;
            // Yield to the event loop between pages so a very large export
            // cannot starve concurrent API/MCP traffic on this process.
            await new Promise<void>((r) => setImmediate(r));
          }
        } catch (e) {
          // Headers are already sent, so a status code is impossible: log the
          // cause and destroy the socket so the client sees a failed download.
          console.error("[onememory] export aborted:", (e as Error).message);
          res.destroy(e as Error);
          return;
        }
        res.end("]}");
        return;
      }

      // POST /import -> restore/seed from a backup: { notes: [...] }
      if (req.method === "POST" && path === "/import") {
        // Restore gets its OWN, much larger body cap: /export is exempt from
        // the response cap so a backup can dump the whole store, so /import
        // must be able to accept one back. The default 1MB request cap made a
        // ~2000-note backup un-restorable (413). Still bounded + admin-only.
        const raw = await readBody(req, IMPORT_BODY_BYTES);
        // ImportNote (not NoteInput): a real backup carries updated_at AND rev
        // per note -- both are restore-fidelity fields the store honors.
        let parsed: { notes?: ImportNote[]; dedupe?: unknown };
        try {
          const v = JSON.parse(raw || "{}") as unknown;
          // Both shapes restore: {"notes":[...]} (every release; an attested export adds an `export` header) and a bare [...].
          parsed = Array.isArray(v) ? { notes: v as ImportNote[] } : (v as { notes?: ImportNote[]; dedupe?: unknown });
        } catch {
          sendJson(res, 400, { error: "invalid JSON body" });
          return;
        }
        if (!parsed || !Array.isArray(parsed.notes)) {
          sendJson(res, 400, { error: "expected { notes: [...] } (or a bare array of notes)" });
          return;
        }
        try {
          // When namespace resolution is active the client-supplied namespace
          // is untrusted: imported notes are forced into the server's own
          // namespace so a backup can't plant notes into another namespace
          // (memory poisoning).
          const notes = nsCtx.active
            ? parsed.notes.map((n) => ({ ...n, namespace: nsCtx.ownNamespace }))
            : parsed.notes;
          const report: ImportReport = { quarantined: [], rejected: [] };
          // Above the threshold, DEFER the similarity-graph rebuild: linking
          // is O(n^2) and measured at 88-97% of a bulk restore's runtime
          // (8000 notes: 3.6s of inserts vs 34.9s of linking). Landing the
          // notes in seconds and rebuilding the graph afterwards with
          // `onememory rebuild-edges` beats blocking the restore for minutes
          // on an optional ranking aid. Below the threshold, link inline so
          // the common small import behaves exactly as before.
          const deferEdges = notes.length > IMPORT_EDGE_DEFER_THRESHOLD;
          // dedupe (body flag or ?dedupe=1): skip notes already present with
          // the same namespace/title/created_at/body, so re-running a restore
          // is idempotent. Off by default (unchanged behaviour).
          const dedupe =
            parsed.dedupe === true || ["1", "true"].includes((url.searchParams.get("dedupe") ?? "").toLowerCase());
          // require_attestation (body flag or ?require_attestation=1): reject notes without an attestation that verifies.
          const requireAttestation =
            (parsed as { require_attestation?: unknown }).require_attestation === true ||
            ["1", "true"].includes((url.searchParams.get("require_attestation") ?? "").toLowerCase());
          const created = await store.importNotes(notes, { report, deferEdges, dedupe, ...(requireAttestation ? { requireAttestation: true } : {}) });
          // Best-effort: index the restored notes for semantic/hybrid search
          // (no-op when embeddings are off). Without this, re-imported notes
          // would be invisible to semantic search until a manual `reindex`.
          for (const note of created) await maybeEmbed(store, note);
          // `imported` keeps its 1.0 meaning; the linter's outcomes are
          // additive fields, present only when non-empty.
          sendJson(res, 200, {
            imported: created.length,
            ...(deferEdges
              ? {
                  similarityGraph: "deferred",
                  note: `similarity graph not rebuilt for ${created.length} notes; run \`onememory rebuild-edges\` to restore neighbor ranking (search is unaffected)`,
                }
              : {}),
            ...(report.skipped ? { skipped: report.skipped } : {}),
            ...(attestationsToShow(report.attestations) ? { attestations: report.attestations } : {}),
            ...(report.quarantined.length ? { quarantined: report.quarantined } : {}),
            ...(report.rejected.length ? { rejected: report.rejected } : {}),
          });
        } catch (e) {
          sendError(res, e);
        }
        return;
      }

      // --- Trust policy (admin scope; see docs/trust.md) ---
      // GET    /trust                      identity, distrusted writers, trusted attesters, recent log
      // POST   /trust/distrust             { namespace, writer }   distrust a writer label or writer_id
      // DELETE /trust/distrust             ?namespace=&writer=     (or the same JSON body)
      // POST   /trust/attesters            { public_key, server_id?, label? }
      // DELETE /trust/attesters/:key_id
      // POST   /trust/revoked              { key_id, reason? }     stop believing anything a key signed (a leaked key)
      // DELETE /trust/revoked/:key_id
      // A token pinned to a namespace can only manage that namespace's rules (never "*"),
      // and cannot change the server-wide attester list.
      if (path === "/trust" || path.startsWith("/trust/")) {
        try {
          const pinned = nsCtx.active;
          const body = async (): Promise<Record<string, unknown> | null> => {
            const raw = await readBody(req);
            try {
              const v = JSON.parse(raw || "{}");
              if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
            } catch {
              /* fall through */
            }
            sendJson(res, 400, { error: "invalid JSON body (expected an object)" });
            return null;
          };
          const ruleScope = (ns: unknown): string | null => {
            const v = typeof ns === "string" ? ns.trim() : "";
            if (pinned) {
              if (v && v !== nsCtx.ownNamespace) {
                sendJson(res, 403, { error: "this token is pinned to its own namespace" });
                return null;
              }
              return nsCtx.ownNamespace;
            }
            return v;
          };
          if (req.method === "GET" && path === "/trust") {
            // Read-only: the key is reported only if one already exists (a listing never creates it).
            const view = store.trustView(pinned ? nsCtx.ownNamespace : undefined);
            sendJson(res, 200, { ...store.peekIdentity(), distrust: view.distrust, attesters: view.attesters, revoked: view.revoked, log: view.log });
            return;
          }
          if (path === "/trust/distrust" && (req.method === "POST" || req.method === "DELETE")) {
            const b = req.method === "POST" ? await body() : ((await body()) ?? null);
            if (!b) return;
            const ns = ruleScope(url.searchParams.get("namespace") ?? b.namespace);
            if (ns === null) return;
            const writer = url.searchParams.get("writer") ?? b.writer;
            if (req.method === "POST") {
              const added = store.distrustAdd(ns, writer as string);
              sendJson(res, 200, { distrust: added, matched_notes: store.distrustMatchCount(added.namespace, added.writer), rules: store.trustView(pinned ? nsCtx.ownNamespace : undefined).distrust });
            } else {
              const removed = store.distrustRemove(ns, writer as string);
              sendJson(res, 200, { removed, rules: store.trustView(pinned ? nsCtx.ownNamespace : undefined).distrust });
            }
            return;
          }
          if (path === "/trust/attesters" && req.method === "POST") {
            if (pinned) {
              sendJson(res, 403, { error: "the attester list is server-wide: use an admin token that is not pinned to a namespace" });
              return;
            }
            const b = await body();
            if (!b) return;
            const added = store.attesterAdd({
              public_key: b.public_key as string,
              server_id: typeof b.server_id === "string" ? b.server_id : undefined,
              label: typeof b.label === "string" ? b.label : undefined,
              any_server: b.any_server === true,
              not_after: typeof b.not_after === "string" ? b.not_after : undefined,
            });
            sendJson(res, 200, { attester: added, attesters: store.attesterList() });
            return;
          }
          const attDel = /^\/trust\/attesters\/([0-9a-fA-F]{16})$/.exec(path);
          if (attDel && req.method === "DELETE") {
            if (pinned) {
              sendJson(res, 403, { error: "the attester list is server-wide: use an admin token that is not pinned to a namespace" });
              return;
            }
            sendJson(res, 200, { removed: store.attesterRemove(attDel[1]), attesters: store.attesterList() });
            return;
          }
          if (path === "/trust/revoked" && req.method === "POST") {
            if (pinned) {
              sendJson(res, 403, { error: "the revocation list is server-wide: use an admin token that is not pinned to a namespace" });
              return;
            }
            const b = await body();
            if (!b) return;
            const r = store.attesterRevoke(typeof b.key_id === "string" ? b.key_id : "", typeof b.reason === "string" ? b.reason : "");
            sendJson(res, 200, { revoked: r, revocations: store.revocationList() });
            return;
          }
          const revDel = /^\/trust\/revoked\/([0-9a-fA-F]{16})$/.exec(path);
          if (revDel && req.method === "DELETE") {
            if (pinned) {
              sendJson(res, 403, { error: "the revocation list is server-wide: use an admin token that is not pinned to a namespace" });
              return;
            }
            sendJson(res, 200, { removed: store.attesterUnrevoke(revDel[1]), revocations: store.revocationList() });
            return;
          }
          sendJson(res, 404, { error: "no such route" });
        } catch (e) {
          sendError(res, e);
        }
        return;
      }

      sendJson(res, 404, { error: "no such route" });
    } catch (e) {
      // A body over the 1MB cap is a client problem -> 413, not a generic 500.
      if (e instanceof PayloadTooLargeError) {
        sendJson(res, 413, { error: "payload too large" });
        return;
      }
      // A body that cannot be decrypted names the note (clear, actionable,
      // contains no content) instead of a bare "internal error".
      if (e instanceof NoteUnreadableError) {
        console.error("[onememory] " + e.message);
        sendJson(res, 500, { error: e.message, id: e.noteId });
        return;
      }
      // Log details server-side; never leak internals (SQL errors, paths) out.
      console.error("[onememory] request error:", (e as Error).message);
      sendJson(res, 500, { error: "internal error" });
    }
  };
  // Every request gets its own actor holder; the label is filled in once the
  // token is authenticated, so change_log records who actually wrote.
  return createServer((req, res) => {
    void actorStore.run({ label: "" }, () => handle(req, res));
  });
}
