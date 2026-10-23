// The merge of the base before a batch's last check (ADR 0164): the base as the remote has it now,
// fetched as the push fetches it (ADR 0090), merged into the check attempt's worktree as a commit
// of its own, through the ledger, so the checks read the code the pull request will hold and a
// kill on either side of the merge never merges twice (I4).

import type { AttemptEffectKey } from '../schemas/store.ts';
import type { AttemptRef } from './attempt-key.ts';
import type { Ending } from './decide.ts';
import type { EffectTarget } from './effects.ts';
import type { BranchPush } from './pull-request-actions.ts';

/** What a merge in a worktree came to: its commit, or the files it conflicts in, aborted. */
export type WorktreeMerged =
  | { kind: 'merged'; commit: string }
  | { kind: 'conflicts'; files: string[] };

/** git in an attempt's worktree. Every call stops when `signal` aborts. */
export interface WorktreeMerge {
  /** The commit the worktree's HEAD is at. */
  head(path: string, signal?: AbortSignal): Promise<string>;
  /** The parents of `commit`, full shas, in order. */
  parents(path: string, commit: string, signal?: AbortSignal): Promise<string[]>;
  /** Aborts a merge a killed run left in progress; nothing when none is. */
  abort(path: string, signal?: AbortSignal): Promise<void>;
  /**
   * Merges `commit` into HEAD as a commit of its own with `message`; on a conflict, the files it
   * conflicts in, with the merge aborted.
   */
  merge(
    path: string,
    commit: string,
    message: string,
    signal?: AbortSignal,
  ): Promise<WorktreeMerged>;
}

/** How a repository's check attempts merge its base. */
export interface BaseMerge {
  /** The branch the pull request goes into, as the remote names it (`main`). */
  base: string;
  /** The push's fetch of the base and its ancestor check (ADR 0090). */
  push: Pick<BranchPush, 'baseTip' | 'isAncestor'>;
  worktree: WorktreeMerge;
}

/** The ledger's key of the merge before attempt `ref`. */
export const baseMergeKey = (ref: AttemptRef): AttemptEffectKey => ({
  ...ref,
  effect: 'merge_base',
});

/** The merge into the worktree at `path`, which the attempt started at `start`. */
export const baseMergeTarget = (
  _merge: BaseMerge,
  _worktree: { path: string; start: string },
  _stepId: string,
): EffectTarget => {
  throw new Error('not implemented');
};

/** How the attempt ends when its merge `result` stops it: a conflict; `undefined` when it runs. */
export const mergeEnding = (_result: unknown, _base: string): Ending | undefined => {
  throw new Error('not implemented');
};
