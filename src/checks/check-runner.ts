// The check runner (ADR 0069): runs the attempts of check steps, the gravity readings. For an attempt
// the driver started, it runs the step's checks one after another in the attempt's worktree through
// the platform shell and the process runner, which kills the whole tree at the step's deadline or
// when the engine stops the attempt; the first check that does not pass ends the step. No model.
// A red proof runs the test check and judges the structured test report against the tests the
// proven step committed, never the exit code (ADR 0078).

import { basename, dirname, join } from 'node:path';
import { type AttemptRef, attemptKey } from '../engine/attempt-key.ts';
import { mergedBase } from '../engine/base-merge.ts';
import type { Env } from '../engine/brewer-env.ts';
import type { AttemptEnd, BrewerRunner } from '../engine/brewer-runner.ts';
import type { Batch, State } from '../engine/fold.ts';
import type { StepChecks } from '../engine/recipe-files.ts';
import type { AttemptProgress } from '../engine/supervisor.ts';
import { readCoverage } from '../formats/coverage-files.ts';
import {
  type CoverageFormat,
  type CoverageReport,
  mergeReports,
  type ReadCoverage,
} from '../formats/coverage-report.ts';
import { parseJunit } from '../formats/junit.ts';
import { parseTap } from '../formats/tap.ts';
import { MAX_REPORT_BYTES } from '../formats/test-report.ts';
import { type BoundedRead, readOutDocFile } from '../platform/bounded-read.ts';
import { checksRunUnsandboxed } from '../platform/check-sandbox.ts';
import { foldsCase, pathInside } from '../platform/paths.ts';
import type { ExecProcess, ExecResult } from '../platform/processes.ts';
import { realPath } from '../platform/real-path.ts';
import { removeTree } from '../platform/remove.ts';
import type { RepositorySetup, TestReportConfig } from '../schemas/brewery-config.ts';
import {
  type CoverageListing,
  type GravityReading,
  MAX_OPEN_FINDING_TEXT,
  MOST_LISTED,
  type WorktreeRef,
} from '../schemas/events.ts';
import type { CheckRef } from '../schemas/recipe.ts';
import type { TestMap } from '../schemas/test-map.ts';
import type { Git } from '../workspace/git.ts';
import {
  type PlannedCheck,
  passed,
  planChecks,
  type RepositoryChecks,
  settleReadings,
} from './gravity.ts';
import { judgeRed, needsTestReport } from './red-proof.ts';
import { checksEnv, readingOn, runLine, runSetup, setupRunOf } from './setup.ts';
import { readDiff, readFilesAt, readTestFiles, stepCommits, stepTests } from './step-commits.ts';
import {
  areaOf,
  clearReportPaths,
  effectiveMap,
  type MapRead,
  type ReadTestMapAt,
  reportPaths,
} from './test-map.ts';
import { type CoverageVerdict, judgeCoverage, uncoveredReason } from './uncovered.ts';

/** A test report's file in a worktree: cleared before the test check runs, read after it. */
export interface ReportFiles {
  /** Clears the report only inside `root`, the worktree. */
  clear: (file: string, root: string) => void | Promise<void>;
  /** Reads the report only inside `root`, the worktree. */
  read: (file: string, root: string) => BoundedRead;
}

export type { RepositorySetup };

export interface CheckRunnerOptions {
  /** The folded state: the driver's, which has recorded the attempt's start and worktree. */
  state: () => State;
  /** The checks of the recipes' check steps (`loadRecipes`). */
  checks: StepChecks;
  /** The commands of a repository's checks (`foedrum.jsonc`), or undefined when it lists none. */
  repositoryChecks: (repo: string) => RepositoryChecks | undefined;
  /** The test report a repository's test check writes (`foedrum.jsonc`), for red proofs. */
  testReport: (repo: string) => TestReportConfig | undefined;
  exec: ExecProcess;
  /**
   * A repository's setup, run before a check step's checks, and the process runner it runs
   * through: the checks' sandbox with the network kept (ADR 0158).
   */
  setup?: { of: (repo: string) => RepositorySetup | undefined; exec: ExecProcess };
  /** git, for the commits of the step a red proof proves (ADR 0078). */
  git: Git;
  /**
   * The clone a repository's attempt worktrees are added to, where git reads the proven step's
   * commits: never the attempt's worktree, which git would find by its `.git` file.
   */
  clone: (repo: string) => string;
  /** Default the file system's. */
  reports?: ReportFiles;
  /** The brewers' environment: its minimal base and the runner's forced variables (ADR 0063). */
  env: { base: Env; forced: Env };
  clock: () => Date;
  /** Default this process's. */
  platform?: NodeJS.Platform;
  /**
   * The test maps of a repository by commit, and the files a report path names in a worktree
   * (ADR 0274): after a test check ran, a module only the batch's map lists that wrote no report
   * sticks the batch.
   */
  testMap?: {
    at: ReadTestMapAt;
    /** Default the file system's. */
    reports?: (pattern: string, root: string) => { paths: string[] } | { refused: string };
    /** A module's coverage report in a worktree (ADR 0274). Default the file system's. */
    coverage?: (format: CoverageFormat, path: string, root: string) => ReadCoverage;
    /** A worktree's real path, where the check sandbox runs (ADR 0076). Default the file system's. */
    realPath?: (path: string) => string;
  };
}

