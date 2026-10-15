// The event store: the append-only event log, leases and the idempotency ledger (ADR 0002,
// architecture §4.1). Callers depend on this interface only, so the storage behind it can change
// (ADR 0002: `better-sqlite3` is the fallback for `node:sqlite`).

import type { Event } from '../schemas/events.ts';

/** An event as stored: `id` grows with every append and is never reused. */
export interface StoredEvent {
  id: number;
  event: Event;
}

/** Who holds an attempt (and its session) until when; alive while `expiresAt` is in the future. */
export interface Lease {
  attemptKey: string;
  owner: string;
  expiresAt: Date;
}

/** The key of an external side effect: applied at most once (invariant I4). */
export interface EffectKey {
  batchId: string;
  stepId: string;
  attempt: number;
  effect: string;
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
  /** Records an applied side effect; throws `DuplicateEffectError` when the key is already recorded. */
  recordEffect(key: EffectKey, result: unknown): void;
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
  /**
   * Rebuilds an empty store from a log (ADR 0011: the state branch is the durable record), in one
   * transaction. Throws `ReplayError` naming the first event that cannot be appended.
   */
  replay(log: readonly unknown[]): void;
  /** The recorded result of a side effect, or `undefined` when it was never applied. */
  findEffect(key: EffectKey): { result: unknown } | undefined;
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
    super(
      `Effect ${key.effect} of ${key.batchId}/${key.stepId}#${key.attempt} was already applied`,
    );
    this.name = 'DuplicateEffectError';
    this.key = key;
  }
}
