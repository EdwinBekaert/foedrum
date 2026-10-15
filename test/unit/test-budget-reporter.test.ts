import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  type BudgetOptions,
  budgetReporter,
  type TestEvent,
} from '../../scripts/test-budget-reporter.ts';

const cwd = join(import.meta.dirname, 'repo');
const fileA = join(cwd, 'test', 'unit', 'a.test.ts');
const fileB = join(cwd, 'test', 'unit', 'b.test.ts');
const fileC = join(cwd, 'test', 'property', 'c.test.ts');
const fileD = join(cwd, 'test', 'chaos', 'd.test.ts');

// The runner's summary of one test file, or of the whole run when there is no file.
const summary = (file: string | undefined, ms: number): TestEvent => ({
  type: 'test:summary',
  data: { ...(file === undefined ? {} : { file }), duration_ms: ms },
});

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

describe('budgetReporter', () => {
  it("lists each file's summary time, slowest first, leaving out the run's summary", async () => {
    // The file summaries count hooks and setup that the tests' own times leave out.
    const { lines, failed } = await report([
      passed(fileA, 300),
      summary(fileA, 700),
      passed(fileB, 100),
      summary(fileB, 1200),
      summary(fileC, 900),
      summary(undefined, 9000),
      { type: 'test:diagnostic', data: { nesting: 0 } },
    ]);
    assert.deepEqual(lines, [
      'test file times (budget 5 s per file in test/unit/, ADR 0021)',
      '  1.20 s  test/unit/b.test.ts',
      '  0.90 s  test/property/c.test.ts',
      '  0.70 s  test/unit/a.test.ts',
      'end of test file times',
    ]);
    assert.equal(failed, false);
  });

  it('lists only the slowest files', async () => {
    const { lines } = await report(
      [summary(fileA, 100), summary(fileB, 300), summary(fileC, 200)],
      5000,
      2,
    );
    assert.deepEqual(lines.slice(1, -1), [
      '  0.30 s  test/unit/b.test.ts',
      '  0.20 s  test/property/c.test.ts',
    ]);
  });

  it('fails the run and names every file over the budget', async () => {
    const { lines, failed } = await report(
      [summary(fileA, 3500), summary(fileB, 5100), summary(fileC, 3000)],
      3000,
    );
    assert.equal(failed, true);
    const over = lines.filter((line) => line.startsWith('✖'));
    assert.equal(over.length, 2);
    assert.match(over[0] ?? '', /^✖ test\/unit\/b\.test\.ts took 5\.10 s, over the 3 s budget/);
    assert.match(over[1] ?? '', /^✖ test\/unit\/a\.test\.ts took 3\.50 s, over the 3 s budget/);
    assert.match(over[0] ?? '', /test\/integration\//);
  });

  // Their time is set by their run count and grows with the load of a parallel check (#87).
  it('lists property and chaos files over the budget but does not fail the run', async () => {
    const { lines, failed } = await report(
      [summary(fileA, 1000), summary(fileC, 9000), summary(fileD, 7000)],
      5000,
    );
    assert.equal(failed, false);
    assert.deepEqual(lines.slice(1, -1), [
      '  9.00 s  test/property/c.test.ts',
      '  7.00 s  test/chaos/d.test.ts',
      '  1.00 s  test/unit/a.test.ts',
    ]);
    assert.equal(lines.filter((line) => line.startsWith('✖')).length, 0);
  });

  it('holds no file outside test/unit/ to the budget, even one whose folder starts alike', async () => {
    const { failed } = await report(
      [
        summary(join(cwd, 'test', 'units', 'e.test.ts'), 9000),
        summary(join(cwd, 'test', 'integration', 'f.test.ts'), 9000),
      ],
      5000,
    );
    assert.equal(failed, false);
  });

  it('still fails for a unit file over the budget, naming only that file', async () => {
    const { lines, failed } = await report(
      [summary(fileA, 5100), summary(fileC, 9000), summary(fileD, 7000)],
      5000,
    );
    assert.equal(failed, true);
    const over = lines.filter((line) => line.startsWith('✖'));
    assert.deepEqual(over.length, 1);
    assert.match(over[0] ?? '', /^✖ test\/unit\/a\.test\.ts took 5\.10 s, over the 5 s budget/);
  });

  it('holds the files of the folder it is given to the budget, instead of test/unit/', async () => {
    const fixture = join(cwd, 'test', 'fixtures', 'budget', 'e.test.ts');
    const { lines, failed } = await report(
      [summary(fixture, 3500), summary(fileA, 9000)],
      3000,
      5,
      { budgetedDir: 'test/fixtures/budget/' },
    );
    assert.equal(failed, true);
    assert.equal(
      lines[0],
      'test file times (budget 3 s per file in test/fixtures/budget/, ADR 0021)',
    );
    assert.deepEqual(
      lines.filter((line) => line.startsWith('✖')).map((line) => line.split(' took')[0]),
      ['✖ test/fixtures/budget/e.test.ts'],
    );
  });

  // A ceiling well above any load's stretch, so a property or chaos file whose run count grew too
  // large still fails, while a parallel check's load cannot fail it (#87).
  for (const [layer, file] of [
    ['property', fileC],
    ['chaos', fileD],
  ] as const) {
    it(`fails the run for a ${layer} file over the 15 s ceiling, naming it`, async () => {
      const { lines, failed } = await report([summary(fileA, 1000), summary(file, 15_100)]);
      assert.equal(failed, true);
      const over = lines.filter((line) => line.startsWith('✖'));
      assert.equal(over.length, 1);
      assert.match(
        over[0] ?? '',
        new RegExp(`^✖ test/${layer}/[cd]\\.test\\.ts took 15\\.10 s, over the 15 s ceiling`),
      );
    });

    it(`lets a ${layer} file that takes exactly the 15 s ceiling pass`, async () => {
      const { failed } = await report([summary(file, 15_000)]);
      assert.equal(failed, false);
    });
  }

  it('lets a file that takes exactly the budget pass', async () => {
    const { failed } = await report([summary(fileA, 3000)], 3000);
    assert.equal(failed, false);
  });

  it('prints nothing when no test file ran', async () => {
    assert.deepEqual(await report([]), { lines: [], failed: false });
  });
});
