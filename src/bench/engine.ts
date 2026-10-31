// The benchmark engine: loads scenario files, runs each one against a fresh store through a MemoryAdapter, judges the
// checks, and totals the numbers. Deterministic by construction: no randomness except the seeded words that fill
// {{placeholders}}, no model, no network beyond the loopback interface.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  SUITES,
  type ActorSpec,
  type BenchNote,
  type Capability,
  type Check,
  type CheckResult,
  type MemoryAdapter,
  type OpResult,
  type Scenario,
  type ScenarioResult,
  type Suite,
  type WorldSpec,
} from "./types.js";

// ---------------------------------------------------------------------------------------------------------------
// Scenario loading and validation

export interface KnownGap {
  title: string;
  summary: string;
  status: "roadmap" | "fixed";
  /** Where the fix landed, for a gap marked fixed. */
  fixed_in?: string;
}

const STEP_OPS = new Set([
  "write", "update", "delete", "archive", "unarchive", "read", "search", "list", "recall", "changes", "sweep",
  "distrust", "undistrust", "export", "import", "trust_server", "merge", "wait",
  "supersede_preview", "supersede_confirm", "supersede_undo", "history", "restore_version",
  "capture", "session_start",
]);
const CHECKS = new Set([
  "outcome", "top", "has", "lacks", "fresh_answer", "hit_count", "field", "no_text", "contains_text", "same_response", "recoverable",
]);

type AnyStep = Record<string, unknown> & { op: string };

export function loadKnownGaps(dir: string): Record<string, KnownGap> {
  try {
    return JSON.parse(readFileSync(join(dir, "known-gaps.json"), "utf8")) as Record<string, KnownGap>;
  } catch {
    return {};
  }
}

/** Read every `*.json` scenario in `dir` (sorted by file name). Throws a message that names the file when one is invalid. */
export function loadScenarios(dir: string, gaps: Record<string, KnownGap> = {}): Scenario[] {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".json") && f !== "known-gaps.json")
    .sort();
  const out: Scenario[] = [];
  const seen = new Set<string>();
  for (const f of files) {
    let s: Scenario;
    try {
      s = JSON.parse(readFileSync(join(dir, f), "utf8")) as Scenario;
    } catch (e) {
      throw new Error(`${f}: not valid JSON (${(e as Error).message})`);
    }
    const bad = validateScenario(s, gaps);
    if (bad) throw new Error(`${f}: ${bad}`);
    if (seen.has(s.id)) throw new Error(`${f}: duplicate scenario id ${s.id}`);
    seen.add(s.id);
    out.push(s);
  }
  return out;
}

