import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type Batch, fold, foldedBatch } from '../../src/engine/fold.ts';
import type { Event } from '../../src/schemas/events.ts';
import type { StepOutcome } from '../../src/schemas/step-outcome.ts';
import { fakeRecipe } from '../helpers/fake-recipes.ts';

const retryable: StepOutcome = { kind: 'failed', retryable: true, reason: 'out doc missing' };

/** Batch b1 with the attempts of `stepId` that ended in `outcomes`, in order. */
const batchWith = (stepId: string, outcomes: readonly StepOutcome[]): Batch =>
  foldedBatch(
    fold([
      {
        type: 'batch.ordered',
        batchId: 'b1',
        order: { issue: 100 },
        routeBy: '2026-12-31T00:00:00.000Z',
      },
      {
        type: 'batch.recipe_chosen',
        batchId: 'b1',
        recipe: 'pint',
        reason: 'feature label',
        source: 'label',
      },
      ...outcomes.flatMap((outcome, i): Event[] => [
        {
          type: 'step.scheduled',
          batchId: 'b1',
          stepId,
          attempt: i + 1,
          deadlineAt: '2026-10-15T13:00:00.000Z',
        },
        { type: 'step.started', batchId: 'b1', stepId, attempt: i + 1 },
        { type: 'step.finished', batchId: 'b1', stepId, attempt: i + 1, outcome },
      ]),
    ]),
    'b1',
  );

describe('fakeRecipe: the round and attempts of each kind of step', () => {
  it("gives a brewer step its recipe's maxAttempts per round", () => {
    const recipe = fakeRecipe({ steps: ['plan'], maxAttempts: 2 });
    assert.equal(recipe.mayRetry(batchWith('plan', [retryable]), 'plan'), true);
    assert.equal(recipe.mayRetry(batchWith('plan', [retryable, retryable]), 'plan'), false);
    assert.equal(recipe.roundAttempts(batchWith('plan', [retryable, retryable]), 'plan'), 2);
  });
});
