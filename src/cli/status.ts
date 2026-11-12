// `foedrum status`: every batch with its issue and state (ADR 0385), and what it is doing or
// waiting for, and what its attempts took. The lane's words are shared with replay and brew.

import { batchState, type DoneHow, stateWords, waitingWords } from '../engine/batch-state.ts';
import { calledAs, claimOfOrder, claimOrderOf, orderName } from '../engine/claim-orders.ts';
import {
  attemptRecipeTypeOf,
  type Batch,
  type Failing,
  type Pause,
  runningAttempt,
  type State,
  stuckOnFailing,
} from '../engine/fold.ts';
import { changesText } from '../engine/order-changes.ts';
import { subOrderRows } from '../engine/order-end.ts';
import { pauseOf, stopAtText } from '../engine/pauses.ts';
import { totalParts } from '../engine/receipt.ts';
import { sessionCommand } from '../engine/status-comment.ts';
import { plainReason } from '../engine/supervisor.ts';
import { sameRepo } from '../engine/task-tree.ts';
import { usageWindowsText } from '../engine/usage-window.ts';
import { firstLineOf, messageOf } from '../platform/errors.ts';
import type { OrderRef, StuckReason, Usage, WaitCondition } from '../schemas/events.ts';
import { addUsage, number } from './brewer-report.ts';
import { columns } from './columns.ts';

const waitingFor = (on: WaitCondition): string => {
  switch (on.kind) {
    case 'merge':
      return `the merge of ${on.pullRequest}`;
    case 'release':
      return `${on.package} ${on.minVersion} or later in ${on.repo}`;
    case 'sibling':
      return `batch ${on.batchId}`;
    default: {
      const unhandled: never = on;
      throw new Error(`Unhandled wait ${JSON.stringify(unhandled)}`);
    }
  }
};

const stuckOn = (reason: StuckReason, called: string, { repo, issue }: Batch): string => {
  switch (reason.kind) {
    case 'needs_input':
      return `needs input at ${reason.stepId}`;
    case 'blocked':
      return `blocked at ${reason.stepId} (${reason.blockerKind}): ${reason.summary}`;
    case 'attempts_exhausted':
      return `attempts exhausted at ${reason.stepId} after ${reason.attempts}: ${plainReason(reason.lastReason)}`;
    case 'deadline_passed':
      return `deadline passed at ${reason.stepId} (${reason.deadlineAt})`;
    case 'waiting_for_session':
      return `waiting for a session at ${reason.stepId}: ${sessionCommand(called)} opens it in a terminal`;
    case 'failing':
      return `failing at ${reason.stepId} in ${reason.pass} since ${reason.since}: ${reason.summary}`;
    case 'stalled':
      return `stalled at ${reason.stepId} since ${reason.lastProgressAt}`;
    case 'routing':
      return `not routed by ${reason.deadlineAt}`;
    case 'pull_request_failed': {
      const after = `at ${reason.stepId} after ${reason.rounds} ${reason.rounds === 1 ? 'round' : 'rounds'}`;
      if (reason.cause === undefined) {
        return `${reason.pullRequest} failed its checks on ${reason.head} ${after}`;
      }
      if (reason.cause.kind === 'conflict') {
        const { branch, tip, files } = reason.cause;
        return `${reason.pullRequest} conflicts with ${branch} at ${tip} in ${files.join(', ')}, ${after}`;
      }
      if (reason.cause.kind === 'review') {
        const { reviews, more } = reason.cause;
        const asked = reviews.map(({ id, by }) => `review ${id} by ${by}`);
        const rest = more > 0 ? [`and ${more} more`] : [];
        return `${reason.pullRequest} got changes asked for on ${reason.head} ${after}: ${[...asked, ...rest].join(', ')}`;
      }
      const { branch, tip, check } = reason.cause;
      return `${reason.pullRequest} fails its checks on the merged tree with ${branch} at ${tip}: ${check}, ${after}`;
    }
    case 'plan_review':
      return `the plan of ${reason.stepId} #${reason.attempt} is ready for your review`;
    case 'stopped':
      return `stopped at ${reason.stepId} by ${reason.by} via ${reason.via}${reason.why === undefined ? '' : `: ${reason.why}`}`;
    case 'order_changed':
      return `the order changed at ${reason.stepId}: ${repo ?? ''}#${issue} changed after its approval: ${changesText(reason)}`;
    default: {
      const unhandled: never = reason;
      throw new Error(`Unhandled stuck reason ${JSON.stringify(unhandled)}`);
    }
  }
};

