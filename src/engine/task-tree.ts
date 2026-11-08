// Where a new attempt's worktree starts (ADR 0066): at the batch's task tree, the commits of the
// steps before it. Pure; the worktree manager resolves the revision after its fetch.

import { attemptBranch } from '../workspace/attempt-worktrees.ts';
import type { Batch } from './fold.ts';

// GitHub names are case-insensitive.
export const sameRepo = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/**
 * The revision a new attempt of `batch` in `repository` starts at: the base, the branch of the
 * task tree's attempt, or the commit of its rewind. Throws with the reason when the task tree is
 * not in that repository.
 */
export const taskTreeStart = (
  batch: Batch,
  repository: { readonly repo: string; readonly base: string },
): string => {
  const { taskTree } = batch;
  if (taskTree === undefined) return repository.base;
  switch (taskTree.kind) {
    case 'attempt': {
      if (!sameRepo(taskTree.repo, repository.repo)) {
        throw new Error(
          `the task tree of batch ${batch.id} is in ${taskTree.repo}, not ${repository.repo}`,
        );
      }
      // Built from the attempt, never the recorded branch (ADR 0037).
      const { stepId, attempt } = taskTree;
      return `refs/heads/${attemptBranch({ batchId: batch.id, stepId, attempt })}`;
    }
    case 'rewound': {
      const found = Object.entries(taskTree.shas).find(([repo]) => sameRepo(repo, repository.repo));
      if (found === undefined) {
        throw new Error(`the rewind of batch ${batch.id} names no commit of ${repository.repo}`);
      }
      return found[1];
    }
    default: {
      const unknown: never = taskTree;
      throw new Error(`Unknown task tree ${JSON.stringify(unknown)}`);
    }
  }
};

/**
 * The revision a new attempt at `stepId` of `batch` starts at (ADR 0358): for the step a red proof
 * proves (`proven`), once it succeeded in the batch's current run and while no open pull request
 * sent the batch back, where its latest success ended, so its new commits come before the code;
 * else the task tree (ADR 0066).
 */
export const attemptStart = (
  _batch: Batch,
  _stepId: string,
  _repository: { readonly repo: string; readonly base: string },
  _proven: boolean,
): string => {
  throw new Error('not implemented');
};
