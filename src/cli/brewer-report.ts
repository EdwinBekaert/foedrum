// `foedrum brewers` (ADR 0159): per brewer, the attempts of its steps, how they ended, the batches
// it holds Stuck and the tokens it used, from the folded events. A step's brewer comes from the
// recipe its batch chose, as the files are now; an attempt of a step they no longer have is listed
// apart, so none is dropped.

import type { State } from '../engine/fold.ts';
import type { Usage } from '../schemas/events.ts';

/** The brewers in use and what each recipe's step is now, from the loaded files. */
export interface BrewerSource {
  /** Every brewer in use, Brewery's and default, with its file. */
  brewers: readonly { name: string; path: string }[];
  /**
   * Step `stepId` of recipe `recipe` as the files have it: a brewer step with its brewer's name, a
   * check step, or `undefined` when no recipe of that name has that step.
   */
  step: (recipe: string, stepId: string) => { brewer: string } | { check: true } | undefined;
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

/** The report over `state`, each step's brewer from `source`. */
export const brewerReport = (_state: State, _source: BrewerSource): BrewerReport => {
  throw new Error('not implemented');
};

/** What `foedrum brewers` prints. */
export const formatBrewerReport = (_report: BrewerReport): string => {
  throw new Error('not implemented');
};