export function validateScenario(s: Scenario, gaps: Record<string, KnownGap> = {}): string | null {
  if (!s || typeof s !== "object") return "must be an object";
  if (typeof s.id !== "string" || !/^[A-Z][0-9]{2,3}$/.test(s.id)) return `id must look like A01 (got ${JSON.stringify(s.id)})`;
  if (!SUITES.includes(s.suite)) return `suite must be one of ${SUITES.join(", ")}`;
  if (typeof s.title !== "string" || !s.title.trim()) return "title is required";
  if (typeof s.what !== "string" || !s.what.trim()) return "what (the plain-language purpose) is required";
  if (!s.actors || typeof s.actors !== "object" || Object.keys(s.actors).length === 0) return "actors is required";
  if (!Array.isArray(s.steps) || s.steps.length === 0) return "steps is required";
  if (!Array.isArray(s.expect) || s.expect.length === 0) return "expect is required";
  const actorNames = new Set(Object.keys(s.actors));
  const refs = new Set<string>();
  const stepIds = new Set<string>();
  const previewIds = new Set<string>();
  for (const [i, raw] of (s.steps as unknown as AnyStep[]).entries()) {
    if (!raw || typeof raw.op !== "string" || !STEP_OPS.has(raw.op)) return `step ${i + 1}: unknown op ${JSON.stringify(raw?.op)}`;
    if (raw.op !== "wait" && (typeof raw.as !== "string" || !actorNames.has(raw.as))) return `step ${i + 1} (${raw.op}): "as" must name one of the actors`;
    if ((raw.op === "write" || raw.op === "merge") && typeof raw.ref !== "string") return `step ${i + 1} (${raw.op}): ref is required`;
    if (raw.op === "write") refs.add(raw.ref as string);
    if (raw.op === "merge") refs.add(raw.ref as string);
    if (["supersede_preview", "supersede_confirm", "history"].includes(raw.op) && typeof raw.id !== "string") return `step ${i + 1} (${raw.op}): id is required`;
    if (raw.op === "supersede_preview") {
      const olds = raw.old as unknown;
      if (!Array.isArray(olds) || olds.length === 0 || olds.some((r) => typeof r !== "string" || !refs.has(r))) return `step ${i + 1} (supersede_preview): old must name earlier writes`;
      if ((raw.new_note === undefined) === (raw.new_ref === undefined)) return `step ${i + 1} (supersede_preview): give exactly one of new_note or new_ref`;
      if (raw.new_ref !== undefined && !refs.has(raw.new_ref as string)) return `step ${i + 1} (supersede_preview): new_ref was not created by an earlier write`;
    }
    if (raw.op === "supersede_confirm") {
      if (!previewIds.has(raw.from as string)) return `step ${i + 1} (supersede_confirm): "from" must be the id of an earlier supersede_preview step`;
      if (typeof raw.ref === "string") refs.add(raw.ref);
    }
    if (raw.op === "restore_version" && (typeof raw.version !== "number" || typeof raw.id !== "string")) return `step ${i + 1} (restore_version): version (a number) and id are required`;
    if (raw.op === "supersede_preview" && typeof raw.id === "string") previewIds.add(raw.id);
    if (["update", "delete", "archive", "unarchive", "read", "supersede_undo", "history", "restore_version"].includes(raw.op)) {
      if (typeof raw.ref !== "string" || !refs.has(raw.ref)) return `step ${i + 1} (${raw.op}): ref "${String(raw.ref)}" was not created by an earlier write`;
    }
    if (raw.op === "merge") {
      const rs = raw.refs as unknown;
      if (!Array.isArray(rs) || rs.some((r) => typeof r !== "string" || !refs.has(r))) return `step ${i + 1} (merge): refs must name earlier writes`;
    }
    if (raw.op === "import" && !stepIds.has(raw.from as string)) return `step ${i + 1} (import): "from" must be the id of an earlier export step`;
    if (raw.op === "restore_version" && raw.if_rev_of !== undefined && !stepIds.has(raw.if_rev_of as string)) return `step ${i + 1} (restore_version): if_rev_of must be the id of an earlier read step`;
    if (raw.op === "update" && raw.if_rev_of !== undefined && !stepIds.has(raw.if_rev_of as string)) return `step ${i + 1} (update): if_rev_of must be the id of an earlier read step`;
    const needsId = ["search", "list", "recall", "changes", "sweep", "export", "import", "capture", "session_start"].includes(raw.op);
    if (needsId && typeof raw.id !== "string") return `step ${i + 1} (${raw.op}): id is required`;
    const id = defaultStepId(raw);
    if (id) stepIds.add(id);
    if (typeof raw.id === "string" && raw.id !== id) stepIds.add(raw.id);
  }
  for (const [i, c] of (s.expect as Check[]).entries()) {
    if (!c || !CHECKS.has(c.check)) return `check ${i + 1}: unknown check ${JSON.stringify(c?.check)}`;
    if (typeof c.desc !== "string" || !c.desc.trim()) return `check ${i + 1}: desc is required`;
    for (const sid of [c.step, ...(c.steps ?? [])]) if (sid !== undefined && !stepIds.has(sid)) return `check ${i + 1}: step "${sid}" does not exist`;
    if (c.check !== "same_response" && c.step === undefined && !(c.check === "contains_text" && c.steps?.length)) return `check ${i + 1} (${c.check}): step is required`;
    for (const r of [c.ref, c.of, c.current, c.same_as?.of, c.differs_from?.of, ...(c.stale ?? [])]) if (r !== undefined && !refs.has(r)) return `check ${i + 1}: ref "${r}" was not created by a write`;
    for (const o of [c.same_as, c.differs_from]) if (o && !stepIds.has(o.step)) return `check ${i + 1}: step "${o.step}" does not exist`;
  }
  if (s.known_gap !== undefined && Object.keys(gaps).length > 0 && !Object.hasOwn(gaps, s.known_gap)) return `known_gap ${s.known_gap} is not listed in known-gaps.json`;
  if (s.distractors !== undefined && (!Number.isInteger(s.distractors) || s.distractors < 0 || s.distractors > 500)) return "distractors must be a whole number from 0 to 500";
  return null;
}

