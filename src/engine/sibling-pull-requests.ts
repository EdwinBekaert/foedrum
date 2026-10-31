// The pull requests of one order name each other and the merge order (ADR 0292, ADR 0013): a
// section of each sub-order pull request's body, written with the body (ADR 0227) and kept up to
// date as its siblings open and end, one revision at a time through the ledger (ADR 0033).

import type { BatchEffectKey } from '../schemas/store.ts';
import type { DriverEffects } from './driver.ts';
import type { State } from './fold.ts';
import type { PullRequestHost } from './pull-request-actions.ts';

/** The effect that writes revision `n` of the sibling section into `batchId`'s body. */
export const siblingKey = (batchId: string, revision: number): BatchEffectKey => ({
  batchId,
  effect: `siblings.${revision}`,
});

/** Where a sub-order's pull request is: not opened yet, open, or how it ended. */
export type SubOrderPullRequestState = 'none' | 'open' | 'merged' | 'closed';

/** A sub-order of an order, in merge order, with its latest batch's pull request. */
export interface SubOrderPullRequest {
  subOrder: number;
  repo: string;
  /** The pull request's URL, when one of its batches opened one. */
  pullRequest?: string;
  state: SubOrderPullRequestState;
}

/** The sub-orders of order `order`, in the order their pull requests merge (ADR 0292). */
export const subOrderPullRequests = (_state: State, _order: number): SubOrderPullRequest[] => {
  throw new Error('not implemented');
};

/**
 * The sibling section of `batchId`'s pull request body, or undefined when the batch brews no
 * sub-order of an order with two or more (ADR 0292).
 */
export const siblingSection = (_state: State, _batchId: string): string | undefined => {
  throw new Error('not implemented');
};

export interface SiblingEffectsOptions {
  host: Pick<PullRequestHost, 'body' | 'update'>;
}

/** The revisions of each open sub-order pull request's sibling section, for the driver. */
export const siblingEffects = (_options: SiblingEffectsOptions): DriverEffects => {
  throw new Error('not implemented');
};
