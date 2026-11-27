// The decisions of node scripts/flight-report.ts (#1084, ADR 0411): its options and their refusals,
// each order's verdict between two Flights by ADR 0404's rule, the report with its summary line, and
// the tasted entry with the pull request description (ADR 0416). Nothing here reads a file;
// scripts/flight-report.ts reads the two Flights' records, a recipe and defaults/models.jsonc, and
// writes what this decides.

import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { checkedInput, parseJsonc } from '../../src/formats/jsonc.ts';
import { ModelId, ModelsConfig, type TastedEntry, tastedKey } from '../../src/schemas/models.ts';
import { escapeCell, runsOfSetup } from '../tasting-compare/core.ts';
import {
  type Args,
  argsOf,
  brewerSteps,
  endingsOf,
  type FlightRecord,
  flightFailure,
  recipeOf,
  scoredFigures,
  swapLevelOf,
  type TokenKinds,
} from './core.ts';

/** The options flight-report.ts reads, as `parseArgs` takes them. */
export const FLIGHT_REPORT_OPTIONS = {
  baseline: { type: 'string' },
  candidate: { type: 'string' },
} as const;

/** The values `parseArgs` reads of `FLIGHT_REPORT_OPTIONS`. */
export type FlightReportValues = ReturnType<
  typeof parseArgs<{ options: typeof FLIGHT_REPORT_OPTIONS }>
>['values'];

/**
 * Reads the command line `args` as `FLIGHT_REPORT_OPTIONS`; an option missing its value is a
 * refusal of one line, never a thrown error.
 */
export const flightReportArgsOf = (args: readonly string[]): Args<FlightReportValues> =>
  argsOf(() => parseArgs({ args: [...args], options: FLIGHT_REPORT_OPTIONS }).values);

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
 * every run and the other, which did not, at most one (ADR 0404, ADR 0411), the same on equal counts
 * of equal runs (ADR 0411).
 */
