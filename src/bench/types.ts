// onememory bench: the small contract between the benchmark engine and the memory system under test.
//
// The engine knows nothing about OneMemory. It talks to a `MemoryAdapter` and judges what comes back. To measure
// another memory system, implement the four core operations (write, update, delete, search) and declare which optional
// ones you support; scenarios that need an operation your adapter lacks are reported as SKIPPED, never as passed.
// See docs/BENCHMARK.md.

/** Who is acting. `writer` is the identity the system should stamp on what this actor writes. */
export interface ActorSpec {
  /** "read" can search and read; "write" can also create and update; "admin" can also delete, import, export, manage trust. */
  scope?: "read" | "write" | "admin";
  /** The tenant this actor is confined to (the system's own word for it: namespace, workspace, project). */
  namespace?: string;
  /** The writer identity (a token label in OneMemory). Defaults to the actor's name. */
  writer?: string;
  /** Which server instance in the scenario this actor talks to. Default "main". Used to move notes between two servers. */
  server?: string;
}

/** What a scenario asks the adapter to set up before the first step. */
export interface WorldSpec {
  actors: Record<string, Required<Pick<ActorSpec, "scope" | "writer" | "server">> & { namespace?: string }>;
  /** Operator read grants: tenant -> tenants it may additionally read (OneMemory `reads_from`). */
  grants: Record<string, string[]>;
  /** Server settings a scenario needs (for example a very short confirmation window). Applied for this scenario only. */
  settings?: { supersede_ttl_seconds?: number };
}

/** The result of any operation, reduced to what the benchmark needs. */
export type Outcome =
  | "ok" //          done
  | "denied" //      refused because of who is asking (scope, tenant, distrust)
  | "not_found" //   the thing does not exist, or the caller may not know it exists
  | "conflict" //    refused because the caller's copy is out of date (compare-and-swap)
  | "invalid" //     refused because the request was malformed or rejected by a content rule
  | "quarantined" // accepted for review, not stored
  | "unsupported" // this adapter does not implement the operation
  | "error"; //      anything else (a server error, a network failure)

/** One note as the benchmark sees it. Optional fields are absent when the system does not have the concept. */
export interface BenchNote {
  id: string;
  namespace?: string;
  title: string;
  body: string;
  tags?: string[];
  /** What the client said wrote it (a claim). */
  source?: string;
  /** Who the SERVER says last changed the content. */
  writer?: string;
  /** Who the server says first wrote it. */
  creator?: string;
  created_at?: string;
  updated_at?: string;
  /** Deletion policy: when the note is due to be forgotten. */
  expires_at?: string;
  /** The system flagged this note as old / possibly out of date. */
  stale?: boolean;
  /** The system marked this note as coming from a writer an admin distrusts. */
  distrusted?: boolean;
  /** The note arrived by import without a verified signature. */
  imported_unverified?: boolean;
  /** A writer name the imported file CLAIMED (unverified). */
  claimed_writer?: string;
  /** A writer a verified signature vouched for. */
  attested_writer?: string;
  /** Every earlier hand the content passed through (the taint set). */
  taint?: string[];
  /** A confidence score, if the system has one. */
  confidence?: number;
  /** "superseded" when a confirmed replacement retired this note. */
  status?: string;
  /** The id of the note that replaced this one. */
  superseded_by?: string;
  rev?: number;
}

export interface OpResult {
  outcome: Outcome;
  /** A short, stable, secret-free description of why (used to prove two refusals look the same). */
  detail?: string;
  note?: BenchNote;
  notes?: BenchNote[];
  /** Search hits, best first. */
  hits?: BenchNote[];
  /** Free text the operation returned (for example a full export), used for leak scans. */
  text?: string;
  /** Anything else worth showing (counts). */
  data?: Record<string, unknown>;
}

export interface WriteInput {
  title: string;
  body: string;
  tags?: string[];
  source?: string;
  /** Arguments below need the optional `restore` capability: they place a note in the past. */
  age_days?: number;
  /** Days until the deletion deadline; negative = already passed. */
  expires_in_days?: number;
  /** Ask the system to keep a confidence value (a system without one will drop it). */
  confidence?: number;
  /** Deletion policy: forget the note after this many days. */
  forget_after?: number;
  /** A tenant the caller CLAIMS to be writing into. A system that confines the caller must ignore it. */
  namespace?: string;
}

export interface UpdateInput {
  title?: string;
  body?: string;
  tags?: string[];
  source?: string;
  /** A new confidence claim (0 to 1), or null to clear it. */
  confidence?: number | null;
  /** Compare-and-swap: refuse with `conflict` when the note is no longer at this revision. */
  if_rev?: number;
}

