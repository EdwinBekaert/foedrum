// Which finished batches a cleanup shelves (ADR 0380): the store forgets them, and the next flush
// moves their folders to `archive/` on the state branch, for people only. Pure: everything is read
// from the folded state and the facts the driver gives.

import type { Batch, State } from './fold.ts';

/** What the cleanup reads beside the fold: work that the events alone do not show. */
export interface ArchiveFacts {
  /** Whether an effect of `batchId` is still due, or one of its sources could not be read. */
  due(batchId: string): boolean;
  /** The batches with a live batch lease or attempt lease. */
  leased: ReadonlySet<string>;
  /** Whether the state branch lacks an event of `batchId`, or the store still keeps an out doc of it. */
  unpushed(batchId: string): boolean;
}

/**
 * The batches a cleanup shelves now, in the order they were ordered: each ended, with no effect
 * due, no mark, no lease and nothing left to push, every batch of its family (the order it was
 * split from and its sub-orders) too, and every earlier batch of its issue.
 */
export const archivable = (_state: State, _facts: ArchiveFacts): Batch[] => {
  throw new Error('not implemented');
};
