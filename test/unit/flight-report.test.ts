import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { FlightRecord } from '../../scripts/flight/core.ts';
import {
  flightLabelOf,
  flightReport,
  flightReportRun,
  verdictOf,
} from '../../scripts/flight/report.ts';

/** A run's step that used `tokens` tokens in `seconds` seconds. */
const step = (tokens: number, seconds: number) => ({
  stepId: 'implement',
  attempts: 1,
  usage: { inputTokens: tokens - 3, outputTokens: 1, cacheReadTokens: 1, cacheWriteTokens: 1 },
  turns: 4,
  durationMs: seconds * 1000,
});

const record = (
  setup: string,
  run: number,
  flight: Partial<FlightRecord['flight']> = {},
): FlightRecord => ({
  setup,
  run,
  ended: 'on_tap',
  wallMs: 60_000,
  attempts: [],
  flight: {
    recipe: 'nip',
    head: 'a'.repeat(40),
    headFrom: 'pull request',
    hidden: 'passed',
    changed: ['src/posts.mjs'],
    outside: [],
    steps: [step(100, 20)],
    models: { implement: ['claude-sonnet-5-5'] },
    ...flight,
  },
});

const SWAP = { brewer: 'cellarman', model: 'claude-opus-5-5', effort: 'larger' } as const;

/** A run that measured nothing: its batch left no head. */
const noHead = (setup: string, run: number, flight: Partial<FlightRecord['flight']> = {}) => {
  const { head: _, ...rest } = record(setup, run, flight).flight;
  return { ...record(setup, run), ended: 'stuck: blocked', flight: rest };
};

/** Three runs of `setup`, the first `passes` of which passed. */
const runsOf = (setup: string, passes: number, flight: Partial<FlightRecord['flight']> = {}) =>
  [1, 2, 3].map((run) =>
    record(setup, run, { ...flight, hidden: run <= passes ? 'passed' : 'failed' }),
  );

/** The table row of `order` in `report`. */
const rowOf = (report: string, order: string): string | undefined =>
  report.split('\n').find((line) => line.startsWith(`| ${order} |`));

