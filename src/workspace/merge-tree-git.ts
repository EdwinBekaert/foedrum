// The merge-tree of an open pull request's head and its base's tip (ADR 0198), the shell: git in a
// git directory of Foedrum's own with the clone's objects (ADR 0090), so no hook and no
// configuration of the clone's takes part, and no merge driver a `.gitattributes` names runs. Git
// runs only through the injected `Git`, so unit tests pass a fake one (ADR 0021).

import type { MergeTreeResult } from '../engine/base-check.ts';
import { firstLine, type OwnRemote, withOwnGitDir } from './clone-git.ts';
import type { Git } from './git.ts';

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

const fullSha = (sha: string): string => {
  if (!SHA.test(sha)) throw new Error(`${JSON.stringify(sha)} is no full commit sha`);
  return sha;
};

/** How `head` and `tip`, both full shas the clone has, merge. */
export const openMergeTree =
  ({ git, clone, own }: MergeTreeOptions) =>
  async (head: string, tip: string, signal?: AbortSignal): Promise<MergeTreeResult> => {
    const args = [
      'merge-tree',
      '--write-tree',
      '--name-only',
      '--no-messages',
      '-z',
      '--end-of-options',
      fullSha(head),
      fullSha(tip),
    ];
    if (own === undefined) {
      throw new Error(`The merge-tree in ${clone} names no URL to reach the remote by`);
    }
    const result = await withOwnGitDir(git, clone, own, signal, (dir) =>
      dir.read(args, { timeoutMs: MERGE_TIMEOUT_MS }),
    );
    // 0: clean, 1: conflicts; anything else is git failing.
    if (result.code === 0) return { kind: 'clean' };
    if (result.code !== 1) throw new Error(`git merge-tree failed: ${firstLine(result)}`);
    // The merged tree, then each conflicting file, each after a NUL.
    const [, ...named] = result.stdout.split('\0');
    const files = [...new Set(named.filter((file) => file !== ''))];
    if (files.length === 0) {
      throw new Error(`git merge-tree named no conflicting file: ${firstLine(result)}`);
    }
    return { kind: 'conflicts', files };
  };
