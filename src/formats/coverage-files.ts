// The coverage report files of a worktree (ADR 0274): LCOV by file, Cobertura as every
// `coverage.cobertura.xml` under a folder pattern, each read as a test report is (ADR 0078).

import type { CoverageFormat, ReadCoverage } from './coverage-report.ts';

/** The coverage at `path`, a file or a folder pattern relative to `root`, or why it is not read. */
export function readCoverage(_format: CoverageFormat, _path: string, _root: string): ReadCoverage {
  throw new Error('not implemented');
}
