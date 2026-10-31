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

const isAbsolutePath = (path: string): boolean => path.startsWith('/') || DRIVE.test(path);

const slashed = (path: string): string => posix.normalize(path.replaceAll('\\', '/'));

/**
 * A report's path relative to `root` with `/` between folders, both sides normalized first; a
 * relative path is taken as relative to `root`. Undefined for a path outside `root`, which no
 * change in the worktree can name. The root is compared in either case: on Windows and macOS a
 * tool run from a shell in another spelling of the worktree writes it so, and two folders that
 * differ only in case are never the worktree and a sibling of it. The part after the root keeps the
 * tool's case, which the comparison with git's paths decides on (ADR 0274).
 */
export function reportPath(path: string, root: string): string | undefined {
  const file = slashed(path);
  if (!isAbsolutePath(file)) return file === '..' || file.startsWith('../') ? undefined : file;
  const prefix = `${slashed(root).replace(/\/+$/, '')}/`;
  const head = file.slice(0, prefix.length);
  return head.toLowerCase() === prefix.toLowerCase() ? file.slice(prefix.length) : undefined;
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
