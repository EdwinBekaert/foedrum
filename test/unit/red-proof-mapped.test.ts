// The red proof in a repository with a test map (ADR 0274): no test names. The run did not bail out,
// shows no load error, the step changed a file in a test area, a test fails, where the report says
// in a test file the step changed, and no skip lies in a line the step added.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { judgeMapped, type MappedRun, skipsInAddedLines } from '../../src/checks/red-proof.ts';
import type { EffectiveModule } from '../../src/checks/test-map.ts';
import { parseJunit } from '../../src/formats/junit.ts';
import { parseTap } from '../../src/formats/tap.ts';
import type { ReadReport, TestReport } from '../../src/formats/test-report.ts';
import { type DiffFile, parseDiff } from '../../src/formats/unified-diff.ts';
import type { TestMapModule } from '../../src/schemas/test-map.ts';

const readable = (parsed: ReadReport): TestReport => {
  assert.ok(parsed.readable, parsed.readable ? '' : parsed.reason);
  return parsed.report;
};
const tap = (...lines: string[]) => readable(parseTap(lines.join('\n')));

// The spike's TypeScript sample (test/fixtures/coverage-spike/ts/), whose paths start at C:\spike\ts.
const root = 'C:\\spike\\ts';
const ts: TestMapModule = {
  name: 'ts',
  code: ['src/**'],
  tests: { paths: ['test/**'] },
  testReport: { format: 'tap', path: 'test.tap' },
  coverage: { format: 'lcov', path: 'lcov.info' },
};
const modules: EffectiveModule[] = [{ module: ts, added: false }];

/** A failing test as node 24's TAP writes it: with its location, backslashes doubled. */
const fails = (n: number, name: string, at: string) => [
  `not ok ${n} - ${name}`,
  '  ---',
  `  location: '${`${root}\\${at}`.replaceAll('\\', '\\\\')}'`,
  "  error: 'not implemented'",
  '  ...',
];

const run = (reports: TestReport[], diff: readonly DiffFile[], more: Partial<MappedRun> = {}) =>
  judgeMapped({ reports, unreported: [], diff, modules, root, foldCase: true, ...more });

const why = (reports: TestReport[], diff: readonly DiffFile[], more: Partial<MappedRun> = {}) => {
  const verdict = run(reports, diff, more);
  assert.equal(verdict.proven, false, 'the red proof should fail');
  return verdict.proven ? '' : verdict.why;
};

// The spike's red step: the multiply stub that throws, two multiply tests, a row in the add table,
// and `clamps above`, a regression test that passes.
const spikeRed = parseDiff(
  readFileSync('test/fixtures/coverage-spike/ts/1-red/step.diff', 'utf8').replaceAll('\r\n', '\n'),
);

/** One file the step changed, with the lines it added at the given line numbers. */
const changed = (path: string, at: number[]): DiffFile => ({
  oldPath: path,
  newPath: path,
  added: at.map((line) => `added at ${line}`),
  addedAt: at,
  removed: [],
});

