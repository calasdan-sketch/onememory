// The OneMemory side of the benchmark. Everything goes through the product's public surface: the REST API over real
// HTTP on the loopback interface (tokens, scopes, namespaces, trust policy, export/import), and, for the one thing REST
// does not offer (merging duplicates), the MCP tool `memory_consolidate` over an in-memory MCP connection.
// Nothing here reads or writes the SQLite file directly.
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Store } from "../store.js";
import { createApiServer } from "../api.js";
import { createMcpServer } from "../mcp-server-core.js";
import type { TokenEntry } from "../config.js";
import type { BenchNote, Capability, MemoryAdapter, OpResult, Outcome, ReplacementInput, SearchOpts, UpdateInput, WorldSpec, WriteInput } from "./types.js";

interface ServerHandle {
  name: string;
  store: Store;
  http: Server;
  base: string;
  tokens: TokenEntry[];
}

interface ActorHandle {
  name: string;
  server: string;
  token: string;
  scope: "read" | "write" | "admin";
  writer: string;
  namespace?: string;
}

const CAPS: Capability[] = ["read", "list", "restore", "retire", "trust", "export_import", "attestation", "merge", "recall", "changes", "tenants", "cas", "supersede", "history"];

function toOutcome(status: number): Outcome {
  if (status === 200 || status === 201) return "ok";
  if (status === 202) return "quarantined";
  if (status === 401 || status === 403) return "denied";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 400 || status === 410 || status === 413) return "invalid"; // 410: a one-time code that expired or was already used
  return "error";
}

type Raw = Record<string, unknown>;
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** One OneMemory note (REST JSON) in the benchmark's vocabulary. */
export function normalizeNote(raw: Raw): BenchNote {
  const n: BenchNote = {
    id: String(raw.id),
    title: str(raw.title) ?? "",
    body: str(raw.body) ?? "",
  };
  if (str(raw.namespace) !== undefined) n.namespace = str(raw.namespace);
  if (Array.isArray(raw.tags)) n.tags = (raw.tags as unknown[]).map(String);
  if (str(raw.source) !== undefined) n.source = str(raw.source);
  if (str(raw.written_by) !== undefined) n.writer = str(raw.written_by);
  if (str(raw.created_by) !== undefined) n.creator = str(raw.created_by);
  if (str(raw.created_at)) n.created_at = str(raw.created_at);
  if (str(raw.updated_at)) n.updated_at = str(raw.updated_at);
  if (str(raw.expires_at)) n.expires_at = str(raw.expires_at);
  if (typeof raw.stale === "boolean") n.stale = raw.stale;
  if (raw.distrusted === true) n.distrusted = true;
  if (raw.imported_unverified === true) n.imported_unverified = true;
  if (str(raw.imported_written_by)) n.claimed_writer = str(raw.imported_written_by);
  if (str(raw.attested_writer)) n.attested_writer = str(raw.attested_writer);
  if (Array.isArray(raw.merged_from_writers)) n.taint = (raw.merged_from_writers as unknown[]).map(String);
  if (typeof raw.confidence === "number") n.confidence = raw.confidence;
  if (raw.status === "superseded") n.status = "superseded";
  if (raw.superseded_by !== undefined && raw.superseded_by !== null) n.superseded_by = String(raw.superseded_by);
  if (typeof raw.rev === "number") n.rev = raw.rev;
  return n;
}

/** The monotonic "next millisecond": writes made one after another must carry different timestamps. */
async function nextTick(last: { t: number }): Promise<void> {
  while (Date.now() <= last.t) await new Promise((r) => setTimeout(r, 1));
  last.t = Date.now();
}

export class OneMemoryAdapter implements MemoryAdapter {
  readonly name = "onememory";
  readonly capabilities: ReadonlySet<Capability> = new Set(CAPS);

