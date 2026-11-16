// The decisions of node scripts/flight.ts (#1083, ADR 0409): its options and their refusals, the
// recipe a Flight brews with one brewer swapped, the model each step asks for, the dry run's
// scripted brewers, a run's record and when it stops the Flight, and the one table. Nothing here
// starts a process; scripts/flight.ts brews the runs through scripts/tasting-compare/harness.ts.

import type { parseArgs } from 'node:util';
import { TEST_MAP_PATH } from '../../src/checks/test-map.ts';
import { effectKey } from '../../src/engine/effect-key.ts';
import { parseJsonc } from '../../src/formats/jsonc.ts';
import type { Killed } from '../../src/platform/processes.ts';
import type { Event, Usage } from '../../src/schemas/events.ts';
import { type Effort, ModelLevel } from '../../src/schemas/models.ts';
import { Recipe } from '../../src/schemas/recipe.ts';
import { PushResult } from '../../src/schemas/store.ts';
import type { Scripted } from '../../test/helpers/nip-fixture.ts';
import type { FlightOrder } from '../flight-orders.ts';
import {
  escapeCell,
  nextRunOf,
  type RunRecord,
  recordIn,
  runsOfSetup,
  scratchNameOf,
  tasterModelOf,
} from '../tasting-compare/core.ts';
import {
  FAMILIES,
  isAsked,
  type StepRun,
  stepModels,
  stepRunsOf,
} from '../tasting-compare/real.ts';

/** The options flight.ts reads, as `parseArgs` takes them. */
export const FLIGHT_OPTIONS = {
  recipe: { type: 'string' },
  brewer: { type: 'string' },
  model: { type: 'string' },
  effort: { type: 'string' },
  runs: { type: 'string' },
  'dry-run': { type: 'boolean' },
} as const;

/** The values `parseArgs` reads of `FLIGHT_OPTIONS`. */
export type FlightValues = ReturnType<
  typeof parseArgs<{ options: typeof FLIGHT_OPTIONS }>
>['values'];

/** The brewer a Flight swaps: its steps, and only they, on this model and effort. */
export interface Swap {
  brewer: string;
  /** A level, which the brewer's steps name, or a model id, which models.jsonc maps a free level to. */
  model: string;
  effort: Effort;
}

/** What a Flight brews: a default recipe as it ships, or with one brewer swapped. */
export interface FlightSettings {
  recipe: string;
  swap?: Swap;
  runs: number;
  dryRun: boolean;
}

/** A brewer step of a recipe, a parallel group's children included. */
interface BrewerStep {
  id: string;
  brewer: string;
  model: ModelLevel;
  effort: Effort;
}

/** A recipe's text, read and checked as the engine reads a recipe. */
const recipeOf = (text: string): Recipe => Recipe.parse(parseJsonc(text));

/** Each brewer step of `recipe`, in order, a parallel group's children included: its own objects. */
const brewerSteps = (recipe: Recipe): BrewerStep[] => {
  const steps: BrewerStep[] = [];
  for (const step of recipe.steps) {
    for (const each of 'parallel' in step ? step.parallel : [step]) {
      if ('brewer' in each && each.id !== undefined) steps.push(each as BrewerStep);
    }
  }
  return steps;
};

/**
 * The level a swapped brewer's steps name: the level `--model` is, or for a model id the first level
 * no other step of the recipe names, which models.jsonc maps to it alone, since a level is shared
 * Brewery-wide (ADR 0409); undefined when every level is taken.
 */
const swapLevelOf = (swap: Swap, recipe: Recipe): ModelLevel | undefined => {
  const level = ModelLevel.safeParse(swap.model);
  if (level.success) return level.data;
  const named = new Set(
    brewerSteps(recipe)
      .filter(({ brewer }) => brewer !== swap.brewer)
      .map(({ model }) => model),
  );
  return ModelLevel.options.find((each) => !named.has(each));
};

/**
 * The Flight `values` ask for, or the refusal that stops the script with exit 2; `recipeText`
 * gives a default recipe's text by its name, undefined when there is none.
 */
export const flightOptionsOf = (
  values: FlightValues,
  recipeText: (name: string) => string | undefined,
): ({ kind: 'flight' } & FlightSettings) | { kind: 'refused'; message: string } => {
  try {
    return { kind: 'flight', ...settingsOf(values, recipeText) };
  } catch (error) {
    // Every check of the options throws its refusal's message.
    return { kind: 'refused', message: (error as Error).message };
  }
};

