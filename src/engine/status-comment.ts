// The status comment of a batch of a Brewery issue (architecture §8, ADR 0072): its text rendered
// from the folded state alone, and its edits as revisions in the ledger, `[batchId, "status.<n>"]`,
// each found by its marker on the Brewery's own comment before it is applied (ADR 0033).

import type { DriverEffects } from './driver.ts';
import type { Batch } from './fold.ts';
import type { Recipes } from './recipes.ts';

/** The status comments on the code host, as the Brewery's own identity sees and makes them. */
export interface StatusComments {
  /** The Brewery's own comment on the issue whose body ends with `marker`: its id and body. */
  find(
    repo: string,
    issue: number,
    marker: string,
    signal?: AbortSignal,
  ): Promise<{ id: number; body: string } | undefined>;
  /** The body of the comment `comment`, or undefined when it is gone or not the Brewery's own. */
  read(repo: string, comment: number, signal?: AbortSignal): Promise<string | undefined>;
  /** Comments on the issue; the new comment's id. */
  create(repo: string, issue: number, body: string, signal?: AbortSignal): Promise<number>;
  /** Replaces the body of `comment`; `gone` when it was deleted. */
  edit(
    repo: string,
    comment: number,
    body: string,
    signal?: AbortSignal,
  ): Promise<'edited' | 'gone'>;
}

/**
 * The status comment's text for `batch`, without its marker: its lane, its recipe's `steps` (the
 * steps the batch has when the recipe is unknown) with the current one marked, the assumptions of
 * its out docs and, on tap, its pull requests. Every text a brewer or an issue wrote is one
 * escaped line.
 */
export const renderStatus = (_batch: Batch, _steps?: readonly string[]): string => {
  throw new Error('not implemented');
};

export interface StatusEffectsOptions {
  /** The Brewery's repository, `owner/name`, where its issues are. */
  brewery: string;
  comments: StatusComments;
  recipes: Recipes;
  clock: () => Date;
  /** The least time between two edits of one batch's comment; default a minute. */
  everyMs?: number;
  /** How long one effect may take; the driver's default when left out (`DriverEffects`). */
  deadlineMs?: number;
}

/** The status comment of every batch of a Brewery issue, for the driver. */
export const statusEffects = (_options: StatusEffectsOptions): DriverEffects => {
  throw new Error('not implemented');
};
