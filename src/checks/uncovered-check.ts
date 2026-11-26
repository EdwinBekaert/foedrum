// The uncovered-line check of a check step (ADR 0274): after a passing test run in a repository
// with a test map, the batch's change read in the clone, a skip its tests add failed, and the
// coverage reports of the modules whose code it touched judged by uncovered.ts. No model.

import type { AttemptEnd } from '../engine/brewer-runner.ts';
import { readCoverage } from '../formats/coverage-files.ts';
import { type CoverageReport, mergeReports } from '../formats/coverage-report.ts';
import { foldsCase } from '../platform/paths.ts';
import { realPath } from '../platform/real-path.ts';
import {
  type CoverageListing,
  MAX_OPEN_FINDING_TEXT,
  MOST_LISTED,
  type WorktreeRef,
} from '../schemas/events.ts';
import type { TestMap } from '../schemas/test-map.ts';
import type { CheckRunnerOptions } from './check-runner.ts';
import { blocked, ranChanged } from './gravity.ts';
import type { ModuleReports } from './module-reports.ts';
import { cut, type MappedReport, skipInAddedLines } from './red-proof.ts';
import { readDiff, readFilesAt } from './step-commits.ts';
import { areaOf, effectiveMap, type MapRead, reportPaths } from './test-map.ts';
import { type CoverageVerdict, judgeCoverage, uncoveredReason } from './uncovered.ts';

/**
 * A file or module name as the listing records it: a brewer names the files, so one longer than
 * the event holds is cut, and one of blanks only is said so.
 */
const recorded = (name: string): string =>
  /\S/.test(name) ? name.slice(0, MAX_OPEN_FINDING_TEXT) : '(a name of blanks)';

/** The first of some files, and how many more there are; none for no files. */
const listed = (files: readonly string[]): { files: string[]; more: number } | undefined =>
  files.length === 0
    ? undefined
    : {
        files: files.slice(0, MOST_LISTED).map(recorded),
        more: Math.max(0, files.length - MOST_LISTED),
      };

/** What the uncovered-line check did not measure, for the status comment; none when nothing. */
const listingOf = ({
  notLoaded,
  noLines,
  outside,
  unmeasured,
}: CoverageVerdict): CoverageListing | undefined => {
  const loaded = listed(notLoaded);
  const lineless = listed(noLines);
  const out = listed(outside);
  const listing: CoverageListing = {
    ...(loaded === undefined ? {} : { notLoaded: loaded }),
    ...(lineless === undefined ? {} : { noLines: lineless }),
    ...(out === undefined ? {} : { outside: out }),
    ...(unmeasured.length === 0
      ? {}
      : { unmeasured: unmeasured.slice(0, MOST_LISTED).map(recorded) }),
  };
  return Object.keys(listing).length === 0 ? undefined : listing;
};

/** The uncovered-line check: `end`, or failed on a skip or a line no test ran. */
export type UncoveredCheck = (
  end: AttemptEnd,
  worktree: WorktreeRef,
  maps: { base: string; before: MapRead; after: TestMap },
  signal: AbortSignal,
) => Promise<AttemptEnd>;

/** What the uncovered-line check uses of the check runner. */
export interface UncoveredCheckOptions
  extends Pick<CheckRunnerOptions, 'git' | 'clone' | 'testMap'> {
  platform: NodeJS.Platform;
  testReportsOf: ModuleReports;
}

