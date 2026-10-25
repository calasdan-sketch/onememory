// `onememory supersede` and `onememory history`: the terminal side of replacing a memory (1.6.0).
//
//   onememory supersede --old 12[,13] --title "..." --body "..." [--tags a,b] [--confidence 0.8]
//   onememory supersede --old 12 --new-id 40
//       Shows the warning ("Are you sure you want to replace this?"). On a terminal it then asks you to TYPE the number of
//       notes you are replacing (or "yes"); anything else cancels and nothing changes. With no terminal (a script, a pipe)
//       it only shows the warning and prints a one-time code.
//   onememory supersede --confirm-token <code> [the same --title/--body/--tags/--confidence] [--acknowledge-risk]
//       The non-interactive way: only a code from a preview works, once, within minutes.
//   onememory supersede undo <id>
//   onememory history <id> [--json] [--include-distrusted]
//   onememory history restore <id> <version> [--if-rev n]
//   onememory history purge <id> [--yes]
//
// There is deliberately NO --yes for a replacement: a script has to carry a code that was made by looking at a preview.
//
// The command line is the machine owner (the same trust as every other `onememory` command), so it runs with the admin scope
// under the writer name "cli". Everything goes through supersede.ts, like the REST and MCP surfaces.
import { readFileSync } from "node:fs";
import { Store, QuarantinedError, ValidationError } from "./store.js";
import { SupersedeError, supersedePreview, supersedeConfirm, supersedeUndo, noteHistory, restoreVersion, purgeNoteHistory, type Caller } from "./supersede.js";
import type { SupersedeReplacementInput } from "./supersede-shared.js";
import { safe } from "./supersede-text.js";
import { maybeEmbed } from "./search-service.js";

export interface CliIO {
  out: (s: string) => void;
  err: (s: string) => void;
  /** Ask one line on the terminal. Only called when `interactive` is true. */
  ask: (prompt: string) => Promise<string>;
  /** True only when a person is at a terminal (stdin AND stdout are TTYs). */
  interactive: boolean;
}

const VALUE_FLAGS = ["old", "new-id", "title", "body", "body-file", "tags", "confidence", "confirm-token", "if-rev"];
const BOOL_FLAGS = ["acknowledge-risk", "json", "include-distrusted", "yes"];

export function parseArgs(args: string[]): { flags: Record<string, string | true>; rest: string[] } {
  const flags: Record<string, string | true> = {};
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const eq = a.indexOf("=");
    const name = a.startsWith("--") ? (eq > 0 ? a.slice(2, eq) : a.slice(2)) : null;
    if (name && VALUE_FLAGS.includes(name)) {
      if (eq > 0) flags[name] = a.slice(eq + 1);
      else if (i + 1 < args.length) flags[name] = args[++i];
      else throw new ValidationError(`Missing value for --${name}`);
    } else if (name && BOOL_FLAGS.includes(name)) flags[name] = true;
    else if (a.startsWith("--")) throw new ValidationError(`Unknown option: ${a}`);
    else rest.push(a);
  }
  return { flags, rest };
}

const s = (v: string | true | undefined): string | undefined => (typeof v === "string" ? v : undefined);

function wholeNumbers(raw: string | undefined, what: string): number[] {
  if (!raw) throw new ValidationError(`${what} is required`);
  const parts = raw.split(",").map((x) => x.trim()).filter(Boolean);
  if (parts.length === 0 || !parts.every((p) => /^\d+$/.test(p))) throw new ValidationError(`${what} must be note numbers like 12 or 12,13`);
  return parts.map(Number);
}

function newNoteFromFlags(flags: Record<string, string | true>): SupersedeReplacementInput | undefined {
  const title = s(flags.title);
  if (title === undefined) return undefined;
  const bodyFile = s(flags["body-file"]);
  const body = bodyFile ? readFileSync(bodyFile, "utf8") : s(flags.body);
  const conf = s(flags.confidence);
  const tags = s(flags.tags);
  return {
    title,
    body: body ?? "",
    ...(tags ? { tags: tags.split(",").map((t) => t.trim()).filter(Boolean) } : {}),
    ...(conf !== undefined ? { confidence: Number(conf) } : {}),
  };
}

/** Does what the person typed count as "yes, replace these N notes"? The note count, or yes. Nothing else. */
export function acceptsReplacement(answer: string, count: number): boolean {
  const a = answer.trim().toLowerCase();
  return a === "yes" || a === String(count);
}

export const RISK_PHRASE = "i accept the risk";

const OWNER: Caller = { scope: "admin" };

