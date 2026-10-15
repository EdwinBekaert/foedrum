import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { budgetReporter, type TestEvent } from '../../scripts/test-budget-reporter.ts';

const cwd = join(import.meta.dirname, 'repo');
const fileA = join(cwd, 'test', 'unit', 'a.test.ts');
const fileB = join(cwd, 'test', 'unit', 'b.test.ts');
const fileC = join(cwd, 'test', 'property', 'c.test.ts');

// The runner's summary of one test file, or of the whole run when there is no file.
const summary = (file: string | undefined, ms: number): TestEvent => ({
  type: 'test:summary',
  data: { ...(file === undefined ? {} : { file }), duration_ms: ms },
});

const passed = (file: string, ms: number): TestEvent => ({
  type: 'test:pass',
  data: { nesting: 0, file, details: { duration_ms: ms } },
});

// Runs the reporter over the events and returns what it printed and whether it failed the run.
const report = async (events: TestEvent[], budgetMs = 5000, slowest = 5) => {
  let failed = false;
  const reporter = budgetReporter({
    budgetMs,
    cwd,
    slowest,
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
      'test file times (budget 5 s per file, ADR 0021)',
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

  it('lets a file that takes exactly the budget pass', async () => {
    const { failed } = await report([summary(fileA, 3000)], 3000);
    assert.equal(failed, false);
  });

  it('prints nothing when no test file ran', async () => {
    assert.deepEqual(await report([]), { lines: [], failed: false });
  });
});
