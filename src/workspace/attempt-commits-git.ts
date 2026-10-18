// The commits an attempt made (ADR 0074), the shell: git in the attempt's worktree, asked whether
// the commit it started at is still an ancestor of HEAD and how many commits lie after it. Git runs
// only through the injected `Git`, so unit tests pass a fake one (ADR 0021).

import type { CommitsSeen } from '../engine/brewer-runner.ts';
import type { Git } from './git.ts';

/** Counts the commits in `worktree` after `since`; never throws, git's failure is `uncounted`. */
export type CountCommits = (
  worktree: string,
  since: string,
  signal?: AbortSignal,
) => Promise<CommitsSeen>;

export const countCommits =
  (_git: Git): CountCommits =>
  async () => {
    throw new Error('not implemented');
  };
