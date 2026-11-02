// The red proof's load errors (ADR 0017, ADR 0269, ADR 0274): a run that shows a load, compile,
// import or collection error proves nothing red, in the languages and runners a Brewery is likely
// to use, and a failed assertion that only quotes such a text is no load error.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { judgeMapped } from '../../src/checks/red-proof.ts';
import type { EffectiveModule } from '../../src/checks/test-map.ts';
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

const modules: EffectiveModule[] = [
  {
    module: {
      name: 'app',
      code: ['src/**'],
      tests: { paths: ['test/**'] },
      testReport: { format: 'tap', path: 'test.tap' },
      coverage: 'none',
    },
    added: false,
  },
];

// The Gauger's commit: a test file and a stub that throws.
const gauged: DiffFile[] = [
  {
    newPath: 'test/add.test.mjs',
    added: ["test('adds two numbers', () => {", '  assert.equal(add(1, 2), 3);', '});'],
    addedAt: [1, 2, 3],
    removed: [],
  },
  {
    newPath: 'src/add.mjs',
    added: ["export const add = () => { throw new Error('not implemented'); };"],
    addedAt: [1],
    removed: [],
  },
];

const failing = (n: number, name: string, error: string) => [
  `not ok ${n} - ${name}`,
  '  ---',
  `  error: '${error}'`,
  '  ...',
];

const judge = (report: TestReport) =>
  judgeMapped({
    reports: [report],
    unreported: [],
    diff: gauged,
    modules,
    root: '/work/app',
    foldCase: false,
  });

const why = (report: TestReport): string => {
  const verdict = judge(report);
  assert.equal(verdict.proven, false, 'the red proof should fail');
  return verdict.proven ? '' : verdict.why;
};

describe('the red proof refuses a load error (regression tests)', () => {
  it('refuses a run with a compile error, even when every test the step added fails', () => {
    const report = tap(
      ...failing(1, 'adds two numbers', 'not implemented'),
      '# file:///work/app/test/broken.test.mjs:2',
      "# SyntaxError: The requested module './add.mjs' does not provide an export named 'nope'",
      ...failing(2, 'test/broken.test.mjs', 'test failed'),
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
      'ReferenceError: add is not defined',
      "ModuleNotFoundError: No module named 'app'",
      "Error: the module './add.mjs' does not provide an export named 'add'",
      'Interrupted: 2 errors during collection',
      'pytest: collection error in tests/test_add.py',
      'java.lang.NoClassDefFoundError: Add',
      'java.lang.ClassNotFoundException: AddTest',
      'add.c:3: compile error',
      'AddTest.java: compilation failed',
      'error: failed to compile add.c',
      // .NET's assembly and type load failures, as xunit writes them (#679).
      "System.IO.FileLoadException : Could not load file or assembly 'C:\\work\\app\\bin\\Calc.dll'. This file is blocked by an application control policy. (0x800711C7)",
      "System.IO.FileLoadException : Could not load file or assembly 'C:\\work\\app\\bin\\Calc.dll'. Dit bestand is geblokkeerd door een beleid voor toepassingsbeheer. (0x800711C7)",
      "System.IO.FileNotFoundException : Could not load file or assembly 'Calc, Version=2.0.0.0, Culture=neutral, PublicKeyToken=null'. The system cannot find the file specified.",
      "System.IO.FileNotFoundException: Could not load file or assembly 'Calc, Version=2.0.0.0, Culture=neutral, PublicKeyToken=null'. The system cannot find the file specified.",
      "System.BadImageFormatException : Bad IL format. The format of the file 'C:\\work\\app\\bin\\Calc.dll' is invalid.",
      "System.TypeLoadException : Could not resolve type 'Calc.Missing' in assembly 'Calc.Tests, Version=1.0.0.0, Culture=neutral, PublicKeyToken=null'.",
    ];
    for (const line of loadErrors) {
      const report = tap(
        ...failing(1, 'adds two numbers', line),
        ...failing(2, 'adds a negative number', 'not implemented'),
      );
      assert.match(why(report), /load, compile, import or collection error/, line);
    }
  });

  it('refuses a .NET load failure by its type when the runtime localizes its message', () => {
    const report = tap(
      ...failing(
        1,
        'adds two numbers',
        "System.IO.FileLoadException : Kan bestand of assembly 'C:\\work\\app\\bin\\Calc.dll' niet laden. (0x800711C7)",
      ),
    );
    assert.match(why(report), /load, compile, import or collection error/);
  });

  it("refuses .NET's own text of a load failure, without xunit's space before the colon", () => {
    const report = tap(
      ...failing(
        1,
        'adds two numbers',
        "System.TypeLoadException: Could not resolve type 'Calc.Missing' in assembly 'Calc.Tests, Version=1.0.0.0, Culture=neutral, PublicKeyToken=null'.",
      ),
    );
    assert.match(why(report), /load, compile, import or collection error/);
  });

  it('refuses a JUnit report with a collection error', () => {
    const report = junit(`<testsuite>
      <testcase name="adds two numbers"><error message="not implemented"/></testcase>
      <testcase classname="" name="tests.test_other"><error message="collection failure"/></testcase>
    </testsuite>`);
    assert.equal(
      why(report),
      'the run has a load, compile, import or collection error: collection failure',
    );
  });
});

describe('the red proof takes no quoted load text for a load error (regression tests)', () => {
  it('proves red a FileNotFoundException of a file, not of an assembly', () => {
    const report = tap(
      ...failing(
        1,
        'adds two numbers',
        "System.IO.FileNotFoundException : Could not find file 'C:\\work\\app\\data.txt'.",
      ),
    );
    assert.deepEqual(judge(report), { proven: true });
  });

  it("proves red an xunit assertion whose expected value quotes .NET's load message", () => {
    // xunit's text when a test expects the message and the stub returns another one.
    const report = junit(`<testsuite>
      <testcase name="adds two numbers"><failure message="Assert.Equal() Failure: Strings differ&#10;           ↓ (pos 0)&#10;Expected: &quot;Could not load file or assembly 'Plugin'&quot;&#10;Actual:   &quot;not implemented&quot;&#10;           ↑ (pos 0)"/></testcase>
    </testsuite>`);
    assert.deepEqual(judge(report), { proven: true });
  });

  it('does not take a .NET test that expects a load failure for one when it fails on an assertion', () => {
    // xunit's text when the stub throws something else: it names the expected type, after typeof.
    const report = junit(`<testsuite>
      <testcase classname="Calc.Tests.LoaderTests" name="throws a TypeLoadException for a missing type"><failure message="Assert.Throws() Failure: Exception type was not an exact match&#10;Expected: typeof(System.TypeLoadException)&#10;Actual:   typeof(System.NotImplementedException)&#10;---- System.NotImplementedException : The method or operation is not implemented."/></testcase>
    </testsuite>`);
    assert.deepEqual(judge(report), { proven: true });
  });

  it("does not take a test's name for a load error: node names each test in a comment", () => {
    const report = tap(
      '# Subtest: throws a SyntaxError on bad JSON',
      'ok 1 - throws a SyntaxError on bad JSON',
      '# Subtest: adds two numbers',
      ...failing(2, 'adds two numbers', 'not implemented'),
    );
    assert.deepEqual(judge(report), { proven: true });
  });
});
