// The lasting lines `foedrum serve` prints for what a person must know (ADR 0434): what a batch did
// between two ticks, the cleanup of a batch and a read of GitHub that failed, in a person's words.

import type { DriverNotice } from '../engine/driver.ts';
import type { State } from '../engine/fold.ts';
import type { IntakeNotice } from '../engine/intake.ts';

/**
 * The lines for what changed in each batch from `before` to `after`, the folded states of two ticks:
 * a step that ended, a batch that got Stuck, a pull request that opened, merged or closed. No line
 * for a batch that stays as it was.
 */
export const lastingLines = (_before: State, _after: State): string[] => {
  throw new Error('not implemented');
};

/** A batch's cleanup in a person's words, with the pull request `state` holds for the batch. */
export const cleanedLine = (
  _notice: Extract<DriverNotice, { kind: 'cleaned' }>,
  _state: State,
): string => {
  throw new Error('not implemented');
};

/**
 * An intake read that failed, in one line that says what failed and that the next pass tries
 * again; the raw error follows it only where no live line is drawn.
 */
export const readFailureLine = (
  _notice: Extract<IntakeNotice, { kind: 'failed' }>,
  _live: boolean,
): string => {
  throw new Error('not implemented');
};