function defaultStepId(step: AnyStep): string | undefined {
  if (typeof step.id === "string") return step.id;
  if (typeof step.ref === "string" && ["write", "update", "delete", "archive", "unarchive", "read", "merge", "supersede_undo"].includes(step.op)) return `${step.op}:${step.ref}`;
  if (["distrust", "undistrust", "trust_server"].includes(step.op)) return `${step.op}:${String(step.writer ?? step.of)}`;
  return undefined;
}

// ---------------------------------------------------------------------------------------------------------------
// Seeded words

const SYL_C = "bdfgklmnprstvz";
const SYL_V = "aeiou";

/** A pronounceable made-up word that depends only on (seed, scenario id, placeholder name). */
export function seededWord(seed: number, scenarioId: string, name: string): string {
  const h = createHash("sha256").update(`${seed}:${scenarioId}:${name}`).digest();
  let w = "";
  for (let i = 0; i < 4; i++) w += SYL_C[h[i * 2] % SYL_C.length] + SYL_V[h[i * 2 + 1] % SYL_V.length];
  return w + String(h[8] % 90 + 10);
}

function fill<T>(value: T, seed: number, id: string): T {
  if (typeof value === "string") return value.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (_m, n: string) => seededWord(seed, id, n)) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => fill(v, seed, id)) as unknown as T;
  if (value && typeof value === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) o[k] = fill(v, seed, id);
    return o as T;
  }
  return value;
}

// ---------------------------------------------------------------------------------------------------------------
// Running one scenario

export interface RunOptions {
  seed: number;
}

function neededCapabilities(s: Scenario): Capability[] {
  const need = new Set<Capability>(s.needs ?? []);
  for (const a of Object.values(s.actors)) if (a.namespace) need.add("tenants");
  for (const raw of s.steps as unknown as AnyStep[]) {
    if (raw.op === "write" && (raw.age_days !== undefined || raw.expires_in_days !== undefined)) need.add("restore");
    if (raw.op === "read") need.add("read");
    if (raw.op === "list") need.add("list");
    if (raw.op === "recall") need.add("recall");
    if (raw.op === "changes") need.add("changes");
    if (["archive", "unarchive", "sweep"].includes(raw.op)) need.add("retire");
    if (raw.op === "distrust" || raw.op === "undistrust") need.add("trust");
    if (raw.op === "export" || raw.op === "import") need.add("export_import");
    if ((raw.op === "export" && raw.attest) || raw.op === "trust_server") need.add("attestation");
    if (raw.op === "merge") need.add("merge");
    if (raw.op === "update" && raw.if_rev_of !== undefined) need.add("cas");
    if (raw.op.startsWith("supersede_")) need.add("supersede");
    if (raw.op === "history" || raw.op === "restore_version") need.add("history");
    if (raw.op === "capture") need.add("capture");
    if (raw.op === "session_start") need.add("session_start");
  }
  return [...need];
}

function worldFor(s: Scenario): WorldSpec {
  const actors: WorldSpec["actors"] = {};
  for (const [name, a] of Object.entries(s.actors) as Array<[string, ActorSpec]>) {
    actors[name] = {
      scope: a.scope ?? "write",
      writer: a.writer ?? name,
      server: a.server ?? "main",
      ...(a.namespace ? { namespace: a.namespace } : {}),
    };
  }
  return { actors, grants: s.grants ?? {}, ...(s.settings ? { settings: s.settings } : {}) };
}

