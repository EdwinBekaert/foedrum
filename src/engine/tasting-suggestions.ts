// What a Brewery could taste next (ADR 0419): the models its brewers ran on that no tasted entry
// covers, and the steps a cheaper level might do for. A pure core: `foedrum doctor` shows one line
// of it, `foedrum taste` (#1143) the whole list.

import type { Event } from '../schemas/events.ts';
import type { Effort, ModelLevel, TastedEntry } from '../schemas/models.ts';

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
export const modelsUsed = (_events: readonly Event[]): ModelUsed[] => {
  throw new Error('not implemented');
};

/** The suggestions the attempts of the last `TASTING_DAYS` days give against the tasted list. */
export const tastingSuggestions = (_inputs: TastingInputs): TastingSuggestions => {
  throw new Error('not implemented');
};
