// The commits an attempt made (ADR 0074), the shell: git in the clone the attempt's worktree was
// added to, asked whether the commit it started at is still an ancestor of the attempt's branch
// and how many commits lie after it. Git runs only through the injected `Git`, so unit tests pass
// a fake one (ADR 0021).

import type { CommitsSeen } from '../engine/brewer-runner.ts';
import type { Git } from './git.ts';

/**
 * Counts the commits on `branch` in `clone` after `since`; never throws, git's failure is
 * `uncounted`.
 */
export type CountCommits = (
  clone: string,
  branch: string,
  since: string,
  signal?: AbortSignal,
) => Promise<CommitsSeen>;

export const countCommits =
  (_git: Git): CountCommits =>
  async () => {
    throw new Error('not implemented');
  };
