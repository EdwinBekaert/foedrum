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

/** A report of `module` whose tests each sit in a file as the report writes it: `[name, result, file?]`. */
const placed = (
  module: string,
  ...tests: [name: string, result: TestResult, file?: string][]
): MappedReport => ({
  module,
  other: '',
  tests: tests.map(([name, result, file]) => ({
    name,
    result,
    leaf: true,
    detail: '',
    ...(file === undefined ? {} : { location: { file } }),
  })),
});

const A = 'test/unit/add.test.ts';
const B = 'test/unit/clamp.test.ts';

describe('judgeRun, over the test files a scoped run ran (ADR 0431)', () => {
  const wide = [
    placed('api', ['adds', 'passed', A], ['clamps', 'passed', B], ['rounds', 'passed', B]),
  ];

  it('a test of a file that did not run is no kill, though the run does not report it', () => {
    const run = [placed('api', ['adds', 'passed', A])];
    assert.deepStrictEqual(judgeRun(wide, run, 'api', false, [A]), { kind: 'survived' });
  });

  it('a test of a file that ran and no longer reports still kills the mutant (regression test)', () => {
    const baseline = [placed('api', ['clamps', 'passed', B], ['rounds', 'passed', B])];
    const run = [placed('api', ['clamps', 'passed', B])];
    assert.deepStrictEqual(judgeRun(baseline, run, 'api', true, [B]), {
      kind: 'killed',
      by: 'rounds',
    });
  });

  it('matches a report that writes the absolute path of the scratch tree, not a longer name', () => {
    const baseline = [
      placed('api', ['adds', 'passed', `/scratch/1/${A}`], ['other', 'passed', `/scratch/1/x${A}`]),
    ];
    const run = [placed('api', ['adds', 'passed', `/scratch/2/${A}`])];
    assert.deepStrictEqual(judgeRun(baseline, run, 'api', false, [A]), { kind: 'survived' });
  });

  it('a baseline test the report places in no file is left out of a scoped run', () => {
    const baseline = [placed('api', ['adds', 'passed', A], ['floating', 'passed'])];
    const run = [placed('api', ['adds', 'passed', A])];
    assert.deepStrictEqual(judgeRun(baseline, run, 'api', false, [A]), { kind: 'survived' });
  });

  it('a module that passed no test in the files that ran is not judged', () => {
    const baseline = [placed('api', ['adds', 'failed', A], ['clamps', 'passed', B])];
    const run = [placed('api', ['adds', 'failed', A])];
    assert.deepStrictEqual(judgeRun(baseline, run, 'api', true, [A]), {
      kind: 'notJudged',
      why: 'no test of module "api" passed at the baseline',
    });
  });

  it('a run of the whole check compares every test of the baseline, a located one too (regression test)', () => {
    const run = [placed('api', ['adds', 'passed', A])];
    assert.deepStrictEqual(judgeRun(wide, run, 'api', true), { kind: 'killed', by: 'clamps' });
  });
});
