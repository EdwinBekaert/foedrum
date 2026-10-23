// The Brewery issue that is the order of a claimed target-repository issue (ADR 0144). The driver
// opens it as an effect of the batch, so its number is what the ledger recorded for that effect;
// a batch that orders the issue again has the Brewery issue an earlier batch of it opened. Pure:
// everything here is read from the folded state.

import type { Batch, State } from './fold.ts';
import type { ClaimOrder } from './issue-claims.ts';

export type { ClaimOrder };

/** The Brewery issue of the claimed batch `batchId`; none for a batch of a Brewery issue. */
export const claimOrderOf = (_state: State, _batchId: string): ClaimOrder => {
  throw new Error('not implemented');
};

/** The latest claimed batch whose order is the Brewery issue `issue`, or undefined. */
export const claimOfOrder = (_state: State, _issue: number): Batch | undefined => {
  throw new Error('not implemented');
};

/**
 * How `status` and `stuck` name a batch's issue: `#<n>` for a Brewery issue, `#<order> (<alias>#<n>)`
 * for a claimed one, and `<alias>#<n>` until its Brewery issue is opened.
 */
export const orderName = (_state: State, _batch: Batch): string => {
  throw new Error('not implemented');
};
