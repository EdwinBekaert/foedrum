// `foedrum status`: every batch with its issue and lane (architecture §4.3), and what it is doing
// or waiting for, and what its attempts took. The lane's words are shared with replay.

import { orderName } from '../engine/claim-orders.ts';
import type { Batch, State } from '../engine/fold.ts';
import { totalParts } from '../engine/receipt.ts';
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

const stuckOn = (reason: StuckReason): string => {
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
      return `waiting for a session at ${reason.stepId}`;
    case 'stalled':
      return `stalled at ${reason.stepId} since ${reason.lastProgressAt}`;
    case 'routing':
      return `not routed by ${reason.deadlineAt}`;
    default: {
      const unhandled: never = reason;
      throw new Error(`Unhandled stuck reason ${JSON.stringify(unhandled)}`);
    }
  }
};

// The latest attempt of each step that is still under way; an abandoned one never will be.
const underWay = (batch: Batch): string[] =>
  [...batch.steps.values()].flatMap((step) => {
    const attempt = [...step.attempts.values()].at(-1);
    if (attempt === undefined || attempt.phase === 'finished' || attempt.abandoned) return [];
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
      return { lane: 'stuck', detail: `${stuckOn(lane.reason)}; reminder ${lane.remindAt}` };
    case 'on_tap':
      return { lane: 'on tap', detail: lane.pullRequests.join(' ') };
    case 'cancelled':
      return { lane: 'cancelled', detail: `by ${lane.by} via ${lane.via}` };
    default: {
      const unhandled: never = lane;
      throw new Error(`Unhandled lane ${JSON.stringify(unhandled)}`);
    }
  }
};

/** The issue a batch brews: `#<n>` in the Brewery, `<owner>/<name>#<n>` in a target repository. */
export const issueOf = (batch: Batch): string => `${batch.repo ?? ''}#${batch.issue}`;

/**
 * What `foedrum status` prints: one line per batch, in the order they were ordered, with the
 * owner of an `interactive` driver that holds it (ADR 0123), then the `kept` lines of the
 * task-tree branches the cleanup keeps (ADR 0092).
 */
export const formatStatus = (
  state: State,
  kept: readonly string[] = [],
  interactive: ReadonlyMap<string, string> = new Map(),
): string => {
  const batches = [...state.batches.values()];
  if (batches.length === 0) return 'No batches.\n';
  const rows = batches.map((batch) => {
    const { lane, detail } = describeLane(batch);
    const owner = interactive.get(batch.id);
    const by = owner === undefined ? [] : [`brewed interactively by ${owner}`];
    // What its attempts took, summed (ADR 0172).
    const total = totalParts(batch).join(' · ');
    return [
      batch.id,
      orderName(state, batch),
      lane,
      [detail, ...by, total].filter((part) => part !== '').join('; '),
    ];
  });
  const count = `${batches.length} ${batches.length === 1 ? 'batch' : 'batches'}`;
  const after = kept.length === 0 ? [] : ['', ...kept];
  return `${[count, '', ...columns(rows), ...after].join('\n')}\n`;
};