/**
 * The test report files of the real file system: removed, a folder included, through the platform's
 * removal, which retries a file another process holds open; read as an out doc is.
 */
export const fileReports: ReportFiles = {
  clear: async (file, root) => {
    // Resolved through links first: a linked folder on the path could point the removal anywhere.
    const resolved = join(realPath(dirname(file)), basename(file));
    if (pathInside(realPath(root), resolved) === undefined) {
      throw new Error('it is outside the worktree');
    }
    await removeTree(resolved);
  },
  read: (file, root) => readOutDocFile(file, MAX_REPORT_BYTES, root),
};

// None of a repository's checks: what a step of literal commands plans against.
const NO_CHECKS: RepositoryChecks = {
  build: null,
  typecheck: null,
  lint: null,
  format: null,
  test: null,
};

/** The test maps of a check step: where the batch's change starts, and at the step's commit. */
interface StepMaps {
  base: string | undefined;
  before: MapRead;
  after: MapRead;
}

/** The coverage report paths of every module either map lists, each once (ADR 0274). */
const coveragePaths = ({ before, after }: StepMaps): string[] => [
  ...new Set(
    [before, after].flatMap((read) =>
      read.kind === 'map'
        ? read.map.modules.flatMap(({ coverage }) => (coverage === 'none' ? [] : [coverage.path]))
        : [],
    ),
  ),
];

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
  outside,
  unmeasured,
}: CoverageVerdict): CoverageListing | undefined => {
  const loaded = listed(notLoaded);
  const out = listed(outside);
  const listing: CoverageListing = {
    ...(loaded === undefined ? {} : { notLoaded: loaded }),
    ...(out === undefined ? {} : { outside: out }),
    ...(unmeasured.length === 0
      ? {}
      : { unmeasured: unmeasured.slice(0, MOST_LISTED).map(recorded) }),
  };
  return Object.keys(listing).length === 0 ? undefined : listing;
};

/**
 * The checks of a tree in a worktree, the repository's setup first: what a check step's attempt
 * runs, and the run on an open pull request's merged tree (ADR 0203).
 */
export type CheckTree = (
  refs: readonly CheckRef[],
  worktree: TreeIn,
  deadlineAt: string,
  signal: AbortSignal,
) => Promise<AttemptEnd>;

/** Where a tree is: its repository and its folder. */
export type TreeIn = Pick<WorktreeRef, 'repo' | 'path'>;

/** The check runner, and the checks of a tree it runs a check step's through. */
export type CheckRunner = BrewerRunner & { checkTree: CheckTree };