// The latest attempt of each step that is still under way; an abandoned one never will be.
const underWay = (batch: Batch): string[] =>
  [...batch.steps.values()].flatMap((step) => {
    const attempt = runningAttempt(step);
    if (attempt === undefined) return [];
    return [`${step.id} #${attempt.attempt} ${attempt.phase}`];
  });

/** A batch's lane, and what it is doing or waiting for there ('' when nothing). */
export const describeLane = (
  batch: Batch,
  /** How its lines name its work (`calledAs`, ADR 0329). */
  called: string,
): { lane: string; detail: string } => {
  const { lane } = batch;
  switch (lane.kind) {
    case 'ordered':
      return { lane: 'ordered', detail: `to be routed by ${lane.routeBy}` };
    case 'brewing':
      return { lane: 'brewing', detail: underWay(batch).join(', ') || 'between steps' };
    case 'conditioning':
      return {
        lane: 'conditioning',
        detail: `waiting for ${waitingFor(lane.on)}; reminder ${lane.remindAt}`,
      };
    case 'stuck':
      return {
        lane: 'stuck',
        detail: `${stuckOn(lane.reason, called, batch)}; reminder ${lane.remindAt}`,
      };
    case 'on_tap': {
      // A plan a person signed off is on tap with no pull request (ADR 0281).
      const { approval } = batch;
      const approved =
        approval === undefined ? [] : [`plan approved by ${approval.by} via ${approval.via}`];
      return { lane: 'on tap', detail: [...lane.pullRequests, ...approved].join(' ') };
    }
    case 'cancelled':
      return { lane: 'cancelled', detail: `by ${lane.by} via ${lane.via}` };
    default: {
      const unhandled: never = lane;
      throw new Error(`Unhandled lane ${JSON.stringify(unhandled)}`);
    }
  }
};

/** How an on-tap batch ended, in `foedrum status`'s words. */
const doneText = (how: DoneHow): string => {
  switch (how.kind) {
    case 'pull_requests':
      return [
        ...(how.merged.length === 0 ? [] : [`merged: ${how.merged.join(' ')}`]),
        ...(how.closed.length === 0 ? [] : [`closed without merging: ${how.closed.join(' ')}`]),
      ].join('; ');
    case 'sub_orders':
      return 'every sub-order merged';
    case 'no_pull_request':
      return 'no pull request';
    case 'cancelled':
      return `cancelled by ${how.by} via ${how.via}`;
    default:
      return how satisfies never;
  }
};

/**
 * A batch's state (ADR 0385), and what it does, waits for, or how it ended, as `foedrum status`
 * and `foedrum stuck` say it ('' when nothing).
 */
export const describeState = (state: State, batch: Batch): { state: string; detail: string } => {
  const rows = batch.decomposed === true ? subOrderRows(state, batch.issue) : [];
  const now = batchState(batch, rows);
  const words = stateWords[now.kind];
  const { lane } = batch;
  switch (now.kind) {
    case 'running':
    case 'queued': {
      // A split order runs while its sub-orders brew (ADR 0293).
      const numbers = now.kind === 'running' ? (now.subOrders ?? []) : [];
      if (lane.kind !== 'on_tap') {
        return { state: words, detail: describeLane(batch, calledAs(state, batch)).detail };
      }
      const named = numbers.length === 0 ? '' : ` (${numbers.map((n) => `#${n}`).join(', ')})`;
      return { state: words, detail: `the sub-orders brew${named}` };
    }
    case 'waiting': {
      const what = waitingWords(now.for, (login) => login);
      if (lane.kind === 'stuck') {
        // A plan's review needs nothing past its words; another reason says what it is.
        if (lane.reason.kind === 'plan_review') return { state: words, detail: what };
        // Who stopped it is in its words already.
        if (lane.reason.kind === 'stopped') {
          const { stepId, via, why } = lane.reason;
          const after = `at ${stepId} via ${via}${why === undefined ? '' : `: ${why}`}`;
          return { state: words, detail: `${what}: ${after}; reminder ${lane.remindAt}` };
        }
        const reason = stuckOn(lane.reason, calledAs(state, batch), batch);
        return { state: words, detail: `${what}: ${reason}; reminder ${lane.remindAt}` };
      }
      // The ones still open first, then how each other one ended.
      if (now.for.kind === 'merge' && lane.kind === 'on_tap') {
        const ends = batch.pullRequestEnds ?? {};
        const ended = doneText({
          kind: 'pull_requests',
          merged: lane.pullRequests.filter((url) => ends[url] === 'merged'),
          closed: lane.pullRequests.filter((url) => ends[url] === 'closed'),
        });
        const open = `${what}: ${now.for.pullRequests.join(' ')}`;
        return { state: words, detail: [open, ended].filter((part) => part !== '').join('; ') };
      }
      if (now.for.kind === 'open_order') {
        const named = now.for.subOrders.map((n) => `#${n}`).join(', ');
        return { state: words, detail: `${what} (${named})` };
      }
      return { state: words, detail: what };
    }
    case 'done':
      return { state: words, detail: doneText(now.how) };
    default:
      return now satisfies never;
  }
};

