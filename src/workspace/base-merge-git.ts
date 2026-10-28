// The merge of the base before a batch's last check (ADR 0164), the shell: git in the check
// attempt's worktree, pointed at its record under the clone, never by discovery (ADR 0029), with
// no hook or fsmonitor (ADR 0137). Git runs only through the injected `Git`, so unit tests pass a
// fake one (ADR 0021).

import type { WorktreeMerge } from '../engine/base-merge.ts';
import { samePath } from '../platform/paths.ts';
import { firstLine, gitOutput, inClone } from './clone-git.ts';
import type { Git, GitOptions } from './git.ts';
import { readRecords } from './worktree-records.ts';

const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** A merge of a large tree takes a while; the effect's deadline aborts it sooner. */
const MERGE_TIMEOUT_MS = 120_000;

const aborts = (signal: AbortSignal | undefined): GitOptions =>
  signal === undefined ? {} : { signal };

const fullSha = (sha: string): string => {
  if (!SHA.test(sha)) throw new Error(`${sha} is no full commit sha`);
  return sha;
};

export interface WorktreeMergeOptions {
  git: Git;
  /** The clone the attempt worktrees are added to: the user's, or the managed one. */
  clone: string;
}

export const openWorktreeMerge = ({ git, clone }: WorktreeMergeOptions): WorktreeMerge => {
  const engine = inClone(git);
  // The worktree's record under the clone: its folder's .git file, which a brewer can point at a
  // repository of its own, is never read (ADR 0029, ADR 0095).
  const recordOf = async (path: string, signal?: AbortSignal): Promise<string> => {
    const args = ['rev-parse', '--path-format=absolute', '--git-common-dir'];
    const common = (await gitOutput(engine, clone, args, aborts(signal))).trim();
    const records = await readRecords(common);
    const found = records.find(({ folder }) => folder !== undefined && samePath(folder, path));
    if (found === undefined) throw new Error(`${clone} has no record of the worktree ${path}`);
    return found.dir;
  };
  const local: Git = async (path, args, options = {}) => {
    const record = await recordOf(path, options.signal);
    return engine(path, [`--git-dir=${record}`, `--work-tree=${path}`, ...args], options);
  };
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
    pending: async () => {
      throw new Error('not implemented');
    },
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
