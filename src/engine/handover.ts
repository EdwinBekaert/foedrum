// A brewer's handover (ADR 0340): what it learned, a proposal a person reads, which no later prompt
// holds. Pure.

import type { Batch } from './fold.ts';

/** One handover line, by the attempt that wrote it. */
export interface Handover {
  stepId: string;
  attempt: number;
  text: string;
}

/** The lines of an out doc's handover, as `step.finished` records them. */
export const handoverOf = (_outDoc: string, _stepId: string): string[] => {
  throw new Error('not implemented');
};

/** An out doc's text as a later prompt reads it: without its handover. */
export const withoutHandover = (_text: string): string => {
  throw new Error('not implemented');
};

/** Every handover line of `batch`, in the order its steps first ran. */
export const handoversOf = (_batch: Batch): Handover[] => {
  throw new Error('not implemented');
};
