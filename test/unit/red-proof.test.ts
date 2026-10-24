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

  it("does not take an old test for a new one when a sentence name ends in a dotted word the step's lines hold", () => {
    const settings = [
      {
        newPath: 'test/unit/attempt-settings.test.ts',
        added: [
          "  it('writes no attribution', () => {",
          "    const noAttribution = { commit: '', pr: '', sessionUrl: false };",
          '  });',
        ],
        removed: [],
      },
    ];
    const report = tap(
      'ok 1 - grants git status, add and commit in Bash to a brewer with git.commit',
      ...failing(2, 'writes no attribution', 'not implemented'),
    );
    // "commit" is the last part after a dot of a sentence, not of a class or module.
    assert.deepEqual(judgeRed(report, settings), {
      proven: true,
      tests: ['writes no attribution'],
    });
  });

  it('finds a sentence test after suite titles that hold spaces, and after a class', () => {
    const suites = [
      {
        newPath: 'test/calculator.test.ts',
        // The suite was there before: its title alone is no declaration of these tests.
        added: [
          "  it('adds two numbers', () => {",
          "  it('subtracts', () => {",
          "  it('adds a negative number', () => {",
        ],
        removed: [],
      },
    ];
    const names = [
      'the calculator > adds two numbers',
      'the calculator > AddTest.subtracts',
      'AddTest.adds a negative number',
    ];
    const report = tap(...names.flatMap((name, n) => failing(n + 1, name, 'not implemented')));
    // A suite title before " > " may hold spaces; only a class or module before a dot may not.
    assert.deepEqual(judgeRed(report, suites), { proven: true, tests: names });
  });

  it('finds a sentence that ends in a dotted word after a suite title, as its part after the title', () => {
    const name = 'the brewer settings > grants commit to a brewer with git.commit';
    const settings = [
      {
        newPath: 'test/settings.test.ts',
        added: ["  it('grants commit to a brewer with git.commit', () => {"],
        removed: [],
      },
    ];
    // Neither the whole name nor a last part after a dot stands in the line: only the title's.
    const report = tap(...failing(1, name, 'not implemented'));
    assert.deepEqual(judgeRed(report, settings), { proven: true, tests: [name] });
  });

  it("does not take a test's name for a load error: node names each test in a comment", () => {
    const report = tap(
      '# Subtest: throws a SyntaxError on bad JSON',
      'ok 1 - throws a SyntaxError on bad JSON',
      '# Subtest: adds two numbers',
      ...failing(2, 'adds two numbers', 'not implemented'),
      '# Subtest: adds a negative number',
      ...failing(3, 'adds a negative number', 'not implemented'),
    );
    assert.deepEqual(judgeRed(report, gauged), {
      proven: true,
      tests: ['adds two numbers', 'adds a negative number'],
    });
  });

  it('finds a name at the end of a line the step added with CRLF line endings', () => {
    const feature = [
      { newPath: 'features/add.feature', added: ['  Scenario: adds two numbers\r'], removed: [] },
    ];
    const report = tap(...failing(1, 'adds two numbers', 'not implemented'));
    assert.deepEqual(judgeRed(report, feature), { proven: true, tests: ['adds two numbers'] });
  });

  it("takes a name's last part only when it has at least three characters", () => {
    const java = [
      {
        newPath: 'src/test/java/AddTest.java',
        added: ['  void addsTwoNumbers() {', '    ok(add(1, 2));'],
        removed: [],
      },
    ];
    const report = junit(`<testsuite>
      <testcase classname="AddTest" name="AddTest.addsTwoNumbers"><failure/></testcase>
      <testcase classname="AddTest" name="AddTest.ok"/>
    </testsuite>`);
    assert.deepEqual(judgeRed(report, java), {
      proven: true,
      tests: ['AddTest.addsTwoNumbers'],
    });
  });

  it('does not take a call or an assertion in a line the step added for a declaration', () => {
    const java = [
      {
        newPath: 'src/test/java/AddTest.java',
        added: [
          '  @Test',
          '  void addNegative() {',
          '    assertEquals(-3, calc.add(-1, -2));',
          '    assert.equal(add(1, -2), -1);',
          '    const sum = calc.add(1, 2);',
        ],
        removed: [],
      },
    ];
    // "add" is an older test that passes: the step only calls the function it is named after.
    const report = junit(`<testsuite>
      <testcase classname="AddTest" name="add"/>
      <testcase classname="AddTest" name="addNegative"><failure message="not implemented"/></testcase>
    </testsuite>`);
    assert.deepEqual(judgeRed(report, java), { proven: true, tests: ['addNegative'] });
  });

  it('does not take a name longer than 1,000 characters for one the step added', () => {
    const name = `adds ${'very '.repeat(250)}numbers`;
    const long = [
      { newPath: 'test/add.test.mjs', added: [`test('${name}', () => {`], removed: [] },
    ];
    assert.equal(
      why(tap(...failing(1, name, 'not implemented')), long),
      'none of the 1 tests in the report is one the step added',
    );
  });

  it('never takes an unnamed test, or a name that is only part of a word, for one the step added', () => {
    const report = tap('ok 1', 'ok 2 - adds two', ...failing(3, 'adds two numbers', 'x'));
    assert.deepEqual(judgeRed(report, gauged), { proven: true, tests: ['adds two numbers'] });
  });

  it('does not take a word in an object literal or an argument list for a declaration (#466)', () => {
    const streamed = (...lines: string[]): DiffFile[] => [
      {
        newPath: 'test/unit/stream.test.ts',
        added: [
          "  it('reads a result line', () => {",
          '    const line = {',
          '      parent_tool_use_id: null,',
          '    };',
          "    done({ exitCode: null, stdout: '' });",
          '      exitCode: null',
          '  Given: null,',
          `    const quoted = ['null", "null'];`,
          ...lines,
        ],
        removed: [],
      },
    ];
    // "null" is an older table case that passes; the step only writes the word in code.
    const report = tap(
      'ok 1 - malformed input > null',
      ...failing(2, 'reads a result line', 'not implemented'),
    );
    assert.deepEqual(judgeRed(report, streamed()), {
      proven: true,
      tests: ['reads a result line'],
    });
    assert.equal(
      why(report, streamed("  it('null', () => {")),
      'test "malformed input > null" passes before the implementation: a stub must throw, not return a value',
    );
  });

  it('finds a name GoogleTest, Ruby and a generic Rust test write as a bare identifier', () => {
    const bare = [
      { newPath: 'test/calc_test.cc', added: ['TEST(CalcTest, Adds) {'], removed: [] },
      { newPath: 'test/add_test.rb', added: ['  def test_subtracts'], removed: [] },
      { newPath: 'tests/add.rs', added: ['#[test]', 'fn divides<T>() {'], removed: [] },
    ];
    const names = ['CalcTest.Adds', 'AddTest.test_subtracts', 'divides'];
    const report = tap(...names.flatMap((name, n) => failing(n + 1, name, 'not implemented')));
    assert.deepEqual(judgeRed(report, bare), { proven: true, tests: names });
  });

  it('finds a GoogleTest fixture test and the other Gherkin scenario keywords', () => {
    const declared = [
      { newPath: 'test/calc_test.cc', added: ['TEST_F(CalcFixture, Subtracts) {'], removed: [] },
      {
        newPath: 'features/add.feature',
        added: ['  Scenario Outline: adds many numbers', '  Example: adds no numbers'],
        removed: [],
      },
    ];
    const names = ['CalcFixture.Subtracts', 'adds many numbers', 'adds no numbers'];
    const report = tap(...names.flatMap((name, n) => failing(n + 1, name, 'not implemented')));
    assert.deepEqual(judgeRed(report, declared), { proven: true, tests: names });
  });

  it('does not take an older name that a declaration form only begins or a comment holds', () => {
    const nearMisses = [
      {
        newPath: 'test/near.test.ts',
        added: [
          "  it('reads a result line', () => {",
          'fn divides_all<T>() {',
          'TEST(CalcTest, AddsMore) {',
          '  Scenario: adds two numbers',
          '  undef adds',
          '  // Scenario: subtracts',
        ],
        removed: [],
      },
    ];
    // Each is an older passing test whose name only begins a form, or stands after a comment.
    const report = tap(
      'ok 1 - divides',
      'ok 2 - CalcTest.Adds',
      'ok 3 - adds two',
      'ok 4 - adds',
      'ok 5 - subtracts',
      ...failing(6, 'reads a result line', 'not implemented'),
    );
    assert.deepEqual(judgeRed(report, nearMisses), {
      proven: true,
      tests: ['reads a result line'],
    });
  });

  it('does not take a capitalised key in a fixture line for a Gherkin scenario', () => {
    const fixture = [
      {
        newPath: 'test/stream.test.ts',
        added: ["  it('reads a result line', () => {", '  Status: null', '  Scenario: null'],
        removed: [],
      },
    ];
    const report = tap(
      'ok 1 - malformed input > null',
      ...failing(2, 'reads a result line', 'not implemented'),
    );
    // "Scenario: null" names the older test: a feature file's scenario declares it.
    assert.match(why(report, fixture), /^test "malformed input > null" passes/);
    fixture[0]?.added.pop();
    assert.deepEqual(judgeRed(report, fixture), { proven: true, tests: ['reads a result line'] });
  });

  it('finds a name written in double quotes or backticks, as Go, C# and Kotlin declare a test', () => {
    const quoted = [
      {
        newPath: 'add_test.go',
        added: ['  t.Run("adds two numbers", func(t *testing.T) {'],
        removed: [],
      },
      {
        newPath: 'src/test/kotlin/AddTest.kt',
        added: ['  fun `adds a negative number`() {'],
        removed: [],
      },
    ];
    const report = tap(
      ...failing(1, 'adds two numbers', 'not implemented'),
      ...failing(2, 'adds a negative number', 'not implemented'),
    );
    assert.deepEqual(judgeRed(report, quoted), {
      proven: true,
      tests: ['adds two numbers', 'adds a negative number'],
    });
  });
});

