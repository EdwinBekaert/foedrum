import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { FlightRecord } from '../../scripts/flight/core.ts';
import {
  flightLabelOf,
  flightReport,
  flightReportArgsOf,
  flightReportRun,
  type TastedInputs,
  tastedOf,
  verdictOf,
} from '../../scripts/flight/report.ts';
import { parseJsonc } from '../../src/formats/jsonc.ts';

const HEADER =
  "// What Foedrum's model levels and efforts are for each agent.\n// A second line.\n";

/** A defaults/models.jsonc with a header of two lines and a field besides the claude block. */
const MODELS = `${HEADER}{
  "$schema": "../schemas/models.json",
  "claude": {
    "models": { "light": "haiku", "strong": "opus" },
    "efforts": { "small": "low", "larger": "high" }
  }
}
`;

/** The default recipes, defaults/models.jsonc and the day the report writes its tasted entry. */
const INPUTS: TastedInputs = {
  recipeText: (name) =>
    name === 'nip'
      ? readFileSync(
          join(import.meta.dirname, '..', '..', 'defaults', 'recipes', 'nip.jsonc'),
          'utf8',
        )
      : undefined,
  modelsText: MODELS,
  today: new Date('2026-11-20T12:00:00Z'),
};

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

  it('calls no difference when both Flights passed every run of unequal runs', () => {
    assert.equal(verdictOf({ passed: 1, runs: 1 }, { passed: 3, runs: 3 }), 'too close to call');
    assert.equal(verdictOf({ passed: 3, runs: 3 }, { passed: 1, runs: 1 }), 'too close to call');
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

  it("shows each order's passes, endings, runs outside its paths, tokens split by kind and time, one Flight against the other", () => {
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
      '| quiz-rank | 2 of 2 against 0 of 2 | on tap 2 of 2 against on tap 2 of 2 | 0 of 2 against 0 of 2 | 200 against 50 | 1 against 1 | 1 against 1 | 1 against 1 | 197 against 47 | 30 s against 10 s | baseline better |',
    );
    assert.equal(
      rowOf(report, 'post-slugs'),
      '| post-slugs | 1 of 2 against 2 of 2 | on tap 2 of 2 against on tap 2 of 2 | 0 of 2 against 1 of 2 | 100 against 100 | 1 against 1 | 1 against 1 | 1 against 1 | 97 against 97 | 20 s against 20 s | candidate better |',
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
      '| quiz-rank | 2 of 3 against 2 of 3 | on tap 2 of 2 against on tap 3 of 3 | 0 of 2 against 0 of 3 | 100 against 100 | 1 against 1 | 1 against 1 | 1 against 1 | 97 against 97 | 20 s against 20 s | the same |',
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

  it('lists an order only one Flight has as only in it, never as not measured in the other', () => {
    const report = flightReport(
      [record('shelf-tags', 1), record('quiz-rank', 1)],
      [record('quiz-rank', 1)],
    );
    assert.match(report, /^Only in the baseline: shelf-tags$/m);
    assert.doesNotMatch(report, /^No run measured/m);
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

  it('sums up the orders each Flight passed every run of, the runs that reached a pull request, those too close to call, and the tokens per order', () => {
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
        'nip as it ships: 2 of 3 orders (9 of 9 runs reached a pull request), nip with cellarman on claude-opus-5-5 at larger: 2 of 3 orders (9 of 9 runs reached a pull request), 2 too close to call, tokens per order +60%',
      ),
      report,
    );
  });

  it('lists an order the candidate measured no run of below the table, out of its rows', () => {
    const report = flightReport(
      [record('shelf-tags', 1), record('quiz-rank', 1)],
      [noHead('shelf-tags', 1), record('quiz-rank', 1)],
    );
    assert.equal(rowOf(report, 'shelf-tags'), undefined);
    assert.match(report, /^No run measured in the candidate: shelf-tags$/m);
  });

  it('counts the orders each Flight passed every run of on its own side of the summary', () => {
    const report = flightReport(
      [...runsOf('quiz-rank', 3), ...runsOf('post-slugs', 3)],
      [...runsOf('post-slugs', 2, { swap: SWAP }), ...runsOf('quiz-rank', 3, { swap: SWAP })],
    );
    assert.match(
      report,
      /^nip as it ships: 2 of 2 orders \(6 of 6 runs reached a pull request\), nip with cellarman on claude-opus-5-5 at larger: 1 of 2 orders \(6 of 6 runs reached a pull request\), 1 too close to call, /m,
    );
  });

  it('counts the runs that reached a pull request beside the orders passed, a stuck run that left a commit green read passing all the same', () => {
    // Stuck with no pull request, as shelf-tags was in the first Flight: its hidden tests passed.
    const stuck = (setup: string, run: number) => ({
      ...record(setup, run, { headFrom: 'green' }),
      ended: 'stuck: blocked',
    });
    const report = flightReport(
      [
        ...runsOf('quiz-rank', 3),
        record('post-slugs', 1),
        record('post-slugs', 2),
        stuck('post-slugs', 3),
      ],
      [
        ...runsOf('quiz-rank', 3, { swap: SWAP, steps: [step(200, 20)] }),
        ...runsOf('post-slugs', 3, { swap: SWAP, steps: [step(200, 20)] }),
      ],
    );
    assert.match(
      report,
      /^nip as it ships: 2 of 2 orders \(5 of 6 runs reached a pull request\), nip with cellarman on claude-opus-5-5 at larger: 2 of 2 orders \(6 of 6 runs reached a pull request\), 0 too close to call, tokens per order \+100%$/m,
    );
  });

  it('counts a run that left no head as not reaching a pull request', () => {
    const report = flightReport(
      [record('quiz-rank', 1), record('quiz-rank', 2), noHead('quiz-rank', 3)],
      [record('quiz-rank', 1), record('quiz-rank', 2), record('quiz-rank', 3)],
    );
    assert.match(
      report,
      /^nip as it ships: 0 of 1 orders \(2 of 3 runs reached a pull request\), nip as it ships: 1 of 1 orders \(3 of 3 runs reached a pull request\), /m,
    );
  });

  it('scores a run stuck on the commit green read as it did, beside a run with a pull request (ADR 0409)', () => {
    const stuck = { ...record('shelf-tags', 1, { headFrom: 'green' }), ended: 'stuck: blocked' };
    const report = flightReport([stuck], [record('shelf-tags', 1, { swap: SWAP })]);
    assert.match(rowOf(report, 'shelf-tags') ?? '', /^\| shelf-tags \| 1 of 1 against 1 of 1 \| /);
    assert.match(report, /, 0 too close to call, /);
  });

  it('heads its columns with the endings and the tokens split into output, cache read, cache write and fresh input', () => {
    const report = flightReport([record('quiz-rank', 1)], [record('quiz-rank', 1)]);
    assert.ok(
      report
        .split('\n')
        .includes(
          "| Order | Hidden tests passed | Ended | Runs outside its paths | Tokens per run | Output per run | Cache read per run | Cache write per run | Fresh input per run | Brewers' time per run | Verdict |",
        ),
      report,
    );
    assert.ok(report.split('\n').includes(`|${'---|'.repeat(11)}`), report);
  });

  it("shows how each Flight's runs of an order ended, grouped, on tap first and the rest in alphabetical order", () => {
    const ended = (run: number, how: string, flight: Partial<FlightRecord['flight']> = {}) => ({
      ...record('quiz-rank', run, flight),
      ended: how,
    });
    const report = flightReport(
      [
        ended(1, 'on_tap'),
        ended(2, 'stuck: blocked', { headFrom: 'green' }),
        ended(3, 'stuck: plan_review', { headFrom: 'green' }),
        ended(4, 'cancelled'),
      ],
      [ended(1, 'on_tap'), ended(2, 'on_tap'), ended(3, 'on_tap'), ended(4, 'on_tap')],
    );
    assert.equal(
      (rowOf(report, 'quiz-rank') ?? '').split(' | ')[2],
      'on tap 1 of 4, cancelled 1 of 4, stuck 2 of 4 against on tap 4 of 4',
    );
  });

  it('splits the tokens per run by kind, the mean of the runs that measured something, one Flight against the other', () => {
    const used = (output: number, cacheRead: number, cacheWrite: number, input: number) => ({
      ...step(0, 20),
      usage: {
        inputTokens: input,
        outputTokens: output,
        cacheReadTokens: cacheRead,
        cacheWriteTokens: cacheWrite,
      },
    });
    const report = flightReport(
      [
        record('quiz-rank', 1, { steps: [used(100, 6_000, 1_000, 10)] }),
        record('quiz-rank', 2, { steps: [used(300, 8_000, 3_000, 30)] }),
        noHead('quiz-rank', 3, { steps: [used(9_999, 9_999, 9_999, 9_999)] }),
      ],
      [
        record('quiz-rank', 1, { steps: [used(50, 1_000, 500, 5)] }),
        record('quiz-rank', 2, { steps: [used(50, 1_000, 500, 5)] }),
        record('quiz-rank', 3, { steps: [used(50, 1_000, 500, 5)] }),
      ],
    );
    const cells = (rowOf(report, 'quiz-rank') ?? '').split(' | ');
    // Tokens, output, cache read, cache write, fresh input.
    assert.deepEqual(cells.slice(4, 9), [
      '9220 against 1555',
      '200 against 50',
      '7000 against 1000',
      '2000 against 500',
      '20 against 5',
    ]);
  });

  describe('its command line', () => {
    it('reads the options it was given as parseArgs does', () => {
      const read = flightReportArgsOf(['--baseline', 'base', '--candidate', 'next']);
      assert.equal(read.kind, 'values');
      assert.deepEqual(read.kind === 'values' ? { ...read.values } : undefined, {
        baseline: 'base',
        candidate: 'next',
      });
    });

    for (const option of ['baseline', 'candidate']) {
      it(`refuses --${option} with no value in one line, not a thrown error`, () => {
        const other = option === 'baseline' ? 'candidate' : 'baseline';
        assert.deepEqual(flightReportArgsOf([`--${other}`, 'folder', `--${option}`]), {
          kind: 'refused',
          message: `--${option} needs a value`,
        });
      });
    }

    it('refuses a lone option missing its value', () => {
      assert.deepEqual(flightReportArgsOf(['--baseline']), {
        kind: 'refused',
        message: '--baseline needs a value',
      });
    });
  });

  it('compares the tokens per measured run of each order, not its total', () => {
    const report = flightReport(
      [record('quiz-rank', 3), noHead('quiz-rank', 2), record('quiz-rank', 1)],
      [1, 2, 3].map((run) => record('quiz-rank', run, { steps: [step(150, 20)] })),
    );
    assert.match(report, /, tokens per order \+50%$/m);
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
      INPUTS,
    );
    const report = flightReport(flights.base ?? [], flights.next ?? []);
    assert.deepEqual(ran, {
      kind: 'report',
      report,
      file: join('next', 'report.md'),
      tasted: tastedOf(flights.base ?? [], flights.next ?? [], report, INPUTS),
    });
  });

  it('refuses a command line without --baseline', () => {
    assert.deepEqual(
      flightReportRun({ candidate: 'next' }, () => [record('quiz-rank', 1)], INPUTS),
      {
        kind: 'refused',
        message: '--baseline names the Flight folder the candidate is compared with',
      },
    );
  });

  it('refuses a command line without --candidate', () => {
    assert.deepEqual(
      flightReportRun({ baseline: 'base' }, () => [record('quiz-rank', 1)], INPUTS),
      {
        kind: 'refused',
        message: '--candidate names the Flight folder compared with the baseline',
      },
    );
  });

  it('refuses a baseline folder with no records', () => {
    const ran = flightReportRun(
      { baseline: 'base', candidate: 'next' },
      (folder) => (folder === 'next' ? [record('quiz-rank', 1)] : []),
      INPUTS,
    );
    assert.deepEqual(ran, {
      kind: 'refused',
      message:
        '--baseline base holds no results.jsonl records: name a Flight folder under .foedrum/tmp/flight',
    });
  });

  it('refuses a candidate folder with no records', () => {
    const ran = flightReportRun(
      { baseline: 'base', candidate: 'next' },
      (folder) => (folder === 'base' ? [record('quiz-rank', 1)] : []),
      INPUTS,
    );
    assert.deepEqual(ran, {
      kind: 'refused',
      message:
        '--candidate next holds no results.jsonl records: name a Flight folder under .foedrum/tmp/flight',
    });
  });
});

describe("the Flight report's tasted entry (ADR 0416)", () => {
  const asShips = {
    models: { implement: ['claude-sonnet-5-5'], correctness: ['claude-sonnet-5-6'] },
  };
  /** The Cellarman on Opus, a model id, whose steps borrow nip's first free level, strong. */
  const onOpus = (tokens: number) => ({
    swap: SWAP,
    steps: [step(tokens, 20)],
    models: { implement: ['claude-opus-5-5'], correctness: ['claude-sonnet-5-6'] },
  });
  /** Two orders as nip ships, one passed every run, and with the Cellarman on Opus, both. */
  const flights = {
    baseline: [...runsOf('quiz-rank', 3, asShips), ...runsOf('post-slugs', 1, asShips)],
    candidate: [...runsOf('post-slugs', 3, onOpus(301)), ...runsOf('quiz-rank', 3, onOpus(400))],
  };
  const ENTRY = {
    brewer: 'cellarman',
    recipe: 'nip',
    level: 'strong',
    effort: 'larger',
    model: 'claude-opus-5-5',
    passed: 2,
    runs: 2,
    baseline: { passed: 1, runs: 2, model: 'claude-sonnet-5-5' },
    tokensPerOrder: 351,
    tokensPerOrderSplit: { output: 1, cacheRead: 1, cacheWrite: 1, input: 348 },
    date: '2026-11-20',
  };
  const tasted = (
    baseline: readonly FlightRecord[] = flights.baseline,
    candidate: readonly FlightRecord[] = flights.candidate,
    inputs: Partial<TastedInputs> = {},
  ) => tastedOf(baseline, candidate, 'The report.\n', { ...INPUTS, ...inputs });
  const notWritten = (...args: Parameters<typeof tasted>) => {
    const result = tasted(...args);
    return result.kind === 'not written' ? result : assert.fail('the entry was written');
  };
  const written = (...args: Parameters<typeof tasted>) => {
    const result = tasted(...args);
    return result.kind === 'written' ? result : assert.fail(result.why);
  };
  const entriesOf = (models: string) =>
    (parseJsonc(models) as { claude: { tasted: (typeof ENTRY)[] } }).claude.tasted;
  /** `records` with `flight` changed by `change`. */
  const changed = (
    records: readonly FlightRecord[],
    change: (flight: FlightRecord['flight']) => FlightRecord['flight'],
  ): FlightRecord[] => records.map((record) => ({ ...record, flight: change(record.flight) }));
  /** MODELS with `entries` as its tasted list. */
  const modelsWith = (entries: readonly unknown[]) =>
    MODELS.replace('"efforts"', `"tasted": ${JSON.stringify(entries)},\n    "efforts"`);

  it("adds the entry of the candidate's swapped brewer, recipe, level and effort to defaults/models.jsonc", () => {
    assert.deepEqual(entriesOf(written().models), [ENTRY]);
  });

  it("names the model only the swapped brewer's steps ran on, in the candidate and in the baseline", () => {
    const [entry] = entriesOf(written().models);
    assert.deepEqual(
      [entry?.model, entry?.baseline.model],
      ['claude-opus-5-5', 'claude-sonnet-5-5'],
    );
  });

  it('names the level a swap to a level ran on as it is', () => {
    const onExtreme = changed(flights.candidate, (flight) => ({
      ...flight,
      swap: { ...SWAP, model: 'extreme' },
    }));
    assert.equal(entriesOf(written(undefined, onExtreme).models)[0]?.level, 'extreme');
  });

  it("dates the entry by today's date in UTC", () => {
    const late = written(undefined, undefined, { today: new Date('2026-11-21T23:30:00-05:00') });
    assert.equal(entriesOf(late.models)[0]?.date, '2026-11-22');
  });

  it('keeps the header comment and the other fields, and writes the rest as Biome formats it', () => {
    const { models } = written();
    // The text `biome format --stdin-file-path=defaults/models.jsonc` leaves as it is.
    assert.equal(
      models,
      `${HEADER}{
  "$schema": "../schemas/models.json",
  "claude": {
    "models": {
      "light": "haiku",
      "strong": "opus"
    },
    "efforts": {
      "small": "low",
      "larger": "high"
    },
    "tasted": [
      {
        "brewer": "cellarman",
        "recipe": "nip",
        "level": "strong",
        "effort": "larger",
        "model": "claude-opus-5-5",
        "passed": 2,
        "runs": 2,
        "baseline": {
          "passed": 1,
          "runs": 2,
          "model": "claude-sonnet-5-5"
        },
        "tokensPerOrder": 351,
        "tokensPerOrderSplit": {
          "output": 1,
          "cacheRead": 1,
          "cacheWrite": 1,
          "input": 348
        },
        "date": "2026-11-20"
      }
    ]
  }
}
`,
    );
  });

  it('keeps the tokens per order apart by kind, each the mean over the orders both Flights measured', () => {
    const used = (output: number, cacheRead: number, cacheWrite: number, input: number) => ({
      ...step(0, 20),
      usage: {
        inputTokens: input,
        outputTokens: output,
        cacheReadTokens: cacheRead,
        cacheWriteTokens: cacheWrite,
      },
    });
    // quiz-rank's runs use 100 + 6000 + 1000 + 10 tokens, post-slugs' 300 + 8000 + 3000 + 31.
    const candidate = [
      ...changed(runsOf('quiz-rank', 3, onOpus(0)), (flight) => ({
        ...flight,
        steps: [used(100, 6_000, 1_000, 10)],
      })),
      ...changed(runsOf('post-slugs', 3, onOpus(0)), (flight) => ({
        ...flight,
        steps: [used(300, 8_000, 3_000, 31)],
      })),
    ];
    const [entry] = entriesOf(written(undefined, candidate).models);
    assert.deepEqual(entry, {
      ...ENTRY,
      tokensPerOrder: 9_221,
      tokensPerOrderSplit: { output: 200, cacheRead: 7_000, cacheWrite: 2_000, input: 21 },
    });
  });

  it('keeps a header read with a BOM and CRLF line ends, written in LF without the BOM', () => {
    const modelsText = `﻿${MODELS.replaceAll('\n', '\r\n')}`;
    const { models } = written(undefined, undefined, { modelsText });
    assert.equal(models.slice(0, HEADER.length + 1), `${HEADER}{`);
  });

  it('replaces the entry of the same combination, in its place, and keeps the others', () => {
    const old = { ...ENTRY, model: 'claude-opus-5', date: '2026-11-01' };
    const other = { ...ENTRY, effort: 'full' };
    const modelsText = modelsWith([old, other]);
    assert.deepEqual(entriesOf(written(undefined, undefined, { modelsText }).models), [
      ENTRY,
      other,
    ]);
  });

  it('describes the pull request from the report: what it adds, both Flights in one line, and the report', () => {
    const { title, description } = written();
    assert.equal(title, 'Taste cellarman in nip on strong at larger: claude-opus-5-5');
    assert.equal(
      description,
      [
        '## How it works',
        "`defaults/models.jsonc`'s `tasted` list keeps the latest Flight of each brewer, recipe, level and effort (ADR 0416). This pull request adds the entry for cellarman in nip on strong at larger: on claude-opus-5-5 it passed every run on 2 of 2 orders, where nip as it ships on claude-sonnet-5-5 passed every run on 1 of 2, at 351 tokens per order (1 output, 1 cache read, 1 cache write and 348 fresh input).",
        '',
        '## The Flight report',
        '',
        'The report.',
        '',
        "Add this pull request's link to the entry as its `report` in a second commit (ADR 0416).",
        '',
      ].join('\n'),
    );
  });

  it('says which entry it replaces, by its date', () => {
    const modelsText = modelsWith([{ ...ENTRY, date: '2026-11-01' }]);
    assert.match(
      written(undefined, undefined, { modelsText }).description,
      / replaces the entry of 2026-11-01 for cellarman in nip on strong at larger: /,
    );
  });

  it('writes no entry for a dry run of the candidate, and ends well', () => {
    const dry = changed(flights.candidate, (flight) => ({ ...flight, dryRun: true }));
    assert.deepEqual(notWritten(undefined, dry), {
      kind: 'not written',
      why: 'a dry run tastes nothing, so defaults/models.jsonc is unchanged',
      exitCode: 0,
    });
  });

  it('writes no entry for a dry run of the baseline, and ends well', () => {
    const dry = changed(flights.baseline, (flight) => ({ ...flight, dryRun: true }));
    assert.equal(notWritten(dry).exitCode, 0);
  });

  it('writes no entry for a candidate as it ships: an entry is of a swapped brewer', () => {
    const shipped = changed(flights.candidate, ({ swap: _, ...flight }) => flight);
    assert.deepEqual(notWritten(undefined, shipped), {
      kind: 'not written',
      why: 'the candidate brews nip as it ships, and a tasted entry is of a swapped brewer, so defaults/models.jsonc is unchanged',
      exitCode: 1,
    });
  });

  it('writes no entry for two Flights of different recipes', () => {
    const deep = changed(flights.baseline, (flight) => ({ ...flight, recipe: 'deep-brew' }));
    assert.deepEqual(notWritten(deep), {
      kind: 'not written',
      why: 'the baseline brews deep-brew and the candidate nip, so defaults/models.jsonc is unchanged',
      exitCode: 1,
    });
  });

  it('writes no entry for a recipe that is no default recipe', () => {
    assert.deepEqual(notWritten(undefined, undefined, { recipeText: () => undefined }), {
      kind: 'not written',
      why: 'nip is no default recipe, so defaults/models.jsonc is unchanged',
      exitCode: 1,
    });
  });

  it('writes no entry when no order was measured by both Flights', () => {
    assert.deepEqual(notWritten(runsOf('shelf-tags', 3, asShips)), {
      kind: 'not written',
      why: 'no order was measured by both Flights, so defaults/models.jsonc is unchanged',
      exitCode: 1,
    });
  });

  it("writes no entry when the candidate's swapped steps ran on two models, naming both", () => {
    const mixed = changed(flights.candidate, (flight) =>
      flight === flights.candidate[0]?.flight
        ? { ...flight, models: { implement: ['claude-opus-5-6'] } }
        : flight,
    );
    assert.deepEqual(notWritten(undefined, mixed), {
      kind: 'not written',
      why: "the candidate's cellarman steps ran on claude-opus-5-6 and claude-opus-5-5, so defaults/models.jsonc is unchanged",
      exitCode: 1,
    });
  });

  it("writes no entry when no transcript of the candidate's swapped steps named a model", () => {
    const unnamed = changed(flights.candidate, (flight) => ({
      ...flight,
      models: { correctness: ['claude-sonnet-5-6'] },
    }));
    assert.deepEqual(notWritten(undefined, unnamed), {
      kind: 'not written',
      why: "no transcript of the candidate's cellarman steps named a model, so defaults/models.jsonc is unchanged",
      exitCode: 1,
    });
  });

  it("writes no entry when the baseline's steps of the swapped brewer ran on two models", () => {
    const mixed = changed(flights.baseline, (flight) =>
      flight === flights.baseline[0]?.flight
        ? { ...flight, models: { implement: ['claude-sonnet-5-6'] } }
        : flight,
    );
    assert.equal(
      notWritten(mixed).why,
      "the baseline's cellarman steps ran on claude-sonnet-5-6 and claude-sonnet-5-5, so defaults/models.jsonc is unchanged",
    );
  });

  it('writes no entry when a transcript names what is no model id, quoting it on one line', () => {
    const odd = changed(flights.candidate, (flight) => ({
      ...flight,
      models: { implement: ['Claude-Opus-5-5\nforged'] },
    }));
    let result: ReturnType<typeof tasted> | undefined;
    assert.doesNotThrow(() => {
      result = tasted(undefined, odd);
    });
    assert.deepEqual(result, {
      kind: 'not written',
      why: `the candidate's cellarman steps named "Claude-Opus-5-5\\nforged", which is no model id, so defaults/models.jsonc is unchanged`,
      exitCode: 1,
    });
  });

  it('gives its tasted entry with the report the options ask for', () => {
    const ran = flightReportRun(
      { baseline: 'base', candidate: 'next' },
      (folder) => (folder === 'base' ? flights.baseline : flights.candidate),
      INPUTS,
    );
    assert.equal(ran.kind === 'report' && ran.tasted.kind, 'written');
  });
});
