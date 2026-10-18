// The testsUnchanged guard, the core (ADR 0017, ADR 0078): which test declarations and assertions
// that the proven step committed an attempt changed or removed. Pure; tests-guard.ts reads the
// diffs.

import type { DiffFile } from '../formats/unified-diff.ts';

/** A line of the proven step's tests that an attempt changed or removed, in the file it was in. */
export interface ChangedTestLine {
  path: string;
  line: string;
}

/** The declarations and assertions `proven` added that `changes` removed or changed. */
export function changedTests(
  _proven: readonly DiffFile[],
  _changes: readonly DiffFile[],
): ChangedTestLine[] {
  throw new Error('not implemented');
}
