// The decisions of node scripts/flight-report.ts (#1084, ADR 0411): its options and their refusals,
// each order's verdict between two Flights by ADR 0404's rule, and the report with its summary line.
// Nothing here reads a file; scripts/flight-report.ts reads the two Flights' records and writes it.

import { join } from 'node:path';
import type { parseArgs } from 'node:util';
import { escapeCell, runsOfSetup } from '../tasting-compare/core.ts';
import { type FlightRecord, flightFailure, tokensOf } from './core.ts';

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

/** Whether `passes` passed every run of its Flight. */
const passedEvery = ({ passed, runs }: Passes): boolean => passed === runs;

/**
 * The verdict on an order that `baseline` and `candidate` passed: a difference only when one passes
 * every run and the other at most one (ADR 0404), the same on equal counts (ADR 0411).
 */
export const verdictOf = (baseline: Passes, candidate: Passes): Verdict => {
  if (baseline.passed === candidate.passed) return 'the same';
  if (passedEvery(baseline) && candidate.passed <= 1) return 'baseline better';
  if (passedEvery(candidate) && baseline.passed <= 1) return 'candidate better';
  return 'too close to call';
};

/** A Flight's name for a person: its recipe, and the brewer it swapped. */
export const flightLabelOf = (records: readonly FlightRecord[]): string => {
  const flight = records[0]?.flight;
  if (flight === undefined) return 'no Flight';
  const { recipe, swap } = flight;
  return swap === undefined
    ? `${recipe} as it ships`
    : `${recipe} with ${swap.brewer} on ${swap.model} at ${swap.effort}`;
};

/** What a Flight measured of one order. */
interface Measured extends Passes {
  /** The runs that measured something, and of those, the runs with changes outside its paths. */
  scored: number;
  outside: number;
  /** Mean tokens and brewers' milliseconds per measured run. */
  tokens: number;
  ms: number;
}

/**
 * What `records` measured of `order`, its passes out of the Flight's `runs`, so a run that measured
 * nothing did not pass (ADR 0411); undefined when no run of it measured anything.
 */
const measuredOf = (
  records: readonly FlightRecord[],
  order: string,
  runs: number,
): Measured | undefined => {
  const { scored } = runsOfSetup(records, order, flightFailure);
  if (scored.length === 0) return undefined;
  const steps = scored.flatMap(({ flight }) => flight.steps);
  return {
    passed: scored.filter(({ flight }) => flight.hidden === 'passed').length,
    runs,
    scored: scored.length,
    outside: scored.filter(({ flight }) => flight.outside.length > 0).length,
    tokens: steps.reduce((sum, { usage }) => sum + tokensOf(usage), 0) / scored.length,
    ms: steps.reduce((sum, { durationMs }) => sum + durationMs, 0) / scored.length,
  };
};

/** The orders of `records`, in the order they were first recorded. */
const ordersOf = (records: readonly FlightRecord[]): string[] => [
  ...new Set(records.map(({ setup }) => setup)),
];

/** A Flight's runs: its highest run number, so an order it stopped short of did not pass the rest. */
const runsOf = (records: readonly FlightRecord[]): number =>
  Math.max(0, ...records.map(({ run }) => run));

/** `percent` with its sign, as the summary gives the candidate's tokens against the baseline's. */
const signed = (percent: number): string => `${percent > 0 ? '+' : ''}${percent}%`;

/**
 * The report comparing two Flights' records: who they are, one summary line, one row per order both
 * measured, and the orders left out of both with why.
 */
