// The end of a split order (ADR 0293): each sub-order its latest breakdown keeps, with its latest
// batch's lane and the release that followed its merge, and whether every one of them merged, or
// which keep the order open and why. The order's status comment shows it, and the close of the
// order's Brewery issue waits for it (`brewery-closes.ts`).

import { planOf } from '../schemas/plan.ts';
import type { Lane, Release, State, SubOrder } from './fold.ts';
import { openedPullRequest } from './pull-request.ts';
import { releaseAfterMerge } from './ready-set.ts';
import { type SubOrderPullRequest, subOrderPullRequests } from './sibling-pull-requests.ts';

/** Why a sub-order keeps its order open: it cannot merge until a person acts on it. */
export type LeftWhy = 'cancelled' | 'closed without merging' | 'needs refinement';

/** A sub-order of the order, in merge order, as the order's status comment rolls it up. */
export interface SubOrderRow extends SubOrderPullRequest {
  /** Its latest batch's lane, or undefined while it has none. */
  lane?: Lane['kind'];
  /** The first release of its repository recorded after its merge (ADR 0216). */
  release?: Release;
  /** Why it keeps the order open, when it does; a sub-order only waiting has none. */
  left?: LeftWhy;
}

/** Whether every sub-order merged, with their pull requests, or which are left and why. */
export type OrderEnd =
  | { kind: 'done'; pullRequests: readonly string[] }
  | { kind: 'open'; left: readonly { subOrder: number; why: LeftWhy }[] };

/** Whether the approved plan entry `subOrder` was opened from was marked not ready (ADR 0285). */
const notReady = (state: State, { plan }: SubOrder): boolean => {
  if (plan === undefined) return false;
  const ended = state.batches.get(plan.batchId)?.steps.get(plan.stepId)?.attempts.get(plan.attempt);
  if (ended?.phase !== 'finished' || ended.outcome.kind !== 'succeeded') return false;
  const entry = planOf(ended.outcome.output)?.subOrders.find(({ id }) => id === plan.entry);
  return entry?.ready === false;
};

/** Why `row`'s sub-order keeps the order open, or undefined: merged, or only waiting. */
const leftWhy = (state: State, row: SubOrderPullRequest): LeftWhy | undefined => {
  if (row.state === 'merged') return undefined;
  const subOrder = state.subOrders.get(row.subOrder);
  if (subOrder === undefined) return undefined;
  const latest = subOrder.batchIds.at(-1);
  if (latest === undefined) return notReady(state, subOrder) ? 'needs refinement' : undefined;
  if (state.batches.get(latest)?.lane.kind === 'cancelled') return 'cancelled';
  // A newer batch brewing again is only waiting.
  const closed = row.state === 'closed' && openedPullRequest(state, latest) === row.pullRequest;
  return closed ? 'closed without merging' : undefined;
};

/** The sub-orders order `order`'s latest breakdown keeps, in merge order, as rows. */
export const subOrderRows = (state: State, order: number): SubOrderRow[] =>
  subOrderPullRequests(state, order).map((row) => {
    const latest = state.subOrders.get(row.subOrder)?.batchIds.at(-1);
    const lane = latest === undefined ? undefined : state.batches.get(latest)?.lane.kind;
    const release = row.state === 'merged' ? releaseAfterMerge(state, row.subOrder) : undefined;
    const left = leftWhy(state, row);
    return {
      ...row,
      ...(lane === undefined ? {} : { lane }),
      ...(release === undefined ? {} : { release }),
      ...(left === undefined ? {} : { left }),
    };
  });

/**
 * The end of an order with `rows`, or undefined for one with none. Done needs every pull request
 * merged and no release: a release a sub-order waited for is behind its merge already.
 */
export const orderEnd = (rows: readonly SubOrderRow[]): OrderEnd | undefined => {
  if (rows.length === 0) return undefined;
  const pullRequests = rows.flatMap(({ state, pullRequest }) =>
    state === 'merged' && pullRequest !== undefined ? [pullRequest] : [],
  );
  if (pullRequests.length === rows.length) return { kind: 'done', pullRequests };
  return {
    kind: 'open',
    left: rows.flatMap(({ subOrder, left }) =>
      left === undefined ? [] : [{ subOrder, why: left }],
    ),
  };
};