describe('judgeMapped (ADR 0274)', () => {
  it('proves a red step whose two new tests fail and whose regression test passes, naming no test', () => {
    const report = tap(
      'TAP version 13',
      'ok 1 - add 1 2 3',
      'ok 2 - add -1 1 0',
      ...fails(3, 'add 0.1 0.2 0.3', 'test\\calc.test.ts:11:3'),
      'ok 4 - clamps below',
      'ok 5 - keeps inside',
      'ok 6 - clamps above',
      ...fails(7, 'multiplies', 'test\\calc.test.ts:18:1'),
      ...fails(8, 'multiplies by zero', 'test\\calc.test.ts:19:1'),
      '1..8',
    );
    assert.deepEqual(run([report], spikeRed), { proven: true });
  });

  it('proves a red step that only adds a row to an existing table test', () => {
    // node places the row's test at the `test(` call in the loop, a line the base already had.
    const report = tap(
      'ok 1 - add 1 2 3',
      ...fails(2, 'add 0.1 0.2 0.3', 'test\\calc.test.ts:11:3'),
      '1..2',
    );
    assert.deepEqual(run([report], [changed('test/calc.test.ts', [9])]), { proven: true });
  });

  it('proves a red step that only adds tests against existing code', () => {
    const report = tap(...fails(1, 'percent rounds', 'test\\legacy.test.ts:5:1'), '1..1');
    const added: DiffFile = {
      newPath: 'test/legacy.test.ts',
      added: ['a', 'b'],
      addedAt: [5, 6],
      removed: [],
    };
    assert.deepEqual(run([report], [added]), { proven: true });
  });

  it('refuses a red step that changes no file in a test area', () => {
    const report = tap(...fails(1, 'add 1 2 3', 'test\\calc.test.ts:11:3'), '1..1');
    assert.equal(
      why([report], [changed('src/calc.ts', [12])]),
      'the step changed no file in a test area of the test map, nor in a module whose tests are inline',
    );
  });

  it('refuses a red step whose only failing test lies in a file the step did not change', () => {
    const report = tap(
      'ok 1 - multiplies',
      ...fails(2, 'clamps below', 'test\\clamp.test.ts:4:1'),
      '1..2',
    );
    assert.equal(
      why([report], [changed('test/calc.test.ts', [18])]),
      'no failing test lies in a test file the step changed: test "clamps below" fails in test/clamp.test.ts',
    );
  });

  it('refuses a red step that adds a skip the report places in its added lines', () => {
    const report = readable(
      parseJunit(`<testsuites>
  <testcase name="multiplies" file="test/calc.test.ts" line="18"><failure message="not implemented"/></testcase>
  <testcase name="multiplies by zero" file="test/calc.test.ts" line="19"><skipped/></testcase>
</testsuites>`),
    );
    assert.equal(
      why([report], [changed('test/calc.test.ts', [18, 19])]),
      'test "multiplies by zero" is skipped at test/calc.test.ts:19, a line the step added, so it proves nothing',
    );
  });

  it('proves a red step whose file holds a platform skip from the base', () => {
    const report = readable(
      parseJunit(`<testsuites>
  <testcase name="reads a junction" file="test/calc.test.ts" line="4"><skipped message="not on linux"/></testcase>
  <testcase name="multiplies" file="test/calc.test.ts" line="18"><failure message="not implemented"/></testcase>
</testsuites>`),
    );
    assert.deepEqual(run([report], [changed('test/calc.test.ts', [18])]), { proven: true });
  });

  it('refuses a red step whose run shows a load error text', () => {
    const report = tap(
      ...fails(1, 'multiplies', 'test\\calc.test.ts:18:1'),
      "# SyntaxError: The requested module '../src/power.ts' does not provide an export named 'power'",
      '1..1',
    );
    assert.equal(
      why([report], spikeRed),
      "the run has a load, compile, import or collection error: SyntaxError: The requested module '../src/power.ts' does not provide an export named 'power'",
    );
  });

  it('takes a module the base lists that wrote no report for a load error, in the reason it is given', () => {
    const report = tap(...fails(1, 'multiplies', 'test\\calc.test.ts:18:1'), '1..1');
    assert.equal(
      why([report], spikeRed, {
        unreported: ['module "cs" wrote no test report at cs/*/TestResults'],
      }),
      'the run has a load, compile, import or collection error: module "cs" wrote no test report at cs/*/TestResults',
    );
  });

  it("refuses a run that bailed out, in any module's report, before anything else", () => {
    const bailed = tap('not ok 1 - x', 'Bail out! no database');
    const fine = tap(...fails(1, 'multiplies', 'test\\calc.test.ts:18:1'), '1..1');
    assert.equal(
      why([fine, bailed], spikeRed, { unreported: ['module "cs" wrote no test report at x'] }),
      'the run bailed out: no database',
    );
  });

  it('refuses a run in which no test fails', () => {
    const report = tap('ok 1 - multiplies', 'ok 2 - add 1 2 3', '1..2');
    assert.equal(why([report], spikeRed), 'no test fails, so none shows the behaviour missing');
  });

  it("judges a suite by its tests: a suite's own failure is no failing test", () => {
    const report = tap(
      '    ok 1 - multiplies',
      '    1..1',
      ...fails(1, 'calc', 'test\\calc.test.ts:1:1'),
      '1..1',
    );
    assert.equal(why([report], spikeRed), 'no test fails, so none shows the behaviour missing');
  });

  it("takes a failing test without a location as possibly the step's, beside one placed elsewhere", () => {
    const report = tap(
      ...fails(1, 'clamps below', 'test\\clamp.test.ts:4:1'),
      'not ok 2 - multiplies',
      '1..2',
    );
    assert.deepEqual(run([report], [changed('test/calc.test.ts', [18])]), { proven: true });
  });

  it("reads a failing test in another module's report", () => {
    const first = tap('ok 1 - adds', '1..1');
    const second = tap(...fails(1, 'multiplies', 'test\\calc.test.ts:18:1'), '1..1');
    assert.deepEqual(run([first, second], [changed('test/calc.test.ts', [18])]), { proven: true });
  });

  it('takes a file of a module whose tests are inline as a test area, for both checks', () => {
    const engine: TestMapModule = {
      ...ts,
      name: 'engine',
      code: ['engine/src/**'],
      tests: { inline: true },
    };
    const report = tap(...fails(1, 'tests::multiplies', 'engine\\src\\calc.rs:40:5'), '1..1');
    const diff = [changed('engine/src/calc.rs', [40])];
    assert.deepEqual(run([report], diff, { modules: [{ module: engine, added: false }] }), {
      proven: true,
    });
    // The same file in a module whose tests are separate is code.
    const separate: TestMapModule = { ...engine, tests: { paths: ['engine/tests/**'] } };
    assert.equal(
      why([report], diff, { modules: [{ module: separate, added: false }] }),
      'the step changed no file in a test area of the test map, nor in a module whose tests are inline',
    );
  });

  it("reads a module's test area from the map the batch added", () => {
    const report = tap(...fails(1, 'squares', 'tools\\test\\power.test.ts:3:1'), '1..1');
    const tools: TestMapModule = {
      ...ts,
      name: 'tools',
      code: ['tools/src/**'],
      tests: { paths: ['tools/test/**'] },
    };
    assert.deepEqual(
      run([report], [changed('tools/test/power.test.ts', [3])], {
        modules: [...modules, { module: tools, added: true }],
      }),
      { proven: true },
    );
  });

  it("places a test the runner writes under the worktree's real path, such as macOS's /private/tmp", () => {
    const report = tap(
      'not ok 1 - multiplies',
      '  ---',
      "  location: '/private/tmp/work/test/calc.test.ts:18:1'",
      '  ...',
    );
    const diff = [changed('test/calc.test.ts', [18])];
    const linked = { root: '/tmp/work', realRoot: '/private/tmp/work', foldCase: false };
    assert.deepEqual(run([report], diff, linked), { proven: true });
    // Neither root: placed outside the worktree.
    assert.match(
      why([report], diff, { ...linked, realRoot: '/private/var/work' }),
      /^no failing test lies in a test file the step changed/,
    );
  });

  it("places a test whose report names it relative to its module's folder, as pytest does from its rootdir", () => {
    const junitOf = (file: string) =>
      readable(
        parseJunit(
          `<testsuites><testcase name="test_x" file="${file}" line="12"><failure message="boom"/></testcase></testsuites>`,
        ),
      );
    const diff = [changed('api/tests/test_x.py', [12])];
    const api: TestMapModule = {
      ...ts,
      name: 'api',
      code: ['api/src/**'],
      tests: { paths: ['api/tests/**'] },
    };
    const more = { modules: [{ module: api, added: false }] };
    assert.deepEqual(run([junitOf('tests/test_x.py')], diff, more), { proven: true });
    // A relative path that ends no file the step changed, and one that only ends a name, are elsewhere.
    for (const file of ['tests/other_x.py', 'test_x.py/../s/test_x.py', 'sts/test_x.py']) {
      assert.match(
        why([junitOf(file)], diff, more),
        /^no failing test lies in a test file the step changed/,
        file,
      );
    }
  });

  it("finds a skip the report names relative to its module's folder in the lines the step added", () => {
    const report = readable(
      parseJunit(`<testsuites>
  <testcase name="test_x" file="tests/test_x.py" line="12"><failure message="boom"/></testcase>
  <testcase name="test_y" file="tests/test_x.py" line="13"><skipped/></testcase>
</testsuites>`),
    );
    const api: TestMapModule = {
      ...ts,
      name: 'api',
      code: ['api/src/**'],
      tests: { paths: ['api/tests/**'] },
    };
    assert.equal(
      why([report], [changed('api/tests/test_x.py', [12, 13])], {
        modules: [{ module: api, added: false }],
      }),
      'test "test_y" is skipped at api/tests/test_x.py:13, a line the step added, so it proves nothing',
    );
  });

  it('places an absolute path inside the worktree only in that very file, never in one whose path ends with it: regression test', () => {
    const report = tap(...fails(1, 'multiplies', 'test\\calc.test.ts:18:1'), '1..1');
    assert.match(
      why([report], [changed('api/test/calc.test.ts', [18])], {
        modules: [{ module: { ...ts, tests: { paths: ['api/test/**'] } }, added: false }],
      }),
      /^no failing test lies in a test file the step changed/,
    );
  });

  it("compares a report's path with git's in either case only where the file system folds case", () => {
    const report = tap(...fails(1, 'multiplies', 'Test\\Calc.test.ts:18:1'), '1..1');
    const diff = [changed('test/calc.test.ts', [18])];
    assert.deepEqual(run([report], diff), { proven: true });
    assert.equal(
      why([report], diff, { foldCase: false }),
      'no failing test lies in a test file the step changed: test "multiplies" fails in Test/Calc.test.ts',
    );
  });

  it('places a failing test outside the worktree in no file the step changed', () => {
    const report = tap(
      'not ok 1 - multiplies',
      '  ---',
      "  location: 'C:\\\\elsewhere\\\\test\\\\calc.test.ts:18:1'",
      '  ...',
    );
    assert.equal(
      why([report], [changed('test/calc.test.ts', [18])]),
      'no failing test lies in a test file the step changed: test "multiplies" fails in C:/elsewhere/test/calc.test.ts',
    );
  });

  it('places a failing test in a changed file outside every test area in no test file', () => {
    const report = tap(...fails(1, 'multiplies', 'src\\calc.ts:3:1'), '1..1');
    assert.equal(
      why([report], [changed('test/calc.test.ts', [18]), changed('src/calc.ts', [3])]),
      'no failing test lies in a test file the step changed: test "multiplies" fails in src/calc.ts',
    );
  });
});

