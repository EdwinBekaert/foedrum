// git's unified diff, as the red proof and the testsUnchanged guard read it (ADR 0078): the lines
// each file gained and lost. Pure.

/** One file of a diff: its path before and after (absent when it was added or deleted). */
export interface DiffFile {
  oldPath?: string;
  newPath?: string;
  added: readonly string[];
  removed: readonly string[];
}

/** The files of `git diff` output made with `--no-color`, `--no-renames` and the a/ b/ prefixes. */
export function parseDiff(_text: string): DiffFile[] {
  throw new Error('not implemented');
}