const settingsOf = (
  values: FlightValues,
  recipeText: (name: string) => string | undefined,
): FlightSettings => {
  const { recipe, brewer, model, effort } = values;
  if (recipe === undefined) throw new Error('--recipe names the default recipe a Flight brews');
  const text = recipeText(recipe);
  if (text === undefined) throw new Error(`--recipe takes a default recipe, not "${recipe}"`);
  const read = recipeOf(text);
  if (!read.steps.some((step) => 'action' in step && step.action === 'openPullRequest')) {
    throw new Error(`--recipe ${recipe} opens no pull request, so no run of it would leave a head`);
  }
  const runs = Number(values.runs ?? '3');
  if (!Number.isSafeInteger(runs) || runs < 1) {
    throw new Error(`--runs must be a whole number of at least 1, not ${values.runs}`);
  }
  const common = { recipe, runs, dryRun: values['dry-run'] === true };
  if (brewer === undefined) {
    if (model !== undefined) throw new Error('--model sets the brewer --brewer names: give it');
    if (effort !== undefined) throw new Error('--effort sets the brewer --brewer names: give it');
    return common;
  }
  if (model === undefined) throw new Error(`--brewer ${brewer} needs --model <level or id>`);
  if (effort === undefined) throw new Error(`--brewer ${brewer} needs --effort <effort>`);
  const swap = { brewer, ...tasterModelOf(model, effort) };
  if (!brewerSteps(read).some((step) => step.brewer === brewer)) {
    throw new Error(`--brewer "${brewer}" names no step of the recipe ${recipe}`);
  }
  if (swapLevelOf(swap, read) === undefined) {
    throw new Error(
      `every level is named by a step of ${recipe} other than ${brewer}'s: a model id needs a level of its own`,
    );
  }
  return { ...common, swap };
};

/** The Flight's folder under .foedrum/tmp/flight: the recipe, with a swap its brewer, model and effort. */
export const flightFolderOf = ({ recipe, swap }: FlightSettings): string =>
  scratchNameOf(
    swap === undefined ? recipe : `${recipe}-${swap.brewer}-${swap.model}-${swap.effort}`,
  );

/** Where the target's test line writes its TAP report, for the Maltster's test map to name. */
const REPORT = 'flight.tap';

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/**
 * The scratch Brewery's files beyond Nip's: none for the recipe as it ships; with a swap, a copy of
 * the default recipe whose swapped brewer's steps name the model and effort, and a models.jsonc when
 * the model is an id; and always the target's test line.
 */
export const flightBreweryFiles = (
  { recipe, swap, dryRun }: FlightSettings,
  recipeText: string,
  names: { brewery: string; target: string; user: string },
): Record<string, string> => {
  const config = {
    'foedrum.jsonc': json({
      brewery: names.brewery,
      users: [names.user],
      repositories: {
        [names.target]: {
          checks: {
            build: null,
            typecheck: null,
            lint: null,
            format: null,
            test: `node --test --test-reporter=tap --test-reporter-destination=stdout --test-reporter=tap --test-reporter-destination=${REPORT}`,
          },
        },
      },
    }),
  };
  if (swap === undefined && !dryRun) return config;
  const copy = recipeOf(recipeText);
  // A dry run skips the test-first steps: they are the engine's, tested there, and a scripted
  // Gauger's tests would fail to load on the base (ADR 0409).
  if (dryRun) copy.testFirst = false;
  const level = swap === undefined ? undefined : swapLevelOf(swap, copy);
  if (swap !== undefined) {
    if (level === undefined) throw new Error(`no level of ${recipe} is free for ${swap.model}`);
    for (const step of brewerSteps(copy)) {
      if (step.brewer !== swap.brewer) continue;
      step.model = level;
      step.effort = swap.effort;
    }
  }
  const what = swap === undefined ? '' : ` with ${swap.brewer} on ${swap.model} at ${swap.effort}`;
  return {
    ...config,
    [`recipes/${recipe}.jsonc`]: `// node scripts/flight.ts's ${recipe}${what}${dryRun ? ', test-first off for a dry run' : ''} (ADR 0409).
${json(copy)}`,
    ...(swap === undefined || level === swap.model
      ? {}
      : { 'models.jsonc': json({ claude: { models: { [String(level)]: swap.model } } }) }),
  };
};