  private dir = "";
  private servers = new Map<string, ServerHandle>();
  private actors = new Map<string, ActorHandle>();
  private grants: Record<string, string[]> = {};
  private clock = { t: 0 };
  private prevEnv: Record<string, string | undefined> = {};

  async open(world: WorldSpec): Promise<void> {
    await this.close();
    this.dir = mkdtempSync(join(tmpdir(), "onememory-bench-"));
    // Ctrl-C or a crash must not leave the throwaway folder behind (best effort: the exit handler can only do sync work).
    process.once("exit", this.onExit);
    this.grants = world.grants;
    // The per-token rate limit (120 requests / 10 s) is a protection for a public server, not something to measure.
    // The audit log goes into the throwaway folder: the benchmark's traffic must never reach the user's own audit.log.
    this.prevEnv = {
      ONEMEMORY_RATE_MAX: process.env.ONEMEMORY_RATE_MAX,
      ONEMEMORY_AUDIT_LOG: process.env.ONEMEMORY_AUDIT_LOG,
      ONEMEMORY_SUPERSEDE_TTL_SECONDS: process.env.ONEMEMORY_SUPERSEDE_TTL_SECONDS,
    };
    if (world.settings?.supersede_ttl_seconds !== undefined) process.env.ONEMEMORY_SUPERSEDE_TTL_SECONDS = String(world.settings.supersede_ttl_seconds);
    process.env.ONEMEMORY_RATE_MAX = "1000000";
    process.env.ONEMEMORY_AUDIT_LOG = join(this.dir, "audit.log");
    const byServer = new Map<string, TokenEntry[]>();
    for (const [name, a] of Object.entries(world.actors)) {
      const token = `bench-${name}-${randomBytes(16).toString("hex")}`;
      const entry: TokenEntry = { token, scope: a.scope, label: a.writer, ...(a.namespace ? { namespace: a.namespace } : {}) };
      this.actors.set(name, { name, server: a.server, token, scope: a.scope, writer: a.writer, namespace: a.namespace });
      const list = byServer.get(a.server) ?? [];
      list.push(entry);
      byServer.set(a.server, list);
    }
    for (const [name, tokens] of byServer) {
      // One folder per server: the signing key lives beside the database, and two servers must not share one.
      const folder = join(this.dir, name);
      mkdirSync(folder, { recursive: true });
      const store = new Store(join(folder, "state.db"));
      const http = createApiServer(store, tokens, this.serverOpts());
      await new Promise<void>((resolve, reject) => {
        http.once("error", reject);
        http.listen(0, "127.0.0.1", () => resolve());
      });
      const port = (http.address() as AddressInfo).port;
      this.servers.set(name, { name, store, http, base: `http://127.0.0.1:${port}`, tokens });
    }
  }

  private onExit = (): void => {
    if (!this.dir) return;
    try {
      rmSync(this.dir, { recursive: true, force: true });
    } catch {
      /* nothing more can be done at exit */
    }
  };

