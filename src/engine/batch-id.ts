// Ids of the batches the engine orders. They become folder names on the state branch, so they must
// pass PathSafeId (ADR 0024). Each carries the time it was ordered, in UTC to the second, so it
// stays unique once a cleanup forgot every earlier batch of its issue (ADR 0380):
// `<issue>-<yyyymmddhhmmss>`, at most 31 characters, and `<alias>-<issue>-<yyyymmddhhmmss>` of a
// target-repository issue, which starts with a letter, at most 52 (ADR 0050). Ids of the older
// forms, `<issue>-<n>` and `<alias>-<issue>[-<n>]`, stay valid as data.

import { RepositoryAlias } from '../schemas/ids.ts';
import type { State } from './fold.ts';

const checkIssue = (issue: number): void => {
  if (!Number.isSafeInteger(issue) || issue < 1) {
    throw new RangeError(`The issue must be a positive integer, got ${issue}`);
  }
};

/** `now` in UTC to the second, as its digits: `yyyymmddhhmmss`. */
export const orderStamp = (now: Date): string =>
  now
    .toISOString()
    .replace(/[^0-9]/g, '')
    .slice(0, 14);

/**
 * `first`, or `first-<n>` with the first `n` from 2 that no batch in the fold uses: two orders of
 * one issue in one second, the first cancelled between them.
 */
const unused = (state: State, first: string): string => {
  if (!state.batches.has(first)) return first;
  for (let n = 2; ; n++) {
    const id = `${first}-${n}`;
    if (!state.batches.has(id)) return id;
  }
};

/** The id of the batch of `issue` ordered at `now`: `<issue>-<yyyymmddhhmmss>`. */
export const nextBatchId = (state: State, issue: number, now: Date): string => {
  checkIssue(issue);
  return unused(state, `${issue}-${orderStamp(now)}`);
};

/**
 * The id of the batch of `issue` in the target repository named `alias` ordered at `now`:
 * `<alias>-<issue>-<yyyymmddhhmmss>`.
 */
export const targetBatchId = (state: State, alias: string, issue: number, now: Date): string => {
  if (!RepositoryAlias.safeParse(alias).success) {
    throw new RangeError(
      `The alias must be 1 to 20 lower-case letters and digits, starting with a letter, got ${JSON.stringify(alias)}`,
    );
  }
  checkIssue(issue);
  return unused(state, `${alias}-${issue}-${orderStamp(now)}`);
};

/**
 * The alias a claimed issue's batch id starts with, as `targetBatchId` makes it or made it in its
 * older form, or undefined for any other id: the alias has no hyphen, so it ends at the first one
 * (ADR 0050).
 */
export const aliasOf = (batchId: string): string | undefined => {
  const alias = /^([a-z][a-z0-9]*)-[1-9][0-9]*(?:-[0-9]{14})?(?:-[1-9][0-9]*)?$/.exec(batchId)?.[1];
  return alias !== undefined && RepositoryAlias.safeParse(alias).success ? alias : undefined;
};
