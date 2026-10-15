import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { budgetReporter, type TestEvent } from '../../scripts/test-budget-reporter.ts';

const cwd = join(import.meta.dirname, 'repo');
const fileA = join(cwd, 'test', 'unit', 'a.test.ts');
const fileB = join(cwd, 'test', 'unit', 'b.test.ts');
const fileC = join(cwd, 'test', 'property', 'c.test.ts');

const ended = (
  file: string | undefined,
  ms: number,
  nesting = 0,
  type: 'test:pass' | 'test:fail' = 'test:pass',
): TestEvent => ({
  type,
  data: { nesting, ...(file === undefined ? {} : { file }), details: { duration_ms: ms } },
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
  it('adds up the top-level times per file and lists files slowest first', async () => {
    const { lines, failed } = await report([
      ended(fileA, 300),
      ended(fileA, 50, 1),
      ended(fileB, 1200),
      ended(fileA, 400, 0, 'test:fail'),
      ended(fileC, 900),
      ended(undefined, 9000),
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
      [ended(fileA, 100), ended(fileB, 300), ended(fileC, 200)],
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
      [ended(fileA, 2000), ended(fileA, 1500), ended(fileB, 5100), ended(fileC, 3000)],
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
    const { failed } = await report([ended(fileA, 3000)], 3000);
    assert.equal(failed, false);
  });

  it('prints nothing when no test file ran', async () => {
    assert.deepEqual(await report([]), { lines: [], failed: false });
  });
});
