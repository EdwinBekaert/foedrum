// A line coverage report as the uncovered-line check reads it (ADR 0274): each file's executable
// lines with their hit counts, and their branches where the tool writes them. lcov.ts and
// cobertura.ts read the formats, coverage-files.ts the files.

/** One executable line: how often it ran, and how many of its branches ran, where the tool says. */
export interface CoveredLine {
  hits: number;
  branches?: { taken: number; total: number };
}

/** File, relative to the worktree's root with `/` between folders, to line number to its coverage. */
export type CoverageReport = ReadonlyMap<string, ReadonlyMap<number, CoveredLine>>;

export type ReadCoverage =
  | { readable: true; report: CoverageReport }
  | { readable: false; reason: string };

/** The formats Foedrum reads: LCOV by file, Cobertura by folder. */
export type CoverageFormat = 'lcov' | 'cobertura';
