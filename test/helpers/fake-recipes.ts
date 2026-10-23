// A fake of the Brewery's recipes for state machine tests: steps in a line, with optional loops back.

import type { Recipe, RecipeAction, Recipes, Stall } from '../../src/engine/recipes.ts';

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
  /** The steps that are actions the engine runs itself, by step id; default none (ADR 0071). */
  actions?: Readonly<Record<string, RecipeAction>>;
  pullRequests?: readonly string[];
  /** The steps whose attempts merge the base before they run (ADR 0164); default none. */
  merges?: readonly string[];
}

export const hour = 3_600_000;

export const fakeRecipe = ({
  steps,
  stall,
  maxAttempts = 2,
  skips = {},
  routes = {},
  actions = {},
  pullRequests = ['https://github.com/acme/api/pull/7'],
  merges = [],
}: FakeRecipe): Recipe => {
  const [firstStep] = steps;
  if (firstStep === undefined) throw new Error('A recipe needs a step');
  // The step that opens the pull request, which the batch goes on tap with (ADR 0071).
  const opens = steps.find((stepId) => actions[stepId] === 'openPullRequest');
  return {
    firstStep,
    steps,
    has: (stepId) => steps.includes(stepId),
    action: (stepId) => actions[stepId],
    mergesBase: (stepId) => merges.includes(stepId),
    deadlineMs: () => hour,
    stall: () => stall,
    skip: (_batch, stepId) => skips[stepId],
    after: (_batch, stepId) => {
      const next = steps[steps.indexOf(stepId) + 1];
      if (next !== undefined) return { kind: 'step', stepId: next };
      return opens === undefined
        ? { kind: 'done', pullRequests }
        : { kind: 'done', pullRequests, opens };
    },
    mayRetry: (batch, stepId) => (batch.steps.get(stepId)?.attempts.size ?? 0) < maxAttempts,
    loopBack: (_batch, stepId, why) => routes[stepId]?.[why],
  };
};

export const fakeRecipes = (recipes: Readonly<Record<string, Recipe>>): Recipes => ({
  find: (name) => recipes[name],
});
