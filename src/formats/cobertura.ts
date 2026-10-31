// Cobertura XML as a coverage report (ADR 0274): each class's file under a `<source>`, and its
// `line` elements with their hits and `condition-coverage`. Pure.

import type { ReadCoverage } from './coverage-report.ts';

/** The lines of a Cobertura report, its paths relative to `root`, or why it is not one. */
export function parseCobertura(_text: string, _root: string): ReadCoverage {
  throw new Error('not implemented');
}
