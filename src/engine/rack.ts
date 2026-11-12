// Rack, the cleanup recipe's actions (ADR 0383): archive the finished batches, delete old archive
// folders and old temporary files. The engine runs them itself, through the ledger, as it runs the
// openPullRequest action (ADR 0071); no brewer, no model.

import type { DriverActions } from './driver.ts';
import type { EventStore } from './event-store.ts';
import type { State } from './fold.ts';
import type { Recipes } from './recipes.ts';

/** The archive on the state branch, as rack moves batches into it and deletes its old folders. */
export interface ArchiveShelf {
  /**
   * Moves `batches/<id>/` of each of `batchIds` to `archive/<date>/<id>/`, and so the folder of any
   * batch `known` lacks, which a forget left before a crash; one already moved is left as it is.
   */
  shelve(batchIds: readonly string[], date: string, known: ReadonlySet<string>): Promise<void>;
  /** The dates of the folders `archive/<date>/`. */
  dates(): Promise<string[]>;
  /** Deletes the folders `archive/<date>/` of `dates`. */
  drop(dates: readonly string[]): Promise<void>;
}

export interface RackActionsOptions {
  /** The Brewery's repository, `owner/name`, where its issues are. */
  brewery: string;
  recipes: Recipes;
  /** The folded state, as it is after a forget. */
  state(): State;
  store: Pick<EventStore, 'forget'>;
  shelf: ArchiveShelf;
  /** Whether an issue is open, closed or gone, read once per issue in each run. */
  issueState(
    repo: string,
    issue: number,
    signal?: AbortSignal,
  ): Promise<'open' | 'closed' | 'gone'>;
  /** The Brewery's `.foedrum/tmp` folder. */
  temporary: string;
  clock(): Date;
}

/** Rack's actions, for the driver: one effect per attempt, which does the step's work. */
export const rackActions = (_options: RackActionsOptions): DriverActions => {
  throw new Error('not implemented');
};
