// `foedrum replay <batch>`: the batch's events as stored, and the state the fold makes of them.

import type { StoredEvent } from '../engine/event-store.ts';
import type { Attempt, Batch } from '../engine/fold.ts';
import type { StepOutcome } from '../schemas/step-outcome.ts';
import { columns } from './columns.ts';
import { describeLane } from './status.ts';

const outcomeOf = (outcome: StepOutcome): string => {
  switch (outcome.kind) {
    case 'succeeded':
      return 'succeeded';
    case 'failed':
      return `failed: ${outcome.reason}`;
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
export const formatReplay = (batch: Batch, events: readonly StoredEvent[]): string => {
  const idWidth = Math.max(...events.map(({ id }) => String(id).length));
  const { lane, detail } = describeLane(batch);
  const { recipe } = batch;
  const lines = [
    `Batch ${batch.id}, issue #${batch.issue}`,
    '',
    'Events',
    ...columns(
      events.map(({ id, event }) => [String(id).padStart(idWidth), event.type, fieldsOf(event)]),
    ),
    '',
    'State',
    `  lane    ${lane}${detail === '' ? '' : `: ${detail}`}`,
  ];
  if (batch.parentBatchId !== undefined) lines.push(`  parent  ${batch.parentBatchId}`);
  if (recipe !== undefined) {
    const chooser = recipe.source === 'human' ? `${recipe.by} via ${recipe.via}` : recipe.source;
    lines.push(`  recipe  ${recipe.name}, chosen by ${chooser}: ${recipe.reason}`);
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
  if (batch.rewinds.length > 0) {
    lines.push(
      '  rewinds',
      ...batch.rewinds.map(({ toStepId, by, via }) => `    to ${toStepId} by ${by} via ${via}`),
    );
  }
  return `${lines.join('\n')}\n`;
};
