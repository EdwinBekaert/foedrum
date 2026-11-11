// The event store: the append-only event log, leases and the idempotency ledger (ADR 0002,
// architecture §4.1). Callers depend on this interface only, so the storage behind it can change
// (ADR 0002: `better-sqlite3` is the fallback for `node:sqlite`).

import type { Event } from '../schemas/events.ts';
import type { BatchLease, EffectKey, KeptOutDoc, Lease, PushedThrough } from '../schemas/store.ts';

export type { BatchLease, EffectKey, KeptOutDoc, Lease, PushedThrough };

/** An event as stored: `id` grows with every append and is never reused. */
export interface StoredEvent {
  id: number;
  event: Event;
}

/** An event as read from the state branch, with the id it had in the store that wrote it. */
export interface LoggedEvent {
  id: number;
  event: unknown;
}

/** A batch whose pending deadline (a step's `deadlineAt` or a Conditioning `remindAt`) is due. */
export interface DueBatch {
  batchId: string;
  deadlineAt: Date;
}

/** The writes of one transaction; usable only inside the `withTransaction` callback. */
export interface EventStoreTransaction {
  /** Validates and appends an event; returns its id. */
  append(event: Event): number;
  /** Creates or renews the lease of `lease.attemptKey`. */
  putLease(lease: Lease): void;
  releaseLease(attemptKey: string): void;
  /**
   * The lease of `batchId`, alive or expired, as the transaction sees it: no other writer changes
   * it before the transaction ends.
   */
  batchLease(batchId: string): BatchLease | undefined;
  /** Creates or replaces the lease of `lease.batchId`. */
  putBatchLease(lease: BatchLease): void;
  releaseBatchLease(batchId: string): void;
  /** Records an applied side effect; throws `DuplicateEffectError` when the key is already recorded. */
  recordEffect(key: EffectKey, result: unknown): void;
  /**
   * Records that the state branch has every event up to `marker.eventId`, in `marker.commit`
   * (ADR 0024). Throws when the marker would move back or past the last event.
   */
  markPushed(marker: PushedThrough): void;
  /**
   * Keeps the text of an attempt's out doc until a flush puts it on the state branch (ADR 0103),
   * replacing one kept for the same attempt.
   */
  keepOutDoc(doc: KeptOutDoc): void;
  /** Lets go of the kept out docs of these attempts, once a push put them on the state branch. */
  forgetOutDocs(attempts: readonly { batchId: string; stepId: string; attempt: number }[]): void;
  /**
   * Forgets these batches (ADR 0380): deletes their events, ledger entries, kept out docs,
   * deadlines and leases, and nothing else. With `shelve`, the next flush moves each one's folder
   * on the state branch to `archive/<month>/`. Every reader of the store folds again after it.
   */
  forget(batchIds: readonly string[], shelve?: { month: string }): void;
  /** Lets go of these batches' shelving, once a push put their folders in `archive/`. */
  shelved(batchIds: readonly string[]): void;
  /** Asks the next flush to delete `archive/<month>/` for every month before `before` (`YYYY-MM`). */
  expire(before: string): void;
  /** Lets go of the expiry, once a push removed those months. */
  expired(): void;
}

export interface EventStore {
  /**
   * Runs `fn` in one write transaction: everything it writes is committed together, or rolled back
   * when it throws. `fn` must be synchronous, and transactions cannot be nested.
   */
  withTransaction<T>(fn: (tx: EventStoreTransaction) => T): T;
  /** Committed events with an id greater than `afterId`, oldest first, at most `limit`. */
  eventsAfter(afterId: number, limit?: number): StoredEvent[];
  /** Batches whose pending deadline is at or before `now`, earliest first. */
  batchesPastDeadline(now: Date): DueBatch[];
  /** Leases still alive at `now`. */
  currentLeases(now: Date): Lease[];
  /** Leases that expired at or before `now` and were not released, earliest first. */
  expiredLeases(now: Date): Lease[];
  /** Batch leases still alive at `now`, by batch id. */
  batchLeases(now: Date): BatchLease[];
  /**
   * Rebuilds an empty store from a log (ADR 0011: the state branch is the durable record), in one
   * transaction. Throws `ReplayError` naming the first event that cannot be appended.
   */
  replay(log: readonly unknown[]): void;
  /** The id of the last committed event; 0 when there is none. */
  lastEventId(): number;
  /** How far the state branch has the log, or `undefined` when nothing was ever pushed. */
  pushedThrough(): PushedThrough | undefined;
  /** The out docs kept for the state branch and not yet pushed (ADR 0103), by attempt. */
  keptOutDocs(): KeptOutDoc[];
  /**
   * Appends events read from the state branch, keeping their ids, and marks everything up to the
   * last one pushed in `commit` (ADR 0024), in one transaction. The ids must grow and come after
   * every stored event, and every stored event must be pushed already. Throws `ReplayError`
   * naming the first event that cannot be appended.
   */
  restore(log: readonly LoggedEvent[], commit: string): void;
  /** The recorded result of a side effect, or `undefined` when it was never applied. */
  findEffect(key: EffectKey): { result: unknown } | undefined;
  /** The batches forgotten and not yet moved to `archive/` on the state branch, with each one's month. */
  shelving(): { batchId: string; month: string }[];
  /** The month before which the next flush deletes `archive/<month>/`, if one was asked. */
  expiring(): string | undefined;
  /** How many times a batch was forgotten in this store: a reader folds again when it changes. */
  forgets(): number;
  /** The id of the last event of `batchId`, or `undefined` when the store has none. */
  lastEventOf(batchId: string): number | undefined;
  close(): void;
}

/** A log that cannot be replayed; `index` is the position of the offending event in the log. */
export class ReplayError extends Error {
  readonly index: number;

  constructor(index: number, cause: unknown) {
    super(`Event ${index} of the log cannot be replayed: ${String(cause)}`, { cause });
    this.name = 'ReplayError';
    this.index = index;
  }
}

export class DuplicateEffectError extends Error {
  readonly key: EffectKey;

  constructor(key: EffectKey) {
    const of = 'stepId' in key ? `${key.batchId}/${key.stepId}#${key.attempt}` : key.batchId;
    super(`Effect ${key.effect} of ${of} was already applied`);
    this.name = 'DuplicateEffectError';
    this.key = key;
  }
}
