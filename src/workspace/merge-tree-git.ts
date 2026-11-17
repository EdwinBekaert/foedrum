// The merge-tree of an open pull request's head and its base's tip (ADR 0198), the shell: git in a
// git directory of Foedrum's own with the clone's objects (ADR 0090), so no hook and no
// configuration of the clone's takes part, and no merge driver a `.gitattributes` names runs. Git
// runs only through the injected `Git`, so unit tests pass a fake one (ADR 0021). The checks on
// the merged tree get a worktree of it from such a directory (ADR 0203).

import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { MergeTreeResult } from '../engine/base-check.ts';
import { pathInside } from '../platform/paths.ts';
import { realPath } from '../platform/real-path.ts';
import { removeTree } from '../platform/remove.ts';
import { isCommitSha } from '../schemas/store.ts';
import { isAttemptBranch } from './attempt-commits-git.ts';
import {
  aborts,
  fullSha,
  gitOutput,
  inClone,
  type OwnGitDir,
  type OwnRemote,
  withOwnGitDir,
} from './clone-git.ts';
import { type Git, type GitResult, gitFailure } from './git.ts';

export interface MergeTreeOptions {
  git: Git;
  /** The clone the attempt worktrees are added to: the user's, or the managed one. */
  clone: string;
  /** The remote as Foedrum names it: a blobless clone's missing blobs come from there. */
  own?: OwnRemote;
}

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
const COPIED_REF = /^refs\/(?:tags|remotes)\/\S+$/;
/** Whether a line of `for-each-ref` names a full commit sha (ADR 0254) and such a ref. */
const isCopiedRef = (line: string): boolean => {
  const [sha = '', ref = '', ...rest] = line.split(' ');
  return isCommitSha(sha) && COPIED_REF.test(ref) && rest.length === 0;
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
    throw new Error(`git merge-tree failed: ${gitFailure(result)}`);
  }
  // The merged tree, then each conflicting file, each after a NUL.
  const [tree = '', ...named] = result.stdout.split('\0');
  if (result.code === 0) return { tree: tree.trim(), conflicts: [] };
  const conflicts = [...new Set(named.filter((file) => file !== ''))];
  if (conflicts.length === 0) {
    throw new Error(`git merge-tree named no conflicting file: ${gitFailure(result)}`);
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
      return checkedOut({ git, clone }, dir, commit, use, signal);
    });
  };

/**
 * Runs `use` with a worktree of `commit` checked out from `dir`, a git directory of Foedrum's own,
 * which gets a copy of the clone's tags and remote-tracking refs and borrows its objects. The
 * worktree goes when `use` ends, also when it fails.
 */
const checkedOut = async <T>(
  { git, clone }: Pick<MergeTreeOptions, 'git' | 'clone'>,
  dir: OwnGitDir,
  commit: string,
  use: (worktree: string) => Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> => {
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
    .filter(isCopiedRef)
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
    if (added.code !== 0) throw new Error(`git worktree add failed: ${gitFailure(added)}`);
    return await use(worktree);
  } finally {
    await removeTree(worktree);
  }
};

/**
 * Runs `use` with a scratch worktree of the tip of `branch`, an attempt's branch in the clone, and
 * commits the files it names on that branch, as Foedrum, with `message` (ADR 0412); the commit's
 * sha, or none when `use` names no file.
 */
export type BranchCommit = <T>(
  branch: string,
  message: string,
  use: (worktree: string) => Promise<{ value: T; files: readonly string[] }>,
  signal?: AbortSignal,
) => Promise<{ value: T; commit?: string }>;

