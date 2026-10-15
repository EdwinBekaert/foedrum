// The supervisor's pure core (architecture §4.4, ADR 0025, ADR 0026): from the folded state, the
// due deadlines and the expired leases, the engine commands one tick issues. It never builds events:
// decide does, so the supervisor cannot do what the state machine refuses.

import type { AttemptRef } from './attempt-key.ts';
import type { EngineCommand } from './decide.ts';
import type { DueBatch, Lease } from './event-store.ts';
import type { State } from './fold.ts';
import type { Recipes } from './recipes.ts';
import type { FlushResult } from './state-branch-git.ts';

/** What the runner (#11) knows about a running attempt: when it last wrote a file or committed. */
export interface AttemptProgress {
  lastProgressAt: Date;
  /** Turns since then. */
  turnsWithoutProgress: number;
}

/** The runner's progress signals; `undefined` for an attempt it does not run. */
export interface ProgressSource {
  progress(attempt: AttemptRef): AttemptProgress | undefined;
}

export interface TickInput {
  state: State;
  /** The batches whose pending deadline is due (`EventStore.batchesPastDeadline(now)`). */
  due: readonly DueBatch[];
  /** The leases that expired (`EventStore.expiredLeases(now)`). */
  expiredLeases: readonly Lease[];
  progress: ProgressSource;
  recipes: Recipes;
  now: Date;
}

export interface TickPlan {
  /** At most one per batch, to decide in this order. */
  commands: EngineCommand[];
  /** Every expired lease: its attempt is lost, or no longer runs. */
  releaseLeases: string[];
}

/** The commands one tick issues: deadlines first (invariant I5), then lost, then stalled attempts. */
export const planTick = (_input: TickInput): TickPlan => {
  throw new Error('not implemented');
};

/** Since when flushes of the state branch fail, and whether that was already reported. */
export type FlushWatch = { failingSince: Date; reported: boolean } | undefined;

/**
 * Follows the state branch's flushes: `overdueSince` is set once, on the first flush that still
 * fails `deadlineMs` after the first failure, so the engine raises attention once (ADR 0024).
 */
export const watchFlush = (
  _watch: FlushWatch,
  _outcome: FlushResult['kind'],
  _now: Date,
  _deadlineMs: number,
): { watch: FlushWatch; overdueSince?: Date } => {
  throw new Error('not implemented');
};