export interface SearchOpts {
  limit?: number;
  /** Admin-only: also show notes from writers the admin put on the distrust list. */
  include_distrusted?: boolean;
  /** A tenant hint; a system must ignore it when the caller may not read that tenant. */
  namespace?: string;
  /** Also show notes a replacement retired (they must be labelled). */
  include_superseded?: boolean;
}

/** Capabilities an adapter may declare. A scenario lists the ones it `needs`. */
export type Capability =
  | "read" //          read one note by id
  | "list" //          list notes
  | "restore" //       write with age_days / expires_in_days (place a note in the past)
  | "retire" //        archive / restore / sweep expired
  | "trust" //         distrust / undistrust writers
  | "export_import" // export a store and import it into another (or the same)
  | "attestation" //   signed export, trusting another server's key
  | "merge" //         merge duplicate notes
  | "recall" //        free-text "what is relevant to this message" lookup
  | "changes" //      change feed
  | "tenants" //      per-tenant isolation
  | "cas" //         compare-and-swap update
  | "supersede" //   two-step replace (preview, then confirm with a one-time code) and undo
  | "history"; //    earlier versions of a note, and restoring one

export interface MemoryAdapter {
  readonly name: string;
  readonly capabilities: ReadonlySet<Capability>;

  /** Start a FRESH store for one scenario and create the actors. Must not touch anything that already exists. */
  open(world: WorldSpec): Promise<void>;
  /** Stop the servers and delete everything `open` made. Must be safe to call twice. */
  close(): Promise<void>;

  // ---- the four core operations (every adapter has these) ----
  write(actor: string, input: WriteInput): Promise<OpResult>;
  update(actor: string, id: string, patch: UpdateInput): Promise<OpResult>;
  delete(actor: string, id: string): Promise<OpResult>;
  search(actor: string, query: string, opts?: SearchOpts): Promise<OpResult>;

  // ---- optional operations (declare the matching capability) ----
  read?(actor: string, id: string, opts?: { include_distrusted?: boolean }): Promise<OpResult>;
  list?(actor: string, opts?: { namespace?: string; include_archived?: boolean; include_superseded?: boolean }): Promise<OpResult>;
  recall?(actor: string, message: string): Promise<OpResult>;
  changes?(actor: string): Promise<OpResult>;
  archive?(actor: string, id: string): Promise<OpResult>;
  unarchive?(actor: string, id: string): Promise<OpResult>;
  sweep?(actor: string): Promise<OpResult>;
  distrust?(actor: string, writer: string, namespace?: string): Promise<OpResult>;
  undistrust?(actor: string, writer: string, namespace?: string): Promise<OpResult>;
  /** Export everything this actor may export. `text` is the raw payload; `data.payload` is what `import` takes back. */
  exportAll?(actor: string, opts?: { attest?: boolean }): Promise<OpResult>;
  importAll?(actor: string, payload: unknown, opts?: { require_attestation?: boolean }): Promise<OpResult>;
  /** Make `actor`'s server believe signatures made by `ofServer`. */
  trustServer?(actor: string, ofServer: string): Promise<OpResult>;
  merge?(actor: string, ids: string[]): Promise<OpResult>;
  /** Step 1 of a replacement. Must change nothing. `data.token` is the one-time code, `text` the warning. */
  supersedePreview?(actor: string, input: { old_ids: string[]; new_note?: ReplacementInput; new_id?: string }): Promise<OpResult>;
  /** Step 2. Needs the code from a preview. */
  supersedeConfirm?(actor: string, input: { token: string; new_note?: ReplacementInput; acknowledge_risk?: boolean }): Promise<OpResult>;
  supersedeUndo?(actor: string, id: string): Promise<OpResult>;
  /** Earlier versions of a note. `data.versions` is the list, `text` the raw payload. */
  history?(actor: string, id: string, opts?: { include_distrusted?: boolean }): Promise<OpResult>;
  restoreVersion?(actor: string, id: string, version: number, opts?: { if_rev?: number }): Promise<OpResult>;
}

/** The text of the note that takes the place of the old ones. */
export interface ReplacementInput {
  title: string;
  body?: string;
  tags?: string[];
  confidence?: number;
}

// ---------------------------------------------------------------------------------------------------------------
// Scenario files

export type Suite = "stale" | "contradiction" | "isolation" | "provenance";
export const SUITES: readonly Suite[] = ["stale", "contradiction", "isolation", "provenance"];

