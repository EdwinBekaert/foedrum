import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { coveringTests, type Range, runsLine } from '../../scripts/mutant-coverage/core.ts';

// fold.ts: `early` runs for every caller, `late` only for some, and lines 3 and 4 are a branch of
// `early` that no caller takes.
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

const records = (entries: [test: string, ranges: Range[]][]): Map<string, Map<string, Range[]>> =>
  new Map(entries.map(([test, ranges]) => [test, new Map([['src/engine/fold.ts', ranges]])]));

const sources = new Map([['src/engine/fold.ts', FOLD]]);

describe('the test files that cover a mutated line', () => {
  it('a mutant in a widely imported file runs only the test files that cover its line', () => {
    const tests = ['test/unit/decide.test.ts', 'test/chaos/kills.test.ts', 'test/unit/b.test.ts'];
    const plan = coveringTests({
      tests,
      records: records([
        ['test/unit/decide.test.ts', foldRanges(false)],
        ['test/chaos/kills.test.ts', foldRanges(true)],
        ['test/unit/b.test.ts', foldRanges(false)],
      ]),
      sources,
      locations: [
        { file: 'src/engine/fold.ts', line: 8 },
        { file: 'src/engine/fold.ts', line: 5 },
      ],
    });
    assert.deepEqual(plan, {
      kind: 'covered',
      locations: [
        { file: 'src/engine/fold.ts', line: 8, tests: ['test/chaos/kills.test.ts'] },
        {
          file: 'src/engine/fold.ts',
          line: 5,
          tests: ['test/chaos/kills.test.ts', 'test/unit/b.test.ts', 'test/unit/decide.test.ts'],
        },
      ],
    });
  });

  it("the file's own test file runs even when its coverage misses the line", () => {
    const plan = coveringTests({
      tests: ['test/unit/decide.test.ts', 'test/unit/fold.test.ts'],
      records: records([
        ['test/unit/fold.test.ts', foldRanges(false)],
        ['test/unit/decide.test.ts', foldRanges(false)],
      ]),
      sources,
      locations: [{ file: 'src/engine/fold.ts', line: 3 }],
    });
    assert.deepEqual(plan, {
      kind: 'covered',
      locations: [{ file: 'src/engine/fold.ts', line: 3, tests: ['test/unit/fold.test.ts'] }],
    });
  });

  it('a test file with no coverage record is run as covering every line', () => {
    const plan = coveringTests({
      tests: ['test/unit/crashed.test.ts', 'test/unit/decide.test.ts'],
      records: records([['test/unit/decide.test.ts', foldRanges(false)]]),
      sources,
      locations: [{ file: 'src/engine/fold.ts', line: 3 }],
    });
    assert.deepEqual(plan, {
      kind: 'covered',
      locations: [{ file: 'src/engine/fold.ts', line: 3, tests: ['test/unit/crashed.test.ts'] }],
    });
  });
});

describe('whether a line ran in one child', () => {
  it('a line inside a function no test calls reads as not covered', () => {
    const ranges = foldRanges(false);
    assert.equal(runsLine(FOLD, ranges, 8), false);
    assert.equal(runsLine(FOLD, ranges, 3), false);
    assert.equal(runsLine(FOLD, ranges, 4), false);
    assert.equal(runsLine(FOLD, ranges, 5), true);
    assert.equal(runsLine(FOLD, ranges, 1), true);
  });

  it('a file that starts with a byte order mark maps its offsets after the mark', () => {
    // V8 compiles the text after the mark, so its offsets do not count it: one character off,
    // the branch's closing brace on line 4 would read as the line break after it, which ran.
    assert.equal(runsLine(`\uFEFF${FOLD}`, foldRanges(false), 4), false);
    assert.equal(runsLine(`\uFEFF${FOLD}`, foldRanges(true), 8), true);
  });
});
