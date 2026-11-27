// Which test files reach a mutant's line (#1176, ADR 0303, ADR 0431): read from the V8 ranges each
// test file's process ran in the baseline. Plain data; no process starts (ADR 0021).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type Range, reachOf, type TestCoverage } from '../../src/checks/mutant-reach.ts';

const FILE = 'src/engine/fold.ts';

// `early` runs for every caller, `late` only for some, and lines 3 and 4 are a branch of `early`
// that no caller takes.
const FOLD = [
  'export const early = (x: number): number => {', // 1
  '  if (x > 10) {', // 2
  '    return x * 2;', // 3
  '  }', // 4
  '  return x + 1;', // 5
  '};', // 6
  'export const late = (): number => {', // 7
  '  return 2;', // 8
  '};', // 9
].join('\n');

// The range of `source` from the start of `from` to the end of `to`, run `count` times.
const span = (source: string, from: string, to: string, count: number): Range => {
  const startOffset = source.indexOf(from);
  const endOffset = source.indexOf(to, startOffset) + to.length;
  assert.ok(startOffset >= 0 && endOffset >= to.length, `${from}…${to} in the source`);
  return { startOffset, endOffset, count };
};

const script = (source: string, count: number): Range => ({
  startOffset: 0,
  endOffset: source.length,
  count,
});

// The ranges of fold.ts in a child that called `early` (with x ≤ 10) and maybe `late`.
const foldRanges = (callsLate: boolean): Range[] => [
  script(FOLD, 1),
  span(FOLD, '(x: number)', '1;\n}', 1),
  span(FOLD, '{\n    return', '}', 0),
  span(FOLD, '()', '2;\n}', callsLate ? 1 : 0),
];

const coverageOf = (entries: [test: string, ranges?: Range[]][]): TestCoverage =>
  new Map(
    entries.map(([test, ranges]) => [
      test,
      new Map(ranges === undefined ? [] : [[FILE, ranges] as const]),
    ]),
  );

const sources = new Map([[FILE, FOLD]]);
const BYTE_ORDER_MARK = String.fromCodePoint(0xfeff);