/**
 * Who paused a batch, with the surface when `via`, and why, and when what still runs is stopped
 * (ADR 0202).
 */
export const pauseLine = ({ by, via, why, stopAt }: Pause, withVia = false): string =>
  [
    `by ${by}${withVia ? ` via ${via}` : ''}${why === undefined ? '' : `: ${why}`}`,
    ...(stopAt === undefined ? [] : [`what still runs is stopped at ${stopAtText(stopAt)}`]),
  ].join('; ');

/** The issue a batch brews: `#<n>` in the Brewery, `<owner>/<name>#<n>` in a target repository. */
export const issueOf = (batch: Batch): string => `${batch.repo ?? ''}#${batch.issue}`;

/** A batch's mark as it reads (ADR 0335). */
const failingText = ({ pass, since, summary }: Failing): string =>
  `failing in ${pass} since ${since}: ${summary}`;

/** A batch's mark, but on a batch whose Stuck reason says it already. */
export const failingParts = ({ failing, lane }: Batch): string[] =>
  failing === undefined || stuckOnFailing(lane) ? [] : [failingText(failing)];

/**
 * What a batch's line says when its rendering throws (ADR 0335): the message on its one line, and
 * the mark whatever the lane, since its reason cannot say it now.
 */
export const unreadable = ({ failing }: Batch, error: unknown): string =>
  [
    `cannot be read: ${firstLineOf(messageOf(error))}`,
    ...(failing === undefined ? [] : [failingText(failing)]),
  ].join('; ');

/**
 * A batch's cells in `foedrum status`: its id, order, lane, and what it does, with the owner of an
 * `interactive` driver that holds it (ADR 0123) and what its attempts took.
 */
export const statusRow = (
  state: State,
  batch: Batch,
  interactive: ReadonlyMap<string, string> = new Map(),
): string[] => {
  const failing = failingParts(batch);
  // A batch whose rendering throws is still shown, with its mark, and the board goes on (ADR 0335).
  try {
    const { state: now, detail } = describeState(state, batch);
    const pause = pauseOf(state, batch);
    const paused = pause === undefined ? [] : [`paused ${pauseLine(pause)}`];
    const owner = interactive.get(batch.id);
    const by = owner === undefined ? [] : [`brewed interactively by ${owner}`];
    // What its attempts took, summed (ADR 0172), in ASCII: a pipe on Windows decodes the output
    // with its code page.
    const total = totalParts(batch).join(' / ');
    return [
      batch.id,
      orderName(state, batch),
      now,
      [detail, ...failing, ...paused, ...by, total].filter((part) => part !== '').join('; '),
    ];
  } catch (error) {
    return [batch.id, issueOf(batch), batch.lane.kind, unreadable(batch, error)];
  }
};

/**
 * What `foedrum status` prints: one line per batch, in the order they were ordered, with the
 * owner of an `interactive` driver that holds it (ADR 0123), then the `kept` lines of the
 * task-tree branches the cleanup keeps (ADR 0092); above the board, the `held` lines of the limits
 * that hold (ADR 0217).
 */
