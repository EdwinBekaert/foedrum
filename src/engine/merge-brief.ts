// When a brewed pull request is ready to merge (ADR 0225): the latest record of the checks on the
// head the batch pushed finished with none failed, its latest base check found no conflict and no
// failing check on the merged tree, and the batch is On tap. And the merge briefs the ledger
// recorded, one per ready record. Pure: the brief's effect and the status comment read it.

import type { HeadCheck } from '../schemas/events.ts';
import type { MergeBrief } from '../schemas/status-comment.ts';
import type { BatchEffectKey } from '../schemas/store.ts';
import type { Batch, State } from './fold.ts';

/** The record of a pull request's checks that makes it ready to merge. */
export interface ReadyRecord {
  pullRequest: string;
  head: string;
  checks: readonly HeadCheck[];
  more?: number;
  /** The first 16 hex digits of the SHA-256 of its checks, as `sameHeadChecks` compares them. */
  digest: string;
}

/**
 * The record that makes the open pull request of `batch` ready to merge, or `undefined` while it
 * is not.
 */
export const readyOf = (_state: State, _batch: Batch): ReadyRecord | undefined => {
  throw new Error('not implemented');
};

/** The effect that posts the `n`th merge brief of `batchId`. */
export const briefKey = (batchId: string, n: number): BatchEffectKey => ({
  batchId,
  effect: `brief.${n}`,
});

/** The latest merge brief the ledger recorded for `batchId`, if any, and the number of the next. */
export const latestBrief = (
  _state: State,
  _batchId: string,
): { next: number; latest: MergeBrief | undefined } => {
  throw new Error('not implemented');
};

/** The latest merge brief of `batch` while it is of the record that makes it ready now. */
export const briefNow = (_state: State, _batch: Batch): MergeBrief | undefined => {
  throw new Error('not implemented');
};
