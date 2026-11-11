// `foedrum replay <issue>`: the batch's events as stored, and the state the fold makes of them.

import { batchState } from '../engine/batch-state.ts';
import { calledAs } from '../engine/claim-orders.ts';
import type { StoredEvent } from '../engine/event-store.ts';
import { type Attempt, type Batch, emptyState, type Pause } from '../engine/fold.ts';
import { plainReason } from '../engine/supervisor.ts';
import { surfaceText } from '../engine/words.ts';
import type { MutantVerdict } from '../schemas/events.ts';
import type { StepOutcome } from '../schemas/step-outcome.ts';
import { columns } from './columns.ts';
import { describeState, issueOf, pauseLine } from './status.ts';

const outcomeOf = (outcome: StepOutcome): string => {
  switch (outcome.kind) {
    case 'succeeded':
      return 'succeeded';
    case 'failed':
      return `failed: ${plainReason(outcome.reason)}`;
    case 'needs_input':
      return 'needs input';
    case 'cancelled':
      return 'cancelled';
    default: {
      const unhandled: never = outcome;
      throw new Error(`Unhandled outcome ${JSON.stringify(unhandled)}`);
    }
  }
};

const verdictOf = (verdict: MutantVerdict): string => {
  switch (verdict.kind) {
    case 'killed':
      return `killed by ${verdict.by}`;
    case 'survived':
      return 'survived';
    case 'timedOut':
      return 'timed out, so killed';
    case 'invalid':
      return `invalid, ${verdict.reason}`;
    case 'notJudged':
      return `not judged, ${verdict.why}`;
    default: {
      const unhandled: never = verdict;
      throw new Error(`Unhandled verdict ${JSON.stringify(unhandled)}`);
    }
  }
};

const attemptOf = (attempt: Attempt): string => {
  const number = `#${attempt.attempt}`;
  switch (attempt.phase) {
    case 'scheduled':
    case 'started':
      return `${number} ${attempt.phase}${attempt.abandoned ? ', abandoned' : ''}`;
    case 'finished':
      return `${number} finished: ${outcomeOf(attempt.outcome)}`;
    default: {
      const unhandled: never = attempt;
      throw new Error(`Unhandled attempt ${JSON.stringify(unhandled)}`);
    }
  }
};

// An event's fields without the type and batch, which its line already shows.
const fieldsOf = (event: StoredEvent['event']): string =>
  JSON.stringify(
    Object.fromEntries(
      Object.entries(event).filter(([key]) => key !== 'type' && key !== 'batchId'),
    ),
  );

/** What `foedrum replay` prints for a batch and the stored events that belong to it. */
export const formatReplay = (
  batch: Batch,
  events: readonly StoredEvent[],
  pause?: Pause,
  /** How its lane's lines name its work (`calledAs`, ADR 0329). */
  called: string = calledAs(emptyState, batch),
): string => {
  const idWidth = Math.max(...events.map(({ id }) => String(id).length));
  const { state, detail } = describeState(
    batch,
    batchState(batch, { paused: pause !== undefined }),
    called,
  );
  const { recipe } = batch;
  const lines = [
    `Batch ${batch.id}, issue ${issueOf(batch)}`,
    '',
    'Events',
    ...columns(
      events.map(({ id, event }) => [String(id).padStart(idWidth), event.type, fieldsOf(event)]),
    ),
    '',
    'State',
    `  state   ${state}${detail === '' ? '' : `: ${detail}`}`,
  ];
  // The pause that holds it now, with the surface it came from (ADR 0202).
  if (pause !== undefined) {
    lines.push(`  paused  ${pauseLine(pause, true)}`);
  }
  if (batch.parentBatchId !== undefined) lines.push(`  parent  ${batch.parentBatchId}`);
  if (recipe !== undefined) {
    const chooser =
      recipe.source === 'human' ? `${recipe.by} ${surfaceText[recipe.via]}` : recipe.source;
    lines.push(`  recipe  ${recipe.name}, chosen by ${chooser}: ${recipe.reason}`);
  }
  // The texts themselves are on the state branch, which keeps them past the worktrees (ADR 0103).
  const finished = [...batch.steps.values()].some((step) =>
    [...step.attempts.values()].some((attempt) => attempt.phase === 'finished'),
  );
  if (finished) {
    lines.push(`  out docs  on the state branch at batches/${batch.id}/<step>-<attempt>.md`);
  }
  if (batch.steps.size > 0) {
    lines.push(
      '  steps',
      ...columns(
        [...batch.steps.values()].map((step) => [
          step.id,
          [...step.attempts.values()].map(attemptOf).join('; '),
        ]),
        '    ',
      ),
    );
  }
  // Each Brett attempt's mutants and what the engine's runs found (ADR 0313).
  const mutants = [...batch.steps.values()].flatMap((step) =>
    [...step.attempts.values()].flatMap((attempt) =>
      attempt.phase === 'finished'
        ? (attempt.mutants ?? []).map(
            ({ file, line, description, verdict }) =>
              `    ${file}:${line} ${description}: ${verdictOf(verdict)} (${step.id}#${attempt.attempt})`,
          )
        : [],
    ),
  );
  if (mutants.length > 0) lines.push('  mutants', ...mutants);
  if (batch.rewinds.length > 0) {
    lines.push(
      '  rewinds',
      ...batch.rewinds.map(({ toStepId, by, via }) => `    to ${toStepId} by ${by} via ${via}`),
    );
  }
  return `${lines.join('\n')}\n`;
};