export type Step =
  | ({ op: "write"; as: string; ref: string; id?: string } & WriteInput)
  | ({ op: "update"; as: string; ref: string; id?: string; if_rev_of?: string } & UpdateInput)
  | { op: "delete" | "archive" | "unarchive" | "read"; as: string; ref: string; id?: string; include_distrusted?: boolean }
  | { op: "search"; as: string; q: string; id: string; limit?: number; include_distrusted?: boolean; include_superseded?: boolean; namespace?: string }
  | { op: "list"; as: string; id: string; namespace?: string; include_archived?: boolean; include_superseded?: boolean }
  | { op: "supersede_preview"; as: string; id: string; old: string[]; new_note?: ReplacementInput; new_ref?: string }
  | { op: "supersede_confirm"; as: string; id: string; from: string; ref?: string; new_note?: ReplacementInput; acknowledge_risk?: boolean; corrupt_code?: boolean }
  | { op: "supersede_undo"; as: string; ref: string; id?: string }
  | { op: "history"; as: string; ref: string; id: string; include_distrusted?: boolean }
  | { op: "restore_version"; as: string; ref: string; version: number; id?: string; if_rev_of?: string }
  | { op: "recall"; as: string; q: string; id: string }
  | { op: "changes" | "sweep"; as: string; id: string }
  | { op: "distrust" | "undistrust"; as: string; writer: string; id?: string; namespace?: string }
  | { op: "export"; as: string; id: string; attest?: boolean }
  | { op: "import"; as: string; from: string; id: string; require_attestation?: boolean; tamper?: { index?: number; field: "body" | "title" | "namespace" | "written_by"; value: string } }
  | { op: "trust_server"; as: string; of: string; id?: string }
  | { op: "merge"; as: string; refs: string[]; ref: string; id?: string }
  | { op: "wait"; ms: number };

export type CheckKind =
  | "outcome" //     a step ended with the given outcome
  | "top" //         the first search hit is `ref`
  | "has" //         `ref` is among the hits (within `within`, default all)
  | "lacks" //       `ref` is not among the hits
  | "fresh_answer" // the stale-memory measurement (see docs/BENCHMARK.md)
  | "hit_count" //   number of hits
  | "field" //       one field of a note (or of the hit for `of`)
  | "no_text" //     a secret string does not appear anywhere in a step's result
  | "contains_text" // a string appears in at least one of the listed steps' results
  | "same_response" // two steps were refused in exactly the same words
  | "recoverable"; // a provenance value is still findable on the note after a move

/** Which headline number a check feeds. */
export type Metric = "leak" | "unexpected_denial" | "field" | "resolution" | "loser_visible" | "silent_overwrite";

export interface Check {
  check: CheckKind;
  /** Plain-language statement of what should be true. Shown in the table and the JSON. */
  desc: string;
  metric?: Metric;
  step?: string;
  steps?: string[];
  ref?: string;
  /** For `field`/`recoverable`: which note of a multi-note result (a ref name), or pick it by exact `title`. */
  of?: string;
  title?: string;
  is?: unknown;
  within?: number;
  max?: number;
  min?: number;
  /** `fresh_answer`: the ref that holds the current value (omit when the fact was deleted), and the refs that hold old values. */
  current?: string;
  stale?: string[];
  /** `fresh_answer`: texts that mean "this is the OLD value": a hit whose title or body contains one counts as a stale hit. */
  stale_text?: string[];
  path?: string;
  equals?: unknown;
  not_equals?: unknown;
  includes?: unknown;
  present?: boolean;
  same_as?: { step: string; of?: string; path: string };
  /** `field`: the value must exist and differ from this other note's field. */
  differs_from?: { step: string; of?: string; path: string };
  text?: string;
  value?: string;
  /** `recoverable`: where a verified value lives, where an unverified claim lives. */
  verified_in?: string[];
  claim_in?: string[];
}

export interface Scenario {
  id: string;
  suite: Suite;
  title: string;
  /** One or two plain sentences: what this scenario protects against. */
  what: string;
  actors: Record<string, ActorSpec>;
  grants?: Record<string, string[]>;
  /** Server settings for this scenario only (see WorldSpec.settings). */
  settings?: { supersede_ttl_seconds?: number };
  /** Unrelated notes written first (by the first actor with write access) so ranking is not trivially easy. */
  distractors?: number;
  steps: Step[];
  expect: Check[];
  /** Capabilities the adapter must have; otherwise the scenario is skipped. */
  needs?: Capability[];
  /** The id of a documented gap this scenario is expected to fail on (see README "known gaps"). */
  known_gap?: string;
  /** Free text note shown in the report for a documented limit. */
  limit?: string;
}

export interface CheckResult {
  desc: string;
  check: CheckKind;
  metric?: Metric;
  pass: boolean;
  expected: string;
  actual: string;
  /** Raw yes/no measurements a `fresh_answer` or `recoverable` check feeds into the suite numbers. */
  measure?: Record<string, boolean>;
}

export type ScenarioStatus = "pass" | "fail" | "known_gap" | "gap_closed" | "skipped";

export interface ScenarioResult {
  id: string;
  suite: Suite;
  title: string;
  what: string;
  status: ScenarioStatus;
  known_gap?: string;
  limit?: string;
  skipped_reason?: string;
  checks: CheckResult[];
  error?: string;
}
