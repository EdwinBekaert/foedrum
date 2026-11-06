// The tests a Gauger named against what a test run's reports hold, the core (ADR 0342). Pure;
// check-runner.ts reads the reports.

import type { TestReport } from '../formats/test-report.ts';
import type { UnreportedTests } from '../schemas/events.ts';
import type { GaugeReport } from '../schemas/out-doc.ts';

/** The names of `named` that `reports` hold under no name of theirs. */
export function unreportedNames(
  _named: GaugeReport,
  _reports: readonly TestReport[],
): readonly string[] {
  throw new Error('not implemented');
}

/** `names` as a step's record keeps them: bounded, on one line, with no secret. */
export function unreportedRecord(_names: readonly string[]): UnreportedTests {
  throw new Error('not implemented');
}
