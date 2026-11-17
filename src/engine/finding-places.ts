// Whether the place each Taster finding cites exists at the head the Taster reviewed (ADR 0421):
// a file, and a line within it, by the citation check /brew-review runs too. Git runs only through
// the injected `ReadFiles`, so no model and no fold is involved.

import type { Ending } from './decide.ts';

/** The tree a Taster reviewed: the commit its worktree started at, in its repository's clone. */
export interface ReviewedTree {
  clone: string;
  commit: string;
}

/**
 * The text of each of the paths that is a regular file at the commit, and none for one that is not
 * (missing, a folder, a link or a submodule); or why git could not read them.
 */
export type FilesRead =
  | { kind: 'read'; files: ReadonlyMap<string, string | undefined> }
  | { kind: 'unread'; reason: string };

/** The files `paths` at `commit` in `clone`; never throws, git's failure is `unread`. */
export type ReadFiles = (
  clone: string,
  commit: string,
  paths: readonly string[],
  signal?: AbortSignal,
) => Promise<FilesRead>;

/**
 * `ending`, with each finding of a Taster's marked where its file or its line does not exist in
 * `reviewed` (ADR 0421).
 */
export async function placesChecked(
  _read: ReadFiles,
  _ending: Ending,
  _reviewed: ReviewedTree | undefined,
  _signal?: AbortSignal,
): Promise<Ending> {
  throw new Error('not implemented');
}
