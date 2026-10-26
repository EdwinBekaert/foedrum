// The ready set (ADR 0211): the sub-orders the intake may start now, a pure function of the folded
// state. A sub-order is ready when it is in its order's latest breakdown, has no batch yet, and
// every sub-order it is blocked by is done: its pull request merged.

import { orderKey, type State } from './fold.ts';

/** A ready sub-order, with the batch it is ordered under: its order's latest. */
export interface ReadySubOrder {
  order: number;
  issue: number;
  parentBatchId: string;
}

/** The pull requests some batch recorded `merged`. */
const mergedPullRequests = (state: State): Set<string> => {
  const merged = new Set<string>();
  for (const batch of state.batches.values()) {
    for (const [url, end] of Object.entries(batch.pullRequestEnds ?? {})) {
      if (end === 'merged') merged.add(url);
    }
  }
  return merged;
};

/**
 * Whether `issue` is done: a pull request of one of its batches merged, or of a bottle it is in,
 * which its bottled batches record as theirs (ADR 0211).
 */
const isDone = (state: State, issue: number, merged: ReadonlySet<string>): boolean =>
  (state.subOrders.get(issue)?.batchIds ?? []).some((id) =>
    Object.values(state.batches.get(id)?.pullRequestEnds ?? {}).includes('merged'),
  ) ||
  [...state.bottles.values()].some(
    (bottle) => bottle.subOrders.includes(issue) && merged.has(bottle.pullRequest),
  );

/** The ready sub-orders of every order not held, by order number, each order's in its plan's order. */
export const readySubOrders = (state: State): ReadySubOrder[] => {
  const merged = mergedPullRequests(state);
  const ready: ReadySubOrder[] = [];
  const orders = [...state.orders.values()].sort((one, other) => one.issue - other.issue);
  for (const { issue: order, batchIds, subOrders, dependencies } of orders) {
    const parentBatchId = batchIds.at(-1);
    if (parentBatchId === undefined || subOrders.length === 0) continue;
    // A paused order would only hold the slot (ADR 0202); a cancelled one wants nothing more.
    if (state.pauses.orders.has(orderKey({ issue: order }))) continue;
    if (state.batches.get(parentBatchId)?.lane.kind === 'cancelled') continue;
    for (const issue of subOrders) {
      if ((state.subOrders.get(issue)?.batchIds.length ?? 0) > 0) continue;
      const blockers = dependencies.filter((dependency) => dependency.subOrder === issue);
      // `release` waits for a release signal no one records yet (#538).
      const unblocked = blockers.every(
        ({ blockedBy, kind }) => kind === 'code' && isDone(state, blockedBy, merged),
      );
      if (unblocked) ready.push({ order, issue, parentBatchId });
    }
  }
  return ready;
};