export const formatStatus = (
  state: State,
  kept: readonly string[] = [],
  interactive: ReadonlyMap<string, string> = new Map(),
  held: readonly string[] = [],
): string => {
  const batches = [...state.batches.values()];
  // Above the board: each holds every batch's brewers, or those of its family (ADR 0206, ADR 0215),
  // then each limit that holds what the intake starts (ADR 0217).
  const lines = [...usageWindowsText(state.usageWindows), ...held];
  const window = lines.length === 0 ? [] : [...lines, ''];
  if (batches.length === 0) return `${[...window, 'No batches.'].join('\n')}\n`;
  const rows = batches.map((batch) => statusRow(state, batch, interactive));
  const count = `${batches.length} ${batches.length === 1 ? 'batch' : 'batches'}`;
  const after = kept.length === 0 ? [] : ['', ...kept];
  return `${[...window, count, '', ...columns(rows), ...after].join('\n')}\n`;
};

/**
 * The batches of `order`, in the order they were ordered: its own and its sub-orders' (ADR 0295).
 * A Brewery issue with no batch of its own is the order of the claimed issue it names (ADR 0144).
 * Sub-orders never plan again (ADR 0285), so one level holds them all.
 */
export const orderBatches = (state: State, order: OrderRef): Batch[] => {
  const all = [...state.batches.values()];
  const of = ({ issue, repo }: OrderRef) =>
    all.filter(
      (batch) =>
        batch.issue === issue &&
        (repo === undefined
          ? batch.repo === undefined
          : batch.repo !== undefined && sameRepo(batch.repo, repo)),
    );
  const own = of(order);
  if (own.length === 0 && order.repo === undefined) {
    const claimed = claimOfOrder(state, order.issue);
    // Only the claimed issue's batches whose order this Brewery issue is, not an earlier or a
    // later one's.
    if (claimed !== undefined) {
      return of(claimed).filter(({ id }) => claimOrderOf(state, id).issue === order.issue);
    }
  }
  if (order.repo !== undefined) return own;
  // Every sub-order it ever had, also one a later breakdown cancelled: its tokens were spent.
  const subOrders = [...state.subOrders.values()].filter((sub) => sub.order === order.issue);
  const ids = new Set([...own.map(({ id }) => id), ...subOrders.flatMap((sub) => sub.batchIds)]);
  return all.filter(({ id }) => ids.has(id));
};

/**
 * The usage of `batches`' attempts, split by the recipe each was scheduled under: a `mash`
 * recipe's is planning, any other's brewing (ADR 0365); an attempt that reported none adds nothing.
 */
const orderTokens = (state: State, batches: readonly Batch[]) => {
  const none = (): Usage => ({
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  });
  const tokens = { planning: none(), brewing: none() };
  for (const batch of batches) {
    for (const step of batch.steps.values()) {
      for (const attempt of step.attempts.values()) {
        if (attempt.phase !== 'finished') continue;
        const ref = { batchId: batch.id, stepId: step.id, attempt: attempt.attempt };
        const planning = attemptRecipeTypeOf(state, ref) === 'mash';
        addUsage(planning ? tokens.planning : tokens.brewing, attempt.usage);
      }
    }
  }
  return tokens;
};

/** `3,675 tokens (310 input, 65 output, 3,000 cache read, 300 cache write)`, or none reported. */
const usageText = (usage: Usage): string => {
  const { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens } = usage;
  const total = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
  if (total === 0) return 'none reported';
  return `${number(total)} tokens (${number(inputTokens)} input, ${number(outputTokens)} output, ${number(cacheReadTokens)} cache read, ${number(cacheWriteTokens)} cache write)`;
};

/**
 * What `foedrum status <order>` prints: the board of the order's `batches`, then what its planning
 * and its brewing took, never a cost (ADR 0181, ADR 0295).
 */
export const formatOrderStatus = (
  state: State,
  batches: readonly Batch[],
  interactive: ReadonlyMap<string, string>,
): string => {
  const rows = batches.map((batch) => statusRow(state, batch, interactive));
  const count = `${batches.length} ${batches.length === 1 ? 'batch' : 'batches'}`;
  const { planning, brewing } = orderTokens(state, batches);
  return `${[
    count,
    '',
    ...columns(rows),
    '',
    `planning: ${usageText(planning)}`,
    `brewing: ${usageText(brewing)}`,
  ].join('\n')}\n`;
};
