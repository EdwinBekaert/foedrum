// The uncovered-line check (ADR 0274): after a passing test reading in a repository with a test map,
// every line the batch's change added in a code area must have run, in the union of the modules'
// coverage reports, each of its branches too where the report has branch data. Pure.

import { shown } from '../formats/coverage-files.ts';
import type { CoverageReport, CoveredLine } from '../formats/coverage-report.ts';
import { areaOf, type EffectiveModule } from './test-map.ts';

/** A file of the batch's change at the step's tip, and the lines it added there. */
export interface ChangedFile {
  path: string;
  addedAt: readonly number[];
}

/** A changed line no test ran: its file, its number, and whether only a branch on it did not. */
export interface UncoveredLine {
  file: string;
  line: number;
  branch: boolean;
}

/** What the check found: the lines that fail it, and the files and modules it did not measure. */
export interface CoverageVerdict {
  uncovered: UncoveredLine[];
  /** Changed code files a tool that leaves unloaded files out (LCOV) did not list. */
  notLoaded: string[];
  /** Changed code files no Cobertura report lists: they have no executable lines (ADR 0288). */
  noLines: string[];
  /** Changed files outside every code and test area: data, docs, config. */
  outside: string[];
  /** The modules with `coverage: none` whose code the change touched. */
  unmeasured: string[];
}

/** The lines of `path` in `report`, its name compared in either case where `foldCase`. */
const linesIn = (
  report: CoverageReport,
  path: string,
  foldCase: boolean,
): ReadonlyMap<number, CoveredLine> | undefined => {
  const exact = report.get(path);
  if (exact !== undefined || !foldCase) return exact;
  const folded = path.toLowerCase();
  return [...report].find(([file]) => file.toLowerCase() === folded)?.[1];
};

/** Judges the batch's changed files against the union of the reports. */
export const judgeCoverage = ({
  modules,
  changed,
  report,
  foldCase,
}: {
  modules: readonly EffectiveModule[];
  changed: readonly ChangedFile[];
  report: CoverageReport;
  foldCase: boolean;
}): CoverageVerdict => {
  const verdict: CoverageVerdict = {
    uncovered: [],
    notLoaded: [],
    noLines: [],
    outside: [],
    unmeasured: [],
  };
  for (const { path, addedAt } of changed) {
    const area = areaOf(modules, path, foldCase);
    if (area === undefined) {
      verdict.outside.push(path);
      continue;
    }
    // A test is not code a test must run.
    if (area.area === 'tests') continue;
    const { coverage } = modules.find(({ module }) => module.name === area.module)?.module ?? {};
    if (coverage === undefined) continue;
    if (coverage === 'none') {
      if (!verdict.unmeasured.includes(area.module)) verdict.unmeasured.push(area.module);
      continue;
    }
    const lines = linesIn(report, path, foldCase);
    if (lines === undefined) {
      // coverlet lists every file with a sequence point, run or not, so one no report holds has no
      // executable line, such as an interface or a project file (ADR 0288); Node leaves out every
      // file no test loaded, as it does a types-only one no test could run.
      (coverage.format === 'cobertura' ? verdict.noLines : verdict.notLoaded).push(path);
      continue;
    }
    for (const line of addedAt) {
      // Only the lines a report lists as executable are judged.
      const covered = lines.get(line);
      if (covered === undefined) continue;
      if (covered.hits === 0) verdict.uncovered.push({ file: path, line, branch: false });
      else if (covered.branches !== undefined && covered.branches.taken < covered.branches.total) {
        verdict.uncovered.push({ file: path, line, branch: true });
      }
    }
  }
  return verdict;
};

/** How many uncovered lines the reason names. */
const MOST_NAMED = 10;

/** The check's reason for uncovered lines: the first ten, and a count of the rest. */
export const uncoveredReason = (lines: readonly UncoveredLine[]): string => {
  const named = lines
    .slice(0, MOST_NAMED)
    .map(
      ({ file, line, branch }) => `${shown(file)}:${line}${branch ? ' (branch not taken)' : ''}`,
    );
  const more = lines.length - named.length;
  const count = `${lines.length} changed line${lines.length === 1 ? '' : 's'}`;
  return `${count} no test runs: ${named.join(', ')}${more > 0 ? ` and ${more} more` : ''}`;
};
