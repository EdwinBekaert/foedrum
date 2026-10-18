// TAP as the red proof reads it (ADR 0078): each test point with its result, whether it has
// subtests, its diagnostic block, and the text outside any test.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseTap } from '../../src/formats/tap.ts';
import type { ReportedTest, TestReport } from '../../src/formats/test-report.ts';

const read = (text: string): TestReport => {
  const parsed = parseTap(text);
  assert.ok(parsed.readable, parsed.readable ? '' : parsed.reason);
  return parsed.report;
};
const brief = (tests: readonly ReportedTest[]) =>
  tests.map(({ name, result, leaf }) => [name, result, leaf]);

// What node --test --test-reporter=tap wrote for a stub that throws, a failed assertion in a
// suite, and a test file that does not load: node puts its stderr in comments above the test.
const nodeTap = `TAP version 13
# Subtest: adds two numbers
not ok 1 - adds two numbers
  ---
  duration_ms: 2.8834
  type: 'test'
  location: '/work/app/add.test.mjs:4:1'
  failureType: 'testCodeFailure'
  error: 'not implemented'
  code: 'ERR_TEST_FAILURE'
  ...
# Subtest: subtract
    # Subtest: fails on assertion
    not ok 1 - fails on assertion
      ---
      duration_ms: 3.0512
      type: 'test'
      failureType: 'testCodeFailure'
      error: |-
        Expected values to be strictly equal:

        1 !== 2
      code: 'ERR_ASSERTION'
      name: 'AssertionError'
      ...
    1..1
not ok 2 - subtract
  ---
  type: 'suite'
  failureType: 'subtestsFailed'
  error: '1 subtest failed'
  ...
# file:///work/app/broken.test.mjs:2
# import { nope } from './add.mjs';
# SyntaxError: The requested module './add.mjs' does not provide an export named 'nope'
# Subtest: broken.test.mjs
not ok 3 - broken.test.mjs
  ---
  failureType: 'testCodeFailure'
  exitCode: 1
  error: 'test failed'
  ...
1..3
# tests 3
# fail 3
`;

describe('parseTap', () => {
  it("reads node's test points, their subtests and diagnostics, and the comments", () => {
    const report = read(nodeTap);
    assert.deepEqual(brief(report.tests), [
      ['adds two numbers', 'failed', true],
      ['fails on assertion', 'failed', true],
      ['subtract', 'failed', false],
      ['broken.test.mjs', 'failed', true],
    ]);
    assert.match(report.tests[0]?.detail ?? '', /error: 'not implemented'/);
    assert.match(report.tests[1]?.detail ?? '', /1 !== 2/);
    assert.doesNotMatch(report.tests[0]?.detail ?? '', /SyntaxError/);
    assert.match(report.other, /SyntaxError: The requested module/);
    assert.equal(report.bailedOut, undefined);
  });

  it('reads passes, skips and todos, with or without a number and a dash', () => {
    const report = read(
      [
        '1..6',
        'ok 1 - passes',
        'ok',
        'not ok - fails',
        'ok 4 skipped here # SKIP no database',
        'not ok 5 - not yet # TODO later',
        'ok 6 - lowercase # skip',
      ].join('\n'),
    );
    assert.deepEqual(brief(report.tests), [
      ['passes', 'passed', true],
      ['', 'passed', true],
      ['fails', 'failed', true],
      ['skipped here', 'skipped', true],
      ['not yet', 'skipped', true],
      ['lowercase', 'skipped', true],
    ]);
  });

  it('keeps an escaped # in a description, and unescapes it', () => {
    const report = read('ok 1 - issue \\#12 is fixed\nok 2 - a back\\\\slash # SKIP\n');
    assert.deepEqual(brief(report.tests), [
      ['issue #12 is fixed', 'passed', true],
      ['a back\\slash', 'skipped', true],
    ]);
  });

  it('reads a bail out', () => {
    const report = read('TAP version 14\nnot ok 1 - first\nBail out! The database is gone\n');
    assert.equal(report.bailedOut, 'The database is gone');
  });

  it('reads a TAP 14 subtest whose parent passed, and a parent with no subtests', () => {
    const report = read(
      [
        'TAP version 14',
        '# Subtest: outer',
        '    ok 1 - inner one',
        '    ok 2 - inner two',
        '    1..2',
        'ok 1 - outer',
        'ok 2 - alone',
        '1..2',
      ].join('\n'),
    );
    assert.deepEqual(brief(report.tests), [
      ['inner one', 'passed', true],
      ['inner two', 'passed', true],
      ['outer', 'passed', false],
      ['alone', 'passed', true],
    ]);
  });

  it('tolerates CRLF line endings, a BOM and lines that are not TAP', () => {
    const report = read('﻿TAP version 13\r\n> app@1.0.0 test\r\nnot ok 1 - fails\r\n1..1\r\n');
    assert.deepEqual(brief(report.tests), [['fails', 'failed', true]]);
    assert.match(report.other, /> app@1\.0\.0 test/);
    assert.doesNotMatch(report.other, /\r/);
  });

  it('ends a line at a carriage return alone', () => {
    const report = read('ok 1 - first\rok 2 - second\n1..2\n');
    assert.deepEqual(brief(report.tests), [
      ['first', 'passed', true],
      ['second', 'passed', true],
    ]);
  });

  it('ends a diagnostic block that never closes at a line shallower than its start', () => {
    const report = read(
      [
        'not ok 1 - first',
        '  ---',
        "  error: 'boom'",
        '',
        '    more',
        'ok 2 - second',
        'Bail out! gone',
      ].join('\n'),
    );
    assert.deepEqual(brief(report.tests), [
      ['first', 'failed', true],
      ['second', 'passed', true],
    ]);
    assert.match(report.tests[0]?.detail ?? '', /more/);
    assert.equal(report.bailedOut, 'gone');
  });

  it('refuses text with no test point', () => {
    assert.deepEqual(parseTap('Error: Cannot find module\n'), {
      readable: false,
      reason: 'it has no TAP test point',
    });
    assert.deepEqual(parseTap('TAP version 13\n1..0\n'), {
      readable: false,
      reason: 'it has no TAP test point',
    });
  });
});