/** Run a supersede / history command. Returns the process exit code (0 done, 1 refused or failed, 2 preview only). */
export async function supersedeCli(store: Store, args: string[], io: CliIO, caller: Caller = OWNER): Promise<number> {
  try {
    const { flags, rest } = parseArgs(args);
    const json = flags.json === true;
    const emit = (v: unknown): void => io.out(JSON.stringify(v, null, 2));

    if (rest[0] === "undo") {
      const out = supersedeUndo(store, caller, Number(rest[1]));
      if (json) emit(out);
      else io.out(out.message);
      return 0;
    }

    const token = s(flags["confirm-token"]);
    if (token !== undefined) {
      const out = supersedeConfirm(store, caller, { token, new_note: newNoteFromFlags(flags), acknowledge_risk: flags["acknowledge-risk"] === true });
      await maybeEmbed(store, out.replacement);
      if (json) emit(out);
      else io.out(out.message);
      return 0;
    }

    const oldIds = wholeNumbers(s(flags.old), "--old");
    const newIdRaw = s(flags["new-id"]);
    const newNote = newNoteFromFlags(flags);
    if ((newNote === undefined) === (newIdRaw === undefined)) {
      throw new ValidationError("give exactly one of --title (with --body) for a new note, or --new-id for a note that already exists");
    }
    const how = io.interactive
      ? "Type the number of notes you are replacing, or yes, to go ahead. Anything else cancels and nothing is changed."
      : "Nothing was changed. To go ahead from a script, run the same command again with --confirm-token {token} (and the same --title/--body).";
    const preview = supersedePreview(store, caller, { old_ids: oldIds, new_note: newNote, new_id: newIdRaw !== undefined ? Number(newIdRaw) : undefined }, how);
    if (json) {
      emit(preview);
      if (!io.interactive) return 2;
    } else io.out(preview.warning);

    if (!io.interactive) {
      if (!json) io.err("\nThis was only a preview: nothing was changed.");
      return 2;
    }
    const answer = await io.ask(`\nReplace ${preview.count} note${preview.count === 1 ? "" : "s"}? Type ${preview.count} or yes: `);
    if (!acceptsReplacement(answer, preview.count)) {
      io.out("Cancelled. Nothing was changed.");
      return 1;
    }
    let ack = false;
    if (preview.requires_acknowledgement) {
      const risk = await io.ask(`The warning above has a RED FLAG. To accept it type exactly: ${RISK_PHRASE}\n> `);
      if (risk.trim().toLowerCase() !== RISK_PHRASE) {
        io.out("Cancelled. Nothing was changed.");
        return 1;
      }
      ack = true;
    }
    const out = supersedeConfirm(store, caller, { token: preview.token, new_note: newNote, acknowledge_risk: ack });
    await maybeEmbed(store, out.replacement);
    io.out(out.message);
    return 0;
  } catch (e) {
    if (e instanceof QuarantinedError) {
      io.err(`Held for review (quarantine #${e.quarantineId}); nothing was replaced.`);
      return 1;
    }
    if (e instanceof SupersedeError || e instanceof ValidationError) {
      io.err(`Error: ${e.message}`);
      if (e instanceof SupersedeError && e.warning) io.err("\n" + e.warning);
      return 1;
    }
    throw e;
  }
}

/** `onememory history ...` */
export async function historyCli(store: Store, args: string[], io: CliIO, caller: Caller = OWNER): Promise<number> {
  try {
    const { flags, rest } = parseArgs(args);
    const json = flags.json === true;
    const sub = rest[0] === "restore" || rest[0] === "purge" ? rest[0] : "list";
    const idArg = sub === "list" ? rest[0] : rest[1];
    const id = Number(idArg);
    if (!Number.isInteger(id) || id < 1) throw new ValidationError("give a note number: onememory history <id> | history restore <id> <version> | history purge <id>");
    if (sub === "list") {
      const h = noteHistory(store, caller, id, { includeDistrusted: flags["include-distrusted"] === true });
      if (json) {
        io.out(JSON.stringify(h, null, 2));
        return 0;
      }
      io.out(`Note ${id}: now at version ${h.current.version} ("${safe(h.current.title, 80)}", written by "${safe(h.current.written_by, 40)}").`);
      if (h.versions.length === 0) io.out("No earlier versions are kept.");
      for (const v of h.versions) {
        const who = v.written_by ? `written by "${safe(v.written_by, 40)}"` : v.claimed_writer ? `claimed to be written by "${safe(v.claimed_writer, 40)}" (unverified, came from an import)` : "writer unknown";
        io.out(`  version ${v.version}: "${safe(v.title, 80)}", ${who}, replaced ${v.saved_at.slice(0, 10)} by "${safe(v.saved_by, 40)}" (${v.reason})`);
        io.out(`      says: "${safe(v.body, 200)}"`);
      }
      if (h.hidden_by_trust_policy > 0) io.out(`${h.hidden_by_trust_policy} version(s) are hidden because their writer is on the distrust list (--include-distrusted shows them).`);
      return 0;
    }
    if (sub === "restore") {
      const version = Number(rest[2]);
      const ifRev = s(flags["if-rev"]);
      const out = restoreVersion(store, caller, id, version, ifRev !== undefined ? { ifRev: Number(ifRev) } : {});
      await maybeEmbed(store, out.note);
      io.out(json ? JSON.stringify(out, null, 2) : out.message);
      return 0;
    }
    // purge
    if (flags.yes !== true) {
      if (!io.interactive) throw new ValidationError("forgetting history cannot be undone: run it at a terminal and answer the question, or add --yes");
      const a = await io.ask(`Forget ALL earlier versions of note ${id}? This cannot be undone. Type yes: `);
      if (a.trim().toLowerCase() !== "yes") {
        io.out("Cancelled. Nothing was changed.");
        return 1;
      }
    }
    const out = purgeNoteHistory(store, caller, id);
    io.out(json ? JSON.stringify(out, null, 2) : out.message);
    return 0;
  } catch (e) {
    if (e instanceof QuarantinedError) {
      io.err(`Held for review (quarantine #${e.quarantineId}); the version was not restored.`);
      return 1;
    }
    if (e instanceof ValidationError) {
      io.err(`Error: ${e.message}`);
      return 1;
    }
    throw e;
  }
}
