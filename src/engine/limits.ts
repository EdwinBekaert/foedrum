// The limits on what the intake starts (ADR 0217), beside the Brewery's `concurrency` (ADR 0068):
// a recipe's `concurrency`, and the Brewery's open-order limit. Pure: a function of the folded
// state, the pass's listing of the Brewery's issues and the limits, so a restart holds the same.

import type { State } from './fold.ts';
import type { TargetIssue } from './issue-claims.ts';
import type { QueuedOrder } from './ranks.ts';
import type { Recipes } from './recipes.ts';

/** What holds what the intake starts, besides the Brewery's free capacity. */
export interface Limits {
  /** How many orders may be open at once: `openOrders` in foedrum.jsonc. */
  openOrders: number;
  /** The `concurrency` of the recipe called `name`, or undefined when it has none. */
  recipe(name: string): number | undefined;
}

/** Why the intake does not start an entry of its queue now, or route a batch. */
export type Hold =
  | { kind: 'recipe'; recipe: string; limit: number }
  | { kind: 'open_orders'; limit: number };

/** The limits of `openOrders` and the recipes' own `concurrency`. */
export const limitsOf = (_openOrders: number, _recipes: Recipes): Limits => {
  throw new Error('not implemented');
};

/** The open orders (ADR 0217), by `orderKey`, each with its name as `foedrum status` gives it. */
export const openOrders = (_state: State): Map<string, string> => {
  throw new Error('not implemented');
};

/** What a walk of the queue started so far, and what holds its next entry. */
export interface StartTally {
  /** The limit that holds `entry` now, or undefined when it may start. */
  hold(entry: QueuedOrder): Hold | undefined;
  /** Counts `entry` as started. */
  start(entry: QueuedOrder): void;
}

/** A tally of what is open and brewing now; `listed`: the Brewery's issues read in this pass. */
export const startTally = (
  _state: State,
  _listed: readonly TargetIssue[],
  _limits: Limits,
): StartTally => {
  throw new Error('not implemented');
};

/**
 * The entries of `queue` a walk starts, in rank order: up to `free`, each a limit does not hold
 * once those before it started, the held ones skipped.
 */
export const chooseStarts = <T extends QueuedOrder>(
  _state: State,
  _listed: readonly TargetIssue[],
  _queue: readonly T[],
  _free: number,
  _limits: Limits,
): T[] => {
  throw new Error('not implemented');
};

/** What holds the route of an Ordered batch to `recipe`: its batches Brewing at its limit. */
export const routeHold = (_state: State, _recipe: string, _limits: Limits): Hold | undefined => {
  throw new Error('not implemented');
};

/** Why a hold holds, in one line. */
export const holdText = (_hold: Hold): string => {
  throw new Error('not implemented');
};

/** The lines `foedrum status` prints above the board: each limit that holds now. */
export const limitLines = (_state: State, _limits: Limits): string[] => {
  throw new Error('not implemented');
};
