// One driver per batch at a time (ADR 0019): the driver that drives a batch holds its lease and
// renews it as its heartbeat. Another driver skips a batch whose lease is alive; an expired lease
// frees it. The driver renews it, never the brewer runner, so a lease stops when its driver does,
// even while an orphaned brewer process runs on.

import type { BatchLease, EventStoreTransaction } from './event-store.ts';

/** Whether the driver holds the batch now, or which other driver does. */
export type Hold = { kind: 'held'; lease: BatchLease } | { kind: 'other'; lease: BatchLease };

export interface HoldRequest {
  batchId: string;
  /** The driver's owner (its lock's). */
  owner: string;
  now: Date;
  /** How long the lease lasts from `now`. */
  leaseMs: number;
}

/**
 * Takes the lease of a batch for `owner`, or renews it, until `now + leaseMs`, unless another
 * owner's lease is alive at `now`. In a transaction, so two drivers cannot both take it.
 */
export const holdBatch = (tx: EventStoreTransaction, request: HoldRequest): Hold => {
  const { batchId, owner, now, leaseMs } = request;
  const current = tx.batchLease(batchId);
  if (current !== undefined && current.owner !== owner && current.expiresAt > now) {
    return { kind: 'other', lease: current };
  }
  const lease = { batchId, owner, expiresAt: new Date(now.getTime() + leaseMs) };
  tx.putBatchLease(lease);
  return { kind: 'held', lease };
};

/** Lets the lease of `batchId` go when `owner` holds it; another owner's lease stays. */
export const releaseBatch = (tx: EventStoreTransaction, batchId: string, owner: string): void => {
  if (tx.batchLease(batchId)?.owner === owner) tx.releaseBatchLease(batchId);
};
