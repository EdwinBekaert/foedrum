// The ready set (ADR 0211): the sub-orders the intake may start now, a pure function of the folded
// state. A sub-order is ready when it is in its order's latest breakdown, has no batch yet, and
// every sub-order it is blocked by is done: its pull request merged.

import type { State } from './fold.ts';

/** A ready sub-order, with the batch it is ordered under: its order's latest. */
export interface ReadySubOrder {
  order: number;
  issue: number;
  parentBatchId: string;
}

/** The ready sub-orders of every order not held, by order number, each order's in its plan's order. */
export const readySubOrders = (_state: State): ReadySubOrder[] => {
  throw new Error('not implemented');
};
