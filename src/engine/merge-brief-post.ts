// The merge brief on a ready pull request (ADR 0225): one comment through the ledger per ready
// record, `[batch, "brief.<n>"]`, titled `Merge? <title> @ <short sha>`, with the verdict, what
// changed since it opened, the evidence on its head and the last Taster's risk left, every fact
// from the ledger and every model text filtered under its own heading.

import type { DriverEffects } from './driver.ts';
import type { Recipes } from './recipes.ts';

/** The pull request's comments and title on the code host, as the Brewery's own identity has them. */
export interface MergeBriefHost {
  /** The Brewery's own comment on the pull request whose body ends with `marker`: its id and body. */
  find(
    repo: string,
    number: number,
    marker: string,
    signal?: AbortSignal,
  ): Promise<{ id: number; body: string } | undefined>;
  /** Comments on the pull request; the new comment's id. */
  create(repo: string, number: number, body: string, signal?: AbortSignal): Promise<number>;
  /** The pull request's title. */
  title(repo: string, number: number, signal?: AbortSignal): Promise<string>;
}

export interface MergeBriefEffectsOptions {
  host: MergeBriefHost;
  recipes: Recipes;
  /** The red proof step of the recipe `recipe`, when it has one (ADR 0078). */
  redProof?: (recipe: string) => string | undefined;
  /** How long one effect may take; the driver's default when left out (`DriverEffects`). */
  deadlineMs?: number;
}

/** The merge brief of each ready pull request, for the driver (ADR 0225). */
export const mergeBriefEffects = (_options: MergeBriefEffectsOptions): DriverEffects => {
  throw new Error('not implemented');
};
