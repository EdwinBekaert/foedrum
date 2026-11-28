// Which test files can kill a Brett mutant (#597, ADR 0303): those whose child process ran its
// line in the wide baseline, read from the V8 coverage each child wrote, and the file's own test
// file. A test file with no coverage record counts as running every line.

import { posix } from 'node:path';
import { listable, quoted } from '../../src/checks/gravity.ts';
import { type Range, runsLine } from '../../src/checks/mutant-reach.ts';

// The rule for a line that ran and the names a covered line can carry are the engine's (ADR 0431),
// so the review and the mutant step cannot read the same coverage differently.
export { listable, quoted, type Range, runsLine };

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

// The file's own test files, as the repository names them: test/unit/<name>.test.ts, and its
// -core and -shell variants, and test/unit/<folder>-<name>.test.ts (mutant-coverage-core for
// scripts/mutant-coverage/core.ts).
const ownTestsOf = (file: string): Set<string> => {
  const name = posix.basename(file, '.ts');
  const folder = posix.basename(posix.dirname(file));
  const names = [name, `${name}-core`, `${name}-shell`, `${folder}-${name}`];
  return new Set(names.map((base) => `test/unit/${base}.test.ts`));
};

export const coveringTests = ({ tests, records, sources, locations }: CoverageInput): Plan => {
  if (tests.length === 0) return { kind: 'fallback', reason: 'no test file imports the files' };
  // The covered line lists the test files with a space between them, so a name holding a space
  // or a line break could split one or forge a line.
  const odd = tests.find((test) => !listable(test));
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
        // A file with no such line ran nothing.
        return runsLine(sources.get(file) ?? '', record.get(file) ?? [], line) === true;
      };
      return { file, line, tests: sorted.filter(covers) };
    }),
  };
};