describe('judgeMapped keeps what the name reading refused (ADR 0274)', () => {
  it("ADR 0269's FileLoadException is still refused", () => {
    // xunit's JUnit report of a run that loads nothing: every test fails, in the files the step changed.
    const report = readable(
      parseJunit(`<testsuites><testsuite name="Calc.Tests">
  <testcase name="Calc.Tests.CalculatorTests.Multiplies" file="test/calc.test.ts" line="18">
    <failure type="System.IO.FileLoadException" message="System.IO.FileLoadException : Could not load file or assembly 'C:\\spike\\cs\\bin\\Calc.dll'. This file is blocked by an application control policy. (0x800711C7)"/>
  </testcase>
</testsuite></testsuites>`),
    );
    assert.match(
      why([report], [changed('test/calc.test.ts', [18])]),
      /^the run has a load, compile, import or collection error: System\.IO\.FileLoadException : Could not load file or assembly/,
    );
  });
});

describe('skipsInAddedLines (ADR 0274)', () => {
  const skipAt = (file: string, line?: number) =>
    readable(
      parseJunit(
        `<testsuites><testcase name="later" file="${file}"${line === undefined ? '' : ` line="${line}"`}><skipped/></testcase></testsuites>`,
      ),
    );
  const added = new Map([['test/calc.test.ts', new Set([18, 19])]]);

  it('names a skip the report places in a line the step added', () => {
    assert.equal(
      skipsInAddedLines([skipAt('test/calc.test.ts', 19)], added, root, true),
      'test "later" is skipped at test/calc.test.ts:19, a line the step added, so it proves nothing',
    );
  });

  it('passes a skip at a line the step did not add, in a file it did not change, or without a line', () => {
    assert.equal(
      skipsInAddedLines([skipAt('test/calc.test.ts', 20)], added, root, true),
      undefined,
    );
    assert.equal(
      skipsInAddedLines([skipAt('test/other.test.ts', 19)], added, root, true),
      undefined,
    );
    assert.equal(skipsInAddedLines([skipAt('test/calc.test.ts')], added, root, true), undefined);
  });

  it("finds a skip's file in either case only where the file system folds case", () => {
    const upper = [skipAt('Test/Calc.test.ts', 18)];
    assert.match(skipsInAddedLines(upper, added, root, true) ?? '', /^test "later" is skipped/);
    assert.equal(skipsInAddedLines(upper, added, root, false), undefined);
  });

  it('finds a skip by its absolute path inside the worktree', () => {
    assert.match(
      skipsInAddedLines([skipAt('C:\\spike\\ts\\test\\calc.test.ts', 18)], added, root, true) ?? '',
      /skipped at test\/calc\.test\.ts:18/,
    );
  });

  it("finds a skip under the worktree's real path in the lines the step added: regression test", () => {
    const report = readable(
      parseJunit(
        '<testsuites><testcase name="later" file="/private/tmp/work/test/calc.test.ts" line="19"><skipped/></testcase></testsuites>',
      ),
    );
    assert.match(
      skipsInAddedLines([report], added, '/tmp/work', false, '/private/tmp/work') ?? '',
      /^test "later" is skipped at test\/calc\.test\.ts:19/,
    );
    assert.equal(skipsInAddedLines([report], added, '/tmp/work', false), undefined);
  });

  it("passes a skipped suite, whose own result follows its tests', and a skip placed outside the worktree: regression test", () => {
    const suite = tap(
      '    ok 1 - later # SKIP',
      '    1..1',
      'ok 1 - calc # SKIP',
      '  ---',
      `  location: '${`${root}\\test\\calc.test.ts:18:1`.replaceAll('\\', '\\\\')}'`,
      '  ...',
    );
    assert.equal(skipsInAddedLines([suite], added, root, true), undefined);
    const outside = skipAt('C:\\elsewhere\\test\\calc.test.ts', 18);
    assert.equal(skipsInAddedLines([outside], added, root, true), undefined);
  });
});
