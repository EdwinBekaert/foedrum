// Decides what the brew-review scratch cleanup removes (ADR 0021, issue #61): the scratch
// folder, only as .foedrum/tmp/<folder>/scratch in the checkout, and the records of its tree,
// never others.

import { join, resolve } from 'node:path';
import { pathInside, samePath } from '../../src/platform/paths.ts';
import type { RecordFact } from '../worktrees-clean/core.ts';

export interface ScratchFacts {
  // The checkout the review runs in; the scratch folder must be its .foedrum/tmp/<folder>/scratch.
  checkout: string;
  scratch: string;
  // The contents of <scratch>/tree/.git, or undefined when that file is missing.
  dotGit: string | undefined;
  records: RecordFact[];
}

export type ScratchPlan = { ok: true; records: string[] } | { ok: false; reason: string };

// A record belongs to the tree when its gitdir file points at it, or when the tree's .git file
// names it and its own gitdir file is gone (git removed the tree part-way).
export const planScratch = (facts: ScratchFacts): ScratchPlan => {
  // Only the shape the review skill uses, .foedrum/tmp/<one folder>/scratch: the removal is
  // recursive, so another issue's folder or the tests' folder must never qualify.
  const tmp = join(facts.checkout, '.foedrum', 'tmp');
  if (!/^[^/]+\/scratch$/.test(pathInside(tmp, facts.scratch) ?? '')) {
    return { ok: false, reason: `${facts.scratch} is not inside ${tmp} as <folder>/scratch` };
  }
  const tree = join(facts.scratch, 'tree');
  const named = /^gitdir:(.*)$/m.exec(facts.dotGit ?? '')?.[1]?.trim();
  const records = facts.records.filter(({ dir, folder }) =>
    folder === undefined
      ? named !== undefined && named !== '' && samePath(resolve(tree, named), dir)
      : samePath(folder, tree),
  );
  return { ok: true, records: records.map(({ dir }) => dir) };
};
