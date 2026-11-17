// What a Brewery could taste next (ADR 0419): the models its brewers ran on that no tasted entry
// covers, and the steps a cheaper level might do for. A pure core: `foedrum doctor` shows one line
// of it, `foedrum taste` (#1143) the whole list.

import type { Event } from '../schemas/events.ts';
import { type Effort, ModelLevel, type TastedEntry } from '../schemas/models.ts';

/** How far back the attempts read reach (ADR 0419). */
export const TASTING_DAYS = 30;

/** A brewer attempt that reported its model in claude's init event (ADR 0116). */
export interface ModelUsed {
  recipe: string;
  stepId: string;
  /** The exact model id claude's init event named. */
  model: string;
  /** Its step's deadline when it was scheduled: the attempt started before it (ADR 0419). */
  deadlineAt: Date;
}

/** A brewer step as its recipe names it today (ADR 0397). */
export interface StepInUse {
  brewer: string;
  level: ModelLevel;
  effort: Effort;
}

/** A model in use that no tasted entry of its brewers covers, with those brewers. */
export interface UntastedModel {
  model: string;
  brewers: string[];
}

/** A step whose tasted level did no worse than its baseline, with the level below never tasted. */
export interface CheaperLevel {
  brewer: string;
  recipe: string;
  stepId: string;
  from: ModelLevel;
  to: ModelLevel;
  effort: Effort;
}

export interface TastingSuggestions {
  untasted: UntastedModel[];
  cheaper: CheaperLevel[];
}

export interface TastingInputs {
  attempts: readonly ModelUsed[];
  /** The brewer, level and effort of a recipe's step, or undefined when the recipe has none. */
  stepOf: (recipe: string, stepId: string) => StepInUse | undefined;
  tasted: readonly TastedEntry[];
  now: Date;
}

/** The brewer attempts of the event log that reported a model, in the log's order. */
export const modelsUsed = (events: readonly Event[]): ModelUsed[] => {
  const recipes = new Map<string, string>();
  // Each attempt's recipe and deadline as it was scheduled: a batch can choose another recipe later.
  const scheduled = new Map<string, { recipe: string; deadlineAt: string }>();
  const used: ModelUsed[] = [];
  for (const event of events) {
    switch (event.type) {
      case 'batch.recipe_chosen':
        recipes.set(event.batchId, event.recipe);
        break;
      case 'step.scheduled': {
        const recipe = recipes.get(event.batchId);
        if (recipe !== undefined) {
          scheduled.set(attemptKey(event), { recipe, deadlineAt: event.deadlineAt });
        }
        break;
      }
      case 'step.finished': {
        const at = scheduled.get(attemptKey(event));
        if (event.claude === undefined || at === undefined) break;
        used.push({
          recipe: at.recipe,
          stepId: event.stepId,
          model: event.claude.model,
          deadlineAt: new Date(at.deadlineAt),
        });
        break;
      }
      default:
        break;
    }
  }
  return used;
};

const attemptKey = ({ batchId, stepId, attempt }: Attempted): string =>
  JSON.stringify([batchId, stepId, attempt]);
type Attempted = { batchId: string; stepId: string; attempt: number };

const DAY_MS = 24 * 60 * 60 * 1000;

/** The level one below `level`, or undefined below the lightest. */
const below = (level: ModelLevel): ModelLevel | undefined => {
  const at = ModelLevel.options.indexOf(level);
  return at > 0 ? ModelLevel.options[at - 1] : undefined;
};

/**
 * An entry did no worse than its baseline: as many orders passed of as many measured, or more
 * (ADR 0419).
 */
const noWorse = ({ passed, runs, baseline }: TastedEntry): boolean =>
  runs === baseline.runs && passed >= baseline.passed;

/** The suggestions the attempts of the last `TASTING_DAYS` days give against the tasted list. */
export const tastingSuggestions = (inputs: TastingInputs): TastingSuggestions => {
  const { attempts, stepOf, tasted, now } = inputs;
  const since = now.getTime() - TASTING_DAYS * DAY_MS;
  const untasted = new Map<string, Set<string>>();
  const cheaper = new Map<string, CheaperLevel>();
  for (const { recipe, stepId, model, deadlineAt } of attempts) {
    if (deadlineAt.getTime() < since) continue;
    const step = stepOf(recipe, stepId);
    if (step === undefined) continue;
    const { brewer, level, effort } = step;
    // Any Flight of the brewer on that exact model covers it (ADR 0419).
    if (!tasted.some((entry) => entry.brewer === brewer && entry.model === model)) {
      untasted.set(model, (untasted.get(model) ?? new Set()).add(brewer));
    }
    const to = below(level);
    if (to === undefined) continue;
    const of = (at: ModelLevel) =>
      tasted.find(
        (entry) =>
          entry.brewer === brewer &&
          entry.recipe === recipe &&
          entry.level === at &&
          entry.effort === effort,
      );
    const entry = of(level);
    if (entry === undefined || entry.model !== model || !noWorse(entry) || of(to) !== undefined) {
      continue;
    }
    cheaper.set(JSON.stringify([brewer, recipe, stepId]), {
      brewer,
      recipe,
      stepId,
      from: level,
      to,
      effort,
    });
  }
  const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  return {
    untasted: [...untasted]
      .map(([model, brewers]) => ({ model, brewers: [...brewers].sort(byName) }))
      .sort((a, b) => byName(a.model, b.model)),
    cheaper: [...cheaper].sort(([a], [b]) => byName(a, b)).map(([, level]) => level),
  };
};
