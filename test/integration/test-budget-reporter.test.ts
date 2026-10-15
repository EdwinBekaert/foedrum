// The budget reporter under the real node:test runner (ADR 0021): the runner's events have the
// shape the unit tests feed it, and a file over the budget fails the run.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const root = join(import.meta.dirname, '..', '..');
const sample = 'test/fixtures/test-budget/sample.test.ts';

const runWith = (reporter: string) =>
  spawnSync(
    process.execPath,
    ['--test', `--test-reporter=${reporter}`, '--test-reporter-destination=stdout', sample],
    // Without NODE_TEST_CONTEXT, which would make the child skip its files as a nested run.
    { cwd: root, encoding: 'utf8', env: { ...process.env, NODE_TEST_CONTEXT: undefined } },
  );

describe('test-budget-reporter under node --test', () => {
  it('lists the test file and lets the run pass within the budget', () => {
    const result = runWith('./scripts/test-budget-reporter.ts');
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /^test file times \(budget 5 s per file/m);
    assert.match(
      result.stdout,
      /^ {2}\d+\.\d\d s {2}test\/fixtures\/test-budget\/sample\.test\.ts$/m,
    );
  });

  it('fails the run and names the file when it is over the budget', () => {
    const result = runWith('./test/fixtures/test-budget/no-time-reporter.ts');
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(
      result.stdout,
      /^✖ test\/fixtures\/test-budget\/sample\.test\.ts took \d+\.\d\d s, over the 0 s budget/m,
    );
  });
});
