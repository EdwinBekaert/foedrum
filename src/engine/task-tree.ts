// Where a new attempt's worktree starts (ADR 0066): at the batch's task tree, the commits of the
// steps before it. Pure; the worktree manager resolves the revision after its fetch.

import type { Batch } from './fold.ts';

/**
 * The revision a new attempt of `batch` in `repository` starts at: the base, the branch of the
 * task tree's attempt, or the commit of its rewind. Throws with the reason when the task tree is
 * not in that repository.
 */
export const taskTreeStart = (
  _batch: Batch,
  _repository: { readonly repo: string; readonly base: string },
): string => {
  throw new Error('not implemented');
};