describe('judgeRed with regression tests (ADR 0170)', () => {
  // The Gauger's commit with a regression test beside the new ones: it pins what stays as it is.
  const withRegression: DiffFile[] = [
    ...gauged,
    {
      newPath: 'test/add-zero.test.mjs',
      added: ["test('keeps adding zero', () => {", '  assert.equal(add(1, 0), 1);', '});'],
      removed: [],
    },
  ];
  const newTestsFail = [
    ...failing(1, 'adds two numbers', 'not implemented'),
    ...failing(2, 'adds a negative number', 'Expected values to be strictly equal'),
  ];
  const refusedWith = (report: TestReport, regressionTests: readonly string[]): string => {
    const verdict = judgeRed(report, withRegression, regressionTests);
    assert.equal(verdict.proven, false, 'the red proof should fail');
    return verdict.proven ? '' : verdict.why;
  };

  it('proves red when a named regression test passes and every new test fails', () => {
    const report = tap(...newTestsFail, 'ok 3 - keeps adding zero', '1..3');
    assert.deepEqual(judgeRed(report, withRegression, ['keeps adding zero']), {
      proven: true,
      tests: ['adds two numbers', 'adds a negative number'],
    });
  });

  it('refuses a named regression test that fails', () => {
    const report = tap(...newTestsFail, ...failing(3, 'keeps adding zero', 'Expected 1'));
    assert.equal(
      refusedWith(report, ['keeps adding zero']),
      'regression test "keeps adding zero" fails before the implementation: a regression test passes before the change',
    );
  });

  it('refuses a named regression test that is skipped', () => {
    const report = tap(...newTestsFail, 'ok 3 - keeps adding zero # SKIP');
    assert.equal(
      refusedWith(report, ['keeps adding zero']),
      'regression test "keeps adding zero" is skipped, so it proves nothing',
    );
  });

  it('still refuses a new test that passes when it is not named a regression test', () => {
    const report = tap(...newTestsFail, 'ok 3 - keeps adding zero');
    assert.match(
      refusedWith(report, []),
      /^test "keeps adding zero" passes before the implementation/,
    );
  });

  it('refuses a run whose only tests the step added are regression tests', () => {
    const report = tap('ok 1 - keeps adding zero', '1..1');
    assert.equal(
      refusedWith(report, ['keeps adding zero']),
      'none of the 1 tests in the report is one the step added, besides its regression tests',
    );
  });

  it('refuses a named regression test the report does not list', () => {
    const report = tap(...newTestsFail, 'ok 3 - keeps adding zero');
    assert.equal(
      refusedWith(report, ['keeps adding zero', 'keeps adding one']),
      'regression test "keeps adding one" is not a test the step added in the report',
    );
  });

  it('refuses a named regression test that passes but is not one the step added', () => {
    // "subtracts" is an older test: the guard would not keep it, so it is no regression test.
    const report = tap(...newTestsFail, 'ok 3 - subtracts');
    assert.equal(
      refusedWith(report, ['subtracts']),
      'regression test "subtracts" is not a test the step added in the report',
    );
  });
});

