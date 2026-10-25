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

/** An element larger than this is refused (a note is capped far below it). */
export const MAX_STREAM_ELEMENT_CHARS = 8_000_000;

export class StreamJsonError extends Error {}

export async function* streamBackupNotes(file: string): AsyncGenerator<unknown, void, void> {
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
