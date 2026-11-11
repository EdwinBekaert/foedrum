// The archive of finished batches (ADR 0380): which batches a cleanup may move to `archive/` on the
// state branch, and the event that records each, which keeps what later batches of its issue still
// read. Pure: everything is read from the folded state and the facts the driver gives.

import type { Event } from '../schemas/events.ts';
import type { Batch, State } from './fold.ts';

/** What the cleanup reads beside the fold: work that the events alone do not show. */
export interface ArchiveFacts {
  /** Whether an effect of `batchId` is still due, or one of its sources could not be read. */
  due(batchId: string): boolean;
  /** The batches with a live batch lease or attempt lease. */
  leased: ReadonlySet<string>;
}

export type Archived = Extract<Event, { type: 'batch.archived' }>;

/**
 * The batches a cleanup archives now, in the order they were ordered: each ended, with no effect
 * due, no mark and no lease, and every batch of its family (the order it was split from and its
 * sub-orders) too.
 */
export const archivable = (_state: State, _facts: ArchiveFacts): Batch[] => {
  throw new Error('not implemented');
};

/** The event that archives `batch`, with what later batches of its issue read of it. */
export const archivedOf = (_state: State, _batch: Batch): Archived => {
  throw new Error('not implemented');
};