export const verdictOf = (baseline: Passes, candidate: Passes): Verdict => {
  if (baseline.passed === candidate.passed && baseline.runs === candidate.runs) return 'the same';
  const better = (one: Passes, other: Passes) =>
    passedEvery(one) && !passedEvery(other) && other.passed <= 1;
  if (better(baseline, candidate)) return 'baseline better';
  if (better(candidate, baseline)) return 'candidate better';
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

/** The lowest and the highest of a figure over an order's measured runs (ADR 0445). */
interface Range {
  low: number;
  high: number;
}

/** What a Flight measured of one order. */
interface Measured extends Passes {
  /** The runs that measured something, and of those, the runs with changes outside its paths. */
  scored: number;
  outside: number;
  /** The measured runs that reached a pull request, and how they all ended (ADR 0425). */
  reached: number;
  ended: string;
  /** Mean tokens, in sum and by kind, and brewers' milliseconds per measured run. */
  tokens: number;
  kinds: TokenKinds;
  ms: number;
  /** The lowest and the highest run of the tokens in sum and of the brewers' milliseconds (ADR 0445). */
  tokensRange: Range;
  msRange: Range;
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
  const { passed, outside, tokens, kinds, ms } = scoredFigures(scored);
  const mean = (sum: number) => sum / scored.length;
  const perRun = scored.map((run) => scoredFigures([run]));
  const rangeOf = (of: (figures: (typeof perRun)[number]) => number): Range => {
    const each = perRun.map(of);
    return { low: Math.min(...each), high: Math.max(...each) };
  };
  return {
    passed,
    runs,
    scored: scored.length,
    outside,
    reached: scored.filter(({ flight }) => flight.headFrom === 'pull request').length,
    ended: endingsOf(scored),
    tokens: mean(tokens),
    kinds: {
      output: mean(kinds.output),
      cacheRead: mean(kinds.cacheRead),
      cacheWrite: mean(kinds.cacheWrite),
      input: mean(kinds.input),
    },
    ms: mean(ms),
    tokensRange: rangeOf(({ tokens }) => tokens),
    msRange: rangeOf(({ ms }) => ms),
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

/** Whole seconds of `ms` milliseconds. */
const seconds = (ms: number): string => String(Math.round(ms / 1000));

/**
 * One summary figure, the candidate's mean sum against the baseline's, and, when the two sides' ranges
 * overlap and the Flights have a spread (`spread`), that the difference is within the spread of the
 * runs (ADR 0445). `show` writes a range's end.
 */
const figureOf = (
  what: string,
  { baseline, candidate }: { baseline: Sum; candidate: Sum },
  show: (n: number) => string,
  unit: string,
  spread: boolean,
): string => {
  if (baseline.mean === 0) return `${what} not compared: the baseline counted none`;
  const figure = `${what} ${signed(Math.round(((candidate.mean - baseline.mean) / baseline.mean) * 100))}`;
  const overlap = baseline.low <= candidate.high && candidate.low <= baseline.high;
  if (!spread || !overlap) return figure;
  const range = ({ low, high }: Range) => `${show(low)}–${show(high)}${unit}`;
  return `${figure}, within the spread of the runs (baseline ${range(baseline)}, candidate ${range(candidate)})`;
};

/**
 * A figure summed over the orders both Flights measured: the sum of the orders' means, and the sums of
 * their lowest and of their highest run, which are the lowest and highest total the runs allow (ADR 0445).
 */
interface Sum extends Range {
  mean: number;
}

/** `sum` with one order's `mean` and `range` added. */
const addTo = (sum: Sum, mean: number, { low, high }: Range): void => {
  sum.mean += mean;
  sum.low += low;
  sum.high += high;
};

/** What two Flights' records compare: each order's row, the orders left out, and the summary's figures. */
const comparisonOf = (baseline: readonly FlightRecord[], candidate: readonly FlightRecord[]) => {
  const runs = { baseline: runsOf(baseline), candidate: runsOf(candidate) };
  const inCandidate = new Set(ordersOf(candidate));
  const inBaseline = new Set(ordersOf(baseline));
  const notes: string[] = [];
  const note = (heading: string, orders: readonly string[]) => {
    if (orders.length > 0) notes.push(`${heading}: ${orders.map(escapeCell).join(', ')}`);
  };
  note(
    'Only in the baseline',
    ordersOf(baseline).filter((order) => !inCandidate.has(order)),
  );
  note(
    'Only in the candidate',
    ordersOf(candidate).filter((order) => !inBaseline.has(order)),
  );
  const unmeasured = { baseline: [] as string[], candidate: [] as string[] };
  const rows: string[] = [];
  const sumOf = (): Sum => ({ mean: 0, low: 0, high: 0 });
  const sums = {
    tokens: { baseline: sumOf(), candidate: sumOf() },
    ms: { baseline: sumOf(), candidate: sumOf() },
  };
  const candidateKinds: TokenKinds = { output: 0, cacheRead: 0, cacheWrite: 0, input: 0 };
  const every = { baseline: 0, candidate: 0 };
  const reached = { baseline: 0, candidate: 0 };
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
    reached.baseline += b.reached;
    reached.candidate += c.reached;
    addTo(sums.tokens.baseline, b.tokens, b.tokensRange);
    addTo(sums.tokens.candidate, c.tokens, c.tokensRange);
    addTo(sums.ms.baseline, b.ms, b.msRange);
    addTo(sums.ms.candidate, c.ms, c.msRange);
    for (const kind of Object.keys(candidateKinds) as (keyof TokenKinds)[]) {
      candidateKinds[kind] += c.kinds[kind];
    }
    const against = (of: (m: Measured) => string) => `${of(b)} against ${of(c)}`;
    const count = (n: number) => String(Math.round(n));
    const tokens = (of: (m: Measured) => number) => against((m) => count(of(m)));
    // The mean with the lowest and highest run beside it, for tokens in sum and for time (ADR 0445).
    const spread = (mean: number, { low, high }: Range, show: (n: number) => string, unit = '') =>
      `${show(mean)}${unit} (${show(low)}–${show(high)}${unit})`;
    rows.push(
      `| ${escapeCell(order)} | ${against(({ passed, runs }) => `${passed} of ${runs}`)} | ${against(({ ended }) => ended)} | ${against(({ outside, scored }) => `${outside} of ${scored}`)} | ${against((m) => spread(m.tokens, m.tokensRange, count))} | ${tokens((m) => m.kinds.output)} | ${tokens((m) => m.kinds.cacheRead)} | ${tokens((m) => m.kinds.cacheWrite)} | ${tokens((m) => m.kinds.input)} | ${against((m) => spread(m.ms, m.msRange, seconds, ' s'))} | ${verdict} |`,
    );
  }
  for (const side of ['baseline', 'candidate'] as const) {
    note(`No run measured in the ${side}`, unmeasured[side]);
  }
  return {
    rows,
    notes,
    sums,
    candidateKinds,
    every,
    reached,
    runs,
    tooClose,
    compared: rows.length,
  };
};

/**
 * The report comparing two Flights' records: who they are, one summary line, one row per order both
 * measured, and the orders left out of both with why.
 */
export const flightReport = (
  baseline: readonly FlightRecord[],
  candidate: readonly FlightRecord[],
): string => {
  const names = { baseline: flightLabelOf(baseline), candidate: flightLabelOf(candidate) };
  const { rows, notes, sums, every, reached, runs, tooClose, compared } = comparisonOf(
    baseline,
    candidate,
  );
  // With one run per order a Flight has no spread to compare against (ADR 0445).
  const oneRun = Math.min(runs.baseline, runs.candidate) === 1;
  const millions = (tokens: number) => `${(tokens / 1_000_000).toFixed(1)}M`;
  const tokens = figureOf('tokens per order', sums.tokens, millions, '', !oneRun);
  const time = figureOf("brewers' time per order", sums.ms, seconds, ' s', !oneRun);
  // A run stuck on the commit green read still passes (ADR 0409), so the runs that reached a pull
  // request are counted beside the orders passed (ADR 0425).
  const side = (of: 'baseline' | 'candidate') =>
    `${names[of]}: ${every[of]} of ${compared} orders (${reached[of]} of ${runs[of] * compared} runs reached a pull request)`;
  const summary = `${side('baseline')}, ${side('candidate')}, ${tooClose} too close to call, ${tokens}, ${time}${oneRun ? ', one run per order: no spread to compare against' : ''}`;
  return `${[
    `Baseline: ${names.baseline}`,
    `Candidate: ${names.candidate}`,
    '',
    summary,
    '',
    "| Order | Hidden tests passed | Ended | Runs outside its paths | Tokens per run | Output per run | Cache read per run | Cache write per run | Fresh input per run | Brewers' time per run | Verdict |",
    `|${'---|'.repeat(11)}`,
    ...rows,
    ...(notes.length === 0 ? [] : ['', ...notes]),
  ].join('\n')}\n`;
};

/** What the report reads beyond the records to write the tasted entry (ADR 0416). */
export interface TastedInputs {
  /** A default recipe's text by its name, undefined when there is none. */
  recipeText: (name: string) => string | undefined;
  /** defaults/models.jsonc's text. */
  modelsText: string;
  today: Date;
}

/** The tasted entry of a report: written, with the models.jsonc and the description, or not, with why. */
export type Tasted =
  | { kind: 'written'; models: string; title: string; description: string }
  | { kind: 'not written'; why: string; exitCode: 0 | 1 };

/**
 * The one model id the transcripts of `steps` in `records` named, or why there is not one: an entry
 * names the exact id the Flight ran on (ADR 0416).
 */
const oneModelOf = (
  records: readonly FlightRecord[],
  steps: ReadonlySet<string>,
  whose: string,
): { model: string } | { why: string } => {
  const named = new Set(
    records.flatMap(({ flight }) =>
      Object.entries(flight.models).flatMap(([stepId, models]) =>
        steps.has(stepId) ? models : [],
      ),
    ),
  );
  // A transcript's name is model output: quoted, so it stays on the reason's one line.
  const odd = [...named].find((name) => !ModelId.safeParse(name).success);
  if (odd !== undefined)
    return { why: `${whose} steps named ${JSON.stringify(odd)}, which is no model id` };
  const [model, ...others] = named;
  if (model !== undefined && others.length === 0) return { model };
  return {
    why:
      model === undefined
        ? `no transcript of ${whose} steps named a model`
        : `${whose} steps ran on ${[...named].join(' and ')}`,
  };
};

/**
 * `modelsText`, a models.jsonc, with `entry` in place of the tasted entry of its combination, or
 * added last, and the entry it replaced: its leading comment lines as they are, the rest written
 * whole as Biome formats JSON, so a comment past them is dropped (ADR 0416).
 */
const withTasted = (
  modelsText: string,
  entry: TastedEntry,
): { text: string; replaced?: TastedEntry } => {
  const config = ModelsConfig.parse(parseJsonc(modelsText));
  const key = tastedKey(entry);
  const replaced = config.claude.tasted.find((each) => tastedKey(each) === key);
  const tasted =
    replaced === undefined
      ? [...config.claude.tasted, entry]
      : config.claude.tasted.map((each) => (each === replaced ? entry : each));
  const header = [];
  for (const line of checkedInput(modelsText).split(/\r?\n/)) {
    if (!line.trimStart().startsWith('//')) break;
    header.push(`${line}\n`);
  }
  const written = ModelsConfig.parse({ ...config, claude: { ...config.claude, tasted } });
  return {
    text: `${header.join('')}${JSON.stringify(written, null, 2)}\n`,
    ...(replaced === undefined ? {} : { replaced }),
  };
};

/**
 * The tasted entry two Flights' records give, with defaults/models.jsonc holding it and the pull
 * request that adds it, or why none is written: a dry run tastes nothing, and an entry is of one
 * swapped brewer, on one recipe, on one model id in each Flight (ADR 0416).
 */
export const tastedOf = (
  baseline: readonly FlightRecord[],
  candidate: readonly FlightRecord[],
  report: string,
  { recipeText, modelsText, today }: TastedInputs,
): Tasted => {
  const notWritten = (why: string, exitCode: 0 | 1 = 1): Tasted => ({
    kind: 'not written',
    why: `${why}, so defaults/models.jsonc is unchanged`,
    exitCode,
  });
  if ([...baseline, ...candidate].some(({ flight }) => flight.dryRun === true)) {
    return notWritten('a dry run tastes nothing', 0);
  }
  const recipe = candidate[0]?.flight.recipe;
  const swap = candidate[0]?.flight.swap;
  if (recipe === undefined || swap === undefined) {
    return notWritten(
      `the candidate brews ${recipe} as it ships, and a tasted entry is of a swapped brewer`,
    );
  }
  const baselineRecipe = baseline[0]?.flight.recipe;
  if (baselineRecipe !== recipe) {
    return notWritten(`the baseline brews ${baselineRecipe} and the candidate ${recipe}`);
  }
  const text = recipeText(recipe);
  if (text === undefined) return notWritten(`${recipe} is no default recipe`);
  const { every, sums, candidateKinds, compared } = comparisonOf(baseline, candidate);
  if (compared === 0) return notWritten('no order was measured by both Flights');
  const read = recipeOf(text);
  const steps = new Set(
    brewerSteps(read)
      .filter(({ brewer }) => brewer === swap.brewer)
      .map(({ id }) => id),
  );
  const ran = oneModelOf(candidate, steps, `the candidate's ${swap.brewer}`);
  if ('why' in ran) return notWritten(ran.why);
  const ranBefore = oneModelOf(baseline, steps, `the baseline's ${swap.brewer}`);
  if ('why' in ranBefore) return notWritten(ranBefore.why);
  const level = swapLevelOf(swap, read);
  // flight.ts refuses a swap with no level free (ADR 0409), so its records never hold one.
  if (level === undefined) throw new Error(`no level of ${recipe} is free for ${swap.model}`);
  const perOrder = (tokens: number) => Math.round(tokens / compared);
  const split = {
    output: perOrder(candidateKinds.output),
    cacheRead: perOrder(candidateKinds.cacheRead),
    cacheWrite: perOrder(candidateKinds.cacheWrite),
    input: perOrder(candidateKinds.input),
  };
  const entry: TastedEntry = {
    brewer: swap.brewer,
    recipe,
    level,
    effort: swap.effort,
    model: ran.model,
    passed: every.candidate,
    runs: compared,
    baseline: { passed: every.baseline, runs: compared, model: ranBefore.model },
    tokensPerOrder: perOrder(sums.tokens.candidate.mean),
    tokensPerOrderSplit: split,
    date: today.toISOString().slice(0, 10),
  };
  const { text: models, replaced } = withTasted(modelsText, entry);
  const key = tastedKey(entry);
  const what = replaced === undefined ? 'adds the entry' : `replaces the entry of ${replaced.date}`;
  return {
    kind: 'written',
    models,
    title: `Taste ${key}: ${entry.model}`,
    description: [
      '## How it works',
      `\`defaults/models.jsonc\`'s \`tasted\` list keeps the latest Flight of each brewer, recipe, level and effort (ADR 0416). This pull request ${what} for ${key}: on ${entry.model} it passed every run on ${entry.passed} of ${compared} orders, where ${flightLabelOf(baseline)} on ${entry.baseline.model} passed every run on ${entry.baseline.passed} of ${compared}, at ${entry.tokensPerOrder} tokens per order (${split.output} output, ${split.cacheRead} cache read, ${split.cacheWrite} cache write and ${split.input} fresh input).`,
      '',
      '## The Flight report',
      '',
      report.trimEnd(),
      '',
      "Add this pull request's link to the entry as its `report` in a second commit (ADR 0416).",
      '',
    ].join('\n'),
  };
};

/**
 * The report `values` ask for, the file it goes to and its tasted entry, or the refusal that stops
 * the script with exit 2; `recordsIn` reads a Flight folder's records, none when it has no
 * results.jsonl.
 */
export const flightReportRun = (
  values: FlightReportValues,
  recordsIn: (folder: string) => readonly FlightRecord[],
  inputs: TastedInputs,
):
  | { kind: 'report'; report: string; file: string; tasted: Tasted }
  | { kind: 'refused'; message: string } => {
  const refused = (message: string) => ({ kind: 'refused' as const, message });
  const { baseline, candidate } = values;
  if (baseline === undefined) {
    return refused('--baseline names the Flight folder the candidate is compared with');
  }
  if (candidate === undefined) {
    return refused('--candidate names the Flight folder compared with the baseline');
  }
  const read = { baseline: recordsIn(baseline), candidate: recordsIn(candidate) };
  const folders = { baseline, candidate };
  for (const side of ['baseline', 'candidate'] as const) {
    if (read[side].length === 0) {
      return refused(
        `--${side} ${folders[side]} holds no results.jsonl records: name a Flight folder under .foedrum/tmp/flight`,
      );
    }
  }
  const report = flightReport(read.baseline, read.candidate);
  return {
    kind: 'report',
    report,
    file: join(candidate, 'report.md'),
    tasted: tastedOf(read.baseline, read.candidate, report, inputs),
  };
};
