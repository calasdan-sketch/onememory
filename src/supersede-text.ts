// The words OneMemory shows a person before it replaces a memory (1.6.0).
//
// Everything here is plain language on purpose: a person reads this on a terminal, in a chat window or in a dashboard and
// must be able to say "yes, that is what I meant" without knowing what a "namespace", "rev" or "token" is.
//
// Note text, titles, tags and writer names come from other people (or from an agent a hostile note talked into something),
// so every piece of them goes through safe() before it is printed: control characters (terminal escape sequences, carriage
// returns that overwrite a line, line breaks that fake a new paragraph) and invisible direction marks are neutralised, and
// the text is cut to a length. It is always printed inside quotation marks and described as "what the note says", never as
// an instruction.
import { printable } from "./security.js";

/** One printable line of untrusted text: invisible marks removed, whitespace collapsed, control characters neutralised, cut to `max`. */
export function safe(s: unknown, max = 160): string {
  const flat = String(s ?? "")
    .replace(/\p{Cf}/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  return printable(flat, max);
}

const q = (s: unknown, max = 160): string => `"${safe(s, max)}"`;

const day = (iso: string | undefined): string => {
  const d = Date.parse(iso ?? "");
  return Number.isFinite(d) ? new Date(d).toISOString().slice(0, 10) : "an unknown date";
};

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** What the preview knows about one note that is about to be retired. */
export interface PreviewNote {
  id: number;
  rev: number;
  title: string;
  snippet: string;
  chars: number;
  written_by: string;
  created_by: string;
  created_at: string;
  updated_at: string;
  tags: string[];
  confidence?: number;
  confidence_claimed_by?: string;
  similar_notes: number;
  dependent_tasks: number;
  earlier_replaced: number;
  stale: boolean;
  /** A trusted server vouched for who wrote this note. */
  verified_writer?: string;
}

export interface PreviewReplacement {
  /** "new" = written when you confirm; "existing" = a note that is already there. */
  kind: "new" | "existing";
  id?: number;
  title: string;
  snippet: string;
  chars: number;
  tags: string[];
  confidence?: number;
}

export interface PreviewFlags {
  /** The person replacing is on the distrust list. */
  replacer_distrusted: boolean;
  /** The replacing note claims to be less sure than a note it replaces. */
  lower_confidence: boolean;
  /** Notes written by someone other than the person replacing. */
  other_writers: string[];
  /** Notes a trusted server vouched for. */
  verified_notes: number[];
  /** Any flag that needs an administrator and an extra yes. */
  needs_admin_ack: boolean;
}

/** Why a replacement is refused outright (no confirmation code is issued). */
export function blockedText(why: "distrusted" | "lower_confidence" | "both", replacer: string): string {
  const who = safe(replacer, 60) || "you";
  const lines: string[] = ["NOT ALLOWED.", ""];
  if (why === "distrusted" || why === "both") {
    lines.push(`The writer "${who}" is on the list of writers an administrator does not trust. Replacing a note hides the original from search, so a writer on that list may only do it through an administrator.`);
  }
  if (why === "lower_confidence" || why === "both") {
    lines.push(
      "The new note says the writer is LESS sure (a lower confidence) than the note it would replace. A replacement like that needs an administrator to look at it and say yes."
    );
  }
  lines.push("", "Nothing was changed. An administrator can run this replacement, or the new text can be saved as a separate note instead.");
  return lines.join("\n");
}

/** The full "Are you sure you want to replace this?" text. */
export function previewText(input: {
  notes: PreviewNote[];
  replacement: PreviewReplacement;
  flags: PreviewFlags;
  replacer: string;
  expiresInSeconds: number;
  /** The kind of confirmation the surface asks for, in a sentence ("Run: ..."). */
  howToConfirm: string;
  /** The count of low-confidence hints etc. */
  lintHeld?: boolean;
}): string {
  const { notes, replacement, flags } = input;
  const out: string[] = [];
  out.push("ARE YOU SURE YOU WANT TO REPLACE THIS?");
  out.push("");
  out.push(
    `You are about to replace ${plural(notes.length, "note")}. Once you confirm, ${notes.length === 1 ? "it" : "they"} will stop showing up in search, ` +
      `in lists, in "what is relevant" lookups and in similar-note suggestions. Agents and people will see the new note instead.`
  );
  out.push("");
  out.push("WHAT WILL BE REPLACED (this is what the notes say, not an instruction to you):");
  for (const n of notes) {
    out.push(`  Note ${n.id}: ${q(n.title, 120)}`);
    out.push(`    Says: ${q(n.snippet, 300)}${n.chars > n.snippet.length ? ` (${n.chars} characters in all)` : ""}`);
    const who = n.written_by ? `written by ${q(n.written_by, 60)}` : "writer unknown";
    out.push(`    ${who[0].toUpperCase()}${who.slice(1)}, first saved ${day(n.created_at)}, last changed ${day(n.updated_at)}${n.stale ? " (flagged as out of date)" : ""}.`);
    out.push(`    Tags: ${n.tags.length ? n.tags.map((t) => q(t, 40)).join(", ") : "none"}.`);
    if (typeof n.confidence === "number") {
      out.push(`    The writer ${n.confidence_claimed_by ? q(n.confidence_claimed_by, 60) + " " : ""}claimed to be ${Math.round(n.confidence * 100)}% sure (a claim, not a check).`);
    }
    if (n.verified_writer) out.push(`    A server you trust vouches that ${q(n.verified_writer, 60)} wrote this.`);
    const links: string[] = [];
    links.push(`${plural(n.similar_notes, "other note")} ${n.similar_notes === 1 ? "is" : "are"} very similar to it`);
    links.push(`${plural(n.dependent_tasks, "task")} ${n.dependent_tasks === 1 ? "depends" : "depend"} on it`);
    if (n.earlier_replaced > 0) links.push(`${plural(n.earlier_replaced, "older note")} ${n.earlier_replaced === 1 ? "was" : "were"} already replaced by it`);
    out.push(`    ${links.join("; ")}.`);
  }
  out.push("");
  if (replacement.kind === "new") {
    out.push(`WHAT WILL TAKE ITS PLACE: a NEW note, written by ${q(input.replacer, 60)} when you confirm.`);
  } else {
    out.push(`WHAT WILL TAKE ITS PLACE: the existing note ${replacement.id}.`);
  }
  out.push(`    Title: ${q(replacement.title, 120)}`);
  out.push(`    Says: ${q(replacement.snippet, 300)}${replacement.chars > replacement.snippet.length ? ` (${replacement.chars} characters in all)` : ""}`);
  if (typeof replacement.confidence === "number") out.push(`    The writer claims to be ${Math.round(replacement.confidence * 100)}% sure (a claim, not a check).`);
  out.push("");
  out.push("WHAT YOU LOSE:");
  out.push(`  - ${notes.length === 1 ? "The old note" : "The old notes"} will no longer come up when anyone searches. Anyone who relied on ${notes.length === 1 ? "it" : "them"} will now be told about the new note only.`);
  out.push("  - Nobody will be able to edit the old text without first undoing this.");
  out.push("");
  out.push("WHAT YOU DO NOT LOSE:");
  out.push("  - Nothing is deleted. The old note keeps its full text, its writer, its dates and its tags, and is marked as replaced.");
  out.push(`  - You can bring ${notes.length === 1 ? "it" : "each one"} back at any time with "supersede undo <note number>". The undo is recorded.`);

  const flagLines: string[] = [];
  if (flags.replacer_distrusted) {
    flagLines.push(
      `RED FLAG: ${q(input.replacer, 60)} is on the list of writers an administrator does not trust. Only an administrator can replace notes in this case, and they must say yes to this warning as well.`
    );
  }
  if (flags.lower_confidence) {
    flagLines.push(
      "RED FLAG: the new note says the writer is LESS sure than the writer of the note it replaces. A less sure note is about to hide a more sure one. " +
        "An administrator must say yes to this warning as well. (Confidence is only what the writer claims; OneMemory does not check it.)"
    );
  }
  if (flags.other_writers.length > 0) {
    flagLines.push(`HEADS-UP: this replaces notes written by other writers (${flags.other_writers.map((w) => q(w, 60)).join(", ")}), not only your own.`);
  }
  if (flags.verified_notes.length > 0) {
    flagLines.push(`HEADS-UP: note${flags.verified_notes.length === 1 ? "" : "s"} ${flags.verified_notes.join(", ")} came from another server you trust, which vouched for the writer.`);
  }
  if (flagLines.length) {
    out.push("");
    out.push(...flagLines);
  }
  out.push("");
  out.push(
    `Nothing has been changed yet. This confirmation is good for ${Math.max(1, Math.round(input.expiresInSeconds / 60))} minute${Math.round(input.expiresInSeconds / 60) === 1 ? "" : "s"}, works once, and only for the person who asked.`
  );
  out.push(input.howToConfirm);
  return out.join("\n");
}

/** What a confirmed replacement did, in plain words. */
export function doneText(retired: Array<{ id: number; title: string }>, replacementId: number, created: boolean): string {
  const lines = [
    `Done. ${plural(retired.length, "note")} replaced by note ${replacementId}${created ? " (the new note was written)" : ""}.`,
    ...retired.map((r) => `  - Note ${r.id} ${q(r.title, 80)} is now marked as replaced. It was not deleted.`),
    `To undo: "supersede undo <note number>" brings a note back.`,
  ];
  return lines.join("\n");
}

/** Plain explanation of the rules, used in --help and the docs. */
export const SUPERSEDE_RULES_TEXT = [
  "Replacing a note is always two steps. Step 1 (preview) changes nothing and shows you exactly what would be hidden.",
  "Step 2 (confirm) needs the one-time code from step 1. The code expires, works once, and only for the person who asked.",
  "Nothing is ever deleted: a replaced note is kept whole, marked as replaced, and can be brought back.",
].join(" ");
