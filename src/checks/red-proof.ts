// The red proof's verdict, the core (ADR 0017, ADR 0078): whether a test report shows the tests a
// step committed failing because the behaviour is missing. Pure; check-runner.ts runs the tests
// and reads the report and the step's diff.

import type { TestReport } from '../formats/test-report.ts';
import type { DiffFile } from '../formats/unified-diff.ts';

export type RedVerdict =
  /** `tests`: the names of the proven step's tests, all failing. */
  { proven: true; tests: readonly string[] } | { proven: false; why: string };

/** Whether `report` proves red the tests that `diff`, the proven step's commits, added. */
export function judgeRed(_report: TestReport, _diff: readonly DiffFile[]): RedVerdict {
  throw new Error('not implemented');
}
