import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { ProcessOutcome, RunOptions, RunProcess } from '../../scripts/process-runner.ts';
import {
  type BudgetOptions,
  budgetReporter,
  recordCpuTime,
  remeasureAlone,
  runsInCi,
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
      'test file times (budget 5 s of CPU time per file in test/unit/, ADR 0036)',
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
      'test file times (budget 3 s of CPU time per file in test/fixtures/budget/, ADR 0036)',
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

// A shared machine's load can push a file over its limit with nothing wrong in it, so outside CI
// the budget and the ceiling only report; in CI, where the machine is not shared, they fail
// (ADR 0136).
describe('budgetReporter outside CI and in CI (ADR 0136)', () => {
  const measuring = () => {
    const measured: string[] = [];
    const remeasure = async (file: string) => {
      measured.push(file);
      return 1000;
    };
    return { measured, remeasure };
  };

  it('with CI unset, lists a unit file over the budget in the times and fails nothing, without running it alone', async () => {
    const { measured, remeasure } = measuring();
    const { lines, failed } = await report(
      [...timed(fileA, 6500, 6000), ...timed(fileB, 900, 800)],
      5000,
      5,
      { ci: runsInCi({}), remeasure },
    );
    assert.equal(failed, false);
    assert.deepEqual(measured, []);
    assert.deepEqual(overLines(lines), []);
    assert.deepEqual(lines, [
      'test file times (budget 5 s of CPU time per file in test/unit/, ADR 0036)',
      '  6.00 s CPU  6.50 s wall  test/unit/a.test.ts',
      '  0.80 s CPU  0.90 s wall  test/unit/b.test.ts',
      '  ⚠ test/unit/a.test.ts used 6.00 s of CPU time, over the 5 s budget for one test file: make it cheaper, or move real tools and file system trees to test/integration/ (ADR 0021); it fails only in CI (ADR 0136)',
      'end of test file times',
    ]);
  });

  it('with CI unset, lists a chaos file over the ceiling and a file without a CPU time, and fails nothing', async () => {
    const { lines, failed } = await report(
      [...timed(fileD, 16_000, 15_500), summary(fileA, 5100)],
      5000,
      5,
      { ci: runsInCi({ CI: '' }) },
    );
    assert.equal(failed, false);
    assert.deepEqual(
      lines.filter((line) => line.startsWith('  ⚠')),
      [
        '  ⚠ test/chaos/d.test.ts used 15.50 s of CPU time, over the 15 s ceiling for a property or chaos file: lower its run count (#87); it fails only in CI (ADR 0136)',
        '  ⚠ test/unit/a.test.ts took 5.10 s of wall time (no CPU time reported), over the 5 s budget for one test file: make it cheaper, or move real tools and file system trees to test/integration/ (ADR 0021); it fails only in CI (ADR 0136)',
      ],
    );
    assert.equal(lines.at(-1), 'end of test file times');
  });

  it('with CI set, fails the run for a unit file over the budget after running it alone', async () => {
    const { measured, remeasure } = measuring();
    const { lines, failed } = await report(timed(fileA, 6500, 6000), 5000, 5, {
      ci: runsInCi({ CI: 'true' }),
      remeasure: async (file) => {
        await remeasure(file);
        return 5500;
      },
    });
    assert.equal(failed, true);
    assert.equal(measured.length, 3);
    assert.ok(!lines.some((line) => line.startsWith('  ⚠')));
    assert.match(
      overLines(lines)[0] ?? '',
      /^✖ test\/unit\/a\.test\.ts used 5\.50 s of CPU time alone \(6\.00 s in the run\), over the 5 s budget/,
    );
  });
});

describe('runsInCi', () => {
  it('is false with CI unset or empty, and true with CI set to anything else', () => {
    assert.equal(runsInCi({}), false);
    assert.equal(runsInCi({ CI: '' }), false);
    assert.equal(runsInCi({ CI: 'true' }), true);
    assert.equal(runsInCi({ CI: '1' }), true);
  });
});

// The same work can take several times the CPU time on a loaded machine (#248), so a file over the
// budget in the run is measured again, alone, once the run has ended (ADR 0089).
describe('budgetReporter with a re-measure (ADR 0089)', () => {
  // A re-measure that answers from the given readings, in ms, and records which files it measured.
  const alone = (readings: Record<string, number | undefined>) => {
    const measured: string[] = [];
    const remeasure = async (file: string) => {
      measured.push(file);
      return readings[file];
    };
    return { measured, remeasure };
  };

  it('lets a unit file pass that was over the budget in the run but is within it alone, and says so', async () => {
    const { measured, remeasure } = alone({ [fileA]: 1300 });
    const { lines, failed } = await report(timed(fileA, 16_000, 5080), 5000, 5, { remeasure });
    assert.equal(failed, false);
    assert.deepEqual(measured, [fileA]);
    assert.deepEqual(overLines(lines), []);
    assert.ok(
      lines.includes(
        'ℹ test/unit/a.test.ts used 5.08 s of CPU time in the run, over the 5 s budget, and 1.30 s alone: the same work takes more CPU time on a loaded machine (ADR 0089)',
      ),
      lines.join('\n'),
    );
  });

  it('fails a unit file that is over the budget alone too, naming both readings', async () => {
    const { remeasure } = alone({ [fileA]: 5200 });
    const { lines, failed } = await report(timed(fileA, 9000, 6000), 5000, 5, { remeasure });
    assert.equal(failed, true);
    assert.match(
      overLines(lines)[0] ?? '',
      /^✖ test\/unit\/a\.test\.ts used 5\.20 s of CPU time alone \(6\.00 s in the run\), over the 5 s budget/,
    );
  });

  // Load only adds CPU time, so the lower reading is the closer one to the file's own work.
  it('keeps the lower reading when the file used more alone than in the run', async () => {
    const { remeasure } = alone({ [fileA]: 6000 });
    const { lines, failed } = await report(timed(fileA, 9000, 5100), 5000, 5, { remeasure });
    assert.equal(failed, true);
    assert.match(
      overLines(lines)[0] ?? '',
      /used 5\.10 s of CPU time in the run \(6\.00 s alone\)/,
    );
  });

  it("keeps the run's reading when the file reports none alone", async () => {
    const { remeasure } = alone({});
    const { lines, failed } = await report(timed(fileA, 9000, 5100), 5000, 5, { remeasure });
    assert.equal(failed, true);
    assert.match(
      overLines(lines)[0] ?? '',
      /^✖ test\/unit\/a\.test\.ts used 5\.10 s of CPU time, over the 5 s budget/,
    );
  });

  it('lets a chaos file pass that was over the ceiling in the run but is within it alone', async () => {
    const { remeasure } = alone({ [fileD]: 9000 });
    const { lines, failed } = await report(timed(fileD, 40_000, 16_000), 5000, 5, { remeasure });
    assert.equal(failed, false);
    assert.ok(
      lines.some((line) =>
        line.startsWith(
          'ℹ test/chaos/d.test.ts used 16.00 s of CPU time in the run, over the 15 s ceiling, and 9.00 s alone',
        ),
      ),
      lines.join('\n'),
    );
  });

  // The runs alone end within the check step's own deadline, however many files are over.
  it('starts no run alone once the runs alone have taken their time, and says so', async () => {
    let clock = 0;
    const measured: string[] = [];
    const remeasure = async (file: string) => {
      measured.push(file);
      clock += 50_000;
      return 6000;
    };
    const { lines, failed } = await report(
      [...timed(fileA, 9000, 6000), ...timed(fileB, 9000, 7000)],
      5000,
      5,
      { remeasure, now: () => clock, remeasureForMs: 120_000 },
    );
    assert.equal(failed, true);
    // b at 0, 50 and 100 s; a at 150 s would start past the 120 s.
    assert.deepEqual(measured, [fileB, fileB, fileB]);
    assert.match(
      overLines(lines)[1] ?? '',
      /^✖ test\/unit\/a\.test\.ts used 6\.00 s of CPU time, not run alone: the runs alone took their 120 s \(ADR 0089\), over the 5 s budget/,
    );
  });

  it('lets a property file pass that was over the ceiling in the run but is within it alone', async () => {
    const { remeasure } = alone({ [fileC]: 1000 });
    const { lines, failed } = await report(timed(fileC, 20_000, 15_100), 5000, 5, { remeasure });
    assert.equal(failed, false);
    assert.deepEqual(overLines(lines), []);
    assert.ok(
      lines.some((line) =>
        line.startsWith('ℹ test/property/c.test.ts used 15.10 s of CPU time in the run'),
      ),
      lines.join('\n'),
    );
  });

  // 90 s to start runs alone, and one more may take its 60 s: with npm test's own run, within the
  // check step's 300 s.
  it('starts no run alone 90 s after the first by default, nor exactly at 90 s', async () => {
    let clock = 0;
    const measured: string[] = [];
    const remeasure = async (file: string) => {
      measured.push(file);
      clock += 30_000;
      return 6000;
    };
    await report([...timed(fileA, 9000, 6000), ...timed(fileB, 9000, 7000)], 5000, 5, {
      remeasure,
      now: () => clock,
    });
    // b at 0, 30 and 60 s; a would start at 90 s.
    assert.deepEqual(measured, [fileB, fileB, fileB]);
  });

  it('lets a file pass that uses exactly the budget alone, after one run alone', async () => {
    const { measured, remeasure } = alone({ [fileA]: 5000 });
    const { failed } = await report(timed(fileA, 9000, 6000), 5000, 5, { remeasure });
    assert.equal(failed, false);
    assert.deepEqual(measured, [fileA]);
  });

  // A run alone that reports nothing will not report anything the next time either.
  it('stops running a file alone once a run alone gives no reading', async () => {
    const { measured, remeasure } = alone({});
    await report(timed(fileA, 9000, 5100), 5000, 5, { remeasure });
    assert.deepEqual(measured, [fileA]);
  });

  it('runs a file alone again after a run without a reading that followed a reading', async () => {
    const readings = [5900, undefined, 4000];
    let calls = 0;
    const remeasure = async () => readings[calls++];
    const { lines, failed } = await report(timed(fileA, 9000, 6000), 5000, 5, { remeasure });
    assert.equal(failed, false);
    assert.equal(calls, 3);
    assert.ok(
      lines.some((line) =>
        line.includes('6.00 s of CPU time in the run, over the 5 s budget, and 4.00 s alone'),
      ),
      lines.join('\n'),
    );
  });

  it('measures again only the files over the budget or the ceiling that reported a CPU time', async () => {
    const { measured, remeasure } = alone({ [fileC]: 1000 });
    const { failed } = await report(
      [
        ...timed(fileA, 6000, 4900),
        summary(fileB, 5100),
        ...timed(fileC, 20_000, 15_100),
        ...timed(fileD, 9000, 9000),
      ],
      5000,
      5,
      { remeasure },
    );
    // b has no CPU time: its wall time holds, as without a re-measure.
    assert.equal(failed, true);
    assert.deepEqual(measured, [fileC]);
  });

  // Other sessions' load outlasts the run, so one run alone can still be over (#248).
  it('measures a file alone up to three times, stopping at the first reading within the budget', async () => {
    const readings = [5900, 4100, 1000];
    let calls = 0;
    const remeasure = async () => readings[calls++];
    const { lines, failed } = await report(timed(fileA, 9000, 6000), 5000, 5, { remeasure });
    assert.equal(failed, false);
    assert.equal(calls, 2);
    assert.ok(
      lines.some((line) =>
        line.includes('6.00 s of CPU time in the run, over the 5 s budget, and 4.10 s alone'),
      ),
      lines.join('\n'),
    );
  });

  it('fails a file over the budget in all three runs alone, with the lowest reading', async () => {
    const readings = [5900, 5300, 5600];
    let calls = 0;
    const remeasure = async () => readings[calls++];
    const { lines, failed } = await report(timed(fileA, 9000, 6000), 5000, 5, { remeasure });
    assert.equal(failed, true);
    assert.equal(calls, 3);
    assert.match(
      overLines(lines)[0] ?? '',
      /used 5\.30 s of CPU time alone \(6\.00 s in the run\)/,
    );
  });

  it('measures the files one at a time, once the run has ended', async () => {
    let ended = false;
    let running = 0;
    const seen: { file: string; ended: boolean; running: number }[] = [];
    const remeasure = async (file: string) => {
      running += 1;
      seen.push({ file, ended, running });
      await new Promise((resolve) => setImmediate(resolve));
      running -= 1;
      return 100;
    };
    const reporter = budgetReporter({ budgetMs: 5000, cwd, slowest: 5, fail: () => {}, remeasure });
    const source = (async function* () {
      yield* [...timed(fileA, 6000, 5100), ...timed(fileB, 7000, 6100)];
      ended = true;
    })();
    for await (const _ of reporter(source));
    assert.deepEqual(seen, [
      { file: fileB, ended: true, running: 1 },
      { file: fileA, ended: true, running: 1 },
    ]);
  });
});

describe('remeasureAlone', () => {
  type Call = { file: string; args: string[]; cwd: string; options?: RunOptions };
  const runner = (outcome: ProcessOutcome) => {
    const calls: Call[] = [];
    const runProcess: RunProcess = async (file, args, cwd, options) => {
      calls.push({ file, args, cwd, ...(options === undefined ? {} : { options }) });
      return outcome;
    };
    return { calls, runProcess };
  };
  const reading = (ms: number) => cpu(fileA, ms)[0]?.data?.message ?? '';

  it('runs the file alone under node --test with the CPU time preload and coverage, as npm test does', async () => {
    const { calls, runProcess } = runner({ exitCode: 0, output: '' });
    await remeasureAlone({ execPath: 'node.exe', cwd, runProcess, timeoutMs: 60_000 })(fileA);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.file, 'node.exe');
    assert.equal(calls[0]?.cwd, cwd);
    assert.deepEqual(calls[0]?.args, [
      '--import',
      './scripts/test-cpu-time.ts',
      '--test',
      '--experimental-test-coverage',
      '--test-reporter=tap',
      '--test-reporter-destination=stdout',
      fileA,
    ]);
    assert.equal(calls[0]?.options?.timeoutMs, 60_000);
  });

  it('gives a run alone 60 s by default', async () => {
    const { calls, runProcess } = runner({ exitCode: 0, output: '' });
    await remeasureAlone({ execPath: 'node', cwd, runProcess })(fileA);
    assert.equal(calls[0]?.options?.timeoutMs, 60_000);
  });

  it('reads the highest CPU time the file reported in its output, failed tests or not', async () => {
    const output = `TAP version 13\nnot ok 1 - x\n# ${reading(1300)}\n# ${reading(20)}\n1..1\n`;
    const { runProcess } = runner({ exitCode: 1, output });
    assert.equal(await remeasureAlone({ execPath: 'node', cwd, runProcess })(fileA), 1300);
  });

  it('reads a CPU time of 0 ms', async () => {
    const { runProcess } = runner({ exitCode: 0, output: `# ${reading(0)}\n` });
    assert.equal(await remeasureAlone({ execPath: 'node', cwd, runProcess })(fileA), 0);
  });

  it('reads nothing from a run without a reading, or one that was killed', async () => {
    const none = runner({ exitCode: 0, output: 'TAP version 13\n1..0\n' });
    assert.equal(
      await remeasureAlone({ execPath: 'node', cwd, runProcess: none.runProcess })(fileA),
      undefined,
    );
    const killed = runner({ exitCode: null, output: `# ${reading(900)}\n`, killed: 'timed-out' });
    assert.equal(
      await remeasureAlone({ execPath: 'node', cwd, runProcess: killed.runProcess })(fileA),
      undefined,
    );
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
