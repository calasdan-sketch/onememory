// Small shared definitions for the replace-a-memory flow (kept apart so the text module and the logic can both use them).

/** Most notes one replacement may retire. */
export const PREVIEW_MAX_OLD = 20;

/** The text of the note that takes the place of the old ones. */
export interface SupersedeReplacementInput {
  title: string;
  body?: string;
  tags?: string[];
  /** A claim (0 to 1) of how sure the writer is. */
  confidence?: number;
}