/** The model each brewer step of the recipe asks for, by step id: a family, or a model id. */
export const askedModels = ({ swap }: FlightSettings, recipeText: string): Map<string, string> => {
  const asked = new Map<string, string>();
  for (const { id, brewer, model } of brewerSteps(recipeOf(recipeText))) {
    const wants = swap !== undefined && brewer === swap.brewer ? swap.model : model;
    const level = ModelLevel.safeParse(wants);
    asked.set(id, level.success ? FAMILIES[level.data] : wants);
  }
  return asked;
};

/**
 * What the dry run's scripted brewers play for `order`, by step id of the recipe: Cellarman commits
 * the whole solution, since a dry run skips the test-first steps, and every other brewer nothing.
 */
export const dryRunScript = (
  order: FlightOrder,
  recipeText: string,
): Record<string, readonly Scripted[]> => {
  const turnOf = ({ id, brewer }: BrewerStep): Scripted => {
    const nothing = { files: {}, message: '', summary: `The dry run's ${brewer} of ${id}.` };
    switch (brewer) {
      case 'cellarman':
        return { ...nothing, files: { ...order.solution }, message: order.title };
      case 'finer':
        return { ...nothing, fining: { unchanged: 'The dry run simplifies nothing.' } };
      case 'taster':
        return { ...nothing, tasting: { verdict: 'approve', findings: [] } };
      default:
        return nothing;
    }
  };
  const script: Record<string, readonly Scripted[]> = {};
  for (const step of brewerSteps(recipeOf(recipeText))) script[step.id] = [turnOf(step)];
  return script;
};

/** How a run's hidden tests ended. */
export type Hidden = 'passed' | 'failed' | 'timed out';

/** What one run of a Flight measured (ADR 0409). */
export interface FlightRun {
  recipe: string;
  swap?: Swap;
  /** The commit a person gets from the batch, and where it was read. */
  head?: string;
  headFrom?: 'pull request' | 'green';
  /** The worktree the green step read a head of no pull request in, where its commit is. */
  headTree?: string;
  hidden?: Hidden;
  /** The end of the hidden tests' output. */
  hiddenOutput?: string;
  changed: readonly string[];
  /** The changed files outside the order's allowed paths. */
  outside: readonly string[];
  steps: readonly StepRun[];
  /** The models each brewer step's transcripts name, by step id. */
  models: Readonly<Record<string, readonly string[]>>;
  /** Why a transcript cannot say its model. */
  unreadable?: string;
}

/** One run of an order: the order's name is its setup. */
export type FlightRecord = RunRecord<string> & { flight: FlightRun };

/** The check step whose worktree commit is the head of a batch with no pull request. */
const GREEN = 'green';

/** The head a person gets from the batch: its pull request's, or else the commit green last read. */
export const headOf = (
  events: readonly { event: Event }[],
): Pick<FlightRun, 'head' | 'headFrom' | 'headTree'> => {
  let green: { commit: string; path: string } | undefined;
  let pushed: { round: number; commit: string } | undefined;
  for (const { event } of events) {
    if (event.type === 'step.started' && event.stepId === GREEN && event.worktree !== undefined) {
      green = { commit: event.worktree.commit, path: event.worktree.path };
    } else if (event.type === 'effect.applied') {
      const key = effectKey.decode(event.key);
      const round = 'stepId' in key ? undefined : /^push(?:\.(\d+))?$/.exec(key.effect);
      const result = PushResult.safeParse(event.result);
      if (round === undefined || round === null || !result.success) continue;
      const at = Number(round[1] ?? '1');
      if (pushed === undefined || at > pushed.round)
        pushed = { round: at, commit: result.data.commit };
    }
  }
  if (pushed !== undefined) return { head: pushed.commit, headFrom: 'pull request' };
  return green === undefined ? {} : { head: green.commit, headFrom: 'green', headTree: green.path };
};

/** The changed files outside `allowedPaths`: a folder ends in `/`, any other entry is one file. */
export const outsidePaths = (
  changed: readonly string[],
  allowedPaths: readonly string[],
): string[] =>
  changed.filter(
    (path) =>
      path !== TEST_MAP_PATH &&
      !allowedPaths.some((entry) =>
        entry.endsWith('/') ? path.startsWith(entry) : path === entry,
      ),
  );

