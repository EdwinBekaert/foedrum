// What a person reads a batch as (ADR 0385): one of four states, worked out here from its lane and
// shown alike by the status comment, the plan comment, `foedrum status` and `foedrum stuck`. The
// lanes stay the engine's; each surface writes its own few words after the state's.

import type { Batch } from './fold.ts';
import { orderEnd, type SubOrderRow } from './order-end.ts';
import { atGate, planApproval } from './plan-applied.ts';

/** What a batch waits for a person to do. */
export type WaitingFor =
  | { kind: 'approve' }
  /** A human gate's go (ADR 0383). */
  | { kind: 'go' }
  | { kind: 'answer' }
  | { kind: 'session' }
  | { kind: 'stopped'; by: string }
  | { kind: 'failure' }
  | { kind: 'merge'; pullRequests: readonly string[] }
  | { kind: 'open_order'; subOrders: readonly number[] };

/** How a batch ended. */
export type DoneHow =
  | { kind: 'pull_requests'; merged: readonly string[]; closed: readonly string[] }
  | { kind: 'sub_orders' }
  | { kind: 'cancelled'; by: string; via: string }
  | { kind: 'no_pull_request' };

export type BatchState =
  | { kind: 'running'; subOrders?: readonly number[] }
  | { kind: 'queued' }
  | { kind: 'waiting'; for: WaitingFor }
  | { kind: 'done'; how: DoneHow };

/** The state's own words, as `foedrum status` writes them; the comments capitalise the first. */
export const stateWords: Record<BatchState['kind'], string> = {
  running: 'running',
  queued: 'queued',
  waiting: 'waiting for you',
  done: 'done',
};

/** `batch`'s state, with `rows`, its order's sub-orders in merge order once it is split. */
export const batchState = (batch: Batch, rows: readonly SubOrderRow[] = []): BatchState => {
  const { lane } = batch;
  switch (lane.kind) {
    case 'ordered':
    case 'conditioning':
      return { kind: 'queued' };
    case 'brewing':
      return { kind: 'running' };
    case 'stuck':
      return { kind: 'waiting', for: stuckFor(batch, lane.reason) };
    case 'on_tap': {
      const ends = batch.pullRequestEnds ?? {};
      const open = lane.pullRequests.filter((url) => ends[url] === undefined);
      if (open.length > 0) return { kind: 'waiting', for: { kind: 'merge', pullRequests: open } };
      if (lane.pullRequests.length > 0) {
        const merged = lane.pullRequests.filter((url) => ends[url] === 'merged');
        const closed = lane.pullRequests.filter((url) => ends[url] === 'closed');
        return { kind: 'done', how: { kind: 'pull_requests', merged, closed } };
      }
      // A plan a person approved hands its work to its sub-orders (ADR 0281, ADR 0293); a human
      // gate's go hands it to nothing (ADR 0383).
      if (planApproval(batch) === undefined && rows.length === 0) {
        return { kind: 'done', how: { kind: 'no_pull_request' } };
      }
      const end = orderEnd(rows);
      if (end?.kind === 'done') return { kind: 'done', how: { kind: 'sub_orders' } };
      if (end !== undefined && end.left.length > 0) {
        const subOrders = end.left.map(({ subOrder }) => subOrder);
        return { kind: 'waiting', for: { kind: 'open_order', subOrders } };
      }
      return { kind: 'running', subOrders: rows.map(({ subOrder }) => subOrder) };
    }
    case 'cancelled':
      return { kind: 'done', how: { kind: 'cancelled', by: lane.by, via: lane.via } };
    // A lane this Foedrum cannot read: each surface shows the batch as one it cannot read (ADR 0335).
    default: {
      const unhandled: never = lane;
      throw new Error(`Unhandled lane ${JSON.stringify(unhandled)}`);
    }
  }
};

const stuckFor = (
  batch: Batch,
  reason: Extract<Batch['lane'], { kind: 'stuck' }>['reason'],
): WaitingFor => {
  switch (reason.kind) {
    case 'plan_review':
      return atGate(batch, reason) ? { kind: 'go' } : { kind: 'approve' };
    case 'needs_input':
    case 'order_changed':
      return { kind: 'answer' };
    case 'waiting_for_session':
      return { kind: 'session' };
    case 'stopped':
      return { kind: 'stopped', by: reason.by };
    case 'blocked':
    case 'attempts_exhausted':
    case 'deadline_passed':
    case 'failing':
    case 'stalled':
    case 'routing':
    case 'pull_request_failed':
      return { kind: 'failure' };
    default: {
      const unhandled: never = reason;
      throw new Error(`Unhandled stuck reason ${JSON.stringify(unhandled)}`);
    }
  }
};

/**
 * What a batch waits for, in the few words every surface shows after "waiting for you"; `name`
 * writes a person's login as the surface shows it.
 */
export const waitingWords = (waiting: WaitingFor, name: (text: string) => string): string => {
  switch (waiting.kind) {
    case 'approve':
      return 'approve the plan';
    case 'go':
      return 'give your go';
    case 'answer':
      return 'answer a question';
    case 'session':
      return 'open its session';
    case 'stopped':
      return `stopped by ${name(waiting.by)} (retry or cancel)`;
    case 'failure':
      return 'look at a failure';
    case 'merge':
      return 'merge a pull request';
    case 'open_order':
      return 'see to what keeps the order open';
    default:
      return waiting satisfies never;
  }
};