const asList = (r: OpResult | undefined): BenchNote[] => (r ? (r.hits ?? r.notes ?? (r.note ? [r.note] : [])) : []);
const show = (v: unknown): string => (typeof v === "string" ? JSON.stringify(v) : v === undefined ? "(absent)" : JSON.stringify(v));
const oneOf = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : v === undefined ? [] : [String(v)]);

class Run {
  refs = new Map<string, string>();
  results = new Map<string, OpResult>();
  exports = new Map<string, unknown>();
  /** One-time codes from preview steps, by step id. */
  codes = new Map<string, string>();
  /** The new text each preview was shown for (a confirm that names none sends the same text). */
  previewed = new Map<string, unknown>();
  constructor(private readonly scenario: Scenario) {}

  idOf(ref: string): string {
    const id = this.refs.get(ref);
    if (id === undefined) throw new Error(`scenario error: ref "${ref}" has no note (its write did not succeed)`);
    return id;
  }
  refOfId(id: string): string | undefined {
    for (const [r, v] of this.refs) if (v === id) return r;
    return undefined;
  }
  result(step: string): OpResult {
    const r = this.results.get(step);
    if (!r) throw new Error(`scenario error: step "${step}" did not run`);
    return r;
  }
  pick(c: Check, r: OpResult): BenchNote | undefined {
    const list = asList(r);
    if (c.title !== undefined) return list.find((n) => n.title === c.title);
    if (c.of !== undefined) {
      const id = this.refs.get(c.of);
      return id === undefined ? undefined : list.find((n) => n.id === id);
    }
    return list[0];
  }
  get id(): string {
    return this.scenario.id;
  }
}

