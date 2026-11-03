// Whether a mutant's run killed it (ADR 0040, ADR 0313): the leaf tests of the mutant's module,
// compared by name with the baseline's. Plain report data; no process starts (ADR 0021).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { judgeRun } from '../../src/checks/mutant-verdict.ts';
import type { MappedReport } from '../../src/checks/red-proof.ts';
import type { TestResult } from '../../src/formats/test-report.ts';

/** A report of `module` with these tests, in this order: `[name, result, leaf?]`. */
const report = (
  module: string,
  ...tests: [name: string, result: TestResult, leaf?: boolean][]
): MappedReport => ({
  module,
  other: '',
  tests: tests.map(([name, result, leaf = true]) => ({ name, result, leaf, detail: '' })),
});

const baseline = [report('api', ['adds', 'passed'], ['clamps', 'passed'])];

describe('judgeRun', () => {
  it('a test that passed at the baseline and no longer reports kills the mutant (regression test)', () => {
    assert.deepStrictEqual(judgeRun(baseline, [report('api', ['adds', 'passed'])], 'api', true), {
      kind: 'killed',
      by: 'clamps',
    });
  });

  it('a test name that passes fewer times than at the baseline kills the mutant (regression test)', () => {
    const twice = [report('api', ['adds', 'passed'], ['adds', 'passed'])];
    assert.deepStrictEqual(judgeRun(twice, [report('api', ['adds', 'passed'])], 'api', false), {
      kind: 'killed',
      by: 'adds',
    });
  });

  it("another module's failure and a failing suite kill nothing (regression test)", () => {
    const run = [
      report('api', ['adds', 'passed'], ['clamps', 'passed'], ['math', 'failed', false]),
      report('web', ['renders', 'failed']),
    ];
    assert.deepStrictEqual(judgeRun(baseline, run, 'api', true), { kind: 'survived' });
  });

  it('the first test of the run that the mutant makes fail is named (regression test)', () => {
    const run = [report('api', ['clamps', 'failed'], ['adds', 'failed'])];
    assert.deepStrictEqual(judgeRun(baseline, run, 'api', true), {
      kind: 'killed',
      by: 'clamps',
    });
  });

  it('a module that wrote no report in a run that passed is not judged (regression test)', () => {
    assert.deepStrictEqual(
      judgeRun(baseline, [report('web', ['renders', 'passed'])], 'api', false),
      {
        kind: 'notJudged',
        why: 'module "api" wrote no test report',
      },
    );
  });

  it('a failing test the baseline never reported kills the mutant (regression test)', () => {
    const run = [report('api', ['adds', 'passed'], ['clamps', 'passed'], ['new', 'failed'])];
    assert.deepStrictEqual(judgeRun(baseline, run, 'api', true), { kind: 'killed', by: 'new' });
  });
});
