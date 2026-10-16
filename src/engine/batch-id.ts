// Ids of the batches the engine orders. They become folder names on the state branch, so they must
// pass PathSafeId (ADR 0024): `<issue>-<n>` is digits and one hyphen, at most 33 characters, and
// `<alias>-<issue>[-<n>]` of a target-repository issue starts with a letter, at most 54 (ADR 0048).

import { RepositoryAlias } from '../schemas/ids.ts';
import type { State } from './fold.ts';

const checkIssue = (issue: number): void => {
  if (!Number.isSafeInteger(issue) || issue < 1) {
    throw new RangeError(`The issue must be a positive integer, got ${issue}`);
  }
};

/** The id of the next batch of `issue`: `<issue>-<n>`, with the first `n` no batch uses yet. */
export const nextBatchId = (state: State, issue: number): string => {
  checkIssue(issue);
  for (let n = 1; ; n++) {
    const id = `${issue}-${n}`;
    if (!state.batches.has(id)) return id;
  }
};

/**
 * The id of the next batch of `issue` in the target repository named `alias`: `<alias>-<issue>`,
 * or `<alias>-<issue>-<n>` from 2 when a batch of the issue has that already.
 */
export const targetBatchId = (state: State, alias: string, issue: number): string => {
  if (!RepositoryAlias.safeParse(alias).success) {
    throw new RangeError(
      `The alias must be 1 to 20 lower-case letters and digits, starting with a letter, got ${JSON.stringify(alias)}`,
    );
  }
  checkIssue(issue);
  const first = `${alias}-${issue}`;
  if (!state.batches.has(first)) return first;
  for (let n = 2; ; n++) {
    const id = `${first}-${n}`;
    if (!state.batches.has(id)) return id;
  }
};
