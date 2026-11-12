// `foedrum stuck`: every Stuck batch with why, what it offers, and the questions it asks, numbered
// in the order `foedrum answer` takes their answers.

import { calledAs, orderName } from '../engine/claim-orders.ts';
import type { Batch, State } from '../engine/fold.ts';
import { issueUrl, ORDER_CHANGED_QUESTION } from '../engine/order-changes.ts';
import { withoutSecrets } from '../engine/out-doc-text.ts';
import { findingText, knownCommits } from '../engine/pull-request.ts';
import { longest, planNextStep, roundsText, STEP_BACK } from '../engine/status-comment.ts';
import type { StuckReason } from '../schemas/events.ts';
import { columns } from './columns.ts';
import { describeState, failingParts, issueOf, unreadable } from './status.ts';

/** A Stuck batch's state (ADR 0385), what it waits for, and why. */
const stuckHead = (state: State, batch: Batch): string => {
  const { state: now, detail } = describeState(state, batch);
  return `${now}: ${detail}`;
};

/**
 * The open findings a findings route that ran out of rounds left, one line each with secrets left
 * out, and the recommendation to step back (ADR 0192); nothing for any other reason.
 */
const openLines = (state: State, batch: Batch, reason: StuckReason): string[] => {
  if (reason.kind !== 'blocked' || reason.roundsOut === undefined) return [];
  const { stepId, roundsOut } = reason;
  const isCommit = knownCommits(state, batch.id);
  const shown = (text: string): string => {
    const line = withoutSecrets(text, stepId, isCommit).replace(/\s+/g, ' ').trim();
    return line.length <= longest ? line : `${line.slice(0, longest - 1)}…`;
  };
  const listed = roundsOut.open.map(
    (finding) => `    ${shown(findingText(finding))}: ${shown(finding.why)}`,
  );
  if (roundsOut.more > 0) listed.push(`    and ${roundsOut.more} more`);
  const after = roundsText(roundsOut.rounds);
  return [
    ...(listed.length === 0
      ? [`  still open after ${after}: no finding was recorded`]
      : [`  still open after ${after}:`, ...listed]),
    `  ${STEP_BACK}`,
  ];
};

/** What `foedrum stuck` prints: each Stuck batch, in the order they were ordered. */
export const formatStuck = (state: State): string => {
  const stuck = [...state.batches.values()].flatMap((batch) =>
    batch.lane.kind === 'stuck' ? [{ batch, lane: batch.lane }] : [],
  );
  // A batch marked failing that is not Stuck: on tap, say, which no other line here shows (ADR 0335).
  const marked = [...state.batches.values()].flatMap((batch) =>
    batch.lane.kind === 'stuck'
      ? []
      : failingParts(batch).map(
          (part) => `${batch.id}  ${orderName(state, batch)}  ${batch.lane.kind}: ${part}`,
        ),
  );
  const also = marked.length === 0 ? [] : ['', ...marked];
  if (stuck.length === 0) return `${['No Stuck batches.', ...also].join('\n')}\n`;
  // One whose rendering throws is still listed, with what it offers (ADR 0335).
  const read = <T>(reading: () => T, instead: (error: unknown) => T): T => {
    try {
      return reading();
    } catch (error) {
      return instead(error);
    }
  };
  const heads = columns(
    stuck.map(({ batch }) =>
      read(
        () => [
          batch.id,
          orderName(state, batch),
          [stuckHead(state, batch), ...failingParts(batch)].join('; '),
        ],
        (error) => [batch.id, issueOf(batch), `stuck: ${unreadable(batch, error)}`],
      ),
    ),
    '',
  );
  const lines = stuck.flatMap(({ batch, lane }, i) => [
    heads[i] ?? '',
    `  options: ${lane.options.join(', ')}`,
    // A number means the latest batch: an older one's options run by its id (ADR 0334).
    ...read(
      () => (calledAs(state, batch) === batch.id ? [`  run as: foedrum <option> ${batch.id}`] : []),
      () => [],
    ),
    ...(lane.reason.kind === 'needs_input'
      ? lane.reason.questions.map(
          ({ q, options, recommended }, n) =>
            `  ${n + 1}. ${q} (${options.join(', ')}; recommended: ${recommended})`,
        )
      : []),
    // The issue that changed since its approval, and the one question (ADR 0368).
    ...(lane.reason.kind === 'order_changed' && batch.repo !== undefined
      ? [
          `  issue: ${issueUrl(batch.repo, batch.issue)}`,
          `  1. ${ORDER_CHANGED_QUESTION} (continue, stop)`,
        ]
      : []),
    ...read(
      () => openLines(state, batch, lane.reason),
      () => [],
    ),
    // What to do with a plan that waits for its review (ADR 0275, ADR 0281).
    ...(lane.reason.kind === 'plan_review'
      ? [`  next: ${planNextStep(calledAs(state, batch), (command) => command)}`]
      : []),
  ]);
  const count = `${stuck.length} Stuck ${stuck.length === 1 ? 'batch' : 'batches'}`;
  return `${[count, '', ...lines, ...also].join('\n')}\n`;
};
