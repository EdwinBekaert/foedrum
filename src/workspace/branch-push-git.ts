// The pushes of the openPullRequest action (ADR 0071), the shell: git in the repository's clone,
// never in an attempt's worktree (ADR 0066). Git runs only through the injected `Git`, so unit
// tests pass a fake one (ADR 0021).

import { devNull } from 'node:os';
import type { BranchPush } from '../engine/pull-request-actions.ts';
import type { Git, GitOptions, GitResult } from './git.ts';

export interface BranchPushOptions {
  git: Git;
  /** The clone the attempt worktrees are added to: the user's, or the managed one. */
  clone: string;
  /** Default `origin`. */
  remote?: string;
}

/** A push of a large repository takes a while; the effect's deadline aborts it sooner. */
const PUSH_TIMEOUT_MS = 300_000;

const SHA = /^[0-9a-f]{40}$/;
// A branch Foedrum pushes, so that nothing from outside reaches git as an option or a refspec.
const FOEDRUM_BRANCH = /^foedrum\/[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)+$/;

const firstLine = ({ code, stderr }: GitResult): string =>
  stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line !== '') ??
  (code === null ? 'git did not finish in time' : `git exited with ${code}`);

// The signal as git's options take it.
const aborts = (signal: AbortSignal | undefined): GitOptions =>
  signal === undefined ? {} : { signal };

const foedrumBranch = (branch: string): string => {
  if (!FOEDRUM_BRANCH.test(branch)) {
    throw new Error(`${JSON.stringify(branch)} is no branch in foedrum/`);
  }
  return branch;
};

export const openBranchPush = (options: BranchPushOptions): BranchPush => {
  const { git, clone, remote = 'origin' } = options;
  const must = async (args: string[], gitOptions: GitOptions): Promise<string> => {
    const result = await git(clone, args, gitOptions);
    if (result.code !== 0) throw new Error(`git ${args[0]} failed: ${firstLine(result)}`);
    return result.stdout;
  };
  return {
    commit: async (revision, signal) => {
      const args = ['rev-parse', '--verify', '--quiet', '--end-of-options', `${revision}^{commit}`];
      const result = await git(clone, args, aborts(signal));
      const commit = result.stdout.trim();
      if (result.code !== 0 || !SHA.test(commit)) {
        throw new Error(`The revision ${revision} is no commit in ${clone}`);
      }
      return commit;
    },
    remoteTip: async (branch, signal) => {
      const ref = `refs/heads/${foedrumBranch(branch)}`;
      const listed = await must(['ls-remote', '--refs', remote, ref], aborts(signal));
      for (const line of listed.split(/\r?\n/)) {
        const [commit, name] = line.split('\t');
        if (name === ref && commit !== undefined && SHA.test(commit)) return commit;
      }
      return undefined;
    },
    push: async (commit, branch, signal) => {
      if (!SHA.test(commit)) throw new Error(`${commit} is no full commit sha`);
      const refspec = `${commit}:refs/heads/${foedrumBranch(branch)}`;
      // Never by force, and no hook of the clone runs: not the user's, and not one a brewer's code
      // wrote into the clone its worktree shares (`--no-verify` alone skips only pre-push).
      await must(['push', '--no-verify', remote, refspec], {
        ...aborts(signal),
        timeoutMs: PUSH_TIMEOUT_MS,
        config: { 'core.hooksPath': devNull },
      });
    },
  };
};
