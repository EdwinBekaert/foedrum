// What a batch is to a person (ADR 0379): running, waiting for them and for what, queued, or done
// and how. One function works it out from the batch's lane; every surface renders its answer, and
// the lanes stay inside the engine.

import type { StuckReason, WaitCondition } from '../schemas/events.ts';
import { type Batch, batchEnded, runningAttempt, type State, unendedPullRequests } from './fold.ts';
import { type LeftWhy, orderEnd, type SubOrderRow, subOrderRows } from './order-end.ts';
import { pauseOf } from './pauses.ts';

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
  /** A sub-order with no batch yet: not ordered, as the sub-orders it depends on have not merged. */
  | { kind: 'not-ordered' };

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

/** What a person does about a batch Stuck for `reason`. */
const waitingOn = (reason: StuckReason): WaitingFor => {
  switch (reason.kind) {
    case 'plan_review':
      return { kind: 'approve-plan' };
    case 'needs_input':
    case 'order_changed':
      return { kind: 'answer' };
    case 'waiting_for_session':
      return { kind: 'open-session' };
    case 'routing':
      return { kind: 'choose-recipe' };
    case 'blocked':
    case 'attempts_exhausted':
    case 'deadline_passed':
    case 'failing':
    case 'stalled':
    case 'pull_request_failed':
    case 'stopped':
      return { kind: 'look-at-failure' };
    default: {
      // A reason a newer Foedrum recorded: a person still looks at it.
      const _unhandled: never = reason;
      return { kind: 'look-at-failure' };
    }
  }
};

/** How pressing a state is for its order: what waits for a person first, what is over last. */
const pressing: Record<BatchState['kind'], number> = { waiting: 0, running: 1, queued: 2, done: 3 };

/**
 * A split order's state: done once every sub-order merged (`orderEnd`), else its sub-orders' most
 * pressing, the first in merge order of those as pressing; a sub-order that keeps the order open
 * waits for a person to look at it.
 */
const splitState = (subOrders: readonly SubOrderState[]): BatchState => {
  if (subOrders.length === 0) return { kind: 'queued', by: { kind: 'sub-orders' } };
  if (orderEnd(subOrders.map(({ row }) => row))?.kind === 'done') {
    return { kind: 'done', how: 'merged' };
  }
  const states = subOrders.map(({ row, latest }): BatchState => {
    const subOrder = row.subOrder;
    if (row.left !== undefined) {
      return { kind: 'waiting', for: { kind: 'look-at-failure', left: row.left }, subOrder };
    }
    if (row.state === 'merged') return { kind: 'done', how: 'merged' };
    if (latest === undefined) return { kind: 'queued', by: { kind: 'not-ordered' }, subOrder };
    return latest.kind === 'done' ? latest : { ...latest, subOrder };
  });
  const most = Math.min(...states.map(({ kind }) => pressing[kind]));
  const first = states.find(({ kind }) => pressing[kind] === most);
  // Every sub-order is over but not merged; orderEnd names those as left, so this is unreachable.
  return first ?? { kind: 'queued', by: { kind: 'not-ordered' } };
};

/**
 * What `batch` is to a person. Done is the engine's own rule (`batchEnded`, and `orderEnd` for a
 * split order), plus a recipe that ended with no pull request.
 */
export const batchState = (batch: Batch, context: StateContext = {}): BatchState => {
  const { lane } = batch;
  switch (lane.kind) {
    case 'ordered':
      return {
        kind: 'queued',
        by: context.paused === true ? { kind: 'pause' } : { kind: 'recipe' },
      };
    case 'brewing': {
      if (context.paused === true) return { kind: 'queued', by: { kind: 'pause' } };
      const running = [...batch.steps.values()].some((step) => runningAttempt(step) !== undefined);
      if (context.usageHeld === true && !running) {
        return { kind: 'queued', by: { kind: 'usage-limit' } };
      }
      return { kind: 'running' };
    }
    case 'conditioning':
      return { kind: 'queued', by: { kind: 'wait', on: lane.on } };
    case 'stuck':
      return { kind: 'waiting', for: waitingOn(lane.reason) };
    case 'cancelled':
      return { kind: 'done', how: 'cancelled' };
    case 'on_tap': {
      if (batchEnded(batch)) {
        const closed = lane.pullRequests.some((url) => batch.pullRequestEnds?.[url] === 'closed');
        return { kind: 'done', how: closed ? 'closed without merging' : 'merged' };
      }
      const open = unendedPullRequests(batch);
      if (open.length > 0) {
        return { kind: 'waiting', for: { kind: 'review-and-merge', pullRequests: open } };
      }
      // A plan a person signed off hands its work to its sub-orders (ADR 0281, ADR 0293).
      if (batch.approval !== undefined) return splitState(context.subOrders ?? []);
      return { kind: 'done', how: 'no pull request' };
    }
    default:
      return lane satisfies never;
  }
};

