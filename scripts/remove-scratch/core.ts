// Decides what the brew-review scratch cleanup removes (ADR 0021, issue #61).

import type { RecordFact } from '../worktrees-clean/core.ts';

export interface ScratchFacts {
  // The checkout the review runs in; the scratch folder must lie inside its .foedrum/tmp/.
  checkout: string;
  scratch: string;
  // The contents of <scratch>/tree/.git, or undefined when that file is missing.
  dotGit: string | undefined;
  records: RecordFact[];
}

export type ScratchPlan = { ok: true; records: string[] } | { ok: false; reason: string };

export const planScratch = (_facts: ScratchFacts): ScratchPlan => {
  throw new Error('not implemented');
};
