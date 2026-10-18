// The red proof's verdict (ADR 0017, ADR 0078): the tests the proven step added must all be in the
// report and fail, on an assertion or an error the code threw, and nothing in the run may be a
// load, compile, import or collection error.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { judgeRed } from '../../src/checks/red-proof.ts';
import { parseJunit } from '../../src/formats/junit.ts';
import { parseTap } from '../../src/formats/tap.ts';
import type { ReadReport, TestReport } from '../../src/formats/test-report.ts';
import type { DiffFile } from '../../src/formats/unified-diff.ts';

const readable = (parsed: ReadReport): TestReport => {
  assert.ok(parsed.readable, parsed.readable ? '' : parsed.reason);
  return parsed.report;
};
const tap = (...lines: string[]) => readable(parseTap(lines.join('\n')));
const junit = (text: string) => readable(parseJunit(text));

// The Gauger's commit: a test file with two tests and a stub that throws.
const gauged: DiffFile[] = [
  {
    newPath: 'test/add.test.mjs',
    added: [
      "import { add } from '../src/add.mjs';",
      "test('adds two numbers', () => {",
      '  assert.equal(add(1, 2), 3);',
      '});',
      "test('adds a negative number', () => {",
      '  assert.equal(add(1, -2), -1);',
      '});',
    ],
    removed: [],
  },
  {
    newPath: 'src/add.mjs',
    added: ["export const add = () => { throw new Error('not implemented'); };"],
    removed: [],
  },
];

const failing = (n: number, name: string, error: string) => [
  `not ok ${n} - ${name}`,
  '  ---',
  `  error: '${error}'`,
  '  ...',
];

const why = (report: TestReport, diff: readonly DiffFile[] = gauged): string => {
  const verdict = judgeRed(report, diff);
  assert.equal(verdict.proven, false, 'the red proof should fail');
  return verdict.proven ? '' : verdict.why;
};

