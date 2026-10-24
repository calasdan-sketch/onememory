// Tags that only the task / handoff code paths may write.
//
// A "task" is a note tagged `task` and a "handoff" one tagged `handoff`; the
// board, the SessionStart hook and the command runner all trust those tags.
// So an ordinary note write (POST /notes, PUT /notes/:id, MCP state_write /
// state_update, file sync) must not be able to mint or change them: anyone
// with a write token could otherwise forge a "latest handoff from owner-pc",
// crowd real tasks off the board, or fake a task's lease / approval.
//
// Reserved: the exact tags `task` and `handoff`, and every tag starting with
// `task.` (task.priority:, task.due:, task.parent:, task.blocked_by:,
// task.ckey:, task.lease:, task.approval:). The `status:`, `surface:` and
// `owner:` tags are NOT reserved on their own: without `task` / `handoff`
// they mean nothing, and plenty of 1.2.x notes already use them.
//
// Compatible rule: an existing note that already carries reserved tags can
// still be edited as long as its reserved-tag set is unchanged (title, body
// and other tags are free). Creating a note with reserved tags, or adding /
// removing one, is rejected with a message pointing at task_put /
// session_handoff. Internal paths (tasks.ts, the runner) call the store
// directly and are not affected.
import { ValidationError } from "./store.js";

export const RESERVED_TAG_PREFIX = "task.";
const RESERVED_EXACT = new Set(["task", "handoff"]);

export function isReservedTag(tag: string): boolean {
  const t = tag.trim();
  return RESERVED_EXACT.has(t) || t.startsWith(RESERVED_TAG_PREFIX);
}

function reservedSet(tags: readonly string[] | undefined): Set<string> {
  return new Set((tags ?? []).map((t) => t.trim()).filter(isReservedTag));
}

/**
 * Throws a ValidationError when `next` (the tags a plain note write wants to
 * store) would change the note's reserved-tag set. `existing` = the note's
 * current tags (update) or undefined (create).
 */
export function assertPlainWriteTags(next: readonly string[] | undefined, existing?: readonly string[]): void {
  if (next === undefined) return; // tags not part of this write
  const want = reservedSet(next);
  const have = reservedSet(existing);
  if (want.size === have.size && [...want].every((t) => have.has(t))) return;
  const bad = [...want].filter((t) => !have.has(t)).concat([...have].filter((t) => !want.has(t)));
  throw new ValidationError(
    `the tag(s) ${bad.map((t) => `"${t}"`).join(", ")} are reserved for the task board: ` +
      `use task_put (POST /tasks) to create or change tasks and session_handoff (POST /handoffs) for handoffs. ` +
      `Reserved: "task", "handoff" and anything starting with "${RESERVED_TAG_PREFIX}".`
  );
}
