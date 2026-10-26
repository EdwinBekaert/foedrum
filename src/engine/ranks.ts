// Ranks (ADR 0208): the order in which the intake orders and claims its queue, by arrival unless a
// person moved an order with `foedrum rank`. Pure: the intake and `rank` both sort through it.

import type { OrderRef } from '../schemas/events.ts';
import { claimedName, claimOfOrder } from './claim-orders.ts';
import { orderKey, type Rank, type State } from './fold.ts';

/** An order of the intake's queue, as it sorts. */
export interface QueuedOrder {
  order: OrderRef;
  /** When its issue was created on GitHub: its arrival. */
  created: string;
  /** 0 for a Brewery issue, else 1 + the place of its repository in foedrum.jsonc. */
  source: number;
  /**
   * A ready sub-order of `order`, started under `parentBatchId` (ADR 0211): it sorts at its order's
   * place, ahead of a new order of the same place.
   */
  subOrder?: { issue: number; parentBatchId: string };
}

type Ranks = ReadonlyMap<string, Rank>;

const marked = (rank: Rank | undefined): boolean => rank?.place.kind === 'first';

// A rank's place stands in for its issue's arrival.
const arrivalOf = (queued: QueuedOrder, rank: Rank | undefined): string =>
  rank?.place.kind === 'position' ? rank.place.arrival : queued.created;

// Where an order goes among those of its arrival: a ranked one by its tie, the lower ahead, and an
// unranked one behind them.
const tieOf = (rank: Rank | undefined): number =>
  rank?.place.kind === 'position' ? rank.place.tie : Number.POSITIVE_INFINITY;

/**
 * `queue` in rank order: the orders marked "finish first" by when they were marked, then the rest
 * by arrival, a rank's in place of its issue's. Of the orders that share an arrival, the ranked ones
 * go first by their tie; then the Brewery's own issue, the order foedrum.jsonc lists the
 * repositories in, and the issue number break a tie.
 */
export const rankQueue = <T extends QueuedOrder>(queue: readonly T[], ranks: Ranks): T[] =>
  queue
    .map((queued) => ({ queued, rank: ranks.get(orderKey(queued.order)) }))
    .sort((one, other) => {
      if (marked(one.rank) !== marked(other.rank)) return marked(one.rank) ? -1 : 1;
      if (marked(one.rank)) return (one.rank?.seq ?? 0) - (other.rank?.seq ?? 0);
      const arrived =
        Date.parse(arrivalOf(one.queued, one.rank)) -
        Date.parse(arrivalOf(other.queued, other.rank));
      if (arrived !== 0) return arrived;
      const [tie, otherTie] = [tieOf(one.rank), tieOf(other.rank)];
      if (tie !== otherTie) return tie < otherTie ? -1 : 1;
      return (
        one.queued.source - other.queued.source || one.queued.order.issue - other.queued.order.issue
      );
    })
    .map(({ queued }) => queued);

/**
 * Where `rank <order> <position>` puts the order: the arrival of the order now at `position` among
 * those of `queue` without the mark, leaving `order` out, and a tie that puts it just ahead of that
 * order and behind the ranked orders of the same arrival ahead of it; past the end, `now`. So the
 * order keeps its place relative to the orders around it as they are ordered, and a later arrival
 * goes behind it.
 */
export const placeAt = (
  queue: readonly QueuedOrder[],
  ranks: Ranks,
  order: OrderRef,
  position: number,
  now: Date,
): { arrival: string; tie: number } => {
  const key = orderKey(order);
  const rankOf = (queued: QueuedOrder): Rank | undefined => ranks.get(orderKey(queued.order));
  const unmarked = rankQueue(queue, ranks).filter(
    (queued) => orderKey(queued.order) !== key && !marked(rankOf(queued)),
  );
  const there = unmarked[position - 1];
  if (there === undefined) return { arrival: now.toISOString(), tie: 0 };
  const arrival = arrivalOf(there, rankOf(there));
  const tie = tieOf(rankOf(there));
  // A ranked order ahead of it with the same arrival: the new rank goes between the two.
  const ahead = unmarked[position - 2];
  const between =
    ahead !== undefined &&
    rankOf(ahead) !== undefined &&
    Date.parse(arrivalOf(ahead, rankOf(ahead))) === Date.parse(arrival)
      ? tieOf(rankOf(ahead))
      : undefined;
  if (between === undefined) return { arrival, tie: Number.isFinite(tie) ? tie - 1 : 0 };
  return { arrival, tie: Number.isFinite(tie) ? (between + tie) / 2 : between + 1 };
};

/**
 * Why `order` cannot be ranked, from the folded state alone, or undefined: it is a sub-order, which
 * its plan ranks, the Brewery issue of a claimed target issue, or it has a batch, so it left the
 * queue.
 */
export const rankRefusal = (state: State, order: OrderRef): string | undefined => {
  const name = `${order.repo ?? ''}#${order.issue}`;
  if (order.repo === undefined) {
    const subOrder = state.subOrders.get(order.issue);
    if (subOrder !== undefined) {
      return `${name} is a sub-order of #${subOrder.order}; its plan ranks it`;
    }
    const claimed = claimOfOrder(state, order.issue);
    if (claimed !== undefined) {
      const target = claimedName(claimed);
      return `${name} is the order of ${target}; rank ${target}`;
    }
  }
  const key = orderKey(order);
  const batch = [...state.batches.values()]
    .filter(
      ({ issue, repo }) => orderKey({ issue, ...(repo === undefined ? {} : { repo }) }) === key,
    )
    .at(-1);
  if (batch !== undefined) {
    return `${name} was ordered as batch ${batch.id}: a rank orders only the queue`;
  }
  return undefined;
};
