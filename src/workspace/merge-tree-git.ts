// The merge-tree of an open pull request's head and its base's tip (ADR 0198), the shell: git in a
// git directory of Foedrum's own with the clone's objects (ADR 0090), so no hook and no
// configuration of the clone's takes part. Git runs only through the injected `Git`, so unit tests
// pass a fake one (ADR 0021).

import type { MergeTreeResult } from '../engine/base-check.ts';
import type { OwnRemote } from './clone-git.ts';
import type { Git } from './git.ts';

export interface MergeTreeOptions {
  git: Git;
  /** The clone the attempt worktrees are added to: the user's, or the managed one. */
  clone: string;
  /** The remote as Foedrum names it: a blobless clone's missing blobs come from there. */
  own?: OwnRemote;
}

/** How `head` and `tip`, both full shas the clone has, merge. */
export const openMergeTree =
  (_options: MergeTreeOptions) =>
  async (_head: string, _tip: string, _signal?: AbortSignal): Promise<MergeTreeResult> => {
    throw new Error('not implemented');
  };

/** Whether the git `git` runs can merge-tree with `--write-tree`: 2.38 or later. */
export const mergeTreeSupported = async (
  _git: Git,
  _cwd: string,
  _signal?: AbortSignal,
): Promise<boolean> => {
  throw new Error('not implemented');
};
