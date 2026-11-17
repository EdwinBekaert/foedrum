// What a person reads first of a ready pull request, and how long a careful read takes (ADR 0422):
// the files the Tasters' findings point at most, then the largest changes, and an effort from 1 to
// 5 by the change's lines, all from what the push recorded, never a model's say.

import type { ChangeSize } from '../schemas/store.ts';

/** A file of a change and the lines it adds and deletes; none for a binary file. */
export interface ChangedFile {
  path: string;
  lines?: number;
}

/** How large the change of `files` is, lock files left out; none when only lock files changed. */
export const sizeOf = (_files: readonly ChangedFile[]): ChangeSize | undefined => {
  throw new Error('not implemented');
};

/** The review effort, 1 to 5, of a change of `lines` changed lines. */
export const effortOf = (_lines: number): number => {
  throw new Error('not implemented');
};

/**
 * The merge brief's read-first line from the push's `size` and the files of the Tasters'
 * `findings`, each once per finding, which count only for a file the push recorded.
 */
export const readFirstLine = (
  _size: ChangeSize,
  _findings: readonly (string | undefined)[],
): string => {
  throw new Error('not implemented');
};
