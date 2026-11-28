// Which tests of the baseline a scoped run's files name (#1176, ADR 0431): a report on Windows
// writes the absolute path of a scratch tree with backslashes. Plain report data; no process starts
// (ADR 0021).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { judgeRun } from '../../src/checks/mutant-verdict.ts';
import type { MappedReport } from '../../src/checks/red-proof.ts';

const placed = (...tests: [name: string, file: string][]): MappedReport => ({
  module: 'api',
  other: '',
  tests: tests.map(([name, file]) => ({
    name,
    result: 'passed',
    leaf: true,
    detail: '',
    location: { file },
  })),
});

const A = 'test/unit/add.test.ts';
const B = 'test/unit/clamp.test.ts';

describe('judgeRun, a report that writes Windows paths (ADR 0431)', () => {
  const baseline = [
    placed(
      ['adds', String.raw`C:\scratch\1\test\unit\add.test.ts`],
      ['clamps', String.raw`C:\scratch\1\test\unit\clamp.test.ts`],
    ),
  ];

  it('takes the baseline tests of the files that ran, whichever way the report slashes them', () => {
    const run = [placed(['adds', String.raw`C:\scratch\2\test\unit\add.test.ts`])];
    assert.deepStrictEqual(judgeRun(baseline, run, 'api', false, [A]), { kind: 'survived' });
  });

  it('kills by a test of a file that ran and no longer reports, though the other file is left out', () => {
    const run = [placed(['adds', String.raw`C:\scratch\2\test\unit\add.test.ts`])];
    assert.deepStrictEqual(judgeRun(baseline, run, 'api', true, [A, B]), {
      kind: 'killed',
      by: 'clamps',
    });
  });

  it('matches a path that holds a longer folder name only whole, as a sibling is no file that ran', () => {
    const sibling = [placed(['other', String.raw`C:\scratch\1\xtest\unit\add.test.ts`])];
    assert.deepStrictEqual(judgeRun(sibling, sibling, 'api', false, [A]), {
      kind: 'notJudged',
      why: 'no test of module "api" passed at the baseline',
    });
  });
});
