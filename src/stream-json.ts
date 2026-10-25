// Streaming reader for a JSON backup (`{"notes":[...]}`, the same with an `export`
// header, or a bare `[...]`): yields the notes one at a time, so restoring a big
// file holds one batch of notes in memory instead of the whole text plus the whole
// parsed tree (measured about 7x the file size). Only the array of notes is
// streamed; every other top-level key (the `export` header) is skipped.
//
// It is a small scanner, not a validator: it tracks string/escape state and
// bracket depth, cuts out each element of the notes array as text and hands it to
// JSON.parse, so malformed JSON inside an element still throws (with the
// element's own parse error) and a file that is not valid JSON overall may be
// accepted up to the point it breaks.
import { createReadStream } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { LIMITS } from "./security.js";

/** An element larger than this is refused (a note is capped far below it). */
export const MAX_STREAM_ELEMENT_CHARS = 8_000_000;

/** JSON nested deeper than this is refused (a backup is a few levels deep; a hostile file is not). */
export const MAX_STREAM_DEPTH = 64;

export class StreamJsonError extends Error {}

const TEXT_FIELDS = ["title", "body", "namespace", "source", "created_at", "updated_at", "expires_at", "archived_at", "written_by", "created_by", "imported_written_by", "imported_created_by"] as const;

/**
 * Shape check of one element of a backup's notes list, used by the whole-file validation pass of `import --file`.
 * Returns null when it is fine, "skip" for an element that is not an object (the importer has always ignored those), or a
 * readable problem. Size limits that the importer enforces per note (an over-long title, a secret in the body) are NOT
 * checked here: those notes are rejected individually and reported. What is checked is what would otherwise crash the
 * import half-way or hide a hostile shape: wrong types, tag lists that are not lists of text, and tag lists over the limit.
 */
export function checkBackupNote(note: unknown): string | null {
  if (note === null || typeof note !== "object" || Array.isArray(note)) return "skip";
  const n = note as Record<string, unknown>;
  for (const f of TEXT_FIELDS) {
    const v = n[f];
    if (v !== undefined && v !== null && typeof v !== "string") return `"${f}" must be text (found ${Array.isArray(v) ? "a list" : typeof v})`;
  }
  const tags = n.tags;
  if (tags !== undefined && tags !== null) {
    if (!Array.isArray(tags)) return `"tags" must be a list of text values (found ${typeof tags})`;
    if (tags.length > LIMITS.tagCount) return `"tags" has ${tags.length} entries (the limit is ${LIMITS.tagCount})`;
    for (let i = 0; i < tags.length; i++) {
      if (typeof tags[i] !== "string") return `tag ${i + 1} must be text (found ${Array.isArray(tags[i]) ? "a nested list" : tags[i] === null ? "null" : typeof tags[i]})`;
    }
  }
  const merged = n.merged_from_writers;
  if (merged !== undefined && merged !== null) {
    if (!Array.isArray(merged) || merged.some((x) => typeof x !== "string")) return '"merged_from_writers" must be a list of text values';
    if (merged.length > 1000) return `"merged_from_writers" has ${merged.length} entries`;
  }
  const rev = n.rev;
  if (rev !== undefined && rev !== null && (typeof rev !== "number" || !Number.isFinite(rev))) return '"rev" must be a number';
  return null;
}

export async function* streamBackupNotes(file: string, stats?: { scalars: number }): AsyncGenerator<unknown, void, void> {
  const dec = new StringDecoder("utf8");
  let depth = 0;
  let inStr = false;
  let esc = false;
  let topIsObject = false;
  let arrDepth = 0; // depth INSIDE the notes array (1 for a bare array, 2 for { "notes": [...] })
  let streaming = false;
  let done = false;
  let found = false;
  let key = "";
  let keyBuf = "";
  let keyCollecting = false;
  let collecting = false;
  let atStart = false; // just inside the notes array or after a comma in it: the next token starts an element
  let parts: string[] = [];
  let size = 0;

  const chunks = createReadStream(file, { highWaterMark: 1 << 20 });
  try {
    for await (const raw of chunks) {
      const chunk = dec.write(raw as Buffer);
      let seg = collecting ? 0 : -1;
      const ready: unknown[] = [];
      for (let i = 0; i < chunk.length; i++) {
        const c = chunk.charCodeAt(i);
        if (inStr) {
          if (keyCollecting && keyBuf.length < 300) keyBuf += chunk[i];
          if (esc) esc = false;
          else if (c === 0x5c) esc = true;
          else if (c === 0x22) {
            inStr = false;
            if (keyCollecting) {
              keyCollecting = false;
              keyBuf = keyBuf.slice(0, -1); // drop the closing quote
            }
          }
          continue;
        }
        if (atStart && streaming && !collecting && depth === arrDepth && c !== 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d && c !== 0xfeff) {
          atStart = false;
          if (c !== 0x7b && c !== 0x5b && c !== 0x5d && stats) stats.scalars++; // a string, number, true/false/null where a note should be
        }
        switch (c) {
          case 0x22: // "
            inStr = true;
            if (depth === 1 && topIsObject && !done) {
              keyCollecting = true;
              keyBuf = "";
            }
            break;
          case 0x7b: // {
          case 0x5b: // [
            if (depth === 0) {
              topIsObject = c === 0x7b;
              if (!topIsObject) {
                streaming = true;
                found = true;
                arrDepth = 1;
              }
            } else if (c === 0x5b && depth === 1 && topIsObject && key === "notes" && !found) {
              streaming = true;
              found = true;
              arrDepth = 2;
            }
            depth++;
            if (streaming && depth === arrDepth) atStart = true;
            if (depth > MAX_STREAM_DEPTH) throw new StreamJsonError(`the JSON is nested more than ${MAX_STREAM_DEPTH} levels deep: not a OneMemory backup`);
            if (streaming && !collecting && depth === arrDepth + 1) {
              collecting = true;
              seg = i;
              parts = [];
              size = 0;
            }
            break;
          case 0x7d: // }
          case 0x5d: // ]
            depth--;
            if (collecting && depth === arrDepth) {
              parts.push(chunk.slice(seg, i + 1));
              collecting = false;
              seg = -1;
              try {
                ready.push(JSON.parse(parts.join("")));
              } catch (e) {
                throw new StreamJsonError(`a note in the file is not valid JSON (${(e as Error).message})`);
              }
              parts = [];
            } else if (streaming && !collecting && depth === arrDepth - 1) {
              streaming = false;
              done = true;
            }
            break;
          case 0x3a: // :
            if (depth === 1 && topIsObject) key = keyBuf;
            break;
          case 0x2c: // ,
            if (depth === 1 && topIsObject) key = "";
            if (streaming && !collecting && depth === arrDepth) atStart = true;
            break;
          default:
            break;
        }
      }
      if (collecting) {
        const piece = seg >= 0 ? chunk.slice(seg) : chunk;
        size += piece.length;
        if (size > MAX_STREAM_ELEMENT_CHARS) throw new StreamJsonError("a note in the file is larger than 8 MB: not a OneMemory backup");
        parts.push(piece);
      }
      for (const n of ready) yield n;
    }
    if (inStr || depth !== 0 || collecting) throw new StreamJsonError("the file ends in the middle of the JSON (truncated?)");
    if (!found) throw new StreamJsonError('expected a JSON file shaped like { "notes": [...] } (or a bare array of notes)');
  } finally {
    chunks.destroy();
  }
}