describe('judgeRed: a regression test the step declared (ADR 0170)', () => {
  it('refuses a regression name that a line the step added only mentions, not declares', () => {
    // An older passing test, named in a comment the step added: testsUnchanged would not keep it.
    const mentioned: DiffFile[] = [
      ...gauged,
      { newPath: 'test/sub.test.mjs', added: ['// keeps subtracting'], removed: [] },
    ];
    const report = tap(
      ...failing(1, 'adds two numbers', 'not implemented'),
      ...failing(2, 'adds a negative number', 'not implemented'),
      'ok 3 - keeps subtracting',
    );
    const verdict = judgeRed(report, mentioned, ['keeps subtracting']);
    assert.deepEqual(verdict, {
      proven: false,
      why: 'regression test "keeps subtracting" is not a test the step added in the report',
    });
  });
});

describe('judgeRed: how a regression name matches (ADR 0170)', () => {
  const withRegression: DiffFile[] = [
    ...gauged,
    {
      newPath: 'test/add-zero.test.mjs',
      added: [
        '// keeps subtracting, an older test, is only mentioned here',
        "test('keeps adding zero', () => {",
        '  assert.equal(add(1, 0), 1);',
        '});',
      ],
      removed: [],
    },
  ];
  const newTestsFail = [
    ...failing(1, 'adds two numbers', 'not implemented'),
    ...failing(2, 'adds a negative number', 'not implemented'),
  ];

  it('takes the whole name, trimmed, never a part of it', () => {
    const report = tap(...newTestsFail, 'ok 3 - keeps adding zero');
    assert.equal(judgeRed(report, withRegression, [' keeps adding zero ']).proven, true);
    assert.deepEqual(judgeRed(report, withRegression, ['keeps adding']), {
      proven: false,
      why: 'regression test "keeps adding" is not a test the step added in the report',
    });
  });

  it('refuses a name reported twice when one of them fails', () => {
    const report = tap(
      ...newTestsFail,
      'ok 3 - keeps adding zero',
      ...failing(4, 'keeps adding zero', 'Expected 1'),
    );
    const verdict = judgeRed(report, withRegression, ['keeps adding zero']);
    assert.equal(
      verdict.proven ? '' : verdict.why,
      'regression test "keeps adding zero" fails before the implementation: a regression test passes before the change',
    );
  });

  it('refuses a name only a comment in a test file mentions', () => {
    const report = tap(...newTestsFail, 'ok 3 - keeps adding zero', 'ok 4 - keeps subtracting');
    assert.deepEqual(judgeRed(report, withRegression, ['keeps subtracting']), {
      proven: false,
      why: 'regression test "keeps subtracting" is not a test the step added in the report',
    });
  });
});

