// `foedrum lenses` (ADR 0221): per lens, the findings of its steps' rounds by severity and by how
// they ended, and the tokens of its steps' attempts, from the folded events. A step's lens comes
// from the recipe its batch chose, as the files are now; a lens step they no longer have is listed
// apart, so no round is dropped.

import type { State } from '../engine/fold.ts';
import type { Usage } from '../schemas/events.ts';
import type { LoadedBrewers } from './brewer-report.ts';

/** The lenses in use and what each recipe's step reviews through now, from the loaded files. */
export interface LensSource {
  /** Every lens a recipe's lens step reviews through, with its file. */
  lenses: readonly { name: string; path: string }[];
  /**
   * Step `stepId` of recipe `recipe` as the files have it, with the lens it reviews through when it
   * is a lens step, or `undefined` when no recipe of that name has that step.
   */
  step: (recipe: string, stepId: string) => { lens: string | undefined } | undefined;
}

/** A lens's findings by their latest severity. */
export interface Severities {
  blocker: number;
  major: number;
  minor: number;
}

/** How a lens's findings ended: each in exactly one. */
export interface Ends {
  fixed: number;
  dismissed: number;
  'pre-existing': number;
  open: number;
}

/** What the rounds of some lens steps found and cost. */
export interface LensTally {
  /** The attempts that reviewed: a Taster's verdict, or blocked by findings. */
  rounds: number;
  /** Each finding once, by its latest severity. */
  severity: Severities;
  ends: Ends;
  /** Rounds blocked by findings no event recorded, and findings past the ones a round kept. */
  notRecorded: { rounds: number; findings: number };
  /** The sum of the finished attempts' usage. */
  usage: Usage;
}

export interface LensReport {
  /** Every lens in use, by name, also those with no rounds. */
  lenses: readonly (LensTally & { name: string; path: string })[];
  /** The lens steps the recipe files no longer have, or no longer give a lens, by recipe and step. */
  gone: readonly (LensTally & { recipe: string; stepId: string })[];
}

/**
 * The report over `state`, each attempt under its recipe in `ran` (`recipesRun` of the events
 * `state` folds) and each step's lens from `source`.
 */
export const lensReport = (
  _state: State,
  _source: LensSource,
  _ran: ReadonlyMap<string, string>,
): LensReport => {
  throw new Error('not implemented');
};

/** What `foedrum lenses` prints. */
export const formatLensReport = (_report: LensReport): string => {
  throw new Error('not implemented');
};

/** The lenses in use and each recipe's lens steps, from the loaded files. */
export const lensSource = (_loaded: LoadedBrewers): LensSource => {
  throw new Error('not implemented');
};
