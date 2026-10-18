// JUnit XML as a test report for the red proof (ADR 0078): the `testcase` elements of a
// `testsuites` or `testsuite` root, read by a small XML reader of its own. Pure.

import type { ReadReport } from './test-report.ts';

/** The tests of a JUnit XML report, or why it is not one. */
export function parseJunit(_text: string): ReadReport {
  throw new Error('not implemented');
}