async function execStep(a: MemoryAdapter, run: Run, step: AnyStep): Promise<void> {
  const as = step.as as string;
  const sid = defaultStepId(step);
  const keep = (r: OpResult): void => {
    if (sid) run.results.set(sid, r);
    if (typeof step.id === "string") run.results.set(step.id, r);
  };
  switch (step.op) {
    case "write": {
      const r = await a.write(as, {
        title: step.title as string,
        body: (step.body as string) ?? "",
        tags: step.tags as string[] | undefined,
        source: step.source as string | undefined,
        age_days: step.age_days as number | undefined,
        expires_in_days: step.expires_in_days as number | undefined,
        confidence: step.confidence as number | undefined,
        forget_after: step.forget_after as number | undefined,
        namespace: step.namespace as string | undefined,
      });
      if (r.outcome === "ok" && r.note) run.refs.set(step.ref as string, r.note.id);
      keep(r);
      return;
    }
    case "update": {
      const patch: Record<string, unknown> = {};
      for (const k of ["title", "body", "tags", "source", "confidence"]) if (step[k] !== undefined) patch[k] = step[k];
      if (typeof step.if_rev_of === "string") {
        const rev = asList(run.result(step.if_rev_of))[0]?.rev;
        if (rev !== undefined) patch.if_rev = rev;
      }
      keep(await a.update(as, run.idOf(step.ref as string), patch));
      return;
    }
    case "delete":
      keep(await a.delete(as, run.idOf(step.ref as string)));
      return;
    case "archive":
    case "unarchive":
    case "read": {
      const fn = step.op === "archive" ? a.archive : step.op === "unarchive" ? a.unarchive : a.read;
      if (!fn) return keep({ outcome: "unsupported" });
      const id = run.idOf(step.ref as string);
      keep(step.op === "read" ? await a.read!(as, id, { include_distrusted: step.include_distrusted === true }) : await fn.call(a, as, id));
      return;
    }
    case "search":
      keep(await a.search(as, step.q as string, { limit: (step.limit as number | undefined) ?? 10, include_distrusted: step.include_distrusted === true, include_superseded: step.include_superseded === true, namespace: step.namespace as string | undefined }));
      return;
    case "list":
      keep(a.list ? await a.list(as, { namespace: step.namespace as string | undefined, include_archived: step.include_archived === true, include_superseded: step.include_superseded === true }) : { outcome: "unsupported" });
      return;
    case "supersede_preview": {
      if (!a.supersedePreview) return keep({ outcome: "unsupported" });
      const r = await a.supersedePreview(as, {
        old_ids: (step.old as string[]).map((x) => run.idOf(x)),
        ...(step.new_note ? { new_note: step.new_note as never } : {}),
        ...(typeof step.new_ref === "string" ? { new_id: run.idOf(step.new_ref) } : {}),
      });
      const code = r.data?.token;
      if (r.outcome === "ok" && typeof code === "string") run.codes.set(step.id as string, code);
      if (step.new_note) run.previewed.set(step.id as string, step.new_note);
      keep(r);
      return;
    }
    case "supersede_confirm": {
      if (!a.supersedeConfirm) return keep({ outcome: "unsupported" });
      let token = run.codes.get(step.from as string);
      if (token === undefined) throw new Error(`scenario error: preview "${String(step.from)}" gave no code`);
      if (step.corrupt_code === true) token = token.slice(0, -4) + (token.endsWith("AAAA") ? "BBBB" : "AAAA");
      const r = await a.supersedeConfirm(as, {
        token,
        ...(step.new_note || run.previewed.has(step.from as string) ? { new_note: (step.new_note ?? run.previewed.get(step.from as string)) as never } : {}),
        ...(step.acknowledge_risk === true ? { acknowledge_risk: true } : {}),
      });
      if (r.outcome === "ok" && r.note && typeof step.ref === "string") run.refs.set(step.ref, r.note.id);
      keep(r);
      return;
    }
    case "supersede_undo":
      keep(a.supersedeUndo ? await a.supersedeUndo(as, run.idOf(step.ref as string)) : { outcome: "unsupported" });
      return;
    case "history":
      keep(a.history ? await a.history(as, run.idOf(step.ref as string), { include_distrusted: step.include_distrusted === true }) : { outcome: "unsupported" });
      return;
    case "restore_version": {
      if (!a.restoreVersion) return keep({ outcome: "unsupported" });
      let ifRev: number | undefined;
      if (typeof step.if_rev_of === "string") ifRev = asList(run.result(step.if_rev_of))[0]?.rev;
      keep(await a.restoreVersion(as, run.idOf(step.ref as string), Number(step.version), ifRev !== undefined ? { if_rev: ifRev } : {}));
      return;
    }
    case "recall":
      keep(a.recall ? await a.recall(as, step.q as string) : { outcome: "unsupported" });
      return;
    case "changes":
      keep(a.changes ? await a.changes(as) : { outcome: "unsupported" });
      return;
    case "sweep":
      keep(a.sweep ? await a.sweep(as) : { outcome: "unsupported" });
      return;
    case "distrust":
    case "undistrust": {
      const fn = step.op === "distrust" ? a.distrust : a.undistrust;
      keep(fn ? await fn.call(a, as, step.writer as string, step.namespace as string | undefined) : { outcome: "unsupported" });
      return;
    }
    case "export": {
      const r = a.exportAll ? await a.exportAll(as, { attest: step.attest === true }) : ({ outcome: "unsupported" } as OpResult);
      if (r.outcome === "ok") run.exports.set(step.id as string, r.data?.payload);
      keep(r);
      return;
    }
    case "import": {
      if (!a.importAll) return keep({ outcome: "unsupported" });
      let payload = structuredClone(run.exports.get(step.from as string));
      const t = step.tamper as { index?: number; field: "body" | "title"; value: string } | undefined;
      if (t) {
        const notes = (payload as { notes: Array<Record<string, unknown>> }).notes;
        notes[t.index ?? 0][t.field] = t.value;
      }
      keep(await a.importAll(as, payload, { require_attestation: step.require_attestation === true }));
      return;
    }
    case "trust_server":
      keep(a.trustServer ? await a.trustServer(as, step.of as string) : { outcome: "unsupported" });
      return;
    case "merge": {
      const r = a.merge ? await a.merge(as, (step.refs as string[]).map((x) => run.idOf(x))) : ({ outcome: "unsupported" } as OpResult);
      if (r.outcome === "ok" && r.note) run.refs.set(step.ref as string, r.note.id);
      keep(r);
      return;
    }
    case "capture":
      keep(
        a.capture
          ? await a.capture(as, {
              event: step.event as string | undefined,
              tool: step.tool as string | undefined,
              input: step.input as string | undefined,
              output: step.output as string | undefined,
              session: step.session as string | undefined,
              namespace: step.namespace as string | undefined,
            })
          : { outcome: "unsupported" }
      );
      return;
    case "session_start":
      keep(a.sessionStart ? await a.sessionStart(as, { namespace: step.namespace as string | undefined }) : { outcome: "unsupported" });
      return;
    case "wait":
      await new Promise((r) => setTimeout(r, Math.min(Number(step.ms) || 0, 2000)));
      return;
  }
}

