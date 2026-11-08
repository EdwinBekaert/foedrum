// What a Cellarman's fix round reads of the pull request's sections its earlier attempts wrote
// (ADR 0167, ADR 0227), so that it returns them updated for the batch's whole change.

import type { Batch } from './fold.ts';

/** The `earlier-sections` input of an attempt, and the text its brewer reads. */
export interface EarlierSectionsInput {
  /** The attempt of the step whose sections the text holds. */
  attempt: number;
  text: string;
}

/**
 * The `earlier-sections` input of attempt `attempt` of `stepId` in `batch`: the sections of the
 * latest attempt of that step before it that succeeded and wrote any. Undefined when none did.
 */
export const earlierSectionsInput = (
  _batch: Batch,
  _stepId: string,
  _attempt: number,
): EarlierSectionsInput | undefined => {
  throw new Error('not implemented');
};
