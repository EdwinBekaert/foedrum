// The testsUnchanged guard (ADR 0017, ADR 0274): an attempt may not change or remove a line the
// proven step added to a separate test file of the test map; other files and new tests may change.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { EffectiveModule } from '../../src/checks/test-map.ts';
import {
  changedTestLines,
  guardedFiles,
  olderTestFiles,
} from '../../src/checks/tests-unchanged.ts';
import type { DiffFile } from '../../src/formats/unified-diff.ts';
import type { TestMapModule } from '../../src/schemas/test-map.ts';

const added = (path: string, lines: string[]): DiffFile => ({
  newPath: path,
  added: lines,
  removed: [],
});
// What the Gauger committed: a test file and a stub that throws.
const test = 'test/add.test.mjs';
const gauged = [
  added(test, [
    "import assert from 'node:assert/strict';",
    "import { add } from '../src/add.mjs';",
    'const pair = () => [1, 2];',
    "test('adds two numbers', () => {",
    '  assert.equal(add(...pair()), 3);',
    '});',
  ]),
  added('src/add.mjs', ["export const add = () => { throw new Error('not implemented'); };"]),
];

/** A module of the effective map, with separate tests or inline ones. */
const module = (name: string, code: string, tests: TestMapModule['tests']): EffectiveModule => ({
  module: {
    name,
    code: [code],
    tests,
    testReport: { format: 'tap', path: `${name}/report.tap` },
    coverage: 'none',
  },
  added: false,
});
const modules = [
  module('web', 'src/**', { paths: ['test/**'] }),
  module('engine', 'engine/src/**', { inline: true }),
];

/** The red test file as the Gauger committed it. */
const gaugedTest = gauged[0]?.added ?? [];
/** What the attempt left: each file's lines at its tip; a file not named is gone. */
const textOf = (files: Record<string, readonly string[]>) =>
  new Map(Object.entries(files).map(([path, lines]) => [path, `${lines.join('\n')}\n`]));
const tipOf = (
  files: Record<string, readonly string[]>,
  before: Record<string, readonly string[]> = {},
) => ({ files: textOf(files), before: textOf(before) });
const mapped = { foldCase: false };

