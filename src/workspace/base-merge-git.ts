// The merge of the base before a batch's last check (ADR 0164), the shell: git in the check
// attempt's worktree, with no hook or fsmonitor (ADR 0137). Git runs only through the injected
// `Git`, so unit tests pass a fake one (ADR 0021).

import type { WorktreeMerge } from '../engine/base-merge.ts';
import { firstLine, gitOutput, inClone } from './clone-git.ts';
import type { Git, GitOptions } from './git.ts';

const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** A merge of a large tree takes a while; the effect's deadline aborts it sooner. */
const MERGE_TIMEOUT_MS = 120_000;

const aborts = (signal: AbortSignal | undefined): GitOptions =>
  signal === undefined ? {} : { signal };

const fullSha = (sha: string): string => {
  if (!SHA.test(sha)) throw new Error(`${sha} is no full commit sha`);
  return sha;
};

export const openWorktreeMerge = (git: Git): WorktreeMerge => {
  const local = inClone(git);
  const head = async (path: string, signal?: AbortSignal): Promise<string> => {
    const args = ['rev-parse', '--verify', '--quiet', '--end-of-options', 'HEAD^{commit}'];
    const sha = (await gitOutput(local, path, args, aborts(signal))).trim();
    if (!SHA.test(sha)) throw new Error(`The HEAD of ${path} names no commit: ${sha}`);
    return sha;
  };
  const abort = async (path: string, signal?: AbortSignal): Promise<void> => {
    // MERGE_HEAD is there while a merge is in progress.
    const args = ['rev-parse', '--verify', '--quiet', '--end-of-options', 'MERGE_HEAD'];
    if ((await local(path, args, aborts(signal))).code === 0) {
      await gitOutput(local, path, ['merge', '--abort'], aborts(signal));
    }
  };
  return {
    head,
    parents: async (path, commit, signal) => {
      const args = ['rev-list', '--parents', '--max-count=1', '--end-of-options', fullSha(commit)];
      const [, ...parents] = (await gitOutput(local, path, args, aborts(signal))).trim().split(' ');
      return parents;
    },
    abort,
    merge: async (path, commit, message, signal) => {
      // A commit of its own, also when the start is behind the base, and no editor.
      const args = ['merge', '--no-ff', '--no-edit', '--no-verify', '-m', message];
      const result = await local(path, [...args, '--end-of-options', fullSha(commit)], {
        ...aborts(signal),
        timeoutMs: MERGE_TIMEOUT_MS,
      });
      if (result.code === 0) return { kind: 'merged', commit: await head(path, signal) };
      const unmerged = await gitOutput(
        local,
        path,
        ['diff', '--no-ext-diff', '--name-only', '--diff-filter=U', '-z'],
        aborts(signal),
      );
      const files = unmerged.split('\0').filter((file) => file !== '');
      await abort(path, signal);
      if (files.length === 0) throw new Error(`git merge failed: ${firstLine(result)}`);
      return { kind: 'conflicts', files };
    },
  };
};