export const flightReport = (
  baseline: readonly FlightRecord[],
  candidate: readonly FlightRecord[],
): string => {
  const names = { baseline: flightLabelOf(baseline), candidate: flightLabelOf(candidate) };
  const runs = { baseline: runsOf(baseline), candidate: runsOf(candidate) };
  const inCandidate = new Set(ordersOf(candidate));
  const inBaseline = new Set(ordersOf(baseline));
  const notes: string[] = [];
  const onlyIn = (side: 'baseline' | 'candidate', orders: string[]) => {
    if (orders.length > 0) notes.push(`Only in the ${side}: ${orders.map(escapeCell).join(', ')}`);
  };
  onlyIn(
    'baseline',
    ordersOf(baseline).filter((order) => !inCandidate.has(order)),
  );
  onlyIn(
    'candidate',
    ordersOf(candidate).filter((order) => !inBaseline.has(order)),
  );
  const unmeasured = { baseline: [] as string[], candidate: [] as string[] };
  const rows: string[] = [];
  const totals = { baseline: 0, candidate: 0 };
  const every = { baseline: 0, candidate: 0 };
  let tooClose = 0;
  for (const order of ordersOf(baseline).filter((each) => inCandidate.has(each))) {
    const b = measuredOf(baseline, order, runs.baseline);
    const c = measuredOf(candidate, order, runs.candidate);
    if (b === undefined) unmeasured.baseline.push(order);
    if (c === undefined) unmeasured.candidate.push(order);
    if (b === undefined || c === undefined) continue;
    const verdict = verdictOf(b, c);
    if (verdict === 'too close to call') tooClose += 1;
    if (passedEvery(b)) every.baseline += 1;
    if (passedEvery(c)) every.candidate += 1;
    totals.baseline += b.tokens;
    totals.candidate += c.tokens;
    const against = (of: (m: Measured) => string) => `${of(b)} against ${of(c)}`;
    rows.push(
      `| ${escapeCell(order)} | ${against(({ passed, runs }) => `${passed} of ${runs}`)} | ${against(({ outside, scored }) => `${outside} of ${scored}`)} | ${against(({ tokens }) => String(Math.round(tokens)))} | ${against(({ ms }) => `${Math.round(ms / 1000)} s`)} | ${verdict} |`,
    );
  }
  for (const side of ['baseline', 'candidate'] as const) {
    if (unmeasured[side].length > 0) {
      notes.push(`No run measured in the ${side}: ${unmeasured[side].map(escapeCell).join(', ')}`);
    }
  }
  const compared = rows.length;
  const tokens =
    totals.baseline === 0
      ? 'tokens per order not compared: the baseline counted none'
      : `tokens per order ${signed(Math.round(((totals.candidate - totals.baseline) / totals.baseline) * 100))}`;
  const summary = `${names.baseline}: ${every.baseline} of ${compared} orders, ${names.candidate}: ${every.candidate} of ${compared} orders, ${tooClose} too close to call, ${tokens}`;
  return `${[
    `Baseline: ${names.baseline}`,
    `Candidate: ${names.candidate}`,
    '',
    summary,
    '',
    "| Order | Hidden tests passed | Runs outside its paths | Tokens per run | Brewers' time per run | Verdict |",
    '|---|---|---|---|---|---|',
    ...rows,
    ...(notes.length === 0 ? [] : ['', ...notes]),
  ].join('\n')}\n`;
};

/**
 * The report `values` ask for and the file it goes to, or the refusal that stops the script with
 * exit 2; `recordsIn` reads a Flight folder's records, none when it has no results.jsonl.
 */
export const flightReportRun = (
  values: FlightReportValues,
  recordsIn: (folder: string) => readonly FlightRecord[],
): { kind: 'report'; report: string; file: string } | { kind: 'refused'; message: string } => {
  const refused = (message: string) => ({ kind: 'refused' as const, message });
  const { baseline, candidate } = values;
  if (baseline === undefined) {
    return refused('--baseline names the Flight folder the candidate is compared with');
  }
  if (candidate === undefined) {
    return refused('--candidate names the Flight folder compared with the baseline');
  }
  const read = { baseline: recordsIn(baseline), candidate: recordsIn(candidate) };
  for (const [side, folder] of [
    ['baseline', baseline],
    ['candidate', candidate],
  ] as const) {
    if (read[side].length === 0) {
      return refused(
        `--${side} ${folder} holds no results.jsonl records: name a Flight folder under .foedrum/tmp/flight`,
      );
    }
  }
  return {
    kind: 'report',
    report: flightReport(read.baseline, read.candidate),
    file: join(candidate, 'report.md'),
  };
};
