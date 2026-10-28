// The commits an attempt made (ADR 0074), the shell: git in the clone the attempt's worktree was
// added to, asked whether the commit it started at is still an ancestor of the attempt's branch
// and how many commits lie after it, and what the push's secret scan finds in them (ADR 0187). Git
// runs only through the injected `Git`, so unit tests pass a fake one (ADR 0021).

import type { CommitsScanned, CommitsSeen } from '../engine/brewer-runner.ts';
import { isCommitSha, noCommitSha } from '../schemas/store.ts';
import { openBranchPush } from './branch-push-git.ts';
import { firstLine, inClone } from './clone-git.ts';
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

// An attempt's branch (`attemptBranch`), and a full sha (ADR 0254), so that nothing reaches git as
// an option or a revision expression.
const ATTEMPT_BRANCH = /^foedrum\/[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*\/\d+$/;

/** Why `since` or `branch` must not reach git, or nothing when both may. */
const unsafe = (since: string, branch: string): string | undefined => {
  if (!isCommitSha(since)) return noCommitSha(since);
  if (!ATTEMPT_BRANCH.test(branch)) return `${JSON.stringify(branch)} is no attempt branch`;
  return undefined;
};

export const countCommits =
  (shared: Git): CountCommits =>
  async (clone, branch, since, signal) => {
    // No hook or fsmonitor of the clone's runs in the engine's git (ADR 0137).
    const git = inClone(shared);
    const refused = unsafe(since, branch);
    if (refused !== undefined) return { kind: 'uncounted', reason: refused };
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
    const refused = unsafe(since, branch);
    if (refused !== undefined) return { kind: 'unscanned', reason: refused };
    // The push's own scan, in the clone, with git reading the objects as committed (ADR 0079).
    const push = openBranchPush({ git: shared, clone });
    try {
      const tip = await push.commit(`refs/heads/${branch}`, signal);
      return { kind: 'scanned', findings: await push.secretScan(since, tip, signal) };
    } catch (error) {
      return { kind: 'unscanned', reason: error instanceof Error ? error.message : String(error) };
    }
  };
