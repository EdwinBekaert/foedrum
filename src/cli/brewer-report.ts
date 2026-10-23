// `foedrum brewers` (ADR 0159): per brewer, the attempts of its steps, how they ended, the batches
// it holds Stuck and the tokens it used, from the folded events. A step's brewer comes from the
// recipe its batch chose, as the files are now; an attempt of a step they no longer have is listed
// apart, so none is dropped.

import { attemptKey } from '../engine/attempt-key.ts';
import type { Attempt, State } from '../engine/fold.ts';
import type { LoadedRecipes } from '../engine/recipe-files.ts';
import type { Event, Usage } from '../schemas/events.ts';

/** The brewers in use and what each recipe's step is now, from the loaded files. */
export interface BrewerSource {
  /** Every brewer in use, Brewery's and default, with its file. */
  brewers: readonly { name: string; path: string }[];
  /**
   * Step `stepId` of recipe `recipe` as the files have it, with its brewer's name when it is a
   * brewer step (a check or an action step has none), or `undefined` when no recipe of that name
   * has that step.
   */
  step: (recipe: string, stepId: string) => { brewer: string | undefined } | undefined;
}

/** How the started attempts ended: by outcome, and those not finished. */
export interface Outcomes {
  succeeded: number;
  failed: number;
  needs_input: number;
  cancelled: number;
  /** Started and not finished: running now, or abandoned when the batch went Stuck. */
  unfinished: number;
}

/** What the attempts of some steps did. */
export interface Tally {
  /** The attempts that started. */
  attempts: number;
  outcomes: Outcomes;
  /** The batches Stuck now at one of these steps, by id, in the order they were ordered. */
  stuck: readonly string[];
  /** The sum of the finished attempts' usage. */
  usage: Usage;
}

export interface BrewerReport {
  /** Every brewer in use, by name, also those with no attempt. */
  brewers: readonly (Tally & { name: string; path: string })[];
  /** The steps the recipe files no longer have (ADR 0059), by recipe and step. */
  gone: readonly (Tally & { recipe: string; stepId: string })[];
}

/** A `Tally` while the report fills it. */
type Counts = Tally & { stuck: string[] };

const counts = (): Counts => ({
  attempts: 0,
  outcomes: { succeeded: 0, failed: 0, needs_input: 0, cancelled: 0, unfinished: 0 },
  stuck: [],
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
});

const add = (tally: Counts, attempt: Attempt): void => {
  // One scheduled and never started did not run.
  if (attempt.phase === 'scheduled') return;
  tally.attempts += 1;
  if (attempt.phase === 'started') {
    tally.outcomes.unfinished += 1;
    return;
  }
  tally.outcomes[attempt.outcome.kind] += 1;
  const { usage } = attempt;
  if (usage === undefined) return;
  tally.usage.inputTokens += usage.inputTokens;
  tally.usage.outputTokens += usage.outputTokens;
  tally.usage.cacheReadTokens += usage.cacheReadTokens;
  tally.usage.cacheWriteTokens += usage.cacheWriteTokens;
};

/**
 * The recipe each attempt was scheduled under, by its `attemptKey`: a batch's steps keep the
 * attempts of the recipe it brewed before a person chose another (ADR 0159).
 */
export const recipesRun = (events: readonly Event[]): ReadonlyMap<string, string> => {
  const chosen = new Map<string, string>();
  const ran = new Map<string, string>();
  for (const event of events) {
    if (event.type === 'batch.recipe_chosen') chosen.set(event.batchId, event.recipe);
    if (event.type !== 'step.scheduled') continue;
    const recipe = chosen.get(event.batchId);
    if (recipe !== undefined) ran.set(attemptKey.encode(event), recipe);
  }
  return ran;
};

/**
 * The report over `state`, each attempt under its recipe in `ran` (`recipesRun` of the events
 * `state` folds) and each step's brewer from `source`.
 */
