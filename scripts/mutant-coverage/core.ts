// Which test files can kill a Brett mutant (#597, ADR 0303): those whose child process ran its
// line in the wide baseline, read from the V8 coverage each child wrote, and the file's own test
// file. A test file with no coverage record counts as running every line.

import { posix } from 'node:path';

// A range of a script that ran `count` times, in UTF-16 offsets of the source V8 compiled.
export interface Range {
  startOffset: number;
  endOffset: number;
  count: number;
}

export interface Location {
  file: string;
  line: number;
}

export type Plan =
  | { kind: 'covered'; locations: (Location & { tests: string[] })[] }
  | { kind: 'fallback'; reason: string };

export interface CoverageInput {
  // The wide list: the test files the baseline ran, relative to the tree with /.
  tests: readonly string[];
  // Per test file that wrote a record, the ranges of each file it loaded, by its path.
  records: ReadonlyMap<string, ReadonlyMap<string, readonly Range[]>>;
  // The text of each mutated file, by its path.
  sources: ReadonlyMap<string, string>;
  locations: readonly Location[];
}

const isRange = (value: unknown): value is Range => {
  if (typeof value !== 'object' || value === null) return false;
  const { startOffset, endOffset, count } = value as Record<string, unknown>;
  return [startOffset, endOffset, count].every((n) => Number.isInteger(n));
};

// The ranges of each script in a V8 coverage file, by its URL, or why it cannot be read.
export const parseCoverage = (text: string): Map<string, Range[]> | string => {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return 'not V8 coverage';
  }
  const result = (value as { result?: unknown } | null)?.result;
  if (!Array.isArray(result)) return 'not V8 coverage';
  const scripts = new Map<string, Range[]>();
  for (const script of result) {
    const { url, functions } = (script ?? {}) as { url?: unknown; functions?: unknown };
    if (typeof url !== 'string' || !Array.isArray(functions)) return 'not V8 coverage';
    const ranges: Range[] = [];
    for (const fn of functions) {
      const fnRanges = (fn as { ranges?: unknown } | null)?.ranges;
      if (!Array.isArray(fnRanges) || !fnRanges.every(isRange)) return 'not V8 coverage';
      ranges.push(...fnRanges);
    }
    scripts.set(url, ranges);
  }
  return scripts;
};

// Whether line `line` (from 1) of `source` ran: whether one of its non-blank characters lies in
// an innermost range that ran. V8 compiles the text after a byte order mark, and type stripping
// keeps every offset, so the offsets are those of the text without the mark.
export const runsLine = (source: string, ranges: readonly Range[], line: number): boolean => {
  const text = source.startsWith('﻿') ? source.slice(1) : source;
  let start = 0;
  for (let n = 1; n < line; n += 1) start = text.indexOf('\n', start) + 1;
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

// The file's own test files, as the repository names them: test/unit/<name>.test.ts, and its
// -core and -shell variants, also by the folder for a core.ts or shell.ts.
const ownTestsOf = (file: string): Set<string> => {
  const name = posix.basename(file, '.ts');
  const folder = posix.basename(posix.dirname(file));
  const names = [name, `${name}-core`, `${name}-shell`, `${folder}-${name}`];
  return new Set(names.map((base) => `test/unit/${base}.test.ts`));
};

// A name an outside party wrote, quoted so it stays on its line: as JSON, with the line and
// paragraph separators JSON leaves as they are escaped too.
export const quoted = (text: string): string =>
  JSON.stringify(text).replace(/[\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16)}`);

const LISTABLE = /^[\w./@+-]+$/;

export const coveringTests = ({ tests, records, sources, locations }: CoverageInput): Plan => {
  if (tests.length === 0) return { kind: 'fallback', reason: 'no test file imports the files' };
  // The covered line lists the test files with a space between them, so a name holding a space
  // or a line break could split one or forge a line.
  const odd = tests.find((test) => !LISTABLE.test(test));
  if (odd !== undefined) {
    const reason = `the test file name ${quoted(odd)} cannot be listed on one line`;
    return { kind: 'fallback', reason };
  }
  if (!tests.some((test) => records.has(test))) {
    return { kind: 'fallback', reason: 'no coverage record names a test file of the run' };
  }
  const sorted = [...tests].sort();
  return {
    kind: 'covered',
    locations: locations.map(({ file, line }) => {
      const own = ownTestsOf(file);
      const covers = (test: string): boolean => {
        const record = records.get(test);
        if (own.has(test) || record === undefined) return true;
        return runsLine(sources.get(file) ?? '', record.get(file) ?? [], line);
      };
      return { file, line, tests: sorted.filter(covers) };
    }),
  };
};
