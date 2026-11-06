// The tests a Gauger named against what a run's reports hold (ADR 0342): a name a report holds in
// any of the forms runners write counts as reported, and what a step's record keeps of the rest.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { unreportedNames, unreportedRecord } from '../../src/checks/named-tests.ts';
import type { ReportedTest, TestReport } from '../../src/formats/test-report.ts';

const reported = (name: string, fields: Partial<ReportedTest> = {}): ReportedTest => ({
  name,
  result: 'passed',
  leaf: true,
  detail: '',
  ...fields,
});
const reportOf = (...tests: ReportedTest[]): TestReport => ({ tests, other: '' });
/** Whether `name` reads as unreported against a report of `held`. */
const unreported = (name: string, ...held: string[]): boolean =>
  unreportedNames({ tests: [name], regressionTests: [] }, [
    reportOf(...held.map((each) => reported(each))),
  ])?.includes(name) === true;

describe('unreportedNames (ADR 0342)', () => {
  it('names a test no report holds, and not one a report holds', () => {
    assert.deepEqual(
      unreportedNames({ tests: ['adds', 'subtracts'], regressionTests: [] }, [
        reportOf(reported('adds')),
      ]),
      ['subtracts'],
    );
  });

  it('reads the regression tests too', () => {
    assert.deepEqual(
      unreportedNames({ tests: ['adds'], regressionTests: ['keeps the sign'] }, [
        reportOf(reported('adds')),
      ]),
      ['keeps the sign'],
    );
  });

  it('reads every report of the run', () => {
    assert.deepEqual(
      unreportedNames({ tests: ['adds', 'subtracts'], regressionTests: [] }, [
        reportOf(reported('adds')),
        reportOf(reported('subtracts')),
      ]),
      [],
    );
  });

  it('counts a failing, a skipped and a parent test as reported', () => {
    assert.deepEqual(
      unreportedNames({ tests: ['a', 'b', 'c'], regressionTests: [] }, [
        reportOf(
          reported('a', { result: 'failed' }),
          reported('b', { result: 'skipped' }),
          reported('c', { leaf: false }),
        ),
      ]),
      [],
    );
  });

  it('a name a report holds with a suite before it is reported', () => {
    assert.equal(unreported('adds two', 'math > adds two'), false);
  });

  it('a name with a suite before it that a report holds alone is reported', () => {
    assert.equal(unreported('math > adds two', 'adds two'), false);
  });

  it('a name a report holds after a class or before its case is reported', () => {
    assert.equal(unreported('Adds', 'Acme.Tests.Math.Adds(a: 1, b: 2)'), false);
    assert.equal(unreported('test_adds', 'test_adds[1-2]'), false);
  });

  it('a name with a path before it is reported', () => {
    assert.equal(unreported('tests/test_math.py::test_adds', 'test_adds'), false);
  });

  it('a name differing only in its white space is reported', () => {
    assert.equal(unreported('adds  two\tnumbers', 'adds two  numbers'), false);
  });

  it('a template name reads as unreported: only the report can say how it was filled in', () => {
    assert.equal(unreported('rejects %s', 'rejects 1', 'rejects 2'), true);
  });

  it('a name inside a longer word of the report is not reported', () => {
    assert.equal(unreported('add', 'adder'), true);
    assert.equal(unreported('add', 'ladd'), true);
    assert.equal(unreported('add', 'add_two'), true);
  });

  it('a name beside a digit or a letter outside ASCII is not reported', () => {
    assert.equal(unreported('add', 'add2'), true);
    assert.equal(unreported('add', '2add'), true);
    assert.equal(unreported('add', 'addé'), true);
  });

  it("a report's name that ends a longer word of the named test is not reported", () => {
    assert.equal(unreported('math_adds', 'adds'), true);
  });

  it("a report's name at the start of the named test is not reported", () => {
    assert.equal(unreported('adds through the real tool', 'adds'), true);
  });

  it('finds a name past an occurrence inside a word', () => {
    assert.equal(unreported('add', 'adder and add'), false);
  });

  it('a name in another case is not reported', () => {
    assert.equal(unreported('Adds', 'adds'), true);
  });

  it("a report's blank name holds nothing", () => {
    assert.equal(unreported('math > ', ' '), true);
  });

  it('says nothing past its limit of work: a name that repeats inside a report it shaped', () => {
    const name = 'a'.repeat(1_000);
    const tests = Array.from({ length: 30 }, () => name);
    assert.equal(
      unreportedNames({ tests, regressionTests: [] }, [reportOf(reported('a'.repeat(20_000)))]),
      undefined,
    );
  });

  it('says nothing past its limit of work: a short name tried at every place of a long one', () => {
    assert.equal(
      unreportedNames({ tests: ['a'], regressionTests: [] }, [
        reportOf(reported('a'.repeat(5_000_000))),
      ]),
      undefined,
    );
  });

  it('says nothing past its limit of work: a name that occurs nowhere in long reports', () => {
    const tests = Array.from({ length: 300 }, (_, index) => `missing ${index}`);
    assert.equal(
      unreportedNames({ tests, regressionTests: [] }, [reportOf(reported('b'.repeat(1_000_000)))]),
      undefined,
    );
  });

  it('a blank name is not read', () => {
    assert.deepEqual(unreportedNames({ tests: [' \t'], regressionTests: [] }, []), []);
  });
});

describe('unreportedRecord (ADR 0342)', () => {
  it('keeps ten names and counts the rest', () => {
    const names = Array.from({ length: 12 }, (_, index) => `test ${index}`);
    const { tests, more } = unreportedRecord(names);
    assert.deepEqual(tests, names.slice(0, 10));
    assert.equal(more, 2);
  });

  it('keeps each name on one line', () => {
    assert.deepEqual(unreportedRecord(['adds\n**forged** line here']).tests, [
      'adds **forged** line here',
    ]);
  });

  it('cuts a long name to 200 characters', () => {
    const [name] = unreportedRecord(['x'.repeat(1_000)]).tests;
    assert.equal(name?.length, 200);
    assert.ok(name?.endsWith('…'));
  });

  it('leaves a name that looks like a secret out', () => {
    const token = ['ghp', 'A1b2'.repeat(9)].join('_');
    assert.deepEqual(unreportedRecord([`logs in with ${token}`]).tests, [
      '[left out: a name that looks like a secret]',
    ]);
  });

  it('keeps a name once, and counts each once', () => {
    assert.deepEqual(unreportedRecord(['adds', 'adds', ' adds ']), { tests: ['adds'], more: 0 });
  });

  it('holds no name for none', () => {
    assert.deepEqual(unreportedRecord([]), { tests: [], more: 0 });
  });
});
