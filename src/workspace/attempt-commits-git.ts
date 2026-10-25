// The commits an attempt made (ADR 0074), the shell: git in the clone the attempt's worktree was
// added to, asked whether the commit it started at is still an ancestor of the attempt's branch
// and how many commits lie after it, and what the push's secret scan finds in them (ADR 0187). Git
// runs only through the injected `Git`, so unit tests pass a fake one (ADR 0021).

import type { CommitsScanned, CommitsSeen } from '../engine/brewer-runner.ts';
import { openBranchPush } from './branch-push-git.ts';
import { inClone } from './clone-git.ts';
import type { Git, GitResult } from './git.ts';

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

// A full sha, SHA-1 or SHA-256 as `CommitSha` allows, and an attempt's branch (`attemptBranch`),
// so that nothing reaches git as an option or a revision expression.
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const ATTEMPT_BRANCH = /^foedrum\/[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*\/\d+$/;

const firstLine = ({ code, stderr }: GitResult): string =>
  stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line !== '') ??
  (code === null ? 'git did not finish in time' : `git exited with ${code}`);

export const countCommits =
  (shared: Git): CountCommits =>
  async (clone, branch, since, signal) => {
    // No hook or fsmonitor of the clone's runs in the engine's git (ADR 0137).
    const git = inClone(shared);
    if (!SHA.test(since)) return { kind: 'uncounted', reason: `${since} is no full commit sha` };
    if (!ATTEMPT_BRANCH.test(branch)) {
      return { kind: 'uncounted', reason: `${JSON.stringify(branch)} is no attempt branch` };
    }
    const tip = `refs/heads/${branch}`;
    const options = signal === undefined ? {} : { signal };
    const ancestor = await git(clone, ['merge-base', '--is-ancestor', since, tip], options);
    // 0: an ancestor, 1: not one; anything else is git failing.
    if (ancestor.code === 1) return { kind: 'rewritten' };
    if (ancestor.code !== 0) {
      return { kind: 'uncounted', reason: `git merge-base failed: ${firstLine(ancestor)}` };
    }
    const listed = await git(clone, ['rev-list', '--count', `${since}..${tip}`], options);
    if (listed.code !== 0) {
      return { kind: 'uncounted', reason: `git rev-list failed: ${firstLine(listed)}` };
    }
    const count = listed.stdout.trim();
    if (!/^\d+$/.test(count)) {
      return { kind: 'uncounted', reason: `git rev-list gave no count: ${JSON.stringify(count)}` };
    }
    return { kind: 'counted', count: Number(count) };
  };

/**
 * Scans the commits on `branch` in `clone` after `since` as the push does (ADR 0079, ADR 0187);
 * never throws, git's failure is `unscanned`.
 */
export type ScanCommits = (
  clone: string,
  branch: string,
  since: string,
  signal?: AbortSignal,
) => Promise<CommitsScanned>;

export const scanAttemptCommits =
  (shared: Git): ScanCommits =>
  async (clone, branch, since, signal) => {
    if (!SHA.test(since)) return { kind: 'unscanned', reason: `${since} is no full commit sha` };
    if (!ATTEMPT_BRANCH.test(branch)) {
      return { kind: 'unscanned', reason: `${JSON.stringify(branch)} is no attempt branch` };
    }
    // The push's own scan, in the clone, with git reading the objects as committed (ADR 0079).
    const push = openBranchPush({ git: shared, clone });
    try {
      const tip = await push.commit(`refs/heads/${branch}`, signal);
      return { kind: 'scanned', findings: await push.secretScan(since, tip, signal) };
    } catch (error) {
      return { kind: 'unscanned', reason: error instanceof Error ? error.message : String(error) };
    }
  };
