// The testsUnchanged guard, the core (ADR 0017, ADR 0078, ADR 0274): which lines the proven step
// added to a separate test file of the test map an attempt changed or removed, or in a repository
// with no map, which of its test declarations and assertions. Pure; tests-guard.ts reads the diffs
// and the maps.

import type { DiffFile } from '../formats/unified-diff.ts';
import { areaOf, type EffectiveModule } from './test-map.ts';

/** A line of the proven step's tests that an attempt changed or removed, in the file it was in. */
export interface ChangedTestLine {
  path: string;
  line: string;
}

/** A line that declares a test, in the runners a Brewery is likely to use. */
const DECLARATIONS: readonly RegExp[] = [
  /\b(?:test|it|describe|context|suite|specify)(?:\.\w+)*\s*\(/,
  /\bdef\s+test\w*\s*\(/,
  /@Test\b/,
  /\[\s*(?:Fact|Theory|Test|TestMethod|TestCase)\b/,
  /\bfunc\s+Test\w*\s*\(/,
  // A Go subtest, which a step may add inside a test it did not add (ADR 0262).
  /\bt\.Run\s*\(/,
  /#\[(?:\w+::)*test\]/,
  /\bTEST(?:_F|_P)?\s*\(/,
];

/** A line that asserts. */
const ASSERTIONS: readonly RegExp[] = [
  /\bassert\w*/i,
  /\bexpect\w*\s*\(/,
  /\.should\b/,
  /\braises\s*\(/,
  /\bt\.(?:Error|Errorf|Fatal|Fatalf|Fail|FailNow)\b/,
  /\b(?:EXPECT|ASSERT)_\w+\s*\(/,
];

/** A line that only imports, which the attempt may change. */
const IMPORT =
  /^(?:import\b|from\s+\S+\s+import\b|using\b|use\b|#include\b|require\s*\(|(?:const|let|var)\s+[^=]+=\s*require\s*\(|package\b|extern\s+crate\b|open\b)/;

const any = (patterns: readonly RegExp[], line: string): boolean =>
  patterns.some((pattern) => pattern.test(line));

/** Whether `line` declares a test: a file with one is a test file, whose lines the guard keeps. */
export const declaresTest = (line: string): boolean => any(DECLARATIONS, line);

/** Whether a line the step added to `file` declares a test: then it is one of its test files. */
export const isTestFile = (file: DiffFile): boolean => file.added.some(declaresTest);

/** Whether `line` asserts without declaring a test: a call of what it tests, not a declaration. */
export const assertsOnly = (line: string): boolean =>
  any(ASSERTIONS, line) && !any(DECLARATIONS, line);

/** The declarations and assertions in each file of `proven` that declares a test, by path. */
function testLines(proven: readonly DiffFile[]): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const { newPath, added } of proven) {
    if (newPath === undefined) continue;
    const lines = added.map((line) => line.trim());
    if (!lines.some((line) => any(DECLARATIONS, line))) continue;
    const kept = lines.filter(
      (line) => !IMPORT.test(line) && (any(DECLARATIONS, line) || any(ASSERTIONS, line)),
    );
    found.set(newPath, [...(found.get(newPath) ?? []), ...kept]);
  }
  return found;
}

/** How often each line occurs, trimmed. */
function counts(lines: readonly string[]): Map<string, number> {
  const found = new Map<string, number>();
  for (const line of lines) found.set(line.trim(), (found.get(line.trim()) ?? 0) + 1);
  return found;
}

/** The lines kept in each file, by path, that `changes` removed or changed, as often as kept. */
function lostLines(
  kept: ReadonlyMap<string, readonly string[]>,
  changes: readonly DiffFile[],
): ChangedTestLine[] {
  const found: ChangedTestLine[] = [];
  for (const [path, lines] of kept) {
    // A line moved within its file is removed and added again: only the lines lost count.
    const removed = counts(changes.flatMap((file) => (file.oldPath === path ? file.removed : [])));
    const added = counts(changes.flatMap((file) => (file.newPath === path ? file.added : [])));
    const lost = new Map(
      [...removed].map(([line, count]) => [line, count - (added.get(line) ?? 0)] as const),
    );
    for (const line of lines) {
      const left = lost.get(line) ?? 0;
      if (left <= 0) continue;
      lost.set(line, left - 1);
      found.push({ path, line });
    }
  }
  return found;
}

/** The declarations and assertions `proven` added that `changes` removed or changed. */
export const changedTests = (
  proven: readonly DiffFile[],
  changes: readonly DiffFile[],
): ChangedTestLine[] => lostLines(testLines(proven), changes);

/** What a guarded attempt left: each guarded test file's text at its tip, absent where it is gone, and its diff. */
export interface AttemptTip {
  files: ReadonlyMap<string, string>;
  changes: readonly DiffFile[];
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
 * times than the step added them; a file in no test area, or in a module whose tests are inline,
 * keeps none, unless the map is new in the batch (`newMap`), which then keeps there what no map
 * keeps (ADR 0274, ADR 0078).
 */
export function changedTestLines(
  proven: readonly DiffFile[],
  tip: AttemptTip,
  modules: readonly EffectiveModule[],
  { foldCase, newMap }: { foldCase: boolean; newMap: boolean },
): ChangedTestLine[] {
  const guarded = guardedFiles(proven, modules, foldCase);
  const found: ChangedTestLine[] = [];
  for (const path of guarded) {
    // By what the tip holds, so a later step's own copy of a red line may go.
    const left = counts(tip.files.get(path)?.split(/\r?\n/) ?? []);
    for (const { newPath, added } of proven) {
      if (newPath !== path) continue;
      for (const line of added.map((text) => text.trim()).filter((text) => text !== '')) {
        const copies = left.get(line) ?? 0;
        if (copies > 0) left.set(line, copies - 1);
        else found.push({ path, line });
      }
    }
  }
  if (!newMap) return found;
  // A map the brewers under check wrote never keeps less than no map does.
  const unguarded = proven.filter(
    ({ newPath }) => newPath === undefined || !guarded.includes(newPath),
  );
  return [...found, ...changedTests(unguarded, tip.changes)];
}
