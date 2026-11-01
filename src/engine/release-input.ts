// The `release` input of a sub-order's batch (ADR 0291): for each `release` blocker of its
// sub-order, the release that made it ready, as the code host wrote it, with the blocker's merged
// pull requests. Foedrum parses no version: the brewer reads it from the released repository.

import type { Batch, State } from './fold.ts';

/** The releases a batch waited for, each tag as written, and the text its brewers read. */
export interface ReleaseInput {
  releases: readonly { repo: string; version: string }[];
  text: string;
}

/** The `release` input of `batch`, or undefined when its sub-order waits on no release. */
export const releaseInput = (_state: State, _batch: Batch): ReleaseInput | undefined => {
  throw new Error('not implemented');
};
