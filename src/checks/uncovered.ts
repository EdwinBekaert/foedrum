// The uncovered-line check (ADR 0274): after a passing test reading in a repository with a test map,
// every line the batch's change added in a code area must have run, in the union of the modules'
// coverage reports, each of its branches too where the report has branch data. Pure.

import type { CoverageReport } from '../formats/coverage-report.ts';
import type { EffectiveModule } from './test-map.ts';

/** A file of the batch's change at the step's tip, and the lines it added there. */
export interface ChangedFile {
  path: string;
  addedAt: readonly number[];
}

/** A changed line no test ran: its file, its number, and whether only a branch on it did not. */
export interface UncoveredLine {
  file: string;
  line: number;
  branch: boolean;
}

/** What the check found: the lines that fail it, and the files and modules it did not measure. */
export interface CoverageVerdict {
  uncovered: UncoveredLine[];
  /** Changed code files a tool that leaves unloaded files out (LCOV) did not list. */
  notLoaded: string[];
  /** Changed files outside every code and test area: data, docs, config. */
  outside: string[];
  /** The modules with `coverage: none` whose code the change touched. */
  unmeasured: string[];
}

/** Judges the batch's changed files against the union of the reports. */
export const judgeCoverage = (_input: {
  modules: readonly EffectiveModule[];
  changed: readonly ChangedFile[];
  report: CoverageReport;
  foldCase: boolean;
}): CoverageVerdict => {
  throw new Error('not implemented');
};

/** The check's reason for uncovered lines: the first ten, and a count of the rest. */
export const uncoveredReason = (_lines: readonly UncoveredLine[]): string => {
  throw new Error('not implemented');
};