export function createCheckRunner(options: CheckRunnerOptions): CheckRunner {
  const { state, checks, exec, git, clone, clock, platform = process.platform } = options;
  const reports = options.reports ?? fileReports;
  const env = checksEnv(options.env, platform);
  // The attempts it runs, by key, with when they started: their progress for the heartbeat.
  const running = new Map<string, AttemptProgress>();

  const blocked = (blockerKind: 'environment' | 'divergence', summary: string): AttemptEnd => ({
    ending: { kind: 'blocked', blockerKind, summary },
  });

  /** What one run of `check` read on this platform (ADR 0076). */
  const readingIn = (check: Extract<PlannedCheck, { kind: 'run' }>, result: ExecResult) =>
    readingOn(check, result, checksRunUnsandboxed(platform));

  /** Runs one check in the worktree through the checks' process runner, its sandbox (ADR 0076). */
  const runCheck = (
    check: Extract<PlannedCheck, { kind: 'run' }>,
    worktree: TreeIn,
    deadlineAt: string,
    signal: AbortSignal,
    maxOutputBytes?: number,
  ): Promise<ExecResult> =>
    runLine(exec, check.command, {
      cwd: worktree.path,
      env,
      deadlineAt,
      now: clock,
      signal,
      maxOutputBytes,
    });

  /**
   * The repository's setup running, or undefined when it has none: then nothing is awaited, so
   * the first check starts at once, before the engine could stop the attempt.
   */
  const prepare = (
    worktree: TreeIn,
    deadlineAt: string,
    signal: AbortSignal,
  ): Promise<GravityReading[]> | undefined => {
    const found = options.setup?.of(worktree.repo);
    if (options.setup === undefined || found === undefined) return undefined;
    const run = { cwd: worktree.path, env, deadlineAt, now: clock, signal };
    // Once the step needs nothing else before its checks (ADR 0140).
    return runSetup(options.setup.exec, setupRunOf(found, platform), run).then((read) => [read]);
  };

  /**
   * A red proof (ADR 0078): the test check's reading, then the report it wrote, judged against
   * what step `of` committed.
   */
  const proveRed = async (
    batch: Batch,
    ref: AttemptRef,
    worktree: WorktreeRef,
    deadlineAt: string,
    of: string,
    signal: AbortSignal,
  ): Promise<AttemptEnd> => {
    const recipe = batch.recipe?.name ?? '';
    const report = options.testReport(worktree.repo);
    if (report === undefined) return blocked('environment', needsTestReport(recipe, worktree.repo));
    const commits = stepCommits(batch, of);
    if (commits === undefined) {
      return blocked(
        'divergence',
        `step ${ref.stepId} proves the tests of step ${of}, which has no attempt that succeeded`,
      );
    }
    // In the clone, never by discovery in the worktree (#210).
    const diff = await readDiff(git, clone(worktree.repo), commits, { signal });
    if ('error' in diff) {
      return blocked('environment', `the commits of step ${of} cannot be read: ${diff.error}`);
    }
    const [check] = planChecks(
      ['test'],
      options.repositoryChecks(worktree.repo) ?? NO_CHECKS,
      platform,
    );
    // foedrum.jsonc's schema gives every repository with a test report its test check.
    if (check?.kind !== 'run') {
      return blocked('environment', `foedrum.jsonc gives ${worktree.repo} no test check`);
    }
    // The repository's setup once nothing else blocks the run, so the run finds what it
    // installed (ADR 0140).
    const preparing = prepare(worktree, deadlineAt, signal);
    const before = preparing === undefined ? [] : await preparing;
    if (!before.every(passed)) return { ending: settleReadings(before), readings: before };
    // A report the tree holds, committed or left over, must not stand for this run's.
    const file =
      report.path === undefined ? undefined : join(worktree.path, ...report.path.split('/'));
    if (file !== undefined) {
      try {
        await reports.clear(file, worktree.path);
      } catch (error) {
        // A folder at the path, or on Windows a file another process holds open.
        const why = error instanceof Error ? error.message : String(error);
        return blocked('environment', `the test report ${report.path} cannot be cleared: ${why}`);
      }
    }
    // TAP on stdout may be as large as a report file.
    const limit = file === undefined ? MAX_REPORT_BYTES : undefined;
    const result = await runCheck(check, worktree, deadlineAt, signal, limit);
    const reading = readingIn(check, result);
    const readings = [...before, reading];
    // A check that did not exit read no report: it ends as any check does (ADR 0069).
    if (reading.result !== 'exited') return { ending: settleReadings(readings), readings };
    const failed = (why: string): AttemptEnd => ({
      ending: {
        kind: 'failed',
        retryable: false,
        reason: `the red proof of step ${of} failed: ${why}`,
      },
      readings,
    });
    let text = result.stdout;
    if (file !== undefined) {
      const read = reports.read(file, worktree.path);
      switch (read.kind) {
        case 'missing':
          return failed(`the test command wrote no test report at ${report.path}`);
        case 'unread':
          return failed(`the test report ${report.path} cannot be read: ${read.reason}`);
        case 'text':
          text = read.text;
          break;
        default: {
          const unhandled: never = read;
          throw new Error(`Unhandled read ${JSON.stringify(unhandled)}`);
        }
      }
    }
    const parsed = report.format === 'tap' ? parseTap(text) : parseJunit(text);
    if (!parsed.readable) {
      const where = report.path ?? 'on stdout';
      const format = report.format === 'tap' ? 'TAP' : 'JUnit XML';
      return failed(`the test report ${where} is not ${format}: ${parsed.reason}`);
    }
    // The regression tests the proven step named pass, as they should (ADR 0170).
    const regressionTests = stepTests(batch, of)?.regressionTests ?? [];
    // A file that declares a test at the step's tip is a test file, though the step only added a
    // row to it (ADR 0262).
    let testFiles: Set<string>;
    try {
      testFiles = await readTestFiles(git, clone(worktree.repo), commits.to, diff.files, signal);
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      return blocked('environment', `the files of step ${of} at its tip cannot be read: ${why}`);
    }
    const verdict = judgeRed(parsed.report, diff.files, regressionTests, testFiles);
    if (!verdict.proven) return failed(verdict.why);
    return { ending: { kind: 'succeeded', output: null }, readings };
  };

  /**
   * The checks `refs` of the tree in `worktree`, the repository's setup first: a check step's
   * attempt's, and the merged tree of an open pull request (ADR 0203).
   */
  const checkTree: CheckTree = async (refs, worktree, deadlineAt, signal) => {
    let repository = NO_CHECKS;
    const named = refs.find((check) => typeof check === 'string');
    if (named !== undefined) {
      const found = options.repositoryChecks(worktree.repo);
      if (found === undefined) {
        return blocked(
          'environment',
          `foedrum.jsonc lists no checks of ${worktree.repo} for the check "${named}"`,
        );
      }
      repository = found;
    }
    const planned = planChecks(refs, repository, platform);
    // The repository's setup once nothing else blocks the step and a check will run, so the
    // checks find what it installed (ADR 0140).
    const preparing = planned.some((check) => check.kind === 'run')
      ? prepare(worktree, deadlineAt, signal)
      : undefined;
    const before = preparing === undefined ? [] : await preparing;
    if (!before.every(passed)) return { ending: settleReadings(before), readings: before };
    const readings: GravityReading[] = [...before];
    for (const check of planned) {
      if (check.kind === 'skip') {
        readings.push({ result: 'skipped', check: check.check });
        continue;
      }
      const reading = readingIn(check, await runCheck(check, worktree, deadlineAt, signal));
      readings.push(reading);
      if (!passed(reading)) break;
    }
    return { ending: settleReadings(readings), readings };
  };

  const run = async (ref: AttemptRef, signal: AbortSignal): Promise<AttemptEnd> => {
    const { batchId, stepId, attempt } = ref;
    const batch = state().batches.get(batchId);
    const current = batch?.steps.get(stepId)?.attempts.get(attempt);
    const worktree = current?.phase === 'started' ? current.worktree : undefined;
    if (batch === undefined || current === undefined || worktree === undefined) {
      return blocked(
        'environment',
        `attempt ${stepId}#${attempt} of batch ${batchId} has no worktree to read`,
      );
    }
    const recipe = batch.recipe?.name ?? '';
    const refs = checks.find(recipe, stepId);
    if (refs === undefined)
      return blocked('divergence', `recipe ${recipe} has no check step ${stepId}`);
    const of = checks.proves(recipe, stepId);
    // A check step's test reading also reads the coverage of the change (ADR 0274): the reports an
    // earlier run left are cleared first, so none stands for this run's or adds its hits to it.
    const maps =
      of === undefined && options.testMap !== undefined && refs.includes('test')
        ? await mapsOf(batch, worktree, signal)
        : undefined;
    if (maps !== undefined) {
      const why = await clearReportPaths(
        coveragePaths(maps),
        worktree.path,
        options.testMap?.reports ?? reportPaths,
        reports.clear,
      );
      if (why !== undefined) {
        return blocked(
          'environment',
          `a coverage report of the test map cannot be cleared: ${why}`,
        );
      }
    }
    const end =
      of !== undefined
        ? await proveRed(batch, ref, worktree, current.deadlineAt, of, signal)
        : await checkTree(refs, worktree, current.deadlineAt, signal);
    return afterTest(batch, worktree, end, maps, signal);
  };

  /** The test maps where the batch's change starts and at the worktree's commit. */
  const mapsOf = async (
    batch: Batch,
    worktree: WorktreeRef,
    signal: AbortSignal,
  ): Promise<StepMaps | undefined> => {
    const { testMap } = options;
    if (testMap === undefined) return undefined;
    const { repo } = worktree;
    // Where the batch's change starts: the base it merged, else its start (ADR 0164).
    const base = mergedBase(state(), batch.id) ?? batch.starts?.[repo.toLowerCase()]?.commit;
    const before: MapRead =
      base === undefined ? { kind: 'none' } : await testMap.at(repo, base, signal);
    const after = await testMap.at(repo, worktree.commit, signal);
    return { base, before, after };
  };

  /**
   * `end`, or once the test check passed: Stuck on the environment for a module only the batch's
   * test map lists whose report path holds no report, since no confirmed line reaches it, or for a
   * check step, failed on a changed line no test ran (ADR 0274). A module the base's map lists is
   * taken as reached, as the base is taken as green.
   */
  const afterTest = async (
    batch: Batch,
    worktree: WorktreeRef,
    end: AttemptEnd,
    read: StepMaps | undefined,
    signal: AbortSignal,
  ): Promise<AttemptEnd> => {
    const { testMap } = options;
    const test = end.readings?.find(
      (reading): reading is Extract<GravityReading, { result: 'exited' }> =>
        reading.result === 'exited' && reading.check === 'test',
    );
    // Only a passing run says a module no report came from was not reached: a failing one may have
    // stopped before it, so its own verdict stands and goes along onFail (ADR 0280).
    if (testMap === undefined || test === undefined || test.exitCode !== 0) return end;
    const { repo } = worktree;
    const ended = (ending: AttemptEnd['ending']): AttemptEnd => ({ ...end, ending });
    const stuck = (why: string): AttemptEnd => ended(blocked('environment', why).ending);
    const maps = read ?? (await mapsOf(batch, worktree, signal));
    if (maps === undefined) return end;
    const { base, before, after } = maps;
    if (before.kind === 'unreadable') {
      return stuck(`the test map of ${repo} at ${base} cannot be read: ${before.reason}`);
    }
    // The batch's own map: the same tree reads the same, so the step's onFail route sends it back
    // to the brewer that broke it.
    if (after.kind === 'unreadable') {
      const reason = `the test map of ${repo} at ${worktree.commit} cannot be read: ${after.reason}`;
      return ended({ kind: 'failed', retryable: false, reason });
    }
    if (after.kind === 'none') return end;
    const listed = new Set(before.kind === 'map' ? before.map.modules.map(({ name }) => name) : []);
    const find = testMap.reports ?? reportPaths;
    for (const { name, testReport } of after.map.modules) {
      if (listed.has(name)) continue;
      const found = find(testReport.path, worktree.path);
      if ('refused' in found) {
        return stuck(`the test report of module "${name}" cannot be looked for: ${found.refused}`);
      }
      if (found.paths.length > 0) continue;
      const why = [
        `module "${name}" of the test map is new in this batch, and no confirmed line reaches it:`,
        `the test check wrote no test report at ${testReport.path};`,
        `make "checks"."test" of ${repo} in foedrum.jsonc, now "${test.command}", also run its tests,`,
        `whatever the tests before them give (ADR 0023, ADR 0274).`,
        `The test check's output ended: ${test.tail}`,
      ].join(' ');
      return stuck(why);
    }
    // A red proof reads no coverage: the uncovered-line check is a check step's (ADR 0274).
    // A step another check already failed or blocked keeps that ending.
    if (read === undefined || base === undefined || end.ending.kind !== 'succeeded') return end;
    return uncovered(end, worktree, { base, before, after: after.map }, signal);
  };

  /**
   * `end`, or failed for its onFail route on a line the batch's change added in a code area that no
   * test ran, with what the check did not measure (ADR 0274).
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
    // The reports are read only for a change to code some report measures.
    const measured = changed.some(({ path }) => {
      const area = areaOf(modules, path, foldCase);
      const module = modules.find(({ module }) => module.name === area?.module)?.module;
      return area?.area === 'code' && module !== undefined && module.coverage !== 'none';
    });
    const read = options.testMap?.coverage ?? readCoverage;
    const find = options.testMap?.reports ?? reportPaths;
    // The check sandbox runs in the worktree's real path, so a report may name its files by either.
    const real = (options.testMap?.realPath ?? realPath)(worktree.path);
    const roots = real === worktree.path ? [worktree.path] : [worktree.path, real];
    const reportsRead: CoverageReport[] = [];
    for (const { module } of measured ? modules : []) {
      if (module.coverage === 'none') continue;
      const { format, path } = module.coverage;
      const cannot = `the coverage report of module "${module.name}" cannot`;
      // Refused out of the worktree, or past the paths a pattern may match (ADR 0274).
      const found = find(path, worktree.path);
      if ('refused' in found) return stuck(`${cannot} be looked for: ${found.refused}`);
      for (const root of roots) {
        const report = read(format, path, root);
        if (!report.readable) {
          const why = `${cannot} be read: ${report.reason}`;
          return report.environment === true ? stuck(why) : failed(why);
        }
        reportsRead.push(report.report);
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

  return {
    start: ({ ref }) => {
      const key = attemptKey.encode(ref);
      const stop = new AbortController();
      running.set(key, { lastProgressAt: clock(), turnsWithoutProgress: 0 });
      const ended = run(ref, stop.signal).finally(() => running.delete(key));
      return { ended, stop: () => stop.abort() };
    },
    progress: (ref) => running.get(attemptKey.encode(ref)),
    checkTree,
  };
}
