// The openPullRequest action (ADR 0071), the pure core: the keys of its two effects, the bottle
// branch it pushes, the pull request the ledger recorded, and the pull request's text from the
// order and the brewers' out docs.

import type { BatchEffectKey } from '../schemas/store.ts';
import { repoFolder } from '../workspace/attempt-worktrees.ts';
import type { Batch, State } from './fold.ts';

/** The effect that pushes the batch's task tree to its bottle branch, once per batch. */
export const pushKey = (batchId: string): BatchEffectKey => ({ batchId, effect: 'push' });

/** The effect that opens the batch's pull request, once per batch. */
export const pullRequestKey = (batchId: string): BatchEffectKey => ({
  batchId,
  effect: 'pull_request',
});

/** The local name of the batch's bottle branch in `repo`: `foedrum/<batch>/<owner>.<name>`. */
export const bottleBranch = (_batchId: string, _repo: string): string => {
  void repoFolder;
  throw new Error('not implemented');
};

/** The pull request the ledger recorded for `batchId`, by its URL, or `undefined`. */
export const openedPullRequest = (_state: State, _batchId: string): string | undefined => {
  throw new Error('not implemented');
};

/** What a step reported in the out doc of its latest attempt that succeeded. */
export interface StepReport {
  stepId: string;
  summary: string;
  assumptions: readonly string[];
}

/** The reports of `batch`'s steps, in the order they were first scheduled. */
export const stepReports = (_batch: Batch): StepReport[] => {
  throw new Error('not implemented');
};

export interface PullRequestTextInput {
  /** The title of the order's issue: untrusted. */
  title: string;
  /** The order's issue, which the pull request closes. */
  closes: { repo: string; issue: number };
  /** Model output: untrusted. */
  reports: readonly StepReport[];
}

export interface PullRequestText {
  title: string;
  body: string;
}

/** The pull request's title and body. */
export const pullRequestText = (_input: PullRequestTextInput): PullRequestText => {
  throw new Error('not implemented');
};
