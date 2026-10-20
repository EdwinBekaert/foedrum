// Reads the task-tree branches the cleanup keeps (ADR 0084, ADR 0092) for `foedrum status`: each
// branch's tip and its commits past the batch's start, through the engine's git in the clone the
// attempt worktrees are added to, never in a worktree a brewer wrote. kept-branches.ts decides.

import type { State } from '../engine/fold.ts';
import type { Git } from '../workspace/git.ts';
import type { BranchReading } from './kept-branches.ts';

export interface KeptBranchesShell {
  git: Git;
  /** The clone a repository's attempt worktrees are added to, or undefined when none is known. */
  cloneOf: (repo: string) => string | undefined;
}

/** What git says of each branch of `unpushed` (`Claims.unpushed`), by name. */
export const readKeptBranches = async (
  _state: State,
  _unpushed: ReadonlyMap<string, string>,
  _shell: KeptBranchesShell,
): Promise<Map<string, BranchReading>> => {
  throw new Error('not implemented');
};
