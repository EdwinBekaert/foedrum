// What a person reads first of a ready pull request, and how long a careful read takes (ADR 0422):
// the files the Tasters' findings point at most, then the largest changes, and an effort from 1 to
// 5 by the change's lines, all from what the push recorded, never a model's say.

import { type ChangeSize, MAX_SIZED } from '../schemas/store.ts';
import { isLock } from './look-before-merging.ts';
import { plain } from './status-comment.ts';

/** A file of a change and the lines it adds and deletes; none for a binary file. */
export interface ChangedFile {
  path: string;
  lines?: number;
}

/** How many files the line names. */
const MOST_NAMED = 3;
/** The most changed lines of each effort below 5, the maintainer's to tune (ADR 0422). */
const EFFORT_CUTS = [50, 200, 400, 1_000];

/** Paths in code-unit order, the same on every machine. */
const byPath = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** How large the change of `files` is, lock files left out; none when only lock files changed. */
export const sizeOf = (files: readonly ChangedFile[]): ChangeSize | undefined => {
  const counted = files.filter(({ path }) => !isLock(path));
  if (counted.length === 0) return undefined;
  const largest = counted
    .flatMap(({ path, lines }) => (lines === undefined ? [] : [{ path, lines }]))
    .sort((a, b) => b.lines - a.lines || byPath(a.path, b.path));
  return {
    lines: largest.reduce((sum, { lines }) => sum + lines, 0),
    files: counted.length,
    largest: largest.slice(0, MAX_SIZED),
  };
};

/** The review effort, 1 to 5, of a change of `lines` changed lines. */
export const effortOf = (lines: number): number => {
  const below = EFFORT_CUTS.findIndex((most) => lines <= most);
  return below < 0 ? EFFORT_CUTS.length + 1 : below + 1;
};

const counted = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * The merge brief's read-first line from the push's `size` and the files of the Tasters'
 * `findings`, each once per finding, which count only for a file the push recorded: a finding's
 * file is a model's words, which only the brief's Findings heading shows (ADR 0225).
 */
export const readFirstLine = (
  size: ChangeSize,
  findings: readonly (string | undefined)[],
): string => {
  const found = new Map<string, number>();
  for (const file of findings) {
    if (file !== undefined) found.set(file, (found.get(file) ?? 0) + 1);
  }
  const named = size.largest
    .map(({ path, lines }) => ({ path, lines, findings: found.get(path) ?? 0 }))
    .sort((a, b) => b.findings - a.findings || b.lines - a.lines || byPath(a.path, b.path))
    .slice(0, MOST_NAMED)
    .map(({ path }) => plain(path));
  const effort = `${effortOf(size.lines)} of 5 (${counted(size.lines, 'changed line')} in ${counted(size.files, 'file')})`;
  return named.length === 0
    ? `**Effort:** ${effort}.`
    : `**Read first:** ${named.join(', ')} · effort ${effort}.`;
};
