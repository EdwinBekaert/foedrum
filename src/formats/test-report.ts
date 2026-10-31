// A structured test report as the red proof reads it (ADR 0017, ADR 0078): each test with its
// result and what it said, and the text outside any test. tap.ts and junit.ts read the formats.

/** A report file's largest size: a test report of a large suite, or a coverage report. */
export const MAX_REPORT_BYTES = 16 * 1024 * 1024;

export type TestResult = 'passed' | 'failed' | 'skipped';

export interface ReportedTest {
  /** As the report names it: a TAP description, a JUnit `name`. */
  name: string;
  result: TestResult;
  /** False for a test that has tests of its own (a TAP subtest's parent, a suite). */
  leaf: boolean;
  /** What the report says about it: a TAP diagnostic block, a JUnit failure's message and text. */
  detail: string;
}

export interface TestReport {
  tests: readonly ReportedTest[];
  /** What the report holds outside any test: TAP comments and other lines, JUnit system output. */
  other: string;
  /** Why the run stopped early, when the report says so (TAP's `Bail out!`). */
  bailedOut?: string;
}

export type ReadReport =
  | { readable: true; report: TestReport }
  | { readable: false; reason: string };
