// LCOV as a coverage report (ADR 0274): `SF` starts a file, `DA` a line, `BRDA` a branch,
// `end_of_record` ends the file. Pure.

import type { ReadCoverage } from './coverage-report.ts';

/** The lines of an LCOV report, its paths relative to `root`, or why it is not one. */
export function parseLcov(_text: string, _root: string): ReadCoverage {
  throw new Error('not implemented');
}
