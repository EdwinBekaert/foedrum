// `foedrum status`: every batch with its issue and lane (architecture §4.3), and what it is doing
// or waiting for, and what its attempts took. The lane's words are shared with replay.

import { orderName } from '../engine/claim-orders.ts';
import { type Batch, type Pause, runningAttempt, type State } from '../engine/fold.ts';
import { pauseOf, stopAtText } from '../engine/pauses.ts';
import { totalParts } from '../engine/receipt.ts';
import { sessionCommand } from '../engine/status-comment.ts';
import { usageWindowsText } from '../engine/usage-window.ts';
import type { StuckReason, WaitCondition } from '../schemas/events.ts';
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

const stuckOn = (reason: StuckReason, batch: Batch): string => {
  switch (reason.kind) {
    case 'needs_input':
      return `needs input at ${reason.stepId}`;
    case 'blocked':
      return `blocked at ${reason.stepId} (${reason.blockerKind}): ${reason.summary}`;
    case 'attempts_exhausted':
      return `attempts exhausted at ${reason.stepId} after ${reason.attempts}: ${reason.lastReason}`;
    case 'deadline_passed':
      return `deadline passed at ${reason.stepId} (${reason.deadlineAt})`;
    case 'waiting_for_session':
      return `waiting for a session at ${reason.stepId}: ${sessionCommand(batch)} opens it in a terminal`;
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
      const { branch, tip, check } = reason.cause;
      return `${reason.pullRequest} fails its checks on the merged tree with ${branch} at ${tip}: ${check}, ${after}`;
    }
    case 'plan_review':
      return `the plan of ${reason.stepId} #${reason.attempt} is ready for your review`;
    case 'stopped':
      return `stopped at ${reason.stepId} by ${reason.by} via ${reason.via}${reason.why === undefined ? '' : `: ${reason.why}`}`;
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
export const describeLane = (batch: Batch): { lane: string; detail: string } => {
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
      return { lane: 'stuck', detail: `${stuckOn(lane.reason, batch)}; reminder ${lane.remindAt}` };
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

/**
 * A batch's cells in `foedrum status`: its id, order, lane, and what it does, with the owner of an
 * `interactive` driver that holds it (ADR 0123) and what its attempts took.
 */
export const statusRow = (
  state: State,
  batch: Batch,
  interactive: ReadonlyMap<string, string> = new Map(),
): string[] => {
  const { lane, detail } = describeLane(batch);
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
    lane,
    [detail, ...paused, ...by, total].filter((part) => part !== '').join('; '),
  ];
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
