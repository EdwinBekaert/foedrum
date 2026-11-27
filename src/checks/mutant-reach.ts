// Which test files reach a Brett mutant's line (#1176, ADR 0303, ADR 0313): read from the V8
// coverage each test file's process wrote in the mutant step's baseline run on Node (a run with
// NODE_V8_COVERAGE), so a mutant runs only those test files. Pure; check-runner.ts records the
// coverage and mutant-run.ts runs the files.

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
 * For each of `lines`, in order, the test files of `coverage`, sorted, whose process ran it; or why
 * the coverage cannot tell, and the mutants run the whole test check.
 */
export const reachOf = (_input: ReachInput): Reach => {
  throw new Error('not implemented');
};
