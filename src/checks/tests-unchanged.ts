// The testsUnchanged guard, the core (ADR 0017, ADR 0274, ADR 0297): which lines the proven step
// added to a separate test file of the test map an attempt changed or removed. Pure;
// tests-guard.ts reads the diffs and the maps.

import type { DiffFile } from '../formats/unified-diff.ts';
import { areaOf, type EffectiveModule } from './test-map.ts';

/** A line of the proven step's tests that an attempt changed or removed, in the file it was in. */
export interface ChangedTestLine {
  path: string;
  line: string;
}

/** How often each line occurs, trimmed. */
function counts(lines: readonly string[]): Map<string, number> {
  const found = new Map<string, number>();
  for (const line of lines) found.set(line.trim(), (found.get(line.trim()) ?? 0) + 1);
  return found;
}

/** What a guarded attempt left: each guarded test file's text at its tip, absent where it is gone. */
export interface AttemptTip {
  files: ReadonlyMap<string, string>;
  /** The same files where the proven step started, absent where they were not yet. */
  before: ReadonlyMap<string, string>;
}

/** The files of `proven` whose every line the map keeps: in a test area of a module, never inline. */
export const guardedFiles = (
  proven: readonly DiffFile[],
  modules: readonly EffectiveModule[],
  foldCase: boolean,
): string[] => [
  ...new Set(
    proven.flatMap(({ newPath }) =>
      // An inline module's tests have no area of their own, so its files read as code.
      newPath !== undefined && areaOf(modules, newPath, foldCase)?.area === 'tests'
        ? [newPath]
        : [],
    ),
  ),
];

/**
 * The lines `proven` added to a separate test file of `modules` that the attempt's tip holds fewer
 * times than the file held them where the step started plus the copies the step added; a file in
 * no test area, or in a module whose tests are inline, keeps none: the test-design lens reads
 * those (ADR 0274).
 */
export function changedTestLines(
  proven: readonly DiffFile[],
  tip: AttemptTip,
  modules: readonly EffectiveModule[],
  { foldCase }: { foldCase: boolean },
): ChangedTestLine[] {
  const guarded = guardedFiles(proven, modules, foldCase);
  const found: ChangedTestLine[] = [];
  const linesOf = (text: string | undefined) => counts(text?.split(/\r?\n/) ?? []);
  for (const path of guarded) {
    const kept = proven
      .flatMap(({ newPath, added }) => (newPath === path ? added : []))
      .map((line) => line.trim())
      .filter((line) => line !== '');
    // By what the tip holds against what the file held before plus the step's copies, so a later
    // step's own copy of a red line may go, and an older copy hides no red one.
    const atTip = linesOf(tip.files.get(path));
    const before = linesOf(tip.before.get(path));
    const short = new Map(
      [...counts(kept)].map(([line, copies]) => {
        const held = (before.get(line) ?? 0) + copies - (atTip.get(line) ?? 0);
        return [line, held] as const;
      }),
    );
    for (const line of kept) {
      const missing = short.get(line) ?? 0;
      if (missing <= 0) continue;
      short.set(line, missing - 1);
      found.push({ path, line });
    }
  }
  return found;
}

/**
 * The files `attempt` changed or removed that lie in a separate test area of `modules` and that
 * `atBase`, the batch's base, holds: an older test is the Gauger's to change, in a red commit
 * (ADR 0358). New test files, and those only the batch added, change freely.
 */
export const olderTestFiles = (
  _attempt: readonly DiffFile[],
  _atBase: ReadonlySet<string>,
  _modules: readonly EffectiveModule[],
  _options: { foldCase: boolean },
): string[] => {
  throw new Error('not implemented');
};
