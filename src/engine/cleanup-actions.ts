// The Cellarer's jobs (ADR 0380), which the driver runs itself through the ledger, as an action:
// `shelve` forgets every finished batch and has the next flush move its folder to `archive/`,
// `sweep` removes what nothing changed in for 2 days from the Brewery's temporary folder, and
// `expire` has the next flush delete the shelf's months older than 6 months.

import type { ArchiveFacts } from './archive.ts';
import type { CommandLog } from './command-log.ts';
import type { DriverActions, DriverEffects } from './driver.ts';
import type { EventStore } from './event-store.ts';
import type { State } from './fold.ts';
import type { RecipeAction, Recipes } from './recipes.ts';

export interface CleanupActionsOptions {
  recipes: Recipes;
  /** The fold the jobs read, and the store they forget batches in. */
  log: CommandLog;
  store: Pick<EventStore, 'withTransaction'>;
  /** What the shelve reads beside the fold: effects still due, leases and what is not pushed. */
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
 * driver runs for a pull request's step and for the Cellarer's.
 */
export const actionsByKind = (
  _recipes: Recipes,
  _kinds: Partial<Record<RecipeAction, DriverActions>>,
): DriverActions => {
  throw new Error('not implemented');
};

/**
 * What the shelve reads beside the fold, from the driver's sources and its store: a batch has an
 * effect due while a key a source gives is not in the ledger, or a source throws; it is leased
 * while it or one of its attempts has a live lease; and it is not pushed while the state branch
 * lacks one of its events or the store still keeps an out doc of it.
 */
export const storeFacts =
  (
    _effects: Pick<DriverEffects, 'due'>,
    _store: Pick<
      EventStore,
      | 'findEffect'
      | 'batchLeases'
      | 'currentLeases'
      | 'pushedThrough'
      | 'lastEventOf'
      | 'keptOutDocs'
    >,
    _clock: () => Date,
  ) =>
  (_state: State): ArchiveFacts => {
    throw new Error('not implemented');
  };
