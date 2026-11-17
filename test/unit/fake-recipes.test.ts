import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type Batch, fold, foldedBatch } from '../../src/engine/fold.ts';
import type { Event } from '../../src/schemas/events.ts';
import type { StepOutcome } from '../../src/schemas/step-outcome.ts';
import { fakeRecipe } from '../helpers/fake-recipes.ts';

const retryable: StepOutcome = { kind: 'failed', retryable: true, reason: 'out doc missing' };
const cancelled: StepOutcome = { kind: 'cancelled' };
/** A check that read the tree and found it failing. */
const read: StepOutcome = { kind: 'failed', retryable: false, reason: 'tests fail' };

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

  it("gives an action the loaded recipe's 3 attempts per round, whatever maxAttempts says", () => {
    const recipe = fakeRecipe({
      steps: ['open'],
      maxAttempts: 2,
      actions: { open: 'openPullRequest' },
    });
    assert.equal(recipe.mayRetry(batchWith('open', [retryable, retryable]), 'open'), true);
    assert.equal(
      recipe.mayRetry(batchWith('open', [retryable, retryable, retryable]), 'open'),
      false,
    );
  });

  it('gives a check step 3 attempts that read nothing, whatever maxAttempts says', () => {
    const recipe = fakeRecipe({ steps: ['green'], maxAttempts: 2, checks: ['green'] });
    assert.equal(recipe.mayRetry(batchWith('green', [cancelled, cancelled]), 'green'), true);
    assert.equal(
      recipe.mayRetry(batchWith('green', [cancelled, cancelled, cancelled]), 'green'),
      false,
    );
  });

  it('retries a check step cancelled after it read the tree: the reading closed its round', () => {
    const recipe = fakeRecipe({ steps: ['green'], maxAttempts: 2, checks: ['green'] });
    const batch = batchWith('green', [read, cancelled]);
    assert.equal(recipe.mayRetry(batch, 'green'), true);
  });

  it("retries a check step after readings that would use up an action's round", () => {
    const recipe = fakeRecipe({ steps: ['green'], checks: ['green'] });
    assert.equal(recipe.mayRetry(batchWith('green', [read, read, cancelled]), 'green'), true);
  });

  it("counts a check step's round from its latest attempt that read the tree", () => {
    const recipe = fakeRecipe({ steps: ['green'], checks: ['green'] });
    assert.equal(
      recipe.roundAttempts(batchWith('green', [cancelled, read, cancelled]), 'green'),
      1,
    );
  });
});
