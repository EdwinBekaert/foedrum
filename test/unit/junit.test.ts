// JUnit XML as the red proof reads it (ADR 0078): each testcase with its result and what its
// failure, error or skip said, and the suites' system output.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseJunit } from '../../src/formats/junit.ts';
import type { ReportedTest, TestReport } from '../../src/formats/test-report.ts';

const read = (text: string): TestReport => {
  const parsed = parseJunit(text);
  assert.ok(parsed.readable, parsed.readable ? '' : parsed.reason);
  return parsed.report;
};
const brief = (tests: readonly ReportedTest[]) =>
  tests.map(({ name, result, leaf }) => [name, result, leaf]);

// Written by hand in the shape pytest gives: a failed assertion, an error thrown by a stub, a
// skip, a pass, and a collection error of a module that does not import.
const pytest = `<?xml version="1.0" encoding="utf-8"?>
<testsuites>
  <testsuite name="pytest" errors="2" failures="1" skipped="1" tests="5">
    <testcase classname="tests.test_add" name="test_adds" time="0.001">
      <failure message="assert 0 == 3">def test_adds():
&gt;       assert add(1, 2) == 3
E       assert 0 == 3</failure>
    </testcase>
    <testcase classname="tests.test_add" name="test_subtracts" time="0.001">
      <error message="NotImplementedError: not implemented" type="NotImplementedError"><![CDATA[raise NotImplementedError("not implemented") <in a stub>]]></error>
    </testcase>
    <testcase classname="tests.test_add" name='test_later'><skipped message="later" /></testcase>
    <testcase classname="tests.test_add" name="test_old"/>
    <testcase classname="" name="tests.test_broken">
      <error message="collection failure">ImportError: cannot import name 'nope'</error>
    </testcase>
    <system-err>warning: &#x27;slow&#x27; &amp; &#39;old&#39;</system-err>
  </testsuite>
</testsuites>
`;

describe('parseJunit', () => {
  it("reads pytest's testcases with their failures, errors and skips, and the system output", () => {
    const report = read(pytest);
    assert.deepEqual(brief(report.tests), [
      ['test_adds', 'failed', true],
      ['test_subtracts', 'failed', true],
      ['test_later', 'skipped', true],
      ['test_old', 'passed', true],
      ['tests.test_broken', 'failed', true],
    ]);
    assert.match(report.tests[0]?.detail ?? '', /assert 0 == 3/);
    assert.match(report.tests[0]?.detail ?? '', />\s+assert add\(1, 2\) == 3/);
    assert.match(report.tests[1]?.detail ?? '', /NotImplementedError/);
    assert.match(report.tests[1]?.detail ?? '', /<in a stub>/);
    assert.match(report.tests[4]?.detail ?? '', /collection failure/);
    assert.equal(report.other.trim(), "warning: 'slow' & 'old'");
  });

  it('reads a testsuite root, nested suites, comments and a testcase without a name', () => {
    const report = read(`<!-- surefire -->
<testsuite name="AddTest">
  <testsuite name="Nested">
    <testcase classname="AddTest" name="addsTwoNumbers()"><failure type="org.opentest4j.AssertionFailedError"/></testcase>
  </testsuite>
  <testcase classname="AddTest"></testcase>
  <system-out><![CDATA[started]]></system-out>
</testsuite>`);
    assert.deepEqual(brief(report.tests), [
      ['addsTwoNumbers()', 'failed', true],
      ['', 'passed', true],
    ]);
    assert.match(report.tests[0]?.detail ?? '', /AssertionFailedError/);
    assert.equal(report.other.trim(), 'started');
  });

  it('tolerates a BOM and CRLF line endings', () => {
    const report = read(
      '﻿<testsuites>\r\n<testsuite><testcase name="a"/></testsuite>\r\n</testsuites>',
    );
    assert.deepEqual(brief(report.tests), [['a', 'passed', true]]);
  });

  it("keeps a testcase's own system output in its detail, and reads a plain DOCTYPE", () => {
    const report = read(`<!DOCTYPE testsuites>
<testsuites><testcase name="adds"><failure message="boom"/><system-err>ImportError: no add</system-err></testcase></testsuites>`);
    assert.match(report.tests[0]?.detail ?? '', /ImportError: no add/);
    assert.equal(report.other, '');
  });

  it('refuses a DOCTYPE with an internal subset, which could define entities', () => {
    const parsed = parseJunit(
      '<!DOCTYPE x [<!ENTITY a "b">]><testsuites><testcase name="&a;"/></testsuites>',
    );
    assert.equal(parsed.readable, false);
    assert.match(parsed.readable ? '' : parsed.reason, /DOCTYPE/);
  });

  it('refuses what is not a JUnit report', () => {
    const refuses = (text: string, reason: RegExp) => {
      const parsed = parseJunit(text);
      assert.equal(parsed.readable, false);
      assert.match(parsed.readable ? '' : parsed.reason, reason);
    };
    refuses('Error: Cannot find module', /not XML/);
    refuses('<results><test name="a"/></results>', /root element <results>/);
    refuses('<testsuites><testsuite><testcase name="a"></testsuite></testsuites>', /not XML/);
    refuses('<testsuites></testsuites>', /no testcase/);
    refuses('<testsuites><testcase name="a &bogus;"/></testsuites>', /not XML/);
  });
});
