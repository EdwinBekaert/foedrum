// What a batch is to a person (ADR 0379): running, waiting for them and for what, queued, or done
// and how. One function works it out from the batch's lane; every surface renders its answer, and
// the lanes stay inside the engine.

import type { WaitCondition } from '../schemas/events.ts';
import type { Batch } from './fold.ts';
import type { LeftWhy, SubOrderRow } from './order-end.ts';

/** What a batch waits for a person to do. */
export type WaitingFor =
  | { kind: 'approve-plan' }
  | { kind: 'answer' }
  | { kind: 'review-and-merge'; pullRequests: readonly string[] }
  | { kind: 'open-session' }
  | { kind: 'choose-recipe' }
  /** A failure Foedrum could not get past, or a sub-order that keeps its order open and why. */
  | { kind: 'look-at-failure'; left?: LeftWhy };

/** What holds a queued batch. */
export type QueuedBy =
  | { kind: 'recipe' }
  | { kind: 'wait'; on: WaitCondition }
  | { kind: 'pause' }
  | { kind: 'usage-limit' }
  /** An approved plan whose sub-orders are not opened yet. */
  | { kind: 'sub-orders' }
  /** A sub-order with no batch yet: the sub-orders it depends on have not merged. */
  | { kind: 'blockers' };

/** How a batch ended. */
export type DoneHow = 'merged' | 'closed without merging' | 'cancelled' | 'no pull request';

/**
 * A batch as a person sees it. A split order's is its sub-orders' most pressing, which `subOrder`
 * names.
 */
export type BatchState =
  | { kind: 'running'; subOrder?: number }
  | { kind: 'waiting'; for: WaitingFor; subOrder?: number }
  | { kind: 'queued'; by: QueuedBy; subOrder?: number }
  | { kind: 'done'; how: DoneHow };

/** A sub-order of a split order, with the state of its latest batch when it has one. */
export interface SubOrderState {
  row: SubOrderRow;
  latest?: BatchState;
}

/** What the store adds to a batch's lane to say what it is. */
export interface StateContext {
  /** Whether a person's pause holds it (ADR 0202). */
  paused?: boolean;
  /** Whether a closed usage window holds its brewers (ADR 0206). */
  usageHeld?: boolean;
  /** Its order's sub-orders, in merge order, once it is split (ADR 0293). */
  subOrders?: readonly SubOrderState[];
}

/** What `batch` is to a person. */
export const batchState = (_batch: Batch, _context: StateContext = {}): BatchState => {
  throw new Error('not implemented');
};

/** The state as one line of plain words, such as `Waiting for you: approve the plan`. */
export const stateLine = (_state: BatchState): string => {
  throw new Error('not implemented');
};
