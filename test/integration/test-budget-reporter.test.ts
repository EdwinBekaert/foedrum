// The budget reporter under the real node:test runner (ADR 0021, ADR 0036): each test process
// reports its CPU time through scripts/test-cpu-time.ts, the runner passes it on with the file,
// the spec reporter hides it, and a file over the budget fails the run.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const root = join(import.meta.dirname, '..', '..');
const sample = 'test/fixtures/test-budget/sample.test.ts';

// The reporters and preload of npm test's script in package.json, with the given budget reporter.
const runWith = (reporter: string) =>
  spawnSync(
    process.execPath,
    [
      '--import',
      './scripts/test-cpu-time.ts',
      '--test',
      '--test-reporter=./scripts/spec-reporter.ts',
      '--test-reporter-destination=stdout',
      `--test-reporter=${reporter}`,
      '--test-reporter-destination=stdout',
      sample,
    ],
    // Without NODE_TEST_CONTEXT, which would make the child skip its files as a nested run.
    { cwd: root, encoding: 'utf8', env: { ...process.env, NODE_TEST_CONTEXT: undefined } },
  );

describe('test-budget-reporter under node --test', () => {
  it("lists the test file's CPU time and lets the run pass within the budget", () => {
    const result = runWith('./scripts/test-budget-reporter.ts');
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /^test file times \(budget 5 s of CPU time per file/m);
    assert.match(
      result.stdout,
      /^ {2}\d+\.\d\d s CPU {2}\d+\.\d\d s wall {2}test\/fixtures\/test-budget\/sample\.test\.ts$/m,
    );
  });

  it("shows the file's tests but not its CPU time diagnostic in the spec output", () => {
    const result = runWith('./scripts/test-budget-reporter.ts');
    assert.match(result.stdout, /^✔ passes/m);
    // spec's diagnostics are the run's summary only.
    const notes = result.stdout
      .split(/\r?\n/)
      .filter((line) => line.startsWith('ℹ '))
      .map((line) => line.split(' ')[1]);
    assert.deepEqual(notes, [
      'tests',
      'suites',
      'pass',
      'fail',
      'cancelled',
      'skipped',
      'todo',
      'duration_ms',
    ]);
  });

  it('fails the run and names the file when its CPU time is over the budget', () => {
    const result = runWith('./test/fixtures/test-budget/no-time-reporter.ts');
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(
      result.stdout,
      /^✖ test\/fixtures\/test-budget\/sample\.test\.ts used \d+\.\d\d s of CPU time, over the 0 s budget/m,
    );
  });
});
