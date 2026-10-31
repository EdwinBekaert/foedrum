// Cobertura XML as the uncovered-line check reads it (ADR 0274): each class's file under its
// `<source>`, with its lines' hits and condition coverage, paths relative to the worktree's root.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { parseCobertura } from '../../src/formats/cobertura.ts';
import type { CoverageReport } from '../../src/formats/coverage-report.ts';

const spike = (step: string, file: string): string =>
  readFileSync(
    join(import.meta.dirname, '..', 'fixtures', 'coverage-spike', 'cs', step, file),
    'utf8',
  );

const read = (text: string, root: string): CoverageReport => {
  const parsed = parseCobertura(text, root);
  assert.ok(parsed.readable, parsed.readable ? '' : parsed.reason);
  return parsed.report;
};

const hitsOf = (report: CoverageReport, file: string) =>
  [...(report.get(file) ?? new Map())].map(([line, { hits }]) => [line, hits]);

describe('parseCobertura', () => {
  it("reads Cobertura line hits and condition coverage from the spike's Calc report", () => {
    // The green step: the OverflowException guard (lines 20 and 21) is what no test runs.
    const report = read(spike('2-green', 'Calc.Tests.cobertura.xml'), 'c:\\spike\\cs');
    assert.deepEqual([...report.keys()], ['src/Calc/Calculator.cs', 'src/Calc/Legacy.cs']);
    assert.deepEqual(hitsOf(report, 'src/Calc/Calculator.cs'), [
      [6, 3],
      [7, 3],
      [8, 3],
      [11, 3],
      [12, 4],
      [13, 3],
      [14, 1],
      [15, 3],
      [18, 2],
      [19, 2],
      [20, 0],
      [21, 0],
      [23, 2],
      [24, 2],
    ]);
    const calculator = report.get('src/Calc/Calculator.cs');
    assert.deepEqual(calculator?.get(19), { hits: 2, branches: { taken: 2, total: 4 } });
    assert.deepEqual(calculator?.get(12), { hits: 4, branches: { taken: 2, total: 2 } });
    assert.deepEqual(calculator?.get(20), { hits: 0 });
    assert.deepEqual(hitsOf(report, 'src/Calc/Legacy.cs'), [
      [7, 0],
      [8, 0],
      [9, 0],
      [10, 0],
    ]);
  });

  it('merges a Cobertura file split over several classes by the most hits per line', () => {
    // A partial class, a nested class and a compiler-made one, each with some of the file's lines.
    const report = read(
      `<?xml version="1.0"?>
<coverage><sources><source>/repo/src/</source></sources><packages><package name="p"><classes>
  <class name="A" filename="A.cs"><lines>
    <line number="9" hits="0" branch="False" />
    <line number="3" hits="2" branch="True" condition-coverage="50% (1/2)" />
  </lines></class>
  <class name="B" filename="B.cs"><lines><line number="1" hits="1" /></lines></class>
  <class name="A/&lt;Nested&gt;d__1" filename="A.cs"><methods><method name="M"><lines>
    <line number="3" hits="1" branch="True" condition-coverage="100% (2/2)" />
    <line number="9" hits="4" />
  </lines></method></methods><lines>
    <line number="3" hits="1" branch="True" condition-coverage="100% (2/2)" />
    <line number="9" hits="4" />
    <line number="5" hits="0" />
  </lines></class>
</classes></package></packages></coverage>`,
      '/repo',
    );
    assert.deepEqual(
      [...(report.get('src/A.cs') ?? [])],
      [
        [9, { hits: 4 }],
        [3, { hits: 2, branches: { taken: 2, total: 2 } }],
        [5, { hits: 0 }],
      ],
    );
    assert.deepEqual(hitsOf(report, 'src/B.cs'), [[1, 1]]);
  });

  it('matches a Cobertura path by the end of source plus filename when there are two sources', () => {
    // With IncludeTestAssembly, coverlet adds `C:\` as a second source for the test SDK's file.
    const report = read(
      spike('1b-red-skipped', 'Calc.Tests.with-tests.cobertura.xml'),
      'C:\\spike\\cs',
    );
    const files = [...report.keys()];
    assert.ok(files.includes('src/Calc/Calculator.cs'), files.join(', '));
    assert.ok(files.includes('test/Calc.Tests/CalculatorTests.cs'), files.join(', '));
    assert.equal(
      files.some((file) => file.startsWith('spike/') || file.includes('\\')),
      false,
    );
    // Two sources, one of them inside the root: the filename lands under the one that holds it.
    const second = read(
      `<coverage><sources><source>/elsewhere/</source><source>/repo/</source></sources>
<packages><package><classes><class filename="lib/a.ts"><lines><line number="1" hits="1"/></lines></class></classes></package></packages></coverage>`,
      '/repo',
    );
    assert.deepEqual([...second.keys()], ['lib/a.ts']);
  });

  it('refuses text that is not a Cobertura report', () => {
    const refuses = (text: string, reason: RegExp) => {
      const parsed = parseCobertura(text, '/repo');
      assert.equal(parsed.readable, false);
      assert.match(parsed.readable ? '' : parsed.reason, reason);
    };
    refuses('Build FAILED.', /not XML/);
    refuses('<testsuites><testcase name="a"/></testsuites>', /root element <testsuites>/);
    refuses(
      '<coverage><packages><package><classes><class filename="a.cs"><lines><line number="x" hits="1"/></lines></class></classes></package></packages></coverage>',
      /line number="x"/,
    );
  });
});