describe('reachOf, the test files that reach a mutated line (ADR 0431)', () => {
  it('lists, per line in the order given, the test files whose process ran it, sorted', () => {
    const reach = reachOf({
      coverage: coverageOf([
        ['test/unit/decide.test.ts', foldRanges(false)],
        ['test/chaos/kills.test.ts', foldRanges(true)],
        ['test/unit/b.test.ts', foldRanges(false)],
      ]),
      sources,
      lines: [
        { file: FILE, line: 8 },
        { file: FILE, line: 5 },
      ],
    });
    assert.deepStrictEqual(reach, {
      kind: 'reached',
      lines: [
        { file: FILE, line: 8, tests: ['test/chaos/kills.test.ts'] },
        {
          file: FILE,
          line: 5,
          tests: ['test/chaos/kills.test.ts', 'test/unit/b.test.ts', 'test/unit/decide.test.ts'],
        },
      ],
    });
  });

  it('reads the last line of a file that ends with no line break', () => {
    const reach = reachOf({
      coverage: coverageOf([['test/unit/a.test.ts', foldRanges(true)]]),
      sources,
      lines: [{ file: FILE, line: 9 }],
    });
    assert.deepStrictEqual(reach, {
      kind: 'reached',
      lines: [{ file: FILE, line: 9, tests: ['test/unit/a.test.ts'] }],
    });
  });

  it('a line no test file ran has no test file, and a test file that never loaded the file reaches nothing', () => {
    const reach = reachOf({
      coverage: coverageOf([
        ['test/unit/a.test.ts', foldRanges(false)],
        ['test/unit/other.test.ts'],
      ]),
      sources,
      lines: [
        { file: FILE, line: 3 },
        { file: FILE, line: 5 },
      ],
    });
    assert.deepStrictEqual(reach, {
      kind: 'reached',
      lines: [
        { file: FILE, line: 3, tests: [] },
        { file: FILE, line: 5, tests: ['test/unit/a.test.ts'] },
      ],
    });
  });

  it('reads a line by its code, not by the indentation of a range that ran', () => {
    // Only `return 2;` lies in the range that never ran; its indentation lies in the script's.
    const ranges = [script(FOLD, 1), span(FOLD, 'return 2;', 'return 2;', 0)];
    const reach = reachOf({
      coverage: coverageOf([['test/unit/a.test.ts', ranges]]),
      sources,
      lines: [{ file: FILE, line: 8 }],
    });
    assert.deepStrictEqual(reach, {
      kind: 'reached',
      lines: [{ file: FILE, line: 8, tests: [] }],
    });
  });

  it('maps the offsets of a file that starts with a byte order mark after the mark', () => {
    // V8 compiles the text after the mark: one character off, the branch's closing brace on line 4
    // would read as the line break after it, which ran.
    const reach = reachOf({
      coverage: coverageOf([['test/unit/a.test.ts', foldRanges(false)]]),
      sources: new Map([[FILE, BYTE_ORDER_MARK + FOLD]]),
      lines: [
        { file: FILE, line: 4 },
        { file: FILE, line: 5 },
      ],
    });
    assert.deepStrictEqual(reach, {
      kind: 'reached',
      lines: [
        { file: FILE, line: 4, tests: [] },
        { file: FILE, line: 5, tests: ['test/unit/a.test.ts'] },
      ],
    });
  });

  it('cannot tell without a coverage record of any test file', () => {
    const reach = reachOf({ coverage: new Map(), sources, lines: [{ file: FILE, line: 5 }] });
    assert.deepStrictEqual(reach, {
      kind: 'whole',
      reason: 'no test file wrote a coverage record',
    });
  });

  it('cannot tell a file whose text it was not given', () => {
    const reach = reachOf({
      coverage: coverageOf([['test/unit/a.test.ts', foldRanges(false)]]),
      sources: new Map(),
      lines: [{ file: FILE, line: 5 }],
    });
    assert.equal(reach.kind, 'whole');
    assert.match(reach.kind === 'whole' ? reach.reason : '', /src\/engine\/fold\.ts/);
  });

  it('cannot tell a line past the end of its file', () => {
    const reach = reachOf({
      coverage: coverageOf([['test/unit/a.test.ts', foldRanges(false)]]),
      sources,
      lines: [{ file: FILE, line: 10 }],
    });
    assert.equal(reach.kind, 'whole');
  });
});

// A name as the reason quotes it: as JSON, with a line separator escaped too.
const quoted = (text: string): string =>
  JSON.stringify(text).replaceAll(String.fromCodePoint(0x2028), '\\u2028');

describe('reachOf, a test file name a command line cannot carry (ADR 0431)', () => {
  for (const name of [
    'test/unit/a b.test.ts',
    'test/unit/a\nb.test.ts',
    `test/unit/a${String.fromCodePoint(0x2028)}b.test.ts`,
    'test/unit/a;b.test.ts',
    'test/unit/$(x).test.ts',
  ]) {
    it(`the mutants run the whole check for ${quoted(name)}`, () => {
      const reach = reachOf({
        coverage: coverageOf([
          [name, foldRanges(false)],
          ['test/unit/decide.test.ts', foldRanges(false)],
        ]),
        sources,
        lines: [{ file: FILE, line: 5 }],
      });
      assert.deepStrictEqual(reach, {
        kind: 'whole',
        reason: `the test file name ${quoted(name)} cannot be listed on one line`,
      });
    });
  }

  it('a name of letters, digits and . _ / @ + - is listed', () => {
    const name = 'test/unit/a_b-c+d@1.test.ts';
    const reach = reachOf({
      coverage: coverageOf([[name, foldRanges(false)]]),
      sources,
      lines: [{ file: FILE, line: 5 }],
    });
    assert.deepStrictEqual(reach, {
      kind: 'reached',
      lines: [{ file: FILE, line: 5, tests: [name] }],
    });
  });
});
