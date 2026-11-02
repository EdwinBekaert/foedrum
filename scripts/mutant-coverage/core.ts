// Which test files can kill a Brett mutant (#597, ADR 0303): those whose child process ran its
// line in the wide baseline, read from the V8 coverage each child wrote, and the file's own test
// file. A test file with no coverage record counts as running every line.

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

// The ranges of each script in a V8 coverage file, by its URL, or why it cannot be read.
export const parseCoverage = (_text: string): Map<string, Range[]> | string => {
  throw new Error('not implemented');
};

// Whether line `line` (from 1) of `source` ran, by the innermost range around its first
// non-blank character.
export const runsLine = (_source: string, _ranges: readonly Range[], _line: number): boolean => {
  throw new Error('not implemented');
};

export const coveringTests = (_input: CoverageInput): Plan => {
  throw new Error('not implemented');
};
