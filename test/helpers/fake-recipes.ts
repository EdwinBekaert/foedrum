// A fake of the Brewery's recipes for state machine tests: steps in a line, with optional loops back.

import type { Recipe, Recipes, Stall } from '../../src/engine/recipes.ts';

export interface FakeRecipe {
  steps: readonly string[];
  /** The stall limit of every step; default none. */
  stall?: Stall;
  /** Attempts per step before the batch is Stuck; default 2. */
  maxAttempts?: number;
  /** The `when` that is false for each step the batch skips, by step id; default none. */
  skips?: Readonly<Record<string, string>>;
  /** Where a failed check or a step blocked by findings goes back to, by step id. */
  routes?: Readonly<Record<string, { failed?: string; findings?: string }>>;
  pullRequests?: readonly string[];
}

export const hour = 3_600_000;

export const fakeRecipe = ({
  steps,
  stall,
  maxAttempts = 2,
  skips = {},
  routes = {},
  pullRequests = ['https://github.com/acme/api/pull/7'],
}: FakeRecipe): Recipe => {
  const [firstStep] = steps;
  if (firstStep === undefined) throw new Error('A recipe needs a step');
  return {
    firstStep,
    steps,
    has: (stepId) => steps.includes(stepId),
    deadlineMs: () => hour,
    stall: () => stall,
    skip: (_batch, stepId) => skips[stepId],
    after: (_batch, stepId) => {
      const next = steps[steps.indexOf(stepId) + 1];
      return next === undefined ? { kind: 'done', pullRequests } : { kind: 'step', stepId: next };
    },
    mayRetry: (batch, stepId) => (batch.steps.get(stepId)?.attempts.size ?? 0) < maxAttempts,
    loopBack: (_batch, stepId, why) => routes[stepId]?.[why],
  };
};

export const fakeRecipes = (recipes: Readonly<Record<string, Recipe>>): Recipes => ({
  find: (name) => recipes[name],
});
