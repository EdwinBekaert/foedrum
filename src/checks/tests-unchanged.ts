// The testsUnchanged guard, the core (ADR 0017, ADR 0078): which test declarations and assertions
// that the proven step committed an attempt changed or removed. Pure; tests-guard.ts reads the
// diffs.

import type { DiffFile } from '../formats/unified-diff.ts';

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

/** The declarations and assertions `proven` added that `changes` removed or changed. */
export function changedTests(
  proven: readonly DiffFile[],
  changes: readonly DiffFile[],
): ChangedTestLine[] {
  const found: ChangedTestLine[] = [];
  for (const [path, lines] of testLines(proven)) {
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
