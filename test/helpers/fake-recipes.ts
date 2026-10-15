// A fake recipe book for state machine tests: steps in a line, with optional routes back.

import type { Recipe, RecipeBook } from '../../src/engine/recipes.ts';

export interface FakeRecipe {
  steps: readonly string[];
  /** Attempts per step before the batch is Stuck; default 2. */
  maxAttempts?: number;
  /** Where a failed check or a step blocked by findings goes back to, by step id. */
  routes?: Readonly<Record<string, { failed?: string; findings?: string }>>;
  pullRequests?: readonly string[];
}

export const hour = 3_600_000;

export const fakeRecipe = ({
  steps,
  maxAttempts = 2,
  routes = {},
  pullRequests = ['https://github.com/acme/api/pull/7'],
}: FakeRecipe): Recipe => {
  const [firstStep] = steps;
  if (firstStep === undefined) throw new Error('A recipe needs a step');
  return {
    firstStep,
    has: (stepId) => steps.includes(stepId),
    deadlineMs: () => hour,
    after: (_batch, stepId) => {
      const next = steps[steps.indexOf(stepId) + 1];
      return next === undefined ? { kind: 'done', pullRequests } : { kind: 'step', stepId: next };
    },
    mayRetry: (batch, stepId) => (batch.steps.get(stepId)?.attempts.size ?? 0) < maxAttempts,
    routeBack: (_batch, stepId, why) => routes[stepId]?.[why],
  };
};

export const fakeRecipeBook = (recipes: Readonly<Record<string, Recipe>>): RecipeBook => ({
  find: (name) => recipes[name],
});