describe('the Flight report (ADR 0411)', () => {
  it('calls a difference when one Flight passes every run and the other at most one', () => {
    assert.equal(verdictOf({ passed: 3, runs: 3 }, { passed: 1, runs: 3 }), 'baseline better');
    assert.equal(verdictOf({ passed: 0, runs: 3 }, { passed: 3, runs: 3 }), 'candidate better');
  });

  it('calls equal pass counts the same, apart from too close to call', () => {
    assert.equal(verdictOf({ passed: 3, runs: 3 }, { passed: 3, runs: 3 }), 'the same');
    assert.equal(verdictOf({ passed: 1, runs: 3 }, { passed: 1, runs: 3 }), 'the same');
  });

  it('calls equal pass counts the same only when both Flights ran as many runs', () => {
    assert.equal(verdictOf({ passed: 1, runs: 3 }, { passed: 1, runs: 1 }), 'candidate better');
    assert.equal(verdictOf({ passed: 3, runs: 3 }, { passed: 3, runs: 5 }), 'too close to call');
  });

  it('calls anything else too close to call', () => {
    assert.equal(verdictOf({ passed: 3, runs: 3 }, { passed: 2, runs: 3 }), 'too close to call');
    assert.equal(verdictOf({ passed: 2, runs: 3 }, { passed: 0, runs: 3 }), 'too close to call');
  });

  it('passes every run only with as many passes as the Flight has runs', () => {
    assert.equal(verdictOf({ passed: 2, runs: 3 }, { passed: 1, runs: 3 }), 'too close to call');
  });

  it('names a Flight by its recipe as it ships, or with the brewer it swapped', () => {
    assert.equal(flightLabelOf([record('quiz-rank', 1)]), 'nip as it ships');
    assert.equal(
      flightLabelOf([record('quiz-rank', 1, { recipe: 'deep-brew', swap: SWAP })]),
      'deep-brew with cellarman on claude-opus-5-5 at larger',
    );
  });

  it("shows each order's passes, runs outside its paths, tokens and time, one Flight against the other", () => {
    const report = flightReport(
      [
        record('quiz-rank', 2, { steps: [step(300, 40)] }),
        record('post-slugs', 1),
        record('quiz-rank', 1),
        record('post-slugs', 2, { hidden: 'failed' }),
      ],
      [
        record('post-slugs', 2, { swap: SWAP, outside: ['package.json'] }),
        record('quiz-rank', 1, { swap: SWAP, hidden: 'timed out', steps: [step(50, 10)] }),
        record('post-slugs', 1, { swap: SWAP }),
        record('quiz-rank', 2, { swap: SWAP, hidden: 'failed', steps: [step(50, 10)] }),
      ],
    );
    assert.equal(
      rowOf(report, 'quiz-rank'),
      '| quiz-rank | 2 of 2 against 0 of 2 | 0 of 2 against 0 of 2 | 200 against 50 | 30 s against 10 s | baseline better |',
    );
    assert.equal(
      rowOf(report, 'post-slugs'),
      '| post-slugs | 1 of 2 against 2 of 2 | 0 of 2 against 1 of 2 | 100 against 100 | 20 s against 20 s | candidate better |',
    );
    assert.match(report, /^Baseline: nip as it ships$/m);
    assert.match(report, /^Candidate: nip with cellarman on claude-opus-5-5 at larger$/m);
  });

  it('counts a run that measured nothing as a run that did not pass', () => {
    const report = flightReport(
      [record('quiz-rank', 1), noHead('quiz-rank', 2), record('quiz-rank', 3)],
      [
        record('quiz-rank', 1),
        record('quiz-rank', 2),
        record('quiz-rank', 3, { hidden: 'failed' }),
      ],
    );
    assert.equal(
      rowOf(report, 'quiz-rank'),
      '| quiz-rank | 2 of 3 against 2 of 3 | 0 of 2 against 0 of 3 | 100 against 100 | 20 s against 20 s | the same |',
    );
  });

  it("counts a Flight's runs as its highest run number, so an order it stopped short of did not pass them", () => {
    const report = flightReport(
      [record('quiz-rank', 1), record('quiz-rank', 2), record('post-slugs', 1)],
      [
        record('quiz-rank', 1),
        record('quiz-rank', 2),
        record('post-slugs', 1),
        record('post-slugs', 2),
      ],
    );
    assert.match(rowOf(report, 'post-slugs') ?? '', /^\| post-slugs \| 1 of 2 against 2 of 2 \|/);
  });

  it('lists an order only one Flight has below the table, out of its rows', () => {
    const report = flightReport(
      [record('quiz-rank', 1), record('shelf-tags', 1)],
      [record('quiz-rank', 1), record('post-slugs', 1)],
    );
    assert.equal(rowOf(report, 'shelf-tags'), undefined);
    assert.equal(rowOf(report, 'post-slugs'), undefined);
    assert.match(report, /^Only in the baseline: shelf-tags$/m);
    assert.match(report, /^Only in the candidate: post-slugs$/m);
  });

  it('lists an order with no run measured in a Flight below the table, out of its rows', () => {
    const report = flightReport(
      [record('quiz-rank', 1), noHead('shelf-tags', 1)],
      [record('quiz-rank', 1), record('shelf-tags', 1), noHead('post-slugs', 1)],
    );
    assert.equal(rowOf(report, 'shelf-tags'), undefined);
    assert.match(report, /^No run measured in the baseline: shelf-tags$/m);
    assert.match(report, /^Only in the candidate: post-slugs$/m);
  });

  it('sums up the orders each Flight passed every run of, those too close to call, and the tokens per order', () => {
    const swapped = { swap: SWAP, steps: [step(160, 20)] };
    const report = flightReport(
      [
        ...runsOf('shelf-tags', 2),
        record('only-here', 1),
        ...runsOf('quiz-rank', 3),
        ...runsOf('post-slugs', 3),
      ],
      [
        ...runsOf('post-slugs', 2, swapped),
        ...runsOf('quiz-rank', 3, swapped),
        ...runsOf('shelf-tags', 3, swapped),
      ],
    );
    const lines = report.split('\n');
    assert.ok(
      lines.includes(
        'nip as it ships: 2 of 3 orders, nip with cellarman on claude-opus-5-5 at larger: 2 of 3 orders, 2 too close to call, tokens per order +60%',
      ),
      report,
    );
  });

  it('gives fewer tokens per order with a minus sign', () => {
    const report = flightReport(
      [record('quiz-rank', 1, { steps: [step(200, 20)] })],
      [record('quiz-rank', 1, { steps: [step(150, 20)] })],
    );
    assert.match(report, /, tokens per order -25%$/m);
  });

  it('compares no tokens when the baseline counted none', () => {
    const { usage: _, ...uncounted } = step(100, 20);
    const report = flightReport(
      [record('quiz-rank', 1, { steps: [uncounted] })],
      [record('quiz-rank', 1)],
    );
    assert.match(report, /, tokens per order not compared: the baseline counted none$/m);
  });

  it('writes the report of the two folders the options name into the candidate folder', () => {
    const flights: Record<string, FlightRecord[]> = {
      base: [record('quiz-rank', 1)],
      next: [record('quiz-rank', 1, { swap: SWAP })],
    };
    const ran = flightReportRun(
      { baseline: 'base', candidate: 'next' },
      (folder) => flights[folder] ?? [],
    );
    assert.deepEqual(ran, {
      kind: 'report',
      report: flightReport(flights.base ?? [], flights.next ?? []),
      file: join('next', 'report.md'),
    });
  });

  it('refuses a command line without --baseline', () => {
    assert.deepEqual(
      flightReportRun({ candidate: 'next' }, () => [record('quiz-rank', 1)]),
      {
        kind: 'refused',
        message: '--baseline names the Flight folder the candidate is compared with',
      },
    );
  });

  it('refuses a command line without --candidate', () => {
    assert.deepEqual(
      flightReportRun({ baseline: 'base' }, () => [record('quiz-rank', 1)]),
      {
        kind: 'refused',
        message: '--candidate names the Flight folder compared with the baseline',
      },
    );
  });

  it('refuses a baseline folder with no records', () => {
    const ran = flightReportRun({ baseline: 'base', candidate: 'next' }, (folder) =>
      folder === 'next' ? [record('quiz-rank', 1)] : [],
    );
    assert.deepEqual(ran, {
      kind: 'refused',
      message:
        '--baseline base holds no results.jsonl records: name a Flight folder under .foedrum/tmp/flight',
    });
  });

  it('refuses a candidate folder with no records', () => {
    const ran = flightReportRun({ baseline: 'base', candidate: 'next' }, (folder) =>
      folder === 'base' ? [record('quiz-rank', 1)] : [],
    );
    assert.deepEqual(ran, {
      kind: 'refused',
      message:
        '--candidate next holds no results.jsonl records: name a Flight folder under .foedrum/tmp/flight',
    });
  });
});