function getPath(n: BenchNote | undefined, path: string): unknown {
  if (!n) return undefined;
  return (n as unknown as Record<string, unknown>)[path];
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

function judge(run: Run, c: Check): CheckResult {
  const base = { desc: c.desc, check: c.check, ...(c.metric ? { metric: c.metric } : {}) };
  const mk = (pass: boolean, expected: string, actual: string, measure?: Record<string, boolean>): CheckResult => ({
    ...base,
    pass,
    expected,
    actual,
    ...(measure ? { measure } : {}),
  });
  const name = (id: string | undefined): string => (id === undefined ? "(nothing)" : (run.refOfId(id) ?? `a note not written by this scenario (#${id})`));
  switch (c.check) {
    case "outcome": {
      const r = run.result(c.step!);
      const want = oneOf(c.is);
      return mk(want.includes(r.outcome), want.join(" or "), r.detail && r.outcome !== "ok" ? `${r.outcome} (${r.detail})` : r.outcome);
    }
    case "top": {
      const r = run.result(c.step!);
      const hits = asList(r);
      if (r.outcome !== "ok") return mk(false, `first hit is ${c.ref}`, `the search was ${r.outcome}`);
      const want = run.idOf(c.ref!);
      return mk(hits[0]?.id === want, `first hit is ${c.ref}`, `first hit is ${name(hits[0]?.id)}`);
    }
    case "has":
    case "lacks": {
      const r = run.result(c.step!);
      const hits = asList(r);
      if (r.outcome !== "ok") return mk(false, `${c.ref} ${c.check === "has" ? "is" : "is not"} in the results`, `the operation was ${r.outcome}`);
      const id = run.refs.get(c.ref!);
      const idx = id === undefined ? -1 : hits.findIndex((h) => h.id === id);
      const within = c.within ?? hits.length;
      const found = idx >= 0 && idx < within;
      return c.check === "has"
        ? mk(found, `${c.ref} is in the results${c.within ? ` (top ${c.within})` : ""}`, found ? `found at rank ${idx + 1}` : "not found")
        : mk(!found, `${c.ref} is not in the results${c.within ? ` (top ${c.within})` : ""}`, found ? `found at rank ${idx + 1}` : "not found");
    }
    case "fresh_answer": {
      const r = run.result(c.step!);
      if (r.outcome !== "ok") return mk(false, "a search that works", `the search was ${r.outcome}`);
      const hits = asList(r);
      const cur = c.current !== undefined ? run.refs.get(c.current) : undefined;
      const staleIds = new Set((c.stale ?? []).map((s) => run.refs.get(s)).filter((x): x is string => x !== undefined));
      const oldTexts = c.stale_text ?? [];
      const isOld = (h: BenchNote): boolean => staleIds.has(h.id) || oldTexts.some((t) => `${h.title}\n${h.body}`.includes(t));
      const top5 = hits.slice(0, 5);
      const stale1 = hits[0] !== undefined && isOld(hits[0]);
      const stale5 = top5.some(isOld);
      const unflagged5 = top5.filter((h) => isOld(h) && h.stale !== true);
      const current1 = cur !== undefined && hits[0]?.id === cur;
      const pass = (c.current === undefined || current1) && unflagged5.length === 0;
      const want =
        (c.current !== undefined ? `current value (${c.current}) ranked first; ` : "") +
        `no old value in the top 5 unless it is flagged stale`;
      const flaggedNote = top5.some((h) => isOld(h) && h.stale === true) ? " (an old one is flagged stale)" : "";
      const got = `${hits.length ? `first is ${name(hits[0]?.id)}` : "no results"}; old values in top 5: ${top5.filter(isOld).map((h) => name(h.id)).join(", ") || "none"}${flaggedNote}`;
      // Only a query that names an old value can have a stale hit; the rates are over those queries.
      const measure: Record<string, boolean> = { has_old_value: staleIds.size > 0 || oldTexts.length > 0, stale_at_1: stale1, stale_at_5: stale5, unflagged_stale_at_5: unflagged5.length > 0 };
      if (c.current !== undefined) measure.current_at_1 = current1;
      return mk(pass, want, got, measure);
    }
    case "hit_count": {
      const r = run.result(c.step!);
      const n = asList(r).length;
      const ok = r.outcome === "ok" && (c.is === undefined || n === c.is) && (c.max === undefined || n <= c.max) && (c.min === undefined || n >= c.min);
      const want = c.is !== undefined ? `exactly ${c.is}` : [c.min !== undefined ? `at least ${c.min}` : "", c.max !== undefined ? `at most ${c.max}` : ""].filter(Boolean).join(" and ");
      return mk(ok, `${want} result(s)`, r.outcome === "ok" ? `${n} result(s)` : `the operation was ${r.outcome}`);
    }
    case "field": {
      const r = run.result(c.step!);
      const n = run.pick(c, r);
      const label = `${c.path}${c.of ? ` of ${c.of}` : ""}`;
      if (!n) return mk(false, `${label} can be read`, r.outcome === "ok" ? "the note was not in the result" : `the operation was ${r.outcome}`);
      const v = getPath(n, c.path!);
      // Timestamps come from the real clock; showing them would make the report differ from run to run.
      const showAt = (path: string, x: unknown): string => (path.endsWith("_at") && typeof x === "string" ? "<a timestamp>" : show(x));
      if (c.present !== undefined) {
        const has = v !== undefined && v !== "" && !(Array.isArray(v) && v.length === 0);
        return mk(has === c.present, `${label} ${c.present ? "is present" : "is absent"}`, has ? showAt(c.path!, v) : "(absent)");
      }
      if (c.equals !== undefined) return mk(same(v, c.equals), `${label} = ${show(c.equals)}`, showAt(c.path!, v));
      if (c.not_equals !== undefined) return mk(!same(v, c.not_equals), `${label} is not ${show(c.not_equals)}`, show(v));
      if (c.includes !== undefined) {
        const ok = Array.isArray(v) ? v.includes(c.includes) : typeof v === "string" && v.includes(String(c.includes));
        return mk(ok, `${label} includes ${show(c.includes)}`, show(v));
      }
      if (c.same_as) {
        const other = run.pick({ ...c, of: c.same_as.of, title: undefined } as Check, run.result(c.same_as.step));
        const ov = getPath(other, c.same_as.path);
        const ok = same(v, ov) && v !== undefined;
        return mk(ok, `${label} equals ${c.same_as.path} of ${c.same_as.of ?? c.same_as.step}`, ok ? "identical" : `${showAt(c.path!, v)} vs ${showAt(c.same_as.path, ov)}${c.path!.endsWith("_at") ? " (different)" : ""}`);
      }
      if (c.differs_from) {
        const other = run.pick({ ...c, of: c.differs_from.of, title: undefined } as Check, run.result(c.differs_from.step));
        const ov = getPath(other, c.differs_from.path);
        const ok = v !== undefined && !same(v, ov);
        return mk(ok, `${label} differs from ${c.differs_from.path} of ${c.differs_from.of ?? c.differs_from.step}`, ok ? "different" : `${showAt(c.path!, v)} (same or missing)`);
      }
      return mk(false, "a field comparison", "check has no comparison");
    }
    case "no_text": {
      const r = run.result(c.step!);
      const hay = JSON.stringify({ hits: r.hits, notes: r.notes, note: r.note, data: r.data, detail: r.detail }) + (r.text ?? "");
      const found = hay.includes(c.text!);
      return mk(!found, "the other tenant's secret does not appear", found ? "the secret appeared in the result" : "not present");
    }
    case "contains_text": {
      const found = (c.steps ?? [c.step!]).filter((sid) => {
        const r = run.result(sid);
        return (JSON.stringify({ hits: r.hits, notes: r.notes, note: r.note, data: r.data }) + (r.text ?? "")).includes(c.text!);
      });
      return mk(found.length > 0, `the text is available from ${(c.steps ?? [c.step!]).join(" or ")}`, found.length ? `found in ${found.join(", ")}` : "not found anywhere");
    }
    case "same_response": {
      const [a, b] = (c.steps ?? []).map((s) => run.result(s));
      if (!a || !b) return mk(false, "two steps", "missing steps");
      const ok = a.outcome === b.outcome && (a.detail ?? "") === (b.detail ?? "");
      return mk(ok, "both refused in exactly the same way", `${a.outcome} (${a.detail ?? ""}) vs ${b.outcome} (${b.detail ?? ""})`);
    }
    case "recoverable": {
      const r = run.result(c.step!);
      const n = run.pick(c, r);
      if (!n) return mk(false, `${c.value} can be found on the note`, `the note was not in the result (${r.outcome})`);
      const holds = (p: string): boolean => {
        const v = getPath(n, p);
        return Array.isArray(v) ? v.includes(c.value) : v === c.value;
      };
      const verified = (c.verified_in ?? []).find(holds);
      const claim = (c.claim_in ?? []).find(holds);
      const wantClaimOk = c.is === "claim";
      const state = verified ? `kept as a verified value (${verified})` : claim ? `kept only as an unverified claim (${claim})` : "lost: not found on the note";
      const pass = Boolean(verified) || (wantClaimOk && Boolean(claim));
      return mk(pass, wantClaimOk ? `${c.value} kept (verified, or at least as a labelled claim)` : `${c.value} kept as a verified value`, state, {
        lost: !verified && !claim,
        claim_only: !verified && Boolean(claim),
      });
    }
  }
}

export async function runScenario(adapter: MemoryAdapter, scenario: Scenario, gaps: Record<string, KnownGap>, opts: RunOptions): Promise<ScenarioResult> {
  const s = fill(scenario, opts.seed, scenario.id);
  const head = { id: s.id, suite: s.suite, title: s.title, what: s.what, ...(s.known_gap ? { known_gap: s.known_gap } : {}), ...(s.limit ? { limit: s.limit } : {}) };
  const missing = neededCapabilities(s).filter((c) => !adapter.capabilities.has(c));
  if (missing.length) {
    return { ...head, status: "skipped", skipped_reason: `adapter "${adapter.name}" lacks: ${missing.join(", ")}`, checks: [] };
  }
  const run = new Run(s);
  try {
    await adapter.open(worldFor(s));
    if (s.distractors) {
      const who = Object.keys(s.actors).find((n) => (s.actors[n].scope ?? "write") !== "read") as string;
      for (let i = 0; i < s.distractors; i++) {
        const r = await adapter.write(who, {
          title: `Unrelated note ${seededWord(opts.seed, s.id, `dt${i}`)}`,
          body: `Something else entirely: ${seededWord(opts.seed, s.id, `da${i}`)} and ${seededWord(opts.seed, s.id, `db${i}`)} for ${seededWord(opts.seed, s.id, `dc${i}`)}.`,
        });
        if (r.outcome !== "ok") throw new Error(`could not write distractor ${i + 1}: ${r.outcome} ${r.detail ?? ""}`);
      }
    }
    for (const step of s.steps as unknown as AnyStep[]) await execStep(adapter, run, step);
    const checks = s.expect.map((c) => judge(run, c));
    const allPass = checks.every((c) => c.pass);
    const status = s.known_gap ? (allPass ? "gap_closed" : "known_gap") : allPass ? "pass" : "fail";
    return { ...head, status, checks };
  } catch (e) {
    return { ...head, status: "fail", checks: [], error: (e as Error).message };
  } finally {
    await adapter.close().catch(() => undefined);
  }
}