  async close(): Promise<void> {
    process.removeListener("exit", this.onExit);
    for (const s of this.servers.values()) {
      await new Promise<void>((resolve) => {
        s.http.closeAllConnections();
        s.http.close(() => resolve());
      });
      try {
        s.store.close(); // before the directory goes: Windows will not delete an open database file
      } catch {
        /* already closed */
      }
    }
    this.servers.clear();
    this.actors.clear();
    if (this.dir) {
      try {
        rmSync(this.dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
      } catch {
        /* a leftover temp directory is not a benchmark result */
      }
      this.dir = "";
    }
    for (const [k, v] of Object.entries(this.prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    this.prevEnv = {};
  }

  // ---- plumbing ----------------------------------------------------------------------------------------------

  /**
   * Read grants are server configuration, and the server only applies them when it has a namespace of its own (the
   * one it resolves from its working directory). Tokens pinned to a tenant ignore that namespace; tokens with no pin
   * fall back to it. Without grants the server has no namespace at all (the open, single-tenant behaviour).
   */
  private serverOpts(): { namespace?: string; readsFrom?: Record<string, string[]> } {
    return Object.keys(this.grants).length ? { namespace: "default", readsFrom: this.grants } : {};
  }

  private actor(name: string): ActorHandle {
    const a = this.actors.get(name);
    if (!a) throw new Error(`scenario error: unknown actor "${name}"`);
    return a;
  }

  private srv(actor: ActorHandle): ServerHandle {
    const s = this.servers.get(actor.server);
    if (!s) throw new Error(`scenario error: no server "${actor.server}"`);
    return s;
  }

  private async http(actorName: string, method: string, path: string, body?: unknown): Promise<{ status: number; json: Raw; text: string }> {
    const a = this.actor(actorName);
    const s = this.srv(a);
    const res = await fetch(s.base + path, {
      method,
      headers: { authorization: `Bearer ${a.token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    let json: Raw = {};
    try {
      const v = JSON.parse(text) as unknown;
      if (v && typeof v === "object") json = v as Raw;
    } catch {
      /* not JSON */
    }
    return { status: res.status, json, text };
  }

  private fail(status: number, json: Raw): OpResult {
    const outcome = toOutcome(status);
    const q = json.quarantined as { reasons?: unknown } | undefined;
    return { outcome, detail: str(json.error) ?? (q ? "held for review" : `HTTP ${status}`) };
  }

  // ---- core ---------------------------------------------------------------------------------------------------

  async write(actor: string, input: WriteInput): Promise<OpResult> {
    await nextTick(this.clock);
    if (input.age_days !== undefined || input.expires_in_days !== undefined) return this.restoreWrite(actor, input);
    const body: Raw = { title: input.title, body: input.body };
    if (input.tags) body.tags = input.tags;
    if (input.source !== undefined) body.source = input.source;
    if (input.confidence !== undefined) body.confidence = input.confidence;
    if (input.forget_after !== undefined) body.forget_after = input.forget_after;
    if (input.namespace !== undefined) body.namespace = input.namespace;
    const r = await this.http(actor, "POST", "/notes", body);
    if (r.status !== 201) return this.fail(r.status, r.json);
    return { outcome: "ok", note: normalizeNote(r.json.note as Raw) };
  }

  /**
   * Place a note in the past (or with a deletion deadline already gone) through the admin restore path, /import,
   * which is the only public way to set timestamps. Limit: the note is stamped with the importing admin as its writer.
   */
  private async restoreWrite(actor: string, input: WriteInput): Promise<OpResult> {
    const a = this.actor(actor);
    const DAY = 86_400_000;
    const created = new Date(Date.now() - (input.age_days ?? 0) * DAY).toISOString();
    const note: Raw = { title: input.title, body: input.body, created_at: created, updated_at: created };
    if (input.tags) note.tags = input.tags;
    if (input.source !== undefined) note.source = input.source;
    if (input.expires_in_days !== undefined) note.expires_at = new Date(Date.now() + input.expires_in_days * DAY).toISOString();
    const r = await this.http(actor, "POST", "/import", { notes: [note] });
    if (r.status !== 200) return this.fail(r.status, r.json);
    // /import does not return ids: find the note by its (unique) title and creation time.
    const found = await this.findByTitle(actor, input.title, created, a.namespace);
    if (!found) return { outcome: "error", detail: "restored note not found afterwards" };
    return { outcome: "ok", note: found };
  }

  private async findByTitle(actor: string, title: string, createdAt: string, namespace?: string): Promise<BenchNote | undefined> {
    for (let offset = 0; offset < 2000; offset += 100) {
      const ns = namespace ? `&namespace=${encodeURIComponent(namespace)}` : "";
      const r = await this.http(actor, "GET", `/notes?limit=100&offset=${offset}&includeArchived=1${ns}`);
      const notes = (r.json.notes as Raw[] | undefined) ?? [];
      const hit = notes.find((n) => n.title === title && n.created_at === createdAt);
      if (hit) return normalizeNote(hit);
      if (notes.length < 100) return undefined;
    }
    return undefined;
  }

  async update(actor: string, id: string, patch: UpdateInput): Promise<OpResult> {
    await nextTick(this.clock);
    const r = await this.http(actor, "PUT", `/notes/${encodeURIComponent(id)}`, patch);
    if (r.status !== 200) return this.fail(r.status, r.json);
    return { outcome: "ok", note: normalizeNote(r.json.note as Raw) };
  }

  async delete(actor: string, id: string): Promise<OpResult> {
    const r = await this.http(actor, "DELETE", `/notes/${encodeURIComponent(id)}`);
    return r.status === 200 ? { outcome: "ok" } : this.fail(r.status, r.json);
  }

  async search(actor: string, query: string, opts: SearchOpts = {}): Promise<OpResult> {
    const p = new URLSearchParams({ q: query });
    if (opts.limit) p.set("limit", String(opts.limit));
    if (opts.include_distrusted) p.set("include_distrusted", "1");
    if (opts.namespace) p.set("namespace", opts.namespace);
    if (opts.include_superseded) p.set("include_superseded", "1");
    const r = await this.http(actor, "GET", `/search?${p.toString()}`);
    if (r.status !== 200) return this.fail(r.status, r.json);
    const hits = ((r.json.results as Raw[] | undefined) ?? []).map(normalizeNote);
    return { outcome: "ok", hits, text: JSON.stringify(r.json.results ?? []) };
  }

  // ---- optional -----------------------------------------------------------------------------------------------

  async read(actor: string, id: string, opts: { include_distrusted?: boolean } = {}): Promise<OpResult> {
    const r = await this.http(actor, "GET", `/notes/${encodeURIComponent(id)}${opts.include_distrusted ? "?include_distrusted=1" : ""}`);
    if (r.status !== 200) return this.fail(r.status, r.json);
    return { outcome: "ok", note: normalizeNote(r.json.note as Raw), text: r.text };
  }

  async list(actor: string, opts: { namespace?: string; include_archived?: boolean; include_superseded?: boolean } = {}): Promise<OpResult> {
    const p = new URLSearchParams({ limit: "200" });
    if (opts.include_superseded) p.set("include_superseded", "1");
    if (opts.namespace) p.set("namespace", opts.namespace);
    if (opts.include_archived) p.set("includeArchived", "1");
    const r = await this.http(actor, "GET", `/notes?${p.toString()}`);
    if (r.status !== 200) return this.fail(r.status, r.json);
    return { outcome: "ok", notes: ((r.json.notes as Raw[] | undefined) ?? []).map(normalizeNote), text: r.text };
  }

  async recall(actor: string, message: string): Promise<OpResult> {
    const r = await this.http(actor, "POST", "/relevant", { message });
    if (r.status !== 200) return this.fail(r.status, r.json);
    // `text` is the results only: the response also echoes the caller's own message back as keywords.
    return { outcome: "ok", hits: ((r.json.results as Raw[] | undefined) ?? []).map(normalizeNote), text: JSON.stringify(r.json.results ?? []) };
  }

  async changes(actor: string): Promise<OpResult> {
    const r = await this.http(actor, "GET", "/changes?since=2000-01-01T00:00:00Z&limit=500");
    if (r.status !== 200) return this.fail(r.status, r.json);
    const list = ((r.json.changes as Raw[] | undefined) ?? []).map((c) => ({
      id: String(c.id),
      title: str(c.title) ?? "",
      body: "",
      namespace: str(c.namespace),
      writer: str(c.note_written_by),
    }));
    return { outcome: "ok", notes: list, text: r.text };
  }

  async archive(actor: string, id: string): Promise<OpResult> {
    const r = await this.http(actor, "POST", `/notes/${encodeURIComponent(id)}/archive`);
    return r.status === 200 ? { outcome: "ok" } : this.fail(r.status, r.json);
  }

  async unarchive(actor: string, id: string): Promise<OpResult> {
    const r = await this.http(actor, "POST", `/notes/${encodeURIComponent(id)}/restore`);
    return r.status === 200 ? { outcome: "ok" } : this.fail(r.status, r.json);
  }

  async sweep(actor: string): Promise<OpResult> {
    const r = await this.http(actor, "POST", "/sweep-expired");
    return r.status === 200 ? { outcome: "ok", data: { archived: r.json.archived } } : this.fail(r.status, r.json);
  }

  private ruleNamespace(actor: string, namespace?: string): string {
    return namespace ?? this.actor(actor).namespace ?? "default";
  }

  async distrust(actor: string, writer: string, namespace?: string): Promise<OpResult> {
    const r = await this.http(actor, "POST", "/trust/distrust", { namespace: this.ruleNamespace(actor, namespace), writer });
    return r.status === 200 ? { outcome: "ok", data: { matched_notes: r.json.matched_notes } } : this.fail(r.status, r.json);
  }

  async undistrust(actor: string, writer: string, namespace?: string): Promise<OpResult> {
    const p = new URLSearchParams({ namespace: this.ruleNamespace(actor, namespace), writer });
    const r = await this.http(actor, "DELETE", `/trust/distrust?${p.toString()}`);
    return r.status === 200 ? { outcome: "ok" } : this.fail(r.status, r.json);
  }

  async exportAll(actor: string, opts: { attest?: boolean } = {}): Promise<OpResult> {
    const r = await this.http(actor, "GET", `/export${opts.attest ? "?attest=1" : ""}`);
    if (r.status !== 200) return this.fail(r.status, r.json);
    const notes = ((r.json.notes as Raw[] | undefined) ?? []).map(normalizeNote);
    return { outcome: "ok", notes, text: r.text, data: { payload: r.json } };
  }

  async importAll(actor: string, payload: unknown, opts: { require_attestation?: boolean } = {}): Promise<OpResult> {
    const body = { ...(payload as Raw), ...(opts.require_attestation ? { require_attestation: true } : {}) };
    const r = await this.http(actor, "POST", "/import", body);
    if (r.status !== 200) return this.fail(r.status, r.json);
    const rejected = Array.isArray(r.json.rejected) ? (r.json.rejected as unknown[]).length : 0;
    const att = (r.json.attestations as { verified?: number; unverified?: number } | undefined) ?? {};
    return {
      outcome: "ok",
      data: { imported: r.json.imported, rejected, attested_verified: att.verified ?? 0, attested_unverified: att.unverified ?? 0 },
    };
  }

  async trustServer(actor: string, ofServer: string): Promise<OpResult> {
    const admin = [...this.actors.values()].find((a) => a.server === ofServer && a.scope === "admin" && !a.namespace);
    if (!admin) return { outcome: "invalid", detail: `scenario error: server "${ofServer}" has no unpinned admin actor` };
    const id = await this.http(admin.name, "GET", "/trust");
    if (id.status !== 200 || typeof id.json.public_key !== "string") return { outcome: "invalid", detail: "that server has no signing key yet (export with attest first)" };
    const r = await this.http(actor, "POST", "/trust/attesters", { public_key: id.json.public_key, server_id: id.json.server_id, label: `bench:${ofServer}` });
    return r.status === 200 ? { outcome: "ok" } : this.fail(r.status, r.json);
  }

  // ---- replacing a memory (1.6.0) and history -------------------------------------------------------------

  async supersedePreview(actor: string, input: { old_ids: string[]; new_note?: ReplacementInput; new_id?: string }): Promise<OpResult> {
    const body: Raw = { old_ids: input.old_ids.map(Number) };
    if (input.new_note) body.new_note = input.new_note;
    if (input.new_id !== undefined) body.new_id = Number(input.new_id);
    const r = await this.http(actor, "POST", "/supersede/preview", body);
    if (r.status !== 200) return { ...this.fail(r.status, r.json), ...(str(r.json.warning) ? { text: str(r.json.warning) } : {}) };
    return {
      outcome: "ok",
      text: `${str(r.json.warning) ?? ""}\n${JSON.stringify(r.json.notes_to_retire ?? [])}`,
      data: { token: r.json.token, count: r.json.count, requires_acknowledgement: r.json.requires_acknowledgement, expires_in_seconds: r.json.expires_in_seconds },
    };
  }

  async supersedeConfirm(actor: string, input: { token: string; new_note?: ReplacementInput; acknowledge_risk?: boolean }): Promise<OpResult> {
    await nextTick(this.clock);
    const r = await this.http(actor, "POST", "/supersede/confirm", input);
    if (r.status !== 200) return this.fail(r.status, r.json);
    const retired = (r.json.retired as Raw[] | undefined) ?? [];
    return { outcome: "ok", note: normalizeNote(r.json.replacement as Raw), data: { retired: retired.map((x) => String(x.id)) }, text: str(r.json.message) };
  }

  async supersedeUndo(actor: string, id: string): Promise<OpResult> {
    const r = await this.http(actor, "POST", "/supersede/undo", { id: Number(id) });
    if (r.status !== 200) return this.fail(r.status, r.json);
    return { outcome: "ok", note: normalizeNote(r.json.note as Raw) };
  }

  async history(actor: string, id: string, opts: { include_distrusted?: boolean } = {}): Promise<OpResult> {
    const r = await this.http(actor, "GET", `/notes/${encodeURIComponent(id)}/history${opts.include_distrusted ? "?include_distrusted=1" : ""}`);
    if (r.status !== 200) return this.fail(r.status, r.json);
    const versions = (r.json.versions as Raw[] | undefined) ?? [];
    return { outcome: "ok", text: r.text, data: { versions: versions.length, hidden: r.json.hidden_by_trust_policy } };
  }

  async restoreVersion(actor: string, id: string, version: number, opts: { if_rev?: number } = {}): Promise<OpResult> {
    await nextTick(this.clock);
    const r = await this.http(actor, "POST", `/notes/${encodeURIComponent(id)}/history/restore`, { version, ...(opts.if_rev !== undefined ? { if_rev: opts.if_rev } : {}) });
    if (r.status !== 200) return this.fail(r.status, r.json);
    return { outcome: "ok", note: normalizeNote(r.json.note as Raw) };
  }

  async merge(actor: string, ids: string[]): Promise<OpResult> {
    const a = this.actor(actor);
    const s = this.srv(a);
    const mcp = createMcpServer(
      s.store,
      a.scope,
      a.namespace ? { namespace: a.namespace, readsFrom: this.grants } : this.serverOpts(),
      { label: a.writer, authed: true }
    );
    const [c, srv] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "onememory-bench", version: "1.0.0" });
    try {
      await Promise.all([client.connect(c), mcp.connect(srv)]);
      const res = (await client.callTool({ name: "memory_consolidate", arguments: { ids: ids.map(Number) } })) as {
        isError?: boolean;
        content: Array<{ type: string; text?: string }>;
      };
      const text = res.content[0]?.text ?? ""; // the first block is the result; later blocks are provenance banners
      if (res.isError) {
        const msg = text.replace(/\s+/g, " ").trim();
        return { outcome: /needs|admin|scope/i.test(msg) ? "denied" : /no note/i.test(msg) ? "not_found" : "invalid", detail: msg.slice(0, 300) };
      }
      const start = text.indexOf("{");
      const parsed = JSON.parse(text.slice(start)) as { merged?: Raw; note?: Raw };
      const merged = parsed.merged ?? parsed.note;
      if (!merged) return { outcome: "error", detail: "merge returned no note" };
      return { outcome: "ok", note: normalizeNote(merged) };
    } finally {
      await client.close().catch(() => undefined);
      await mcp.close().catch(() => undefined);
    }
  }
}
