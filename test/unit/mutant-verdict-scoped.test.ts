// The verdict of a run of some test files (#1176, ADR 0431, ADR 0040): the run's tests are filtered
// to the files that ran as the baseline's are, so a test no report places in a file, which fails in
// both runs, is no new failure. The other cases of the verdict are in test/unit/mutant-verdict.test.ts.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { judgeRun } from '../../src/checks/mutant-verdict.ts';
import type { MappedReport } from '../../src/checks/red-proof.ts';
import type { TestResult } from '../../src/formats/test-report.ts';

/** A report of module api: each test with its result, and the file a report places it in. */
const report = (...tests: [name: string, result: TestResult, file?: string][]): MappedReport => ({
  module: 'api',
  other: '',
  tests: tests.map(([name, result, file]) => ({
    name,
    result,
    leaf: true,
    detail: '',
    ...(file === undefined ? {} : { location: { file, line: 3 } }),
  })),
});

const ran = ['test/a.test.ts'];

describe('judgeRun, a run of some test files (ADR 0431)', () => {
  it('does not read as a kill a test no report places in a file that fails in both runs', () => {
    const baseline = report(['adds', 'passed', 'test/a.test.ts'], ['helper suite', 'failed']);
    const run = report(['adds', 'passed', 'test/a.test.ts'], ['helper suite', 'failed']);
    assert.deepStrictEqual(judgeRun([baseline], [run], 'api', true, ran), { kind: 'survived' });
  });

  it('does not read as a kill a test of a file that did not run, whatever it reports', () => {
    const baseline = report(['adds', 'passed', 'test/a.test.ts']);
    const run = report(['adds', 'passed', 'test/a.test.ts'], ['other', 'failed', 'test/b.test.ts']);
    assert.deepStrictEqual(judgeRun([baseline], [run], 'api', true, ran), { kind: 'survived' });
  });

  it('still reads as a kill a test of a file that ran that fails', () => {
    const baseline = report(['adds', 'passed', 'test/a.test.ts']);
    const run = report(['adds', 'failed', 'test/a.test.ts']);
    assert.deepStrictEqual(judgeRun([baseline], [run], 'api', true, ran), {
      kind: 'killed',
      by: 'adds',
    });
  });

  it('compares a run of the whole check by every test, a test no report places in a file too', () => {
    const baseline = report(['adds', 'passed', 'test/a.test.ts'], ['helper suite', 'passed']);
    const run = report(['adds', 'passed', 'test/a.test.ts'], ['helper suite', 'failed']);
    assert.deepStrictEqual(judgeRun([baseline], [run], 'api', true), {
      kind: 'killed',
      by: 'helper suite',
    });
  });
});
