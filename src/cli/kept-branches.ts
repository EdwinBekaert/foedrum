// The task-tree branches the cleanup keeps (ADR 0084, ADR 0092), as `foedrum status` lists them:
// pure, from the claims and what git says of each branch. kept-branches-git.ts reads git.

/** What git says of one branch the claims name, in the clone of its batch's repository. */
export type BranchReading =
  /** `ahead`: the commits past the batch's start; undefined when the start is unknown. */
  | { kind: 'read'; clone: string; tip: string; ahead: number | undefined }
  /** The branch is no longer in the clone: someone took the commits and dropped it. */
  | { kind: 'gone' }
  | { kind: 'unread'; reason: string };

/**
 * The lines `foedrum status` adds for the branches the cleanup keeps: the ones of `unpushed`
 * (`Claims.unpushed`) whose tip is not the batch's start, each with its batch, its commits past the
 * start and the line that drops it. None when nothing is kept.
 */
export const keptBranchLines = (
  _unpushed: ReadonlyMap<string, string>,
  _readings: ReadonlyMap<string, BranchReading>,
): string[] => {
  throw new Error('not implemented');
};
