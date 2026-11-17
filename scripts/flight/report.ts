// The decisions of node scripts/flight-report.ts (#1084, ADR 0411): its options and their refusals,
// each order's verdict between two Flights by ADR 0404's rule, and the report with its summary line.
// Nothing here reads a file; scripts/flight-report.ts reads the two Flights' records and writes it.

import type { parseArgs } from 'node:util';
import type { FlightRecord } from './core.ts';

/** The options flight-report.ts reads, as `parseArgs` takes them. */
export const FLIGHT_REPORT_OPTIONS = {
  baseline: { type: 'string' },
  candidate: { type: 'string' },
} as const;

/** The values `parseArgs` reads of `FLIGHT_REPORT_OPTIONS`. */
export type FlightReportValues = ReturnType<
  typeof parseArgs<{ options: typeof FLIGHT_REPORT_OPTIONS }>
>['values'];

/** An order's hidden tests passed in a Flight: in how many of its runs. */
export interface Passes {
  passed: number;
  runs: number;
}

/** Which Flight did better on an order, by ADR 0404's rule. */
export type Verdict = 'baseline better' | 'candidate better' | 'the same' | 'too close to call';

/** The verdict on an order that `baseline` and `candidate` passed. */
export const verdictOf = (_baseline: Passes, _candidate: Passes): Verdict => {
  throw new Error('not implemented');
};

/** A Flight's name for a person: its recipe, and the brewer it swapped. */
export const flightLabelOf = (_records: readonly FlightRecord[]): string => {
  throw new Error('not implemented');
};

/** The report comparing two Flights' records: a table per order, and one summary line. */
export const flightReport = (
  _baseline: readonly FlightRecord[],
  _candidate: readonly FlightRecord[],
): string => {
  throw new Error('not implemented');
};

/**
 * The report `values` ask for and the file it goes to, or the refusal that stops the script with
 * exit 2; `recordsIn` reads a Flight folder's records, none when it has no results.jsonl.
 */
export const flightReportRun = (
  _values: FlightReportValues,
  _recordsIn: (folder: string) => readonly FlightRecord[],
): { kind: 'report'; report: string; file: string } | { kind: 'refused'; message: string } => {
  throw new Error('not implemented');
};