describe('judgeRed: where a regression test may be declared (ADR 0170)', () => {
  const newTestsFail = [
    ...failing(1, 'adds two numbers', 'not implemented'),
    ...failing(2, 'adds a negative number', 'not implemented'),
  ];
  const refusal = (name: string) => ({
    proven: false,
    why: `regression test "${name}" is not a test the step added in the report`,
  });

  it('refuses a name a line of a file without a test declaration holds', () => {
    // An older passing test, listed in a document the step added.
    const listed: DiffFile[] = [
      ...gauged,
      { newPath: 'docs/regressions.md', added: ['- keeps subtracting'], removed: [] },
    ];
    const report = tap(...newTestsFail, 'ok 3 - keeps subtracting');
    assert.deepEqual(judgeRed(report, listed, ['keeps subtracting']), refusal('keeps subtracting'));
  });

  it('refuses a name only a comment holds, in each comment form, and takes a Rust attribute line', () => {
    for (const comment of [
      '# keeps subtracting',
      ' * keeps subtracting',
      '/* keeps subtracting',
      '-- keeps subtracting',
    ]) {
      const mentioned: DiffFile[] = [
        ...gauged,
        { newPath: 'test/sub.test.mjs', added: ["test('x', () => {});", comment], removed: [] },
      ];
      const report = tap(
        ...newTestsFail,
        'ok 3 - keeps subtracting',
        ...failing(4, 'x', 'not implemented'),
      );
      assert.deepEqual(
        judgeRed(report, mentioned, ['keeps subtracting']),
        refusal('keeps subtracting'),
        comment,
      );
    }
    const rust: DiffFile[] = [
      ...gauged,
      { newPath: 'tests/add.rs', added: ['#[test] fn keeps_adding_zero() {', '}'], removed: [] },
    ];
    const report = tap(...newTestsFail, 'ok 3 - keeps_adding_zero');
    assert.equal(judgeRed(report, rust, ['keeps_adding_zero']).proven, true);
  });

  it('refuses a name a comment after code holds (ADR 0176)', () => {
    const mentioned: DiffFile[] = [
      ...gauged,
      {
        newPath: 'test/sub.test.mjs',
        added: ["test('x', () => {", '  run(); // keeps subtracting', '});'],
        removed: [],
      },
    ];
    const report = tap(
      ...newTestsFail,
      'ok 3 - keeps subtracting',
      ...failing(4, 'x', 'not implemented'),
    );
    assert.deepEqual(
      judgeRed(report, mentioned, ['keeps subtracting']),
      refusal('keeps subtracting'),
    );
  });
});

