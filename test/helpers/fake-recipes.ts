// A fake of the Brewery's recipes for state machine tests: steps in a line, with optional loops back.

import type { Recipe, RecipeAction, Recipes, RouteWhy, Stall } from '../../src/engine/recipes.ts';

export interface FakeRecipe {
  steps: readonly string[];
  /** The stall limit of every step; default none. */
  stall?: Stall;
  /** Attempts per step before the batch is Stuck; default 2. */
  maxAttempts?: number;
  /** The `when` that is false for each step the batch skips, by step id; default none. */
  skips?: Readonly<Record<string, string>>;
  /**
   * Where a failed check, a step blocked by findings or an open pull request that failed (ADR 0219)
   * goes back to, by step id.
   */
  routes?: Readonly<Record<string, Partial<Record<RouteWhy, string>>>>;
  /** The rounds of every route; default no limit. */
  maxRounds?: number;
  /** The steps that are actions the engine runs itself, by step id; default none (ADR 0071). */
  actions?: Readonly<Record<string, RecipeAction>>;
  pullRequests?: readonly string[];
  /** The steps whose attempts merge the base before they run (ADR 0164); default none. */
  merges?: readonly string[];
  /** The children of each step that is a parallel group, by its id (ADR 0168); default none. */
  groups?: Readonly<Record<string, readonly string[]>>;
  /** The interactive steps, whose attempts run as a person's session (ADR 0222); default none. */
  interactive?: readonly string[];
  /** The steps whose answer chooses the batch's recipe (ADR 0232); default none. */
  chooses?: readonly string[];
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
  groups = {},
  interactive = [],
  chooses = [],
  maxRounds = Number.POSITIVE_INFINITY,
}: FakeRecipe): Recipe => {
  const [firstStep] = steps;
  if (firstStep === undefined) throw new Error('A recipe needs a step');
  // The step that opens the pull request, which the batch goes on tap with (ADR 0071).
  const opens = steps.find((stepId) => actions[stepId] === 'openPullRequest');
  const groupOf = (stepId: string): string | undefined =>
    Object.entries(groups).find(([, children]) => children.includes(stepId))?.[0];
  // As the loaded recipe does, a route counts the attempts of its goto step it scheduled.
  const roundsOf: Recipe['rounds'] = (batch, stepId, why) => {
    const goto = routes[stepId]?.[why];
    if (goto === undefined) return undefined;
    const attempts = [...(batch.steps.get(goto)?.attempts.values() ?? [])];
    return attempts.filter(({ route }) => route?.from === stepId && route.why === why).length;
  };
  return {
    firstStep,
    steps: steps.flatMap((stepId) => groups[stepId] ?? [stepId]),
    has: (stepId) => steps.includes(stepId) || groupOf(stepId) !== undefined,
    children: (stepId) => groups[stepId],
    group: groupOf,
    interactive: (stepId) => interactive.includes(stepId),
    choosesRecipe: (stepId) => chooses.includes(stepId),
    action: (stepId) => actions[stepId],
    mergesBase: (stepId) => merges.includes(stepId),
    // As the loaded recipe does, a parallel group has no deadline: only its children are scheduled.
    deadlineMs: (stepId) => {
      if (groups[stepId] !== undefined) throw new Error(`${stepId} is a parallel group`);
      return hour;
    },
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
    rounds: roundsOf,
    maxRounds: (stepId, why) => (routes[stepId]?.[why] === undefined ? undefined : maxRounds),
    loopBack: (batch, stepId, why) =>
      (roundsOf(batch, stepId, why) ?? 0) < maxRounds ? routes[stepId]?.[why] : undefined,
    routesTo: (stepId, why) => routes[stepId]?.[why],
  };
};

export const fakeRecipes = (recipes: Readonly<Record<string, Recipe>>): Recipes => ({
  find: (name) => recipes[name],
});
