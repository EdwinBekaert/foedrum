// The pushes of the openPullRequest action (ADR 0071), the shell: git in the repository's clone,
// never in an attempt's worktree (ADR 0066). Git runs only through the injected `Git`, so unit
// tests pass a fake one (ADR 0021).

import type { BranchPush } from '../engine/pull-request-actions.ts';
import type { Git } from './git.ts';

export interface BranchPushOptions {
  git: Git;
  /** The clone the attempt worktrees are added to: the user's, or the managed one. */
  clone: string;
  /** Default `origin`. */
  remote?: string;
}

export const openBranchPush = (_options: BranchPushOptions): BranchPush => {
  throw new Error('not implemented');
};