describe('judgeRed', () => {
  it('proves red the tests the step added when each fails on a stub or an assertion', () => {
    const report = tap(
      'TAP version 13',
      ...failing(1, 'adds two numbers', 'not implemented'),
      ...failing(2, 'adds a negative number', 'Expected values to be strictly equal'),
      // Tests the step did not add may pass or fail on an assertion.
      'ok 3 - subtracts',
      ...failing(4, 'divides', 'Expected values to be strictly equal'),
      '1..4',
    );
    assert.deepEqual(judgeRed(report, gauged), {
      proven: true,
      tests: ['adds two numbers', 'adds a negative number'],
    });
  });

  it('refuses a run with a compile error, even when every test the step added fails', () => {
    const report = tap(
      ...failing(1, 'adds two numbers', 'not implemented'),
      ...failing(2, 'adds a negative number', 'not implemented'),
      '# file:///work/app/test/broken.test.mjs:2',
      "# SyntaxError: The requested module './add.mjs' does not provide an export named 'nope'",
      ...failing(3, 'test/broken.test.mjs', 'test failed'),
    );
    assert.equal(
      why(report),
      "the run has a load, compile, import or collection error: SyntaxError: The requested module './add.mjs' does not provide an export named 'nope'",
    );
  });

  it("refuses a load error in a test's own failure, and a compiler's or a collector's", () => {
    const loadErrors = [
      "Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/work/app/src/add.mjs'",
      "src/add.ts(3,1): error TS2304: Cannot find name 'add'.",
      "ImportError: cannot import name 'add' from 'app'",
      "NameError: name 'add' is not defined",
      'AddTests.cs(12,9): error CS0103: The name Add does not exist',
      'error: cannot find symbol',
      'Test suite failed to run',
      'ERROR collecting tests/test_add.py',
      'error: could not compile `app` due to previous error',
    ];
    for (const line of loadErrors) {
      const report = tap(
        ...failing(1, 'adds two numbers', line),
        ...failing(2, 'adds a negative number', 'not implemented'),
      );
      assert.match(why(report), /load, compile, import or collection error/, line);
    }
  });

  it('refuses a JUnit report with a collection error', () => {
    const report = junit(`<testsuite>
      <testcase name="adds two numbers"><error message="not implemented"/></testcase>
      <testcase name="adds a negative number"><failure message="expected -1"/></testcase>
      <testcase classname="" name="tests.test_other"><error message="collection failure"/></testcase>
    </testsuite>`);
    assert.equal(
      why(report),
      'the run has a load, compile, import or collection error: collection failure',
    );
  });

  it('refuses a test the step added that passes: a stub that returns a value', () => {
    const report = tap(
      ...failing(1, 'adds two numbers', 'not implemented'),
      'ok 2 - adds a negative number',
    );
    assert.equal(
      why(report),
      'test "adds a negative number" passes before the implementation: a stub must throw, not return a value',
    );
  });

  it('refuses a test the step added that is skipped', () => {
    const report = tap(
      ...failing(1, 'adds two numbers', 'not implemented'),
      'ok 2 - adds a negative number # SKIP later',
    );
    assert.equal(why(report), 'test "adds a negative number" is skipped, so it proves nothing');
  });

  it('refuses a report with none of the tests the step added', () => {
    const report = tap('ok 1 - subtracts', ...failing(2, 'divides', 'expected 2'));
    assert.equal(why(report), 'none of the 2 tests in the report is one the step added');
    assert.equal(
      why(tap('ok 1 - adds two numbers'), []),
      'none of the 1 tests in the report is one the step added',
    );
  });

  it('refuses a run that bailed out', () => {
    const report = tap(...failing(1, 'adds two numbers', 'not implemented'), 'Bail out! no db');
    assert.equal(why(report), 'the run bailed out: no db');
  });

  it("judges a suite by its tests: a passing test refuses it, the suite's own failure does not", () => {
    const suite = [
      {
        newPath: 'test/calc.test.mjs',
        added: ["describe('calc', () => {", "  it('adds', () => {", "  it('subtracts', () => {"],
        removed: [],
      },
    ];
    const subtests = (second: string) =>
      tap(
        '    not ok 1 - adds',
        second,
        'not ok 1 - calc',
        '  ---',
        "  error: '2 subtests failed'",
        '  ...',
      );
    assert.deepEqual(judgeRed(subtests('    not ok 2 - subtracts'), suite), {
      proven: true,
      tests: ['adds', 'subtracts'],
    });
    assert.equal(
      why(subtests('    ok 2 - subtracts'), suite),
      'test "subtracts" passes before the implementation: a stub must throw, not return a value',
    );
  });

  it("finds a test by its name in the step's lines, as JUnit runners name them", () => {
    const java = [
      {
        newPath: 'src/test/java/AddTest.java',
        added: ['  @Test', '  void addsTwoNumbers() {', '  void adds(int a, int b) {'],
        removed: [],
      },
    ];
    const report = junit(`<testsuite>
      <testcase classname="AddTest" name="addsTwoNumbers()"><failure/></testcase>
      <testcase classname="AddTest" name="adds(int, int)[1]"><error message="not implemented"/></testcase>
      <testcase classname="AddTest" name="com.acme.AddTest.adds"><failure/></testcase>
      <testcase classname="AddTest" name="add"><failure/></testcase>
    </testsuite>`);
    // A name is found only as a whole word: "add" is not in "addsTwoNumbers".
    assert.deepEqual(judgeRed(report, java), {
      proven: true,
      tests: ['addsTwoNumbers()', 'adds(int, int)[1]', 'com.acme.AddTest.adds'],
    });
  });

  it('never takes an unnamed test, or a name that is only part of a word, for one the step added', () => {
    const report = tap('ok 1', 'ok 2 - adds two', ...failing(3, 'adds two numbers', 'x'));
    assert.deepEqual(judgeRed(report, gauged), { proven: true, tests: ['adds two numbers'] });
  });
});