describe('judgeRed: a name before a parenthesis declares a test only where no call can stand (ADR 0178)', () => {
  // The older passing test `parser > parse` is named after a free function the step calls or declares.
  const withLine = (line: string): DiffFile[] => [
    {
      newPath: 'test/parser.test.ts',
      added: ["  it('reads a result line', () => {", line],
      removed: [],
    },
  ];
  const callIsNoDeclaration = (line: string, older = 'parser > parse') => {
    const report = tap(`ok 1 - ${older}`, ...failing(2, 'reads a result line', 'not implemented'));
    assert.deepEqual(
      judgeRed(report, withLine(line)),
      { proven: true, tests: ['reads a result line'] },
      line,
    );
  };
  const declaresIt = (line: string, name = 'parser > parse') => {
    const report = tap(...failing(1, name, 'not implemented'));
    const diff: DiffFile[] = [{ newPath: 'test/Parser.java', added: [line], removed: [] }];
    assert.deepEqual(judgeRed(report, diff), { proven: true, tests: [name] }, line);
  };

  it('does not take a call in an assignment for a declaration', () => {
    callIsNoDeclaration('    const tree = parse(input);');
  });

  it('does not take a call after return for a declaration', () => {
    callIsNoDeclaration('    return parse(input);');
  });

  it('does not take a call after await for a declaration', () => {
    callIsNoDeclaration('    await parse(input);');
  });

  it('does not take a call in an arrow function for a declaration', () => {
    callIsNoDeclaration('    const run = () => parse(input);');
  });

  it('does not take a call in a lambda for a declaration', () => {
    callIsNoDeclaration('    items.forEach(x -> parse(x));');
  });

  it('does not take a member call through a pointer for a declaration', () => {
    callIsNoDeclaration('    int sum = calc->Add(1, 2);', 'CalcTest.Add');
  });

  it('does not take a call at the start of its line for a declaration', () => {
    callIsNoDeclaration('  parse(input);');
  });

  it('does not take a call after a conditional for a declaration', () => {
    callIsNoDeclaration('    const tree = ok ? parse(input) : null;');
  });

  it('does not take a call after a logical operator for a declaration', () => {
    callIsNoDeclaration('    ok && parse(input);');
  });

  it('does not take a call after a scope operator for a declaration', () => {
    callIsNoDeclaration('    Parser::parse(input);');
  });

  it('does not take a call after a question mark at the start of its line for a declaration', () => {
    callIsNoDeclaration('    ? parse(input)');
  });

  it('does not take a call in an argument list for a declaration', () => {
    callIsNoDeclaration('    show(1, parse(input));');
  });

  it('does not take a call after throw for a declaration', () => {
    callIsNoDeclaration('    throw parse(input);');
  });

  it('does not take a call after else for a declaration', () => {
    callIsNoDeclaration('    } else parse(input);');
  });

  it('does not take a call when every place the name stands in the line is a call', () => {
    callIsNoDeclaration('    const both = [parse(a), parse(b)];');
  });

  it('declares a test after a void return type', () => {
    declaresIt('  void parse() {');
  });

  it('declares a test after an annotation', () => {
    declaresIt('  @Test void parse() {');
  });

  it('declares a test after modifiers and a return type', () => {
    declaresIt('  public async Task Parse() {', 'parser > Parse');
  });

  it('declares a test after a generic return type', () => {
    declaresIt('  List<int> parse() {');
  });

  it('declares a test after a nullable return type', () => {
    declaresIt('  Task? Parse() {', 'parser > Parse');
  });

  it('declares a test after a pointer return type', () => {
    declaresIt('  int *parse() {');
  });

  it('declares a test after a Go receiver', () => {
    declaresIt('func (s *Suite) TestParse(t *testing.T) {', 'TestParse');
  });

  it('declares a test after a word that only ends like a keyword', () => {
    declaresIt('  Domain parse() {');
  });

  it('declares a test when the name stands first as a call and then as a declaration', () => {
    declaresIt('  int x = parse(a); void parse() {');
  });
  it('does not take a call after any pair or character that opens an expression for a declaration', () => {
    for (const line of [
      '    ok || parse(input);',
      '    show(parse(input));',
      '    const run = () => { parse(input); };',
      '    if (!parse(input)) stop();',
      '    const tree = { root: parse(input) };',
      '    total + parse(input);',
      '    total - parse(input);',
      '    total / parse(input);',
      '    total % parse(input);',
      '    flags | parse(input);',
      '    flags ^ parse(input);',
      '    ~parse(input);',
      '    run(); parse(input);',
      '? parse(input)',
    ]) {
      callIsNoDeclaration(line);
    }
  });

  it('does not take a call after any word that takes an expression for a declaration', () => {
    for (const word of [
      'yield',
      'raise',
      'new',
      'typeof',
      'in',
      'of',
      'case',
      'do',
      'then',
      'if',
      'elif',
      'while',
      'unless',
      'until',
      'when',
      'match',
      'with',
      'defer',
      'go',
      'not',
      'and',
      'or',
    ]) {
      callIsNoDeclaration(`    x ${word} parse(input)`);
    }
  });

  it('does not take a call after assert in a one-line test for a declaration', () => {
    callIsNoDeclaration('def test_reads(): assert parse(input)');
  });

  it('declares a test after a reference, a nested generic or a nullable generic return type', () => {
    declaresIt('  Foo& parse() {');
    declaresIt('  Map<String, List<Int>> parse() {');
    declaresIt('  List<int>? Parse() {', 'parser > Parse');
    declaresIt('  Vec2? Parse() {', 'parser > Parse');
  });

  it('declares a test after a capitalised word that is only a keyword in lower case', () => {
    declaresIt('  If parse() {');
  });

  it('declares a test after a word that only ends like a six-letter keyword', () => {
    declaresIt('  Mytypeof parse() {');
  });
});
