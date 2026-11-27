// The lasting lines `foedrum serve` prints for what a person must know (ADR 0434): what a batch did
// between two ticks, the cleanup of a batch and a read of GitHub that failed, in a person's words.

import { calledAs, orderName } from '../engine/claim-orders.ts';
import type { DriverNotice } from '../engine/driver.ts';
import { type Batch, foldedBatch, type State } from '../engine/fold.ts';
import type { IntakeNotice } from '../engine/intake.ts';
import { messageOf } from '../platform/errors.ts';
import { number } from './brewer-report.ts';
import { elapsed } from './live-line.ts';
import { stuckOn } from './status.ts';

/** The attempts of `batch`, each named `<step> #<n>`; none for a batch the other tick did not know. */
const attemptNames = (batch: Batch | undefined): Set<string> =>
  new Set(
    [...(batch?.steps.values() ?? [])].flatMap(({ id, attempts }) =>
      [...attempts.keys()].map((attempt) => `${id} #${attempt}`),
    ),
  );

/** Text a model wrote, on one line: whitespace of any kind, a line break too, becomes one space. */
const oneLine = (text: string): string => text.replace(/\s+/g, ' ');

/** The lines for the attempts of `batch` that ended since `before`, in the order of its steps. */
const endedLines = (name: string, batch: Batch, before: Batch | undefined): string[] =>
  [...batch.steps.values()].flatMap(({ id, attempts }) =>
    [...attempts.values()].flatMap((attempt) => {
      if (attempt.phase !== 'finished') return [];
      if (before?.steps.get(id)?.attempts.get(attempt.attempt)?.phase === 'finished') return [];
      const { usage, receipt } = attempt;
      const took = [
        ...(receipt?.durationMs === undefined ? [] : [elapsed(receipt.durationMs)]),
        ...(usage === undefined
          ? []
          : [`${number(usage.inputTokens)} input, ${number(usage.outputTokens)} output tokens`]),
      ];
      const said = `${name} ${id} #${attempt.attempt} ${attempt.outcome.kind.replace('_', ' ')}`;
      return [took.length === 0 ? said : `${said} (${took.join(', ')})`];
    }),
  );

/**
 * The lines for what changed in each batch from `before` to `after`, the folded states of two ticks:
 * a step that ended, a batch that got Stuck, a pull request that opened, merged or closed. No line
 * for a batch that stays as it was.
 */
export const lastingLines = (before: State, after: State): string[] =>
  [...after.batches.values()].flatMap((batch) => {
    const earlier = before.batches.get(batch.id);
    const name = orderName(after, batch);
    const called = calledAs(after, batch);
    const { lane } = batch;
    // A batch that was Stuck, moved on and got Stuck again for the same reason started an attempt
    // between the two ticks; a reminder of the same stop started none.
    const known = attemptNames(earlier);
    const movedOn = [...attemptNames(batch)].some((attempt) => !known.has(attempt));
    const stuck =
      lane.kind !== 'stuck' || (earlier?.lane.kind === 'stuck' && !movedOn)
        ? []
        : [
            `${name} is stuck: ${oneLine(stuckOn(lane.reason, called, batch))}; to move it on: ${lane.options.map((option) => `foedrum ${option} ${called}`).join(', ')}`,
          ];
    const tapped = earlier?.lane.kind === 'on_tap' ? earlier.lane.pullRequests : [];
    const opened =
      lane.kind !== 'on_tap'
        ? []
        : lane.pullRequests
            .filter((url) => !tapped.includes(url))
            .map((url) => `${name} opened pull request ${url}`);
    const ended = Object.entries(batch.pullRequestEnds ?? {})
      .filter(([url]) => earlier?.pullRequestEnds?.[url] === undefined)
      .map(
        ([url, end]) =>
          `${name} pull request ${url} was ${end === 'merged' ? 'merged' : 'closed without merging'}`,
      );
    return [...endedLines(name, batch, earlier), ...stuck, ...opened, ...ended];
  });

/** A pull request's link as `#<n>`, or the link itself when it is not a pull request's. */
const shortLink = (url: string): string => {
  const pull = /\/pull\/(\d+)$/.exec(url)?.[1];
  return pull === undefined ? url : `#${pull}`;
};

/** A batch's cleanup in a person's words, with the pull request `state` holds for the batch. */
export const cleanedLine = (
  notice: Extract<DriverNotice, { kind: 'cleaned' }>,
  state: State,
): string => {
  const batch = foldedBatch(state, notice.batchId);
  const { done, kept, failed } = notice.report;
  const copies = done.filter((line) => line.startsWith('removed worktree ')).length;
  // The branch the cleanup keeps for a check that fails on an open pull request (ADR 0219).
  const lastBranch = kept.filter((line) => line.includes('(ADR 0219)'));
  const rest = [...kept.filter((line) => !lastBranch.includes(line)), ...failed];
  // The pull request is named as the reason there was something to clean: a cleanup that found no
  // working copy does not repeat the line of the pull request's opening.
  const opened =
    copies > 0 && batch.lane.kind === 'on_tap' && batch.lane.pullRequests.length > 0
      ? ` opened pull request ${batch.lane.pullRequests.map(shortLink).join(', ')};`
      : '';
  const cleaned =
    copies === 0
      ? 'cleaned nothing'
      : `cleaned its ${copies} working cop${copies === 1 ? 'y' : 'ies'}`;
  const keeping =
    lastBranch.length === 0
      ? ''
      : ', keeping its last branch in case a check on the pull request fails';
  const more = rest.length === 0 ? '' : `; ${rest.join('; ')}`;
  return `${orderName(state, batch)}${opened} ${cleaned}${keeping}${more}`;
};

/**
 * An intake read that failed, in one line that says what failed and that the next pass tries
 * again; the raw error follows it only where no live line is drawn.
 */
export const readFailureLine = (
  notice: Extract<IntakeNotice, { kind: 'failed' }>,
  live: boolean,
): string =>
  live
    ? `the intake failed ${notice.what}; the next pass tries again`
    : `the intake failed ${notice.what}: ${messageOf(notice.error)}; the next pass tries again`;
