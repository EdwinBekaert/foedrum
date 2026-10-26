// Pauses (ADR 0202): which batches a person's pause holds, and when what runs of them is stopped.

import type { Batch, Pause, State } from './fold.ts';

/**
 * The pause that holds `batch`, if any: `--all`, else its order's (a sub-order's batch is held by
 * its order's). A batch that ended is held by none.
 */
export const pauseOf = (_state: State, _batch: Batch): Pause | undefined => {
  throw new Error('not implemented');
};

/** Whether the pause holding `batch` has reached its stopAt at `now`: what runs of it is stopped. */
export const stopsNow = (_state: State, _batch: Batch, _now: Date): boolean => {
  throw new Error('not implemented');
};
