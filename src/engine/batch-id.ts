// Ids of the batches the engine orders. They become folder names on the state branch, so they must
// pass PathSafeId (ADR 0024).

import type { State } from './fold.ts';

/** The id of the next batch of `issue`: `<issue>-<n>`, with the first `n` no batch uses yet. */
export const nextBatchId = (_state: State, _issue: number): string => {
  throw new Error('not implemented');
};
