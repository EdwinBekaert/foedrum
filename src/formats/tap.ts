// TAP, the Test Anything Protocol (versions 13 and 14, with indented subtests), as a test report
// for the red proof (ADR 0078). Pure.

import type { ReadReport } from './test-report.ts';

/** The tests of a TAP stream, or why it is not one. */
export function parseTap(_text: string): ReadReport {
  throw new Error('not implemented');
}
