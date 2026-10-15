// Decides what the brew-review scratch cleanup removes (ADR 0021, issue #61): the scratch
// folder, only as .foedrum/tmp/<folder>/scratch in the checkout, and a record under
// .git/worktrees/ that still points at its tree, never others.

import { join } from 'node:path';
import { pathInside, samePath } from '../../src/platform/paths.ts';
import type { RecordFact } from '../worktrees-clean/core.ts';

export interface ScratchFacts {
  // The checkout the review runs in; the scratch folder must be its .foedrum/tmp/<folder>/scratch.
  checkout: string;
  scratch: string;
  records: RecordFact[];
}

export type ScratchPlan = { ok: true; records: string[] } | { ok: false; reason: string };

// The review's scratch tree is a clone, which has no record; a record whose gitdir file points
// at <scratch>/tree is left by a run from before that, when the tree was a worktree.
export const planScratch = (facts: ScratchFacts): ScratchPlan => {
  // Only the shape the review skill uses, .foedrum/tmp/<one folder>/scratch: the removal is
  // recursive, so another issue's folder or the tests' folder must never qualify.
  const tmp = join(facts.checkout, '.foedrum', 'tmp');
  if (!/^[^/]+\/scratch$/.test(pathInside(tmp, facts.scratch) ?? '')) {
    return { ok: false, reason: `${facts.scratch} is not inside ${tmp} as <folder>/scratch` };
  }
  const tree = join(facts.scratch, 'tree');
  const records = facts.records.filter(
    ({ folder }) => folder !== undefined && samePath(folder, tree),
  );
  return { ok: true, records: records.map(({ dir }) => dir) };
};