export function createUncoveredCheck(options: UncoveredCheckOptions): UncoveredCheck {
  const { git, clone, platform, testReportsOf } = options;

  /**
   * `end`, or failed for its onFail route on a skip a test report places in a line the batch's
   * change added, or on such a line in a code area that no test ran, with what the check did not
   * measure (ADR 0274).
   */
  const uncovered = async (
    end: AttemptEnd,
    worktree: WorktreeRef,
    maps: { base: string; before: MapRead; after: TestMap },
    signal: AbortSignal,
  ): Promise<AttemptEnd> => {
    const { repo } = worktree;
    // The readings stay as they ran, whatever ends the step.
    const failed = (reason: string): AttemptEnd => ({
      ...end,
      ending: { kind: 'failed', retryable: false, reason },
    });
    const stuck = (why: string): AttemptEnd => ({
      ...end,
      ending: blocked('environment', why).ending,
    });
    const range = { from: maps.base, to: worktree.commit };
    const diff = await readDiff(git, clone(repo), range, { signal });
    if ('error' in diff) return stuck(`the change of the batch cannot be read: ${diff.error}`);
    const foldCase = foldsCase(platform);
    const deleted = diff.files.flatMap(({ oldPath, newPath }) =>
      newPath === undefined && oldPath !== undefined ? [oldPath] : [],
    );
    // The base's files decide whether a base module the batch deleted drops out of the map.
    let atBase: string[] = [];
    if (deleted.length > 0) {
      const files = await readFilesAt(git, clone(repo), maps.base, signal);
      if ('error' in files)
        return stuck(`the files of ${maps.base} cannot be read: ${files.error}`);
      atBase = files.files;
    }
    const modules = effectiveMap(
      maps.before.kind === 'map' ? maps.before.map : undefined,
      maps.after,
      { atBase, deleted },
      foldCase,
    );
    const changed = diff.files.flatMap(({ newPath, addedAt = [] }) =>
      newPath === undefined || addedAt.length === 0 ? [] : [{ path: newPath, addedAt }],
    );
    // The check sandbox runs in the worktree's real path, so a report may name its files by either.
    const real = (options.testMap?.realPath ?? realPath)(worktree.path);
    // A skip the batch added in a separate test file of the map weakens a test the change was
    // proven by: named first, as the red proof names the first of its checks that fails. Inline
    // tests are the test-design lens's (ADR 0274).
    const inTests = changed.flatMap((file) => {
      const area = areaOf(modules, file.path, foldCase);
      return area?.area === 'tests' ? [{ ...file, module: area.module }] : [];
    });
    const tests: MappedReport[] = [];
    for (const { module } of modules) {
      // Only a module whose test files the batch added to can report a skip the batch added. A TRX
      // report's skips are left unread at green, where a .NET target brewed before (#727).
      if (!inTests.some((file) => file.module === module.name)) continue;
      if (module.testReport.format === 'trx') continue;
      const wrote = testReportsOf(module, worktree);
      if ('stuck' in wrote) return stuck(wrote.stuck);
      if ('failed' in wrote) return failed(wrote.failed);
      tests.push(...wrote.reports);
    }
    const skip = skipInAddedLines(
      tests,
      new Map(inTests.map(({ path, addedAt }) => [path, new Set(addedAt)])),
      worktree.path,
      foldCase,
      real === worktree.path ? undefined : real,
      (path) => areaOf(modules, path, foldCase)?.module,
    );
    if (skip !== undefined) {
      return failed(
        `test "${cut(skip.name)}" is skipped at ${cut(skip.path)}:${skip.line}, a line the batch added: a change may not skip a test it was proven by`,
      );
    }
    // The reports are read only for a change to code some report measures.
    const measured = changed.some(({ path }) => {
      const area = areaOf(modules, path, foldCase);
      const module = modules.find(({ module }) => module.name === area?.module)?.module;
      return area?.area === 'code' && module !== undefined && module.coverage !== 'none';
    });
    const read = options.testMap?.coverage ?? readCoverage;
    const find = options.testMap?.reports ?? reportPaths;
    const roots = real === worktree.path ? [worktree.path] : [worktree.path, real];
    // The modules whose code the change touched: another's report is the environment's to write.
    const touched = new Set(
      changed.flatMap(({ path }) => {
        const area = areaOf(modules, path, foldCase);
        return area?.area === 'code' ? [area.module] : [];
      }),
    );
    // A run of testChanged may leave an untouched module's tests unrun, and its report unwritten
    // (ADR 0242).
    const changedOnly = ranChanged(end);
    const reportsRead: CoverageReport[] = [];
    for (const { module } of measured ? modules : []) {
      if (module.coverage === 'none') continue;
      if (changedOnly && !touched.has(module.name)) continue;
      // The second line's report of a module the change touches, read beside its coverage (ADR 0430).
      const { coverageSecond } = module;
      const places =
        coverageSecond === undefined || !touched.has(module.name)
          ? [module.coverage]
          : [module.coverage, coverageSecond];
      const cannot = `the coverage report of module "${module.name}" cannot`;
      for (const { format, path } of places) {
        // Refused out of the worktree, or past the paths a pattern may match (ADR 0274).
        const found = find(path, worktree.path);
        if ('refused' in found) return stuck(`${cannot} be looked for: ${found.refused}`);
        for (const root of roots) {
          const report = read(format, path, root);
          if (!report.readable) {
            if (report.environment === true) return stuck(`${cannot} be read: ${report.reason}`);
            if (!touched.has(module.name)) {
              return stuck(
                `the coverage report of module "${module.name}" at ${path} cannot be read, though the change touches none of its code: ${report.reason}`,
              );
            }
            return failed(`${cannot} be read: ${report.reason}`);
          }
          reportsRead.push(report.report);
        }
      }
    }
    const verdict = judgeCoverage({
      modules,
      changed,
      report: mergeReports(reportsRead),
      foldCase,
    });
    const listing = listingOf(verdict);
    const judged =
      verdict.uncovered.length === 0 ? end : failed(uncoveredReason(verdict.uncovered));
    return { ...judged, ...(listing === undefined ? {} : { coverage: listing }) };
  };

  return uncovered;
}
