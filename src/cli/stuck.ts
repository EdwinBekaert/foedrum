// `foedrum stuck`: every batch that waits for you (ADR 0379), with why, what to do next, and the
// questions it asks, numbered in the order `foedrum answer` takes their answers.

import { stateLine, stateOf } from '../engine/batch-state.ts';
import { calledAs, orderName } from '../engine/claim-orders.ts';
import { type Batch, type State, unendedPullRequests } from '../engine/fold.ts';
import { stuckNext } from '../engine/next-step.ts';
import { issueUrl, ORDER_CHANGED_QUESTION } from '../engine/order-changes.ts';
import { withoutSecrets } from '../engine/out-doc-text.ts';
import { findingText, knownCommits } from '../engine/pull-request.ts';
import { longest, roundsText, STEP_BACK } from '../engine/status-comment.ts';
import type { StuckReason } from '../schemas/events.ts';
import { columns } from './columns.ts';
import { describeState, failingParts, issueOf, unreadable } from './status.ts';

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

/**
 * What `foedrum stuck` prints: each batch that waits for you (ADR 0379), in the order they were
 * ordered, with why and its `Next:` line. A split order that waits only through one of its
 * sub-orders is left out: that sub-order is listed itself.
 */
export const formatStuck = (state: State): string => {
  const waiting = [...state.batches.values()].flatMap((batch) => {
    const now = stateOf(state, batch);
    return now.kind === 'waiting' && now.subOrder === undefined ? [{ batch, now }] : [];
  });
  const listed = new Set(waiting.map(({ batch }) => batch.id));
  // A batch marked failing that waits for no one, which no other line here shows (ADR 0335).
  const marked = [...state.batches.values()].flatMap((batch) =>
    listed.has(batch.id)
      ? []
      : failingParts(batch).map(
          (part) =>
            `${batch.id}  ${orderName(state, batch)}  ${stateLine(stateOf(state, batch))}: ${part}`,
        ),
  );
  const also = marked.length === 0 ? [] : ['', ...marked];
  if (waiting.length === 0) return `${['Nothing waits for you.', ...also].join('\n')}\n`;
  // One whose rendering throws is still listed, with what it offers (ADR 0335).
  const read = <T>(reading: () => T, instead: (error: unknown) => T): T => {
    try {
      return reading();
    } catch (error) {
      return instead(error);
    }
  };
  const heads = columns(
    waiting.map(({ batch, now }) =>
      read(
        () => {
          const { state: shown, detail } = describeState(batch, now, calledAs(state, batch));
          return [
            batch.id,
            orderName(state, batch),
            [`${shown}:`, [detail, ...failingParts(batch)].filter((part) => part !== '').join('; ')]
              .filter((part) => part !== ':')
              .join(' '),
          ];
        },
        (error) => [batch.id, issueOf(batch), stateLine(now), unreadable(batch, error)],
      ),
    ),
    '',
  );
  const plainCommand = (text: string): string => text;
  const lines = waiting.flatMap(({ batch }, i) => {
    const { lane } = batch;
    const head = heads[i] ?? '';
    if (lane.kind !== 'stuck') {
      // On tap with a pull request open: a person reviews and merges it.
      const open = unendedPullRequests(batch);
      return [head, `  Next: review and merge ${open.join(', ')}.`];
    }
    const called = read(
      () => calledAs(state, batch),
      () => batch.id,
    );
    return [
      head,
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
      `  ${stuckNext(lane.reason, lane.options, called, plainCommand)}`,
    ];
  });
  const count = `${waiting.length} ${waiting.length === 1 ? 'batch waits' : 'batches wait'} for you`;
  return `${[count, '', ...lines, ...also].join('\n')}\n`;
};