/**
 * How the hidden tests ended by their exit code, and how the runner killed them: timed out only at
 * their deadline; killed for their output, or never started, they failed.
 */
export const hiddenOf = (exitCode: number | null, killed?: Killed): Hidden =>
  killed === 'timed-out' ? 'timed out' : exitCode === 0 ? 'passed' : 'failed';

/** A run's record from its store's events, before its hidden tests ran. */
export const flightRecordOf = (
  events: readonly { event: Event }[],
  { recipe, swap }: FlightSettings,
  asked: ReadonlyMap<string, string>,
  transcriptOf: (sessionId: string, worktree: string) => string | undefined,
): Pick<FlightRecord, 'ended' | 'attempts' | 'flight'> => {
  const models: Record<string, readonly string[]> = {};
  let unreadable: string | undefined;
  for (const stepId of asked.keys()) {
    const read = stepModels(events, stepId, transcriptOf);
    if (read.models.length > 0) models[stepId] = read.models;
    unreadable ??= read.unreadable;
  }
  return {
    ended: recordIn(events, new Map()).ended,
    attempts: [],
    flight: {
      recipe,
      ...(swap === undefined ? {} : { swap }),
      ...headOf(events),
      changed: [],
      outside: [],
      steps: stepRunsOf(events, transcriptOf),
      models,
      ...(unreadable === undefined ? {} : { unreadable }),
    },
  };
};

/** Why a run measured nothing, or undefined: its batch left no head. */
export const flightFailure = ({
  ended,
  flight,
}: Pick<FlightRecord, 'ended' | 'flight'>): string | undefined =>
  flight.head === undefined ? `the batch ended ${ended} before it left a head` : undefined;

/** Why a run stops the Flight, or undefined: a transcript that cannot say, or a model not asked for. */
export const flightStop = (
  { setup, flight }: Pick<FlightRecord, 'setup' | 'flight'>,
  asked: ReadonlyMap<string, string>,
): string | undefined => {
  if (flight.unreadable !== undefined) return escapeCell(flight.unreadable);
  for (const [stepId, models] of Object.entries(flight.models)) {
    const wants = asked.get(stepId);
    const other = wants === undefined ? undefined : models.find((model) => !isAsked(wants, model));
    if (other !== undefined) {
      return escapeCell(`${stepId}: it ran on ${other}, and ${setup} asks for ${wants}`);
    }
  }
  return undefined;
};

/** The next run to brew of `orders` (`nextRunOf`). */
export const nextFlightRun = (
  records: readonly FlightRecord[],
  runs: number,
  orders: readonly string[],
): { setup: string; run: number; retry: boolean } | undefined =>
  nextRunOf(orders, records, runs, flightFailure);

const tokensOf = (usage: Usage | undefined): number =>
  usage === undefined
    ? 0
    : usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;

/** One row per order: its runs, hidden tests passed, runs with outside changes, tokens and time. */
export const flightTable = (records: readonly FlightRecord[]): string => {
  const orders = [...new Set(records.map(({ setup }) => setup))];
  const rows = orders.map((order) => {
    const { scored, failed } = runsOfSetup(records, order, flightFailure);
    const passed = scored.filter(({ flight }) => flight.hidden === 'passed').length;
    const outside = scored.filter(({ flight }) => flight.outside.length > 0).length;
    const steps = scored.flatMap(({ flight }) => flight.steps);
    const tokens = steps.reduce((sum, { usage }) => sum + tokensOf(usage), 0);
    const ms = steps.reduce((sum, { durationMs }) => sum + durationMs, 0);
    const row = `| ${order} | ${scored.length} | ${passed} of ${scored.length} | ${outside} | ${tokens} | ${Math.round(ms / 1000)} s |`;
    return [
      row,
      ...failed.map(({ run, why }) => `Failed: ${order} run ${run}: ${escapeCell(why)}`),
    ];
  });
  return `${[
    '| Order | Runs | Hidden tests passed | Outside its paths | Tokens | Brewers |',
    '|---|---|---|---|---|---|',
    ...rows.map(([row]) => row),
    '',
    ...rows.flatMap(([, ...failed]) => failed),
  ].join('\n')}\n`;
};
