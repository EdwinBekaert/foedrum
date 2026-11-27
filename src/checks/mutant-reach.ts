// Which test files reach a Brett mutant's line (#1176, ADR 0303, ADR 0313): read from the V8
// coverage each test file's process wrote in the mutant step's baseline run on Node (a run with
// NODE_V8_COVERAGE), so a mutant runs only those test files. Pure; check-runner.ts records the
// coverage and mutant-run.ts runs the files.

import { listable, quoted, unlistable } from './gravity.ts';

const BYTE_ORDER_MARK = String.fromCodePoint(0xfeff);

// A range of a script that ran `count` times, in UTF-16 offsets of the source V8 compiled.
export interface Range {
  startOffset: number;
  endOffset: number;
  count: number;
}

/** Per test file that wrote a record, the ranges of each script it loaded, by its path in the tree. */
export type TestCoverage = ReadonlyMap<string, ReadonlyMap<string, readonly Range[]>>;

/** A line (from 1) of a file of the tree. */
export interface MutantLine {
  file: string;
  line: number;
}

export type Reach =
  | { kind: 'reached'; lines: readonly (MutantLine & { tests: readonly string[] })[] }
  | { kind: 'whole'; reason: string };

export interface ReachInput {
  coverage: TestCoverage;
  /** The text of each mutated file, by its path. */
  sources: ReadonlyMap<string, string>;
  lines: readonly MutantLine[];
}

/**
 * Whether line `line` (from 1) of `source` ran, or undefined when the file has no such line:
 * whether one of its non-blank characters lies in an innermost range that ran. V8 compiles the
 * text after a byte order mark, and type stripping keeps every offset, so the offsets are those of
 * the text without the mark.
 */
const runsLine = (source: string, ranges: readonly Range[], line: number): boolean | undefined => {
  const text = source.startsWith(BYTE_ORDER_MARK) ? source.slice(1) : source;
  let start = 0;
  for (let n = 1; n < line; n += 1) {
    const end = text.indexOf('\n', start);
    if (end === -1) return undefined;
    start = end + 1;
  }
  const end = text.indexOf('\n', start);
  for (let offset = start; offset < (end === -1 ? text.length : end); offset += 1) {
    if (/\s/.test(text.charAt(offset))) continue;
    let innermost: Range | undefined;
    for (const range of ranges) {
      if (offset < range.startOffset || offset >= range.endOffset) continue;
      const width = range.endOffset - range.startOffset;
      if (innermost === undefined || width <= innermost.endOffset - innermost.startOffset) {
        innermost = range;
      }
    }
    if ((innermost?.count ?? 0) > 0) return true;
  }
  return false;
};

/**
 * For each of `lines`, in order, the test files of `coverage`, sorted, whose process ran it; or why
 * the coverage cannot tell, and the mutants run the whole test check (ADR 0431).
 */
export const reachOf = ({ coverage, sources, lines }: ReachInput): Reach => {
  if (coverage.size === 0) return { kind: 'whole', reason: 'no test file wrote a coverage record' };
  // The test files go on one command line, a space between them: a name holding a space or a line
  // break could split one or forge a line.
  const tests = [...coverage.keys()].sort();
  const odd = tests.find((test) => !listable(test));
  if (odd !== undefined) return { kind: 'whole', reason: unlistable(odd) };
  const reached: (MutantLine & { tests: readonly string[] })[] = [];
  for (const { file, line } of lines) {
    const source = sources.get(file);
    if (source === undefined) {
      return { kind: 'whole', reason: `the text of ${quoted(file)} was not read` };
    }
    const running: string[] = [];
    for (const test of tests) {
      const ran = runsLine(source, coverage.get(test)?.get(file) ?? [], line);
      if (ran === undefined) {
        return { kind: 'whole', reason: `${quoted(file)} has no line ${line}` };
      }
      if (ran) running.push(test);
    }
    reached.push({ file, line, tests: running });
  }
  return { kind: 'reached', lines: reached };
};