export const brewerReport = (
  state: State,
  source: BrewerSource,
  ran: ReadonlyMap<string, string>,
): BrewerReport => {
  const brewers = new Map(source.brewers.map(({ name, path }) => [name, { ...counts(), path }]));
  const gone = new Map<string, Counts & { recipe: string; stepId: string }>();
  // The counts of step `stepId` of `recipe`, or none for a step without a brewer.
  const tallyOf = (recipe: string, stepId: string): Counts | undefined => {
    const step = source.step(recipe, stepId);
    if (step === undefined) {
      const key = JSON.stringify([recipe, stepId]);
      const found = gone.get(key) ?? { ...counts(), recipe, stepId };
      gone.set(key, found);
      return found;
    }
    if (step.brewer === undefined) return undefined;
    const found = brewers.get(step.brewer) ?? { ...counts(), path: '' };
    brewers.set(step.brewer, found);
    return found;
  };
  for (const batch of state.batches.values()) {
    // A batch has steps only once a recipe was chosen.
    const recipe = batch.recipe?.name;
    if (recipe === undefined) continue;
    for (const step of batch.steps.values()) {
      for (const attempt of step.attempts.values()) {
        // `ran` has every attempt of the events `state` folds; the batch's recipe is the latest.
        const key = attemptKey.encode({
          batchId: batch.id,
          stepId: step.id,
          attempt: attempt.attempt,
        });
        const tally = tallyOf(ran.get(key) ?? recipe, step.id);
        if (tally !== undefined) add(tally, attempt);
      }
    }
    // A batch is Stuck at a step of the recipe it brews now.
    const { lane } = batch;
    if (lane.kind === 'stuck' && 'stepId' in lane.reason) {
      tallyOf(recipe, lane.reason.stepId)?.stuck.push(batch.id);
    }
  }
  const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  return {
    brewers: [...brewers]
      .sort(([a], [b]) => byName(a, b))
      .map(([name, tally]) => ({ name, ...tally })),
    gone: [...gone.values()].sort(
      (a, b) => byName(a.recipe, b.recipe) || byName(a.stepId, b.stepId),
    ),
  };
};

const number = (n: number): string => n.toLocaleString('en-US');

const outcomeNames: readonly [keyof Outcomes, string][] = [
  ['succeeded', 'succeeded'],
  ['failed', 'failed'],
  ['needs_input', 'needs input'],
  ['cancelled', 'cancelled'],
  ['unfinished', 'unfinished'],
];

// The attempts and how they ended, the tokens they used, and the batches Stuck at the steps; a
// batch can be Stuck at a step whose attempt never started.
const tallyLines = ({ attempts, outcomes, stuck, usage }: Tally): string[] => {
  const held = stuck.length === 0 ? [] : [`  Stuck: ${stuck.join(', ')}`];
  if (attempts === 0) return ['  no attempts', ...held];
  const ended = outcomeNames
    .filter(([kind]) => outcomes[kind] > 0)
    .map(([kind, name]) => `${number(outcomes[kind])} ${name}`);
  const { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens } = usage;
  const spent = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
  return [
    `  ${number(attempts)} ${attempts === 1 ? 'attempt' : 'attempts'}: ${ended.join(', ')}`,
    spent === 0
      ? '  tokens: none reported'
      : `  tokens: ${number(inputTokens)} input, ${number(outputTokens)} output, ${number(cacheReadTokens)} cache read, ${number(cacheWriteTokens)} cache write`,
    ...held,
  ];
};

/** What `foedrum brewers` prints. */
export const formatBrewerReport = ({ brewers, gone }: BrewerReport): string => {
  if (brewers.length === 0 && gone.length === 0) return 'No brewers.\n';
  const lines = [
    ...brewers.flatMap((brewer) => [`${brewer.name}  ${brewer.path}`, ...tallyLines(brewer)]),
    ...(gone.length === 0
      ? []
      : [
          '',
          'Steps the recipe files no longer have (ADR 0059):',
          ...gone.flatMap((step) => [`${step.recipe}/${step.stepId}`, ...tallyLines(step)]),
        ]),
  ];
  return `${lines.join('\n')}\n`;
};

/** What the report needs from the Brewery's loaded files. */
export type LoadedBrewers = Pick<
  Extract<LoadedRecipes, { valid: true }>,
  'recipes' | 'brewers' | 'catalog'
>;

/** The brewers in use and each recipe's steps, from the loaded files. */
export const brewerSource = ({ recipes, brewers, catalog }: LoadedBrewers): BrewerSource => ({
  brewers: catalog.brewers.map(({ name, path }) => ({ name, path })),
  step: (recipe, stepId) =>
    recipes.find(recipe)?.has(stepId) === true
      ? { brewer: brewers.find(recipe, stepId)?.brewer.name }
      : undefined,
});
