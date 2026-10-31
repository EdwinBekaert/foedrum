// A line coverage report as the uncovered-line check reads it (ADR 0274): each file's executable
// lines with their hit counts, and their branches where the tool writes them. lcov.ts and
// cobertura.ts read the formats, coverage-files.ts the files. Pure.

import { posix } from 'node:path';

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

const DRIVE = /^[A-Za-z]:\//;

/** Whether a path `reportPath` gave is still absolute: outside the root it was given. */
export const isAbsolutePath = (path: string): boolean => path.startsWith('/') || DRIVE.test(path);

const slashed = (path: string): string => posix.normalize(path.replaceAll('\\', '/'));
/** A drive letter in one case: Windows tells no case apart there, and tools write either. */
const folded = (path: string): string =>
  DRIVE.test(path) ? `${path.charAt(0).toLowerCase()}${path.slice(1)}` : path;

/**
 * A report's path relative to `root` with `/` between folders, both sides normalized first and a
 * drive letter compared in either case; a relative path is taken as relative to `root`, and one
 * outside `root` is kept, absolute, as written. The rest of its case is left as the tool wrote it.
 */
export function reportPath(path: string, root: string): string {
  const file = slashed(path);
  if (!isAbsolutePath(file)) return file;
  const prefix = `${folded(slashed(root)).replace(/\/+$/, '')}/`;
  return folded(file).startsWith(prefix) ? file.slice(prefix.length) : file;
}

/**
 * Adds `line` to a file's lines: the most hits, and of two lines' branches the one with more taken.
 * Counts cannot tell which branches ran, so two runs that took different halves of a branch show
 * the higher count, not their union.
 */
export function addLine(lines: Map<number, CoveredLine>, number: number, line: CoveredLine): void {
  const had = lines.get(number);
  if (had === undefined) {
    lines.set(number, line);
    return;
  }
  const branches =
    had.branches === undefined ||
    (line.branches !== undefined && line.branches.taken > had.branches.taken)
      ? line.branches
      : had.branches;
  lines.set(number, {
    hits: Math.max(had.hits, line.hits),
    ...(branches === undefined ? {} : { branches }),
  });
}

/** The lines of `file` in `files`, made when it has none yet. */
export function linesOf(
  files: Map<string, Map<number, CoveredLine>>,
  file: string,
): Map<number, CoveredLine> {
  const known = files.get(file);
  if (known !== undefined) return known;
  const lines = new Map<number, CoveredLine>();
  files.set(file, lines);
  return lines;
}

/** Several reports as one, each line by `addLine`. */
export function mergeReports(reports: readonly CoverageReport[]): CoverageReport {
  const files = new Map<string, Map<number, CoveredLine>>();
  for (const report of reports) {
    for (const [file, lines] of report) {
      const merged = linesOf(files, file);
      for (const [number, line] of lines) addLine(merged, number, line);
    }
  }
  return files;
}
