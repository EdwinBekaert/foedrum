// Ranks (ADR 0208): the order in which the intake orders and claims its queue, by arrival unless a
// person moved an order with `foedrum rank`. Pure: the intake and `rank` both sort through it.

import type { OrderRef } from '../schemas/events.ts';
import type { Rank, State } from './fold.ts';

/** An order of the intake's queue, as it sorts. */
export interface QueuedOrder {
  order: OrderRef;
  /** When its issue was created on GitHub: its arrival. */
  created: string;
  /** 0 for a Brewery issue, else 1 + the place of its repository in foedrum.jsonc. */
  source: number;
}

/**
 * `queue` in rank order: the orders marked "finish first" by when they were marked, then the rest
 * by arrival, a rank's in place of its issue's.
 */
export const rankQueue = <T extends QueuedOrder>(
  _queue: readonly T[],
  _ranks: ReadonlyMap<string, Rank>,
): T[] => {
  throw new Error('not implemented');
};

/**
 * The arrival `rank <order> <position>` records: that of the order now at `position` among those
 * of `queue` without the mark, leaving `order` out; past the end, `now`.
 */
export const arrivalAt = (
  _queue: readonly QueuedOrder[],
  _ranks: ReadonlyMap<string, Rank>,
  _order: OrderRef,
  _position: number,
  _now: Date,
): string => {
  throw new Error('not implemented');
};

/**
 * Why `order` cannot be ranked, from the folded state alone, or undefined: it has a batch, is a
 * sub-order, or is the Brewery issue of a claimed target issue.
 */
export const rankRefusal = (_state: State, _order: OrderRef): string | undefined => {
  throw new Error('not implemented');
};
