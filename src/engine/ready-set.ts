// The ready set (ADR 0211, ADR 0216): the sub-orders the intake may start now, a pure function of the
// folded state. A sub-order is ready when it is in its order's latest breakdown, has no batch yet,
// and every sub-order it is blocked by is done: its pull request merged, and for a `release`
// dependency, a release of its repository recorded after that merge. `releaseWaits` says which
// repositories' releases the intake reads for that (ADR 0223).

import type { Dependency } from '../schemas/events.ts';
import { orderKey, type State } from './fold.ts';
import { orderOfBatch } from './pauses.ts';

/** A ready sub-order, with the batch it is ordered under: its order's latest. */
export interface ReadySubOrder {
  order: number;
  issue: number;
  parentBatchId: string;
}

/**
 * The merged pull requests of `issue`, by URL: of one of its batches, or of a bottle it is in,
 * which its bottled batches record as theirs (ADR 0211).
 */
const mergedOf = (state: State, issue: number): string[] =>
  [
    ...(state.subOrders.get(issue)?.batchIds ?? []).flatMap((id) =>
      Object.entries(state.batches.get(id)?.pullRequestEnds ?? {})
        .filter(([, end]) => end === 'merged')
        .map(([url]) => url),
    ),
    ...[...state.bottles.values()]
      .filter((bottle) => bottle.subOrders.includes(issue))
      .map((bottle) => bottle.pullRequest),
  ].filter((url) => state.merges.has(url));

/** Where the fold recorded the merges of `issue`'s pull requests (ADR 0216). */
const mergesOf = (state: State, issue: number): number[] =>
  mergedOf(state, issue).flatMap((url) => state.merges.get(url) ?? []);

/**
 * Whether the sub-order a dependency is blocked by is done: its pull request merged, and for
 * `release`, its repository released after that merge, in any case (ADR 0211, ADR 0216).
 */
const isDone = (state: State, { blockedBy, kind }: Dependency): boolean => {
  const merges = mergesOf(state, blockedBy);
  switch (kind) {
    case 'code':
      return merges.length > 0;
    case 'release': {
      const repo = state.subOrders.get(blockedBy)?.repo.toLowerCase();
      return state.releases.some(
        (release) =>
          release.repo.toLowerCase() === repo && merges.some((merged) => merged < release.seq),
      );
    }
    default:
      return kind satisfies never;
  }
};

/** The Brewery orders a person stopped that still have a batch Stuck for it (ADR 0205). */
const stoppedOrders = (state: State): Set<number> => {
  const stopped = new Set<number>();
  for (const batch of state.batches.values()) {
    if (batch.lane.kind !== 'stuck' || batch.lane.reason.kind !== 'stopped') continue;
    const order = orderOfBatch(state, batch);
    if (order.repo === undefined) stopped.add(order.issue);
  }
  return stopped;
};

/** The ready sub-orders of every order not held, by order number, each order's in its plan's order. */
export const readySubOrders = (state: State): ReadySubOrder[] => {
  const stopped = stoppedOrders(state);
  const ready: ReadySubOrder[] = [];
  const orders = [...state.orders.values()].sort((one, other) => one.issue - other.issue);
  for (const { issue: order, batchIds, subOrders, dependencies } of orders) {
    const parentBatchId = batchIds.at(-1);
    if (parentBatchId === undefined || subOrders.length === 0) continue;
    // A paused or stopped order would only hold the slot (ADR 0202, ADR 0205); a cancelled one
    // wants nothing more.
    if (state.pauses.orders.has(orderKey({ issue: order })) || stopped.has(order)) continue;
    if (state.batches.get(parentBatchId)?.lane.kind === 'cancelled') continue;
    for (const issue of subOrders) {
      if ((state.subOrders.get(issue)?.batchIds.length ?? 0) > 0) continue;
      const blockers = dependencies.filter((dependency) => dependency.subOrder === issue);
      if (blockers.every((blocker) => isDone(state, blocker))) {
        ready.push({ order, issue, parentBatchId });
      }
    }
  }
  return ready;
};

/** A repository a `release` blocker waits on, and the merges a release of it must hold. */
export interface ReleaseWait {
  /** The repository as the first breakdown that names it spells it. */
  repo: string;
  /** Each waiting blocker's merged pull requests, by URL: a release must hold one of each. */
  blockers: readonly (readonly string[])[];
}

/**
 * The repositories whose release a sub-order waits for (ADR 0223): of each order not cancelled,
 * every `release` blocker of a sub-order with no batch that merged and is not done, by repository
 * in lower case, in the order the orders and their breakdowns name them.
 */
export const releaseWaits = (state: State): ReleaseWait[] => {
  const waits = new Map<string, { repo: string; blockers: Map<number, string[]> }>();
  const orders = [...state.orders.values()].sort((one, other) => one.issue - other.issue);
  for (const { batchIds, dependencies } of orders) {
    const parentBatchId = batchIds.at(-1);
    // A paused or stopped order is read: its sub-order starts once the hold lifts (ADR 0223).
    if (parentBatchId === undefined) continue;
    if (state.batches.get(parentBatchId)?.lane.kind === 'cancelled') continue;
    for (const dependency of dependencies) {
      const { subOrder, blockedBy, kind } = dependency;
      if (kind !== 'release') continue;
      if ((state.subOrders.get(subOrder)?.batchIds.length ?? 0) > 0) continue;
      const repo = state.subOrders.get(blockedBy)?.repo;
      const merged = mergedOf(state, blockedBy);
      if (repo === undefined || merged.length === 0 || isDone(state, dependency)) continue;
      const key = repo.toLowerCase();
      const wait = waits.get(key) ?? { repo, blockers: new Map() };
      wait.blockers.set(blockedBy, merged);
      waits.set(key, wait);
    }
  }
  return [...waits.values()].map(({ repo, blockers }) => ({
    repo,
    blockers: [...blockers.values()],
  }));
};
