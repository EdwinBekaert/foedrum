// The merge-tree of an open pull request's head and its base's tip (ADR 0198), the shell: git in a
// git directory of Foedrum's own with the clone's objects (ADR 0090), so no hook and no
// configuration of the clone's takes part, and no merge driver a `.gitattributes` names runs. Git
// runs only through the injected `Git`, so unit tests pass a fake one (ADR 0021). The checks on
// the merged tree get a worktree of it from such a directory (ADR 0203).

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { MergeTreeResult } from '../engine/base-check.ts';
import { removeTree } from '../platform/remove.ts';
import { firstLine, gitOutput, inClone, type OwnRemote, withOwnGitDir } from './clone-git.ts';
import type { Git, GitResult } from './git.ts';

export interface MergeTreeOptions {
  git: Git;
  /** The clone the attempt worktrees are added to: the user's, or the managed one. */
  clone: string;
  /** The remote as Foedrum names it: a blobless clone's missing blobs come from there. */
  own?: OwnRemote;
}

const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** A merge of a large tree takes a while; the intake pass's deadline aborts it sooner. */
const MERGE_TIMEOUT_MS = 120_000;

/** The checkout of the merged tree, which in a blobless clone fetches its blobs (ADR 0203). */
const CHECKOUT_TIMEOUT_MS = 300_000;

/** Who makes the merged tree's commit: Foedrum, so the user's configuration need not name one. */
const FOEDRUM = {
  GIT_AUTHOR_NAME: 'Foedrum',
  GIT_AUTHOR_EMAIL: 'foedrum@localhost',
  GIT_COMMITTER_NAME: 'Foedrum',
  GIT_COMMITTER_EMAIL: 'foedrum@localhost',
};

/** A ref of the clone's that the merged tree's directory gets: a tag or a remote-tracking ref. */
const COPIED_REF = /^(?:[0-9a-f]{40}|[0-9a-f]{64}) refs\/(?:tags|remotes)\/\S+$/;

const fullSha = (sha: string): string => {
  if (!SHA.test(sha)) throw new Error(`${JSON.stringify(sha)} is no full commit sha`);
  return sha;
};

const mergeArgs = (head: string, tip: string): string[] => [
  'merge-tree',
  '--write-tree',
  '--name-only',
  '--no-messages',
  '-z',
  '--end-of-options',
  fullSha(head),
  fullSha(tip),
];

/** What git's merge-tree answered: the merged tree, and the files of a conflict. */
const mergeOf = (result: GitResult): { tree: string; conflicts: string[] } => {
  // 0: clean, 1: conflicts; anything else is git failing.
  if (result.code !== 0 && result.code !== 1) {
    throw new Error(`git merge-tree failed: ${firstLine(result)}`);
  }
  // The merged tree, then each conflicting file, each after a NUL.
  const [tree = '', ...named] = result.stdout.split('\0');
  if (result.code === 0) return { tree: tree.trim(), conflicts: [] };
  const conflicts = [...new Set(named.filter((file) => file !== ''))];
  if (conflicts.length === 0) {
    throw new Error(`git merge-tree named no conflicting file: ${firstLine(result)}`);
  }
  return { tree: tree.trim(), conflicts };
};

/** How `head` and `tip`, both full shas the clone has, merge. */
export const openMergeTree =
  ({ git, clone, own }: MergeTreeOptions) =>
  async (head: string, tip: string, signal?: AbortSignal): Promise<MergeTreeResult> => {
    const args = mergeArgs(head, tip);
    if (own === undefined) {
      throw new Error(`The merge-tree in ${clone} names no URL to reach the remote by`);
    }
    const result = await withOwnGitDir(git, clone, own, signal, (dir) =>
      dir.read(args, { timeoutMs: MERGE_TIMEOUT_MS }),
    );
    const { conflicts } = mergeOf(result);
    return conflicts.length === 0 ? { kind: 'clean' } : { kind: 'conflicts', files: conflicts };
  };

/** A worktree of the merged tree of `head` and `tip` for `use`, removed after (ADR 0203). */
export type MergedTree = <T>(
  head: string,
  tip: string,
  use: (worktree: string) => Promise<T>,
  signal?: AbortSignal,
) => Promise<T>;

/**
 * Runs `use` with a worktree of the merged tree of `head` and `tip` (ADR 0203): a commit of it on
 * both, checked out from a git directory of Foedrum's own that borrows the clone's objects and
 * holds a copy of its tags and remote-tracking refs. Both go when `use` ends, also when it fails.
 */
export const openMergedTree =
  ({ git, clone, own }: MergeTreeOptions): MergedTree =>
  async <T>(
    head: string,
    tip: string,
    use: (worktree: string) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> => {
    const args = mergeArgs(head, tip);
    if (own === undefined) {
      throw new Error(`The merged tree in ${clone} names no URL to reach the remote by`);
    }
    return withOwnGitDir(git, clone, own, signal, async (dir) => {
      const { tree, conflicts } = mergeOf(await dir.read(args, { timeoutMs: MERGE_TIMEOUT_MS }));
      if (conflicts.length > 0) {
        throw new Error(`the merge with ${tip} conflicts in ${conflicts.join(', ')}`);
      }
      const message = 'The merged tree the checks read (ADR 0203)';
      const commit = fullSha(
        (
          await dir.run(['commit-tree', fullSha(tree), '-p', head, '-p', tip, '-m', message], {
            env: FOEDRUM,
          })
        ).trim(),
      );
      // The clone's tags and remote-tracking refs, so `git describe` or a log of the base reads
      // what it reads in a check step's worktree.
      const listed = await gitOutput(
        inClone(git),
        clone,
        ['for-each-ref', '--format=%(objectname) %(refname)', 'refs/tags', 'refs/remotes'],
        signal === undefined ? {} : { signal },
      );
      const refs = listed
        .split(/\r?\n/)
        .filter((line) => COPIED_REF.test(line))
        .map((line) => `${line}\n`);
      await writeFile(join(dir.path, 'packed-refs'), refs.join(''));
      // git in the worktree runs without the call's object directory: it borrows the clone's.
      await mkdir(join(dir.path, 'objects', 'info'), { recursive: true });
      await writeFile(join(dir.path, 'objects', 'info', 'alternates'), `${dir.objects}\n`);
      const worktree = dir.path.replace(/\.git$/, '.tree');
      try {
        const added = await dir.read(
          ['worktree', 'add', '--quiet', '--detach', '--end-of-options', worktree, commit],
          { timeoutMs: CHECKOUT_TIMEOUT_MS },
        );
        if (added.code !== 0) throw new Error(`git worktree add failed: ${firstLine(added)}`);
        return await use(worktree);
      } finally {
        await removeTree(worktree);
      }
    });
  };