/**
 * What `batch` is to a person, read from the store: its pause, the usage windows, and for a split
 * order its sub-orders' latest batches (ADR 0293), which never split again (ADR 0285).
 */
export const stateOf = (state: State, batch: Batch): BatchState => {
  const subOrders =
    batch.decomposed === true
      ? subOrderRows(state, batch.issue).map((row): SubOrderState => {
          const id = state.subOrders.get(row.subOrder)?.batchIds.at(-1);
          const latest = id === undefined ? undefined : state.batches.get(id);
          return latest === undefined ? { row } : { row, latest: stateOf(state, latest) };
        })
      : [];
  return batchState(batch, {
    paused: pauseOf(state, batch) !== undefined,
    // Only the window of every brewer holds a batch between steps: a family's holds only its own
    // brewers, and the next step may run on the other family or be a check (ADR 0215).
    usageHeld: state.usageWindows.all !== undefined,
    subOrders,
  });
};

/** What a batch in conditioning waits on, in words. */
export const waitedOn = (on: WaitCondition): string => {
  switch (on.kind) {
    case 'merge':
      return `the merge of ${on.pullRequest}`;
    case 'release':
      return `${on.package} ${on.minVersion} or later in ${on.repo}`;
    case 'sibling':
      return `batch ${on.batchId}`;
    default:
      return on satisfies never;
  }
};

const ofSubOrder = (subOrder: number | undefined): string =>
  subOrder === undefined ? '' : ` of sub-order #${subOrder}`;

const waitingText = (waiting: WaitingFor, subOrder: number | undefined): string => {
  switch (waiting.kind) {
    case 'approve-plan':
      return `approve the plan${ofSubOrder(subOrder)}`;
    case 'answer':
      return `answer a question${ofSubOrder(subOrder)}`;
    case 'review-and-merge': {
      const them = waiting.pullRequests.length === 1 ? 'the pull request' : 'the pull requests';
      return `review and merge ${them}${ofSubOrder(subOrder)}`;
    }
    case 'open-session':
      return `open its session${ofSubOrder(subOrder)}`;
    case 'choose-recipe':
      return `choose a recipe${ofSubOrder(subOrder)}`;
    case 'look-at-failure':
      if (waiting.left !== undefined && subOrder !== undefined) {
        return `look at sub-order #${subOrder}, ${waiting.left}`;
      }
      return subOrder === undefined
        ? 'look at a failure Foedrum could not get past'
        : `look at a failure of sub-order #${subOrder} that Foedrum could not get past`;
    default:
      return waiting satisfies never;
  }
};

/** What holds a queued batch, its sub-order first when it is a split order's (ADR 0379). */
const queuedText = (by: QueuedBy, subOrder: number | undefined): string => {
  const who = subOrder === undefined ? undefined : `sub-order #${subOrder}`;
  switch (by.kind) {
    case 'recipe':
      return who === undefined ? 'waiting for a recipe' : `${who} waits for a recipe`;
    case 'wait':
      return who === undefined
        ? `waiting for ${waitedOn(by.on)}`
        : `${who} waits for ${waitedOn(by.on)}`;
    case 'pause':
      return who === undefined ? 'paused' : `${who} is paused`;
    case 'usage-limit':
      return who === undefined ? 'held by a usage limit' : `${who} is held by a usage limit`;
    case 'sub-orders':
      return 'its sub-orders are being opened';
    case 'not-ordered':
      return who === undefined ? 'its sub-orders are not ordered yet' : `${who} is not ordered yet`;
    default:
      return by satisfies never;
  }
};

const doneText: Record<DoneHow, string> = {
  merged: 'merged',
  'closed without merging': 'closed without merging',
  cancelled: 'cancelled',
  'no pull request': 'finished with no pull request',
};

/** The state as the end of a sentence about the batch, such as `waiting for you: approve the plan`. */
export const stateClause = (state: BatchState): string => {
  const line = stateLine(state);
  return `${line.charAt(0).toLowerCase()}${line.slice(1)}`;
};

/** The state as one line of plain words, such as `Waiting for you: approve the plan`. */
export const stateLine = (state: BatchState): string => {
  switch (state.kind) {
    case 'running':
      return state.subOrder === undefined ? 'Running' : `Running: sub-order #${state.subOrder}`;
    case 'waiting':
      return `Waiting for you: ${waitingText(state.for, state.subOrder)}`;
    case 'queued':
      return `Queued: ${queuedText(state.by, state.subOrder)}`;
    case 'done':
      return `Done: ${doneText[state.how]}`;
    default:
      return state satisfies never;
  }
};
