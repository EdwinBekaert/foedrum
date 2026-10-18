// The commits an attempt made (ADR 0074), the shell: git in the attempt's worktree, asked whether
// the commit it started at is still an ancestor of HEAD and how many commits lie after it. Git runs
// only through the injected `Git`, so unit tests pass a fake one (ADR 0021).

import type { CommitsSeen } from '../engine/brewer-runner.ts';
import type { Git, GitResult } from './git.ts';

/** Counts the commits in `worktree` after `since`; never throws, git's failure is `uncounted`. */
export type CountCommits = (
  worktree: string,
  since: string,
  signal?: AbortSignal,
) => Promise<CommitsSeen>;

// A full sha, so that nothing reaches git as an option or a revision expression.
const SHA = /^[0-9a-f]{40}$/;

const firstLine = ({ code, stderr }: GitResult): string =>
  stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line !== '') ??
  (code === null ? 'git did not finish in time' : `git exited with ${code}`);

export const countCommits =
  (git: Git): CountCommits =>
  async (worktree, since, signal) => {
    if (!SHA.test(since)) return { kind: 'uncounted', reason: `${since} is no full commit sha` };
    const options = signal === undefined ? {} : { signal };
    const ancestor = await git(worktree, ['merge-base', '--is-ancestor', since, 'HEAD'], options);
    // 0: an ancestor, 1: not one; anything else is git failing.
    if (ancestor.code === 1) return { kind: 'rewritten' };
    if (ancestor.code !== 0) {
      return { kind: 'uncounted', reason: `git merge-base failed: ${firstLine(ancestor)}` };
    }
    const listed = await git(worktree, ['rev-list', '--count', `${since}..HEAD`], options);
    if (listed.code !== 0) {
      return { kind: 'uncounted', reason: `git rev-list failed: ${firstLine(listed)}` };
    }
    const count = listed.stdout.trim();
    if (!/^\d+$/.test(count)) {
      return { kind: 'uncounted', reason: `git rev-list gave no count: ${JSON.stringify(count)}` };
    }
    return { kind: 'counted', count: Number(count) };
  };
