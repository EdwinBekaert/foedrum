import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  type BudgetOptions,
  budgetReporter,
  recordCpuTime,
  type TestEvent,
  withoutCpuTimes,
} from '../../scripts/test-budget-reporter.ts';

const cwd = join(import.meta.dirname, 'repo');
const fileA = join(cwd, 'test', 'unit', 'a.test.ts');
const fileB = join(cwd, 'test', 'unit', 'b.test.ts');
const fileC = join(cwd, 'test', 'property', 'c.test.ts');
const fileD = join(cwd, 'test', 'chaos', 'd.test.ts');

// The runner's summary of one test file, or of the whole run when there is no file. Its time is
// wall time.
const summary = (file: string | undefined, ms: number): TestEvent => ({
  type: 'test:summary',
  data: { ...(file === undefined ? {} : { file }), duration_ms: ms },
});

// The diagnostics recordCpuTime sends from a test process whose CPU usage is the given one, as
// the runner passes them on with the process's file.
const cpuDiagnostics = (
  file: string,
  usage: { user: number; system: number },
  env: NodeJS.ProcessEnv = { NODE_TEST_CONTEXT: 'child-v8' },
): TestEvent[] => {
  const events: TestEvent[] = [];
  recordCpuTime({
    env,
    after: (hook) =>
      hook({
        diagnostic: (message) => {
          events.push({ type: 'test:diagnostic', data: { nesting: 0, file, message } });
        },
      }),
    cpuUsage: () => usage,
  });
  return events;
};

// A test file's CPU time in ms, half user and half system time (process.cpuUsage() counts µs).
const cpu = (file: string, ms: number): TestEvent[] =>
  cpuDiagnostics(file, { user: ms * 500, system: ms * 500 });

// Two readings the reporter cannot use: one whose number is not a number, and one without a file.
const unusableReadings = (file: string): TestEvent[] => {
  const [reading] = cpu(file, 1);
  const prefix = (reading?.data?.message ?? '').replace(/[0-9.]+$/, '');
  return [
    { type: 'test:diagnostic', data: { nesting: 0, file, message: `${prefix}abc` } },
    { type: 'test:diagnostic', data: { nesting: 0, message: `${prefix}9000` } },
  ];
};

// A file's wall time and CPU time, the reading before the summary as the runner sends them.
const timed = (file: string, wallMs: number, cpuMs: number): TestEvent[] => [
  ...cpu(file, cpuMs),
  summary(file, wallMs),
];

// A top-level test's own time, which the reporter does not read.
const passed = (file: string, ms: number): TestEvent =>
  ({ type: 'test:pass', data: { nesting: 0, file, details: { duration_ms: ms } } }) as TestEvent;

// Runs the reporter over the events and returns what it printed and whether it failed the run.
const report = async (
  events: TestEvent[],
  budgetMs = 5000,
  slowest = 5,
  options: Partial<BudgetOptions> = {},
) => {
  let failed = false;
  const reporter = budgetReporter({
    budgetMs,
    cwd,
    slowest,
    ...options,
    fail: () => {
      failed = true;
    },
  });
  const source = (async function* () {
    yield* events;
  })();
  let output = '';
  for await (const chunk of reporter(source)) output += chunk;
  return { lines: output.split('\n').filter((line) => line !== ''), failed };
};

const overLines = (lines: string[]) => lines.filter((line) => line.startsWith('✖'));

