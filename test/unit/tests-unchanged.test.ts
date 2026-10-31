// The testsUnchanged guard (ADR 0017, ADR 0078, ADR 0274): in a repository with a test map, an
// attempt may not change or remove a line the proven step added to a separate test file of the map;
// without one, the test declarations and assertions the step committed; helpers, fixtures, imports
// and new tests may change.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { EffectiveModule } from '../../src/checks/test-map.ts';
import { changedTestLines, changedTests } from '../../src/checks/tests-unchanged.ts';
import type { DiffFile } from '../../src/formats/unified-diff.ts';
import type { TestMapModule } from '../../src/schemas/test-map.ts';

const added = (path: string, lines: string[]): DiffFile => ({
  newPath: path,
  added: lines,
  removed: [],
});
const changed = (path: string, removed: string[], lines: string[] = []): DiffFile => ({
  oldPath: path,
  newPath: path,
  added: lines,
  removed,
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

describe('changedTests', () => {
  it('names an assertion the attempt weakened', () => {
    const weakened = changed(test, ['  assert.equal(add(...pair()), 3);'], ['  assert.ok(true);']);
    assert.deepEqual(changedTests(gauged, [weakened]), [
      { path: test, line: 'assert.equal(add(...pair()), 3);' },
    ]);
  });

  it('lets an attempt add a fixture and a test, and change an import, a helper or the stub', () => {
    const changes = [
      added('test/fixtures/numbers.json', ['[1, 2]']),
      changed(
        test,
        ["import { add } from '../src/add.mjs';", 'const pair = () => [1, 2];'],
        [
          "import { add } from '../src/math.mjs';",
          "const pair = () => JSON.parse(readFileSync('test/fixtures/numbers.json'));",
          "test('adds zero', () => {",
          '  assert.equal(add(0, 0), 0);',
          '});',
        ],
      ),
      changed(
        'src/add.mjs',
        ["export const add = () => { throw new Error('not implemented'); };"],
        ['export const add = (a, b) => a + b;'],
      ),
    ];
    assert.deepEqual(changedTests(gauged, changes), []);
  });

  it('lets an attempt change an import, even one that names assert', () => {
    const imported = changed(
      test,
      ["import assert from 'node:assert/strict';"],
      ["import assert from 'node:assert';"],
    );
    assert.deepEqual(changedTests(gauged, [imported]), []);
  });

  it('lets an attempt move or reindent a line of the tests within its file', () => {
    const moved = changed(
      test,
      ["test('adds two numbers', () => {", '  assert.equal(add(...pair()), 3);'],
      [
        "describe('add', () => {",
        "  test('adds two numbers', () => {",
        '    assert.equal(add(...pair()), 3);',
      ],
    );
    assert.deepEqual(changedTests(gauged, [moved]), []);
  });

  it('names every line of the tests in a file the attempt deleted', () => {
    const deleted: DiffFile = {
      oldPath: test,
      added: [],
      removed: gauged[0]?.added ?? [],
    };
    assert.deepEqual(changedTests(gauged, [deleted]), [
      { path: test, line: "test('adds two numbers', () => {" },
      { path: test, line: 'assert.equal(add(...pair()), 3);' },
    ]);
  });

  it('counts a line the tests have twice: removing one of them changes the tests', () => {
    const twice = [
      added(test, [
        "it('adds', () => {",
        '  expect(add(1, 2)).toBe(3);',
        '  expect(add(1, 2)).toBe(3);',
      ]),
    ];
    assert.deepEqual(changedTests(twice, [changed(test, ['  expect(add(1, 2)).toBe(3);'])]), [
      { path: test, line: 'expect(add(1, 2)).toBe(3);' },
    ]);
    assert.deepEqual(
      changedTests(twice, [changed(test, [], ['  expect(add(2, 2)).toBe(4);'])]),
      [],
    );
  });

  it("reads other languages' declarations and assertions", () => {
    const cases: [string, string[], string][] = [
      [
        'tests/test_add.py',
        ['def test_adds():', '    assert add(1, 2) == 3'],
        '    assert add(1, 2) > 0',
      ],
      [
        'add_test.go',
        [
          'func TestAdd(t *testing.T) {',
          '\tif add(1, 2) != 3 {',
          '\t\tt.Errorf("got %d", add(1, 2))',
        ],
        '\t\tt.Log("fine")',
      ],
      [
        'AddTests.cs',
        ['[Fact]', 'public void Adds()', '    Assert.Equal(3, Add(1, 2));'],
        '    Assert.True(true);',
      ],
      [
        'src/lib.rs',
        ['#[test]', 'fn adds() {', '    assert_eq!(add(1, 2), 3);'],
        '    assert!(true);',
      ],
    ];
    for (const [path, lines, weaker] of cases) {
      const last = lines.at(-1) ?? '';
      const found = changedTests([added(path, lines)], [changed(path, [last], [weaker])]);
      assert.deepEqual(found, [{ path, line: last.trim() }], path);
    }
  });

  it('protects a Go subtest the step declared with t.Run in a test it did not add (#661)', () => {
    const path = 'add_test.go';
    const subtest = '	t.Run("adds two numbers", func(t *testing.T) {';
    const found = changedTests(
      [added(path, [subtest])],
      [changed(path, [subtest], ['	t.Run("adds", func(t *testing.T) {'])],
    );
    assert.deepEqual(found, [{ path, line: subtest.trim() }]);
  });

  it('lets an attempt keep a Go subtest the step declared with t.Run as it was', () => {
    const path = 'add_test.go';
    const subtest = '	t.Run("adds two numbers", func(t *testing.T) {';
    const found = changedTests(
      [added(path, [subtest])],
      [changed(path, [subtest], ['		if add(1, 2) != 3 {', subtest])],
    );
    assert.deepEqual(found, []);
  });

  it('protects nothing in a file where the step declared no test', () => {
    const helper = [added('test/helpers.mjs', ['export const check = (x) => assert.ok(x);'])];
    assert.deepEqual(
      changedTests(helper, [
        changed('test/helpers.mjs', ['export const check = (x) => assert.ok(x);']),
      ]),
      [],
    );
  });

  it('has nothing to compare when the step added nothing', () => {
    assert.deepEqual(changedTests([], [changed(test, ['  assert.equal(1, 1);'])]), []);
  });
});

describe('changedTests: regression tests (ADR 0170)', () => {
  it('keeps a regression test the step added as it keeps a new one', () => {
    const regression = 'test/sub.test.mjs';
    const both = [
      ...gauged,
      added(regression, [
        "test('keeps subtracting', () => {",
        '  assert.equal(sub(2, 1), 1);',
        '});',
      ]),
    ];
    const weakened = changed(regression, ['  assert.equal(sub(2, 1), 1);'], ['  assert.ok(sub);']);
    assert.deepEqual(changedTests(both, [weakened]), [
      { path: regression, line: 'assert.equal(sub(2, 1), 1);' },
    ]);
  });
});

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

describe('changedTestLines (ADR 0274)', () => {
  it('refuses a green step that drops a line the red step added to a test file', () => {
    const dropped = changed(test, ['const pair = () => [1, 2];']);
    assert.deepEqual(changedTestLines(gauged, [dropped], modules, false), [
      { path: test, line: 'const pair = () => [1, 2];' },
    ]);
  });

  it('refuses a green step that weakens an assertion the red step added', () => {
    const weakened = changed(test, ['  assert.equal(add(...pair()), 3);'], ['  assert.ok(true);']);
    assert.deepEqual(changedTestLines(gauged, [weakened], modules, false), [
      { path: test, line: 'assert.equal(add(...pair()), 3);' },
    ]);
  });

  it('refuses a green step that edits an import line the red step added', () => {
    const imported = changed(
      test,
      ["import { add } from '../src/add.mjs';"],
      ["import { add } from '../src/math.mjs';"],
    );
    assert.deepEqual(changedTestLines(gauged, [imported], modules, false), [
      { path: test, line: "import { add } from '../src/add.mjs';" },
    ]);
  });

  it('allows a green step that moves a red test within its file', () => {
    const moved = changed(
      test,
      ["test('adds two numbers', () => {", '  assert.equal(add(...pair()), 3);', '});'],
      [
        "describe('add', () => {",
        "  test('adds two numbers', () => {",
        '    assert.equal(add(...pair()), 3);',
        '  });',
        '});',
      ],
    );
    const stub = changed(
      'src/add.mjs',
      ["export const add = () => { throw new Error('not implemented'); };"],
      ['export const add = (a, b) => a + b;'],
    );
    assert.deepEqual(changedTestLines(gauged, [moved, stub], modules, false), []);
  });

  it('does not guard a module whose tests are inline', () => {
    const path = 'engine/src/lib.rs';
    const inline = [added(path, ['#[test]', 'fn adds() {', '    assert_eq!(add(1, 2), 3);'])];
    const weakened = changed(path, ['    assert_eq!(add(1, 2), 3);'], ['    assert!(true);']);
    assert.deepEqual(changedTestLines(inline, [weakened], modules, false), []);
  });

  it('does not guard a file the map places in no test area', () => {
    const path = 'scripts/check.mjs';
    const script = [added(path, ["test('checks', () => {", '  assert.ok(check());'])];
    const weakened = changed(path, ['  assert.ok(check());'], ['  assert.ok(true);']);
    assert.deepEqual(changedTestLines(script, [weakened], modules, false), []);
  });

  it('counts no blank line the red step added', () => {
    const spaced = [added(test, ["test('adds', () => {", '', '  assert.equal(add(1, 2), 3);'])];
    const closed = changed(test, ['   '], []);
    assert.deepEqual(changedTestLines(spaced, [closed], modules, false), []);
  });

  it('reads a test file by the map in either case where the file system folds case', () => {
    const upper = 'Test/Add.test.mjs';
    const red = [added(upper, ['  assert.equal(add(1, 2), 3);'])];
    const weakened = changed(upper, ['  assert.equal(add(1, 2), 3);']);
    assert.deepEqual(changedTestLines(red, [weakened], modules, true), [
      { path: upper, line: 'assert.equal(add(1, 2), 3);' },
    ]);
    assert.deepEqual(changedTestLines(red, [weakened], modules, false), []);
  });
});