describe('changedTestLines (ADR 0274)', () => {
  it('refuses a green step that drops a line the red step added to a test file', () => {
    const tip = tipOf({ [test]: gaugedTest.filter((line) => !line.startsWith('const pair')) });
    assert.deepEqual(changedTestLines(gauged, tip, modules, mapped), [
      { path: test, line: 'const pair = () => [1, 2];' },
    ]);
  });

  it('refuses a green step that weakens an assertion the red step added', () => {
    const tip = tipOf({
      [test]: gaugedTest.map((line) =>
        line.replace('assert.equal(add(...pair()), 3)', 'assert.ok(true)'),
      ),
    });
    assert.deepEqual(changedTestLines(gauged, tip, modules, mapped), [
      { path: test, line: 'assert.equal(add(...pair()), 3);' },
    ]);
  });

  it('refuses a green step that edits an import line the red step added', () => {
    const tip = tipOf({
      [test]: gaugedTest.map((line) => line.replace("'../src/add.mjs'", "'../src/math.mjs'")),
    });
    assert.deepEqual(changedTestLines(gauged, tip, modules, mapped), [
      { path: test, line: "import { add } from '../src/add.mjs';" },
    ]);
  });

  it('allows a green step that moves a red test within its file', () => {
    const tip = tipOf({
      [test]: [
        ...gaugedTest.slice(0, 3),
        "describe('add', () => {",
        "  test('adds two numbers', () => {",
        '    assert.equal(add(...pair()), 3);',
        '  });',
        '});',
      ],
    });
    assert.deepEqual(changedTestLines(gauged, tip, modules, mapped), []);
  });

  it('allows a later step that removes its own line equal to a red line', () => {
    // Cellarman added two tests that each end in `});`; the Finer merged them and removed one.
    const tip = tipOf({
      [test]: [
        ...gaugedTest,
        "test('adds zero and one', () => {",
        '  assert.equal(add(0, 1), 1);',
        '});',
      ],
    });
    assert.deepEqual(changedTestLines(gauged, tip, modules, mapped), []);
  });

  it('refuses a green step that removes a red line the file already held before the red step', () => {
    const older = "test('answers', () => assert.equal(res.status, 200));";
    const red = [
      added(test, ["test('creates', () => {", '  assert.equal(res.status, 200);', '});']),
    ];
    // The older test's copy is still there; the red test's is gone.
    const before = { [test]: ['  assert.equal(res.status, 200);', older] };
    const tip = tipOf(
      { [test]: ['  assert.equal(res.status, 200);', older, "test('creates', () => {", '});'] },
      before,
    );
    assert.deepEqual(changedTestLines(red, tip, modules, mapped), [
      { path: test, line: 'assert.equal(res.status, 200);' },
    ]);
  });

  it('counts a line the red step added twice as often as it added it', () => {
    const twice = [added(test, ['  assert.equal(add(1, 2), 3);', '  assert.equal(add(1, 2), 3);'])];
    const tip = tipOf({ [test]: ['  assert.equal(add(1, 2), 3);'] });
    assert.deepEqual(changedTestLines(twice, tip, modules, mapped), [
      { path: test, line: 'assert.equal(add(1, 2), 3);' },
    ]);
  });

  it('names every line of a test file the attempt removed', () => {
    assert.deepEqual(
      changedTestLines(gauged, tipOf({}), modules, mapped).map(({ line }) => line),
      gaugedTest.map((line) => line.trim()),
    );
  });

  it('does not guard a module whose tests are inline', () => {
    const path = 'engine/src/lib.rs';
    const inline = [added(path, ['#[test]', 'fn adds() {', '    assert_eq!(add(1, 2), 3);'])];
    const tip = tipOf({ [path]: ['#[test]', 'fn adds() {', '    assert!(true);'] });
    assert.deepEqual(changedTestLines(inline, tip, modules, mapped), []);
  });

  it('does not guard a file the map places in no test area', () => {
    const path = 'scripts/check.mjs';
    const script = [added(path, ["test('checks', () => {", '  assert.ok(check());'])];
    const tip = tipOf({ [path]: ["test('checks', () => {", '  assert.ok(true);'] });
    assert.deepEqual(changedTestLines(script, tip, modules, mapped), []);
  });

  it('counts no blank line the red step added', () => {
    const spaced = [added(test, ["test('adds', () => {", '', '  assert.equal(add(1, 2), 3);'])];
    const tip = tipOf({ [test]: ["test('adds', () => {", '  assert.equal(add(1, 2), 3);'] });
    assert.deepEqual(changedTestLines(spaced, tip, modules, mapped), []);
  });

  it('reads a test file by the map in either case where the file system folds case', () => {
    const upper = 'Test/Add.test.mjs';
    const red = [added(upper, ['  assert.equal(add(1, 2), 3);'])];
    assert.deepEqual(changedTestLines(red, tipOf({}), modules, { ...mapped, foldCase: true }), [
      { path: upper, line: 'assert.equal(add(1, 2), 3);' },
    ]);
    assert.deepEqual(changedTestLines(red, tipOf({}), modules, mapped), []);
    assert.deepEqual(guardedFiles(red, modules, true), [upper]);
    assert.deepEqual(guardedFiles(red, modules, false), []);
  });
});

describe('olderTestFiles (ADR 0358)', () => {
  const older = 'test/older.test.mjs';
  const changed = (path: string): DiffFile => ({
    oldPath: path,
    newPath: path,
    added: ["  assert.equal(add(1, 2), 'three');"],
    removed: ['  assert.equal(add(1, 2), 3);'],
  });
  const removed = (path: string): DiffFile => ({ oldPath: path, added: [], removed: ['x'] });

  it("refuses a change to a test file the batch's base holds", () => {
    assert.deepEqual(olderTestFiles([changed(older)], new Set([older]), modules, mapped), [older]);
  });

  it('refuses the removal of a test file the base holds', () => {
    assert.deepEqual(olderTestFiles([removed(older)], new Set([older]), modules, mapped), [older]);
  });

  it('lets an attempt add a test file, and change one the base does not hold', () => {
    const attempt = [added('test/new.test.mjs', ['test()']), changed(test)];
    assert.deepEqual(olderTestFiles(attempt, new Set([older]), modules, mapped), []);
  });

  it('lets an attempt change code, files in no test area, and inline tests the base holds', () => {
    const paths = ['src/add.mjs', 'fixtures/a.json', 'engine/src/run.rs'];
    assert.deepEqual(olderTestFiles(paths.map(changed), new Set(paths), modules, mapped), []);
  });

  it('reads a test file by the map in either case where the file system folds case', () => {
    const upper = 'Test/older.test.mjs';
    const atBase = new Set([upper]);
    assert.deepEqual(olderTestFiles([changed(upper)], atBase, modules, { foldCase: true }), [
      upper,
    ]);
    assert.deepEqual(olderTestFiles([changed(upper)], atBase, modules, mapped), []);
  });
});