export const openBranchCommit =
  ({ git, clone, own }: MergeTreeOptions): BranchCommit =>
  async <T>(
    branch: string,
    message: string,
    use: (worktree: string) => Promise<{ value: T; files: readonly string[] }>,
    signal?: AbortSignal,
  ): Promise<{ value: T; commit?: string }> => {
    if (!isAttemptBranch(branch)) throw new Error(`${JSON.stringify(branch)} is no attempt branch`);
    if (own === undefined) {
      throw new Error(`The scratch tree in ${clone} names no URL to reach the remote by`);
    }
    const ref = `refs/heads/${branch}`;
    const inTheClone = inClone(git);
    const tip = fullSha(
      (
        await gitOutput(
          inTheClone,
          clone,
          ['rev-parse', '--verify', `${ref}^{commit}`],
          aborts(signal),
        )
      ).trim(),
    );
    return withOwnGitDir(git, clone, own, signal, (dir) =>
      checkedOut(
        { git, clone },
        dir,
        tip,
        async (worktree) => {
          const { value, files } = await use(worktree);
          if (files.length === 0) return { value };
          // The tip's tree with the files as the tree holds them, in an index of the directory's own.
          const index = { env: { GIT_INDEX_FILE: join(dir.path, 'foedrum.index') } };
          await dir.run(['read-tree', tip], index);
          for (const file of files) {
            const path = join(worktree, ...file.split('/'));
            // As a commit of that path stores it: a checkout's CRLF goes back to the repository's
            // line ends (core.autocrlf, which Git for Windows sets).
            const blob = (
              await dir.run(['hash-object', '-w', `--path=${file}`, '--', path])
            ).trim();
            await dir.run(
              ['update-index', '--add', '--cacheinfo', `100644,${blob},${file}`],
              index,
            );
          }
          const tree = (await dir.run(['write-tree'], index)).trim();
          const made = await dir.run(['commit-tree', tree, '-p', tip, '-m', message], {
            env: FOEDRUM,
          });
          const commit = fullSha(made.trim());
          // Only from the tip the tree was made from: a branch moved meanwhile is no one's to lose.
          await gitOutput(inTheClone, clone, ['update-ref', ref, commit, tip], aborts(signal));
          return { value, commit };
        },
        signal,
      ),
    );
  };

/** A file of a scratch tree rewritten after its checkout: a mutant's (ADR 0313). */
export interface TreeEdit {
  /** A plain relative path, with forward slashes. */
  file: string;
  /** The file's new text from its text as git checked it out; throws when it cannot be made. */
  rewrite: (checkedOut: string) => string;
}

/**
 * A worktree of `commit`, with `edit` written over its file, for `use`, removed after (ADR 0313).
 */
export type CommitTree = <T>(
  commit: string,
  use: (worktree: string) => Promise<T>,
  options?: { signal?: AbortSignal; edit?: TreeEdit },
) => Promise<T>;

/**
 * Runs `use` with a scratch worktree of `commit` (ADR 0313), checked out from a git directory of
 * Foedrum's own as the merged tree is (ADR 0203). Both go when `use` ends, also when it fails.
 */
export const openCommitTree =
  ({ git, clone, own }: MergeTreeOptions): CommitTree =>
  async <T>(
    commit: string,
    use: (worktree: string) => Promise<T>,
    options: { signal?: AbortSignal; edit?: TreeEdit } = {},
  ): Promise<T> => {
    const { signal, edit } = options;
    const sha = fullSha(commit);
    if (own === undefined) {
      throw new Error(`The scratch tree in ${clone} names no URL to reach the remote by`);
    }
    return withOwnGitDir(git, clone, own, signal, (dir) =>
      checkedOut(
        { git, clone },
        dir,
        sha,
        async (worktree) => {
          if (edit !== undefined) {
            // A plain relative path the mutant check accepted. A link the commit holds, there or on
            // the way, could lead the write out of the tree: only a regular file inside it is edited.
            const file = join(worktree, ...edit.file.split('/'));
            const found = await lstat(file).catch(() => undefined);
            if (
              found?.isFile() !== true ||
              pathInside(realPath(worktree), realPath(file)) === undefined
            ) {
              throw new Error(
                `${JSON.stringify(edit.file)} is no regular file of the scratch tree`,
              );
            }
            // Read strictly: a lossy decode would rewrite every byte that is not UTF-8.
            let text: string;
            try {
              text = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(file));
            } catch {
              throw new Error(
                `${JSON.stringify(edit.file)} is not UTF-8: a rewrite would change more than its line`,
              );
            }
            await writeFile(file, edit.rewrite(text));
          }
          return use(worktree);
        },
        signal,
      ),
    );
  };