describe('budgetReporter', () => {
  it("lists each file's CPU and wall time, most CPU first, leaving out the run's summary", async () => {
    // The file summaries count hooks and setup that the tests' own times leave out.
    const { lines, failed } = await report([
      passed(fileA, 300),
      ...timed(fileA, 2700, 700),
      passed(fileB, 100),
      ...timed(fileB, 1200, 1100),
      ...timed(fileC, 900, 950),
      summary(undefined, 9000),
      { type: 'test:diagnostic', data: { nesting: 0, message: 'tests 3' } },
    ]);
    assert.deepEqual(lines, [
      'test file times (budget 5 s of CPU time per file in test/unit/, ADR 0035)',
      '  1.10 s CPU  1.20 s wall  test/unit/b.test.ts',
      '  0.95 s CPU  0.90 s wall  test/property/c.test.ts',
      '  0.70 s CPU  2.70 s wall  test/unit/a.test.ts',
      'end of test file times',
    ]);
    assert.equal(failed, false);
  });

  it('lists only the files with the most CPU time', async () => {
    const { lines } = await report(
      [...timed(fileA, 900, 100), ...timed(fileB, 100, 300), ...timed(fileC, 500, 200)],
      5000,
      2,
    );
    assert.deepEqual(lines.slice(1, -1), [
      '  0.30 s CPU  0.10 s wall  test/unit/b.test.ts',
      '  0.20 s CPU  0.50 s wall  test/property/c.test.ts',
    ]);
  });

  // A loaded machine stretches a file's wall time, not the CPU time it uses (#108).
  it('lets a unit file that waits pass: long wall time, little CPU time', async () => {
    const { lines, failed } = await report(timed(fileA, 12_000, 800));
    assert.equal(failed, false);
    assert.deepEqual(overLines(lines), []);
  });

  it('fails the run for a unit file that spins over the budget, naming its CPU time', async () => {
    const { lines, failed } = await report(timed(fileA, 5300, 5100));
    assert.equal(failed, true);
    const over = overLines(lines);
    assert.equal(over.length, 1);
    assert.match(
      over[0] ?? '',
      /^✖ test\/unit\/a\.test\.ts used 5\.10 s of CPU time, over the 5 s budget/,
    );
    assert.match(over[0] ?? '', /test\/integration\//);
  });

  // Threads (garbage collection, coverage) can use more CPU time than the wall time passed.
  it('fails the run for a unit file over the budget in CPU time but not in wall time', async () => {
    const { failed } = await report(timed(fileA, 4000, 5100));
    assert.equal(failed, true);
  });

  it('adds user and system time', async () => {
    const { lines, failed } = await report([
      ...cpuDiagnostics(fileA, { user: 3_000_000, system: 2_100_000 }),
      summary(fileA, 5200),
    ]);
    assert.equal(failed, true);
    assert.match(overLines(lines)[0] ?? '', /used 5\.10 s of CPU time/);
  });

  it('fails the run and names every file over the budget, most CPU first', async () => {
    const { lines, failed } = await report(
      [...timed(fileA, 3600, 3500), ...timed(fileB, 5200, 5100), ...timed(fileC, 3100, 3000)],
      3000,
    );
    assert.equal(failed, true);
    const over = overLines(lines);
    assert.equal(over.length, 2);
    assert.match(over[0] ?? '', /^✖ test\/unit\/b\.test\.ts used 5\.10 s of CPU time/);
    assert.match(over[1] ?? '', /^✖ test\/unit\/a\.test\.ts used 3\.50 s of CPU time/);
  });

  // Without a reading (the file failed to load, or the run left out scripts/test-cpu-time.ts),
  // wall time is the only measure; it is never lower than what the file would have reported.
  it('holds a file without a CPU time to its wall time, and says so', async () => {
    const { lines, failed } = await report([summary(fileA, 5100), ...timed(fileB, 900, 800)]);
    assert.equal(failed, true);
    assert.deepEqual(lines.slice(1, 3), [
      '  no CPU time  5.10 s wall  test/unit/a.test.ts',
      '  0.80 s CPU  0.90 s wall  test/unit/b.test.ts',
    ]);
    assert.match(
      overLines(lines)[0] ?? '',
      /^✖ test\/unit\/a\.test\.ts took 5\.10 s of wall time \(no CPU time reported\), over the 5 s budget/,
    );
  });

  // A test file's own root-level after hook runs after the preload's and could send a reading of
  // its own: a lower one must not replace the real one.
  it('keeps the highest CPU time a file reports', async () => {
    const { lines, failed } = await report([
      ...cpu(fileA, 8000),
      ...cpu(fileA, 0),
      summary(fileA, 8100),
    ]);
    assert.equal(failed, true);
    assert.match(overLines(lines)[0] ?? '', /used 8\.00 s of CPU time/);
  });

  // A test can send a diagnostic of its own before the preload's after hook runs.
  it('keeps the highest CPU time a file reports when the lower one comes first', async () => {
    const { lines, failed } = await report([
      ...cpu(fileA, 0),
      ...cpu(fileA, 8000),
      summary(fileA, 8100),
    ]);
    assert.equal(failed, true);
    assert.match(overLines(lines)[0] ?? '', /used 8\.00 s of CPU time/);
  });

  it('holds a file whose CPU time is negative to its wall time', async () => {
    const { lines, failed } = await report([...cpu(fileA, -1_000_000), summary(fileA, 5100)]);
    assert.equal(failed, true);
    assert.match(overLines(lines)[0] ?? '', /took 5\.10 s of wall time \(no CPU time reported\)/);
  });

  // Their time is set by their run count (#87).
  it('lists property and chaos files over the budget but does not fail the run', async () => {
    const { lines, failed } = await report(
      [...timed(fileA, 1000, 1000), ...timed(fileC, 9500, 9000), ...timed(fileD, 7500, 7000)],
      5000,
    );
    assert.equal(failed, false);
    assert.deepEqual(lines.slice(1, -1), [
      '  9.00 s CPU  9.50 s wall  test/property/c.test.ts',
      '  7.00 s CPU  7.50 s wall  test/chaos/d.test.ts',
      '  1.00 s CPU  1.00 s wall  test/unit/a.test.ts',
    ]);
    assert.deepEqual(overLines(lines), []);
  });

  it('holds no file outside test/unit/ to the budget, even one whose folder starts alike', async () => {
    const { failed } = await report(
      [
        ...timed(join(cwd, 'test', 'units', 'e.test.ts'), 9000, 9000),
        ...timed(join(cwd, 'test', 'integration', 'f.test.ts'), 9000, 9000),
      ],
      5000,
    );
    assert.equal(failed, false);
  });

  it('still fails for a unit file over the budget, naming only that file', async () => {
    const { lines, failed } = await report(
      [...timed(fileA, 5200, 5100), ...timed(fileC, 9000, 9000), ...timed(fileD, 7000, 7000)],
      5000,
    );
    assert.equal(failed, true);
    const over = overLines(lines);
    assert.deepEqual(over.length, 1);
    assert.match(over[0] ?? '', /^✖ test\/unit\/a\.test\.ts used 5\.10 s of CPU time/);
  });

  it('holds the files of the folder it is given to the budget, instead of test/unit/', async () => {
    const fixture = join(cwd, 'test', 'fixtures', 'budget', 'e.test.ts');
    const { lines, failed } = await report(
      [...timed(fixture, 3600, 3500), ...timed(fileA, 9000, 9000)],
      3000,
      5,
      { budgetedDir: 'test/fixtures/budget/' },
    );
    assert.equal(failed, true);
    assert.equal(
      lines[0],
      'test file times (budget 3 s of CPU time per file in test/fixtures/budget/, ADR 0035)',
    );
    assert.deepEqual(
      overLines(lines).map((line) => line.split(' used')[0]),
      ['✖ test/fixtures/budget/e.test.ts'],
    );
  });

  // A ceiling well above what a file's run count needs, so a property or chaos file whose run
  // count grew too large still fails (#87); on CPU time, like the budget (#108).
  for (const [layer, file] of [
    ['property', fileC],
    ['chaos', fileD],
  ] as const) {
    it(`fails the run for a ${layer} file over the 15 s ceiling in CPU time, naming it`, async () => {
      const { lines, failed } = await report([
        ...timed(fileA, 1000, 1000),
        ...timed(file, 15_200, 15_100),
      ]);
      assert.equal(failed, true);
      const over = overLines(lines);
      assert.equal(over.length, 1);
      assert.match(
        over[0] ?? '',
        new RegExp(
          `^✖ test/${layer}/[cd]\\.test\\.ts used 15\\.10 s of CPU time, over the 15 s ceiling`,
        ),
      );
    });

    it(`lets a ${layer} file pass that waits past the 15 s ceiling with less CPU time`, async () => {
      const { failed } = await report(timed(file, 40_000, 14_000));
      assert.equal(failed, false);
    });

    it(`lets a ${layer} file that uses exactly the 15 s ceiling pass`, async () => {
      const { failed } = await report(timed(file, 15_000, 15_000));
      assert.equal(failed, false);
    });
  }

  it('lets a file that uses exactly the budget pass', async () => {
    const { failed } = await report(timed(fileA, 3000, 3000), 3000);
    assert.equal(failed, false);
  });

  it('prints nothing when no test file ran', async () => {
    assert.deepEqual(await report([]), { lines: [], failed: false });
  });
});

describe('recordCpuTime', () => {
  it('reports the CPU time once, from an after hook, in a test process the runner started', () => {
    let hooks = 0;
    let reads = 0;
    const messages: string[] = [];
    recordCpuTime({
      env: { NODE_TEST_CONTEXT: 'child-v8' },
      after: (hook) => {
        hooks += 1;
        // Read when the hook runs, after the file's tests, not when it is registered.
        assert.equal(reads, 0);
        hook({ diagnostic: (message) => messages.push(message) });
      },
      cpuUsage: () => {
        reads += 1;
        return { user: 1, system: 2 };
      },
    });
    assert.equal(hooks, 1);
    assert.equal(reads, 1);
    assert.equal(messages.length, 1);
  });

  // With --import, node also loads the module in the runner itself, which runs no tests.
  it('registers nothing outside a test process the runner started', () => {
    assert.deepEqual(cpuDiagnostics(fileA, { user: 1, system: 2 }, {}), []);
  });
});

describe('withoutCpuTimes', () => {
  it('drops the CPU time diagnostics and passes every other event on, in order', async () => {
    const other: TestEvent = { type: 'test:diagnostic', data: { nesting: 0, message: 'tests 3' } };
    const fileDiagnostic: TestEvent = {
      type: 'test:diagnostic',
      data: { nesting: 0, file: fileA, message: 'a note of the test itself' },
    };
    const source = (async function* () {
      yield* [passed(fileA, 1), ...cpu(fileA, 700), fileDiagnostic, summary(fileA, 900), other];
    })();
    const out: TestEvent[] = [];
    for await (const event of withoutCpuTimes(source)) out.push(event);
    assert.deepEqual(out, [passed(fileA, 1), fileDiagnostic, summary(fileA, 900), other]);
  });

  it('passes on a reading it cannot use: no number, or no file', async () => {
    const readings = unusableReadings(fileA);
    const source = (async function* () {
      yield* readings;
    })();
    const out: TestEvent[] = [];
    for await (const event of withoutCpuTimes(source)) out.push(event);
    assert.deepEqual(out, readings);
  });
});

describe('budgetReporter with readings it cannot use', () => {
  it('holds the file to its wall time', async () => {
    const { lines, failed } = await report([...unusableReadings(fileA), summary(fileA, 5100)]);
    assert.equal(failed, true);
    assert.match(overLines(lines)[0] ?? '', /took 5\.10 s of wall time \(no CPU time reported\)/);
  });
});

describe('npm test', () => {
  // Without the preload every file would be held to its wall time again; with node's own spec,
  // each file's reading would add a line to the output.
  it('loads the CPU time preload and shows spec without the readings', () => {
    const packageJson = join(import.meta.dirname, '..', '..', 'package.json');
    const { scripts } = JSON.parse(readFileSync(packageJson, 'utf8')) as {
      scripts?: Record<string, string>;
    };
    const args = (scripts?.test ?? '').split(' ');
    assert.equal(args[args.indexOf('./scripts/test-cpu-time.ts') - 1], '--import');
    assert.ok(args.indexOf('--import') < args.indexOf('--test'));
    assert.ok(args.includes('--test-reporter=./scripts/spec-reporter.ts'));
    assert.ok(args.includes('--test-reporter=./scripts/test-budget-reporter.ts'));
    assert.ok(!args.includes('--test-reporter=spec'));
  });
});
