// The actions of a cleanup recipe (ADR 0380), which the driver runs itself through the ledger:
// `archive` records `batch.archived` for every batch the cleanup may take, and `sweep` removes what
// nothing changed in for 2 days from the Brewery's temporary folder.

import type { ArchiveFacts } from './archive.ts';
import type { CommandLog } from './command-log.ts';
import type { DriverActions } from './driver.ts';
import type { State } from './fold.ts';
import type { Recipes } from './recipes.ts';

export interface CleanupActionsOptions {
  recipes: Recipes;
  /** Records the archive's events, in the store the driver reads. */
  log: CommandLog;
  /** What the archive reads beside the fold: effects still due and leases. */
  facts: (state: State) => ArchiveFacts;
  /** The Brewery's temporary folder, `.foedrum/tmp/` in its clone. */
  temp: string;
  clock: () => Date;
}

export const cleanupActions = (_options: CleanupActionsOptions): DriverActions => {
  throw new Error('not implemented');
};

/**
 * One set of actions out of several, by the action each attempt's step is in its recipe: what the
 * driver runs for a pull request's step and for a cleanup's.
 */
export const actionsByKind = (
  _recipes: Recipes,
  _kinds: Partial<Record<'openPullRequest' | 'archive' | 'sweep', DriverActions>>,
): DriverActions => {
  throw new Error('not implemented');
};
