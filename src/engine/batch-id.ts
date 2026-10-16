// Ids of the batches the engine orders. They become folder names on the state branch, so they must
// pass PathSafeId (ADR 0024): `<issue>-<n>` is digits and one hyphen, at most 33 characters.

import type { State } from './fold.ts';

/** The id of the next batch of `issue`: `<issue>-<n>`, with the first `n` no batch uses yet. */
export const nextBatchId = (state: State, issue: number): string => {
  if (!Number.isSafeInteger(issue) || issue < 1) {
    throw new RangeError(`The issue must be a positive integer, got ${issue}`);
  }
  for (let n = 1; ; n++) {
    const id = `${issue}-${n}`;
    if (!state.batches.has(id)) return id;
  }
};

/** The id of the next batch of `issue` in the target repository named `alias` (ADR 0043). */
export const targetBatchId = (_state: State, _alias: string, _issue: number): string => {
  throw new Error('not implemented');
};
