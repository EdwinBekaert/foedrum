// The check runner (ADR 0069): runs the attempts of check steps, the gravity readings. For an attempt
// the driver started, it runs the step's checks one after another in the attempt's worktree through
// the platform shell and the process runner, which kills the whole tree at the step's deadline or
// when the engine stops the attempt; the first check that does not pass ends the step. No model.
// A red proof runs the test check and judges its structured reports, never the exit code: in a
// repository with a test map, each module's report by checks that read no test name (ADR 0274);
// in one without, the test report against the tests the proven step committed (ADR 0078).

import { type AttemptRef, attemptKey } from '../engine/attempt-key.ts';
import { mergedBase } from '../engine/base-merge.ts';
import type { Env } from '../engine/brewer-env.ts';
import type { AttemptEnd, BrewerRunner } from '../engine/brewer-runner.ts';
import type { Batch, State } from '../engine/fold.ts';
import type { StepChecks } from '../engine/recipe-files.ts';
import type { AttemptProgress } from '../engine/supervisor.ts';
import type { CoverageFormat, ReadCoverage } from '../formats/coverage-report.ts';
import { checksRunUnsandboxed } from '../platform/check-sandbox.ts';
import type { ExecProcess, ExecResult } from '../platform/processes.ts';
import type { RepositorySetup, TestReportConfig } from '../schemas/brewery-config.ts';
import type { GravityReading, WorktreeRef } from '../schemas/events.ts';
import type { CheckRef } from '../schemas/recipe.ts';
import type { Git } from '../workspace/git.ts';
import { createFailingNames } from './failing-names.ts';
import {
  blocked,
  NO_CHECKS,
  type PlannedCheck,
  passed,
  planChecks,
  type RepositoryChecks,
  settleReadings,
} from './gravity.ts';
import {
  agreed,
  createStaleMap,
  type Fresh,
  surveyNeedsNoRun,
  withStale,
} from './map-agreement.ts';
import { createMappedProof } from './mapped-proof.ts';
import {
  coveragePath,
  fileReports,
  folderAt,
  moduleReports,
  pathsOf,
  type ReportFiles,
  type StepMaps,
  stepModules,
  testReportPath,
} from './module-reports.ts';
import type { MappedReport } from './red-proof.ts';
import { checksEnv, readingOn, runLine, runSetup, setupRunOf } from './setup.ts';
import {
  clearReportPaths,
  type EffectiveModule,
  type MapRead,
  type ReadManifestFreshness,
  type ReadTestMapAt,
  reportPaths,
  type touchedPaths,
  unclearable,
} from './test-map.ts';
import { createUncoveredCheck } from './uncovered-check.ts';

export type { RepositorySetup };

export interface CheckRunnerOptions {
  /** The folded state: the driver's, which has recorded the attempt's start and worktree. */
  state: () => State;
  /** The checks of the recipes' check steps (`loadRecipes`). */
  checks: StepChecks;
  /** The commands of a repository's checks (`foedrum.jsonc`), or undefined when it lists none. */
  repositoryChecks: (repo: string) => RepositoryChecks | undefined;
  /**
   * The test report a repository's test check writes (`foedrum.jsonc`): where a run's tests
   * outside the test map are found (ADR 0282); the red proof reads the map's reports (ADR 0297).
   */
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
    /** Where a repository's map is kept (ADR 0018); default in the repository. */
    keptIn?: (repo: string) => 'repo' | 'brewery';
    /** A map's manifests against a worktree's files (ADR 0282); default git's. */
    manifests?: ReadManifestFreshness;
    /** The paths among some globs that a range of commits changed, read in the clone; default git's. */
    touched?: ReturnType<typeof touchedPaths>;
    /** A module's coverage report in a worktree (ADR 0274). Default the file system's. */
    coverage?: (format: CoverageFormat, path: string, root: string) => ReadCoverage;
    /** A worktree's real path, where a sandboxed run writes its absolute paths. Default the file system's. */
    realPath?: (path: string) => string;
    /** Whether a report path is a folder. Default the file system's. */
    isFolder?: (path: string) => boolean;
    /** Whether a file a test's location may name is there. Default the file system's. */
    exists?: (path: string) => boolean;
  };
}

/**
 * The checks of a tree in a worktree, the repository's setup first: what a check step's attempt
 * runs, and the run on an open pull request's merged tree (ADR 0203).
 */
export type CheckTree = (
  refs: readonly CheckRef[],
  worktree: TreeIn,
  deadlineAt: string,
  signal: AbortSignal,
  /** For a merged tree, the commits it merges: where its test maps are read (ADR 0307). */
  merged?: MergedCommits,
) => Promise<AttemptEnd>;

/** The commits of an open pull request's merged tree: its head and the base's tip (ADR 0203). */
export interface MergedCommits {
  head: string;
  tip: string;
}

/** Where a tree is: its repository and its folder. */
export type TreeIn = Pick<WorktreeRef, 'repo' | 'path'>;

/**
 * The repository's test check run in a scratch tree, its setup first, and the test reports the
 * modules wrote where the test map says (ADR 0313); or why it did not run or its reports cannot be
 * read.
 */
export type TestRun = (
  tree: TreeIn,
  modules: readonly EffectiveModule[],
  deadlineAt: string,
  signal: AbortSignal,
) => Promise<TestRunEnd>;

/** What a test run read: the test check's reading and each module's reports, or why none. */
export type TestRunEnd =
  | { kind: 'ran'; reading: GravityReading; reports: readonly MappedReport[] }
  | { kind: 'unrun'; why: string };

/** The check runner, the checks of a tree it runs a check step's through, and a tree's tests. */
export type CheckRunner = BrewerRunner & { checkTree: CheckTree; testRun: TestRun };

export function createCheckRunner(options: CheckRunnerOptions): CheckRunner {
  const { state, checks, exec, clock, platform = process.platform } = options;
  const reports = options.reports ?? fileReports;
  const env = checksEnv(options.env, platform);
  // The attempts it runs, by key, with when they started: their progress for the heartbeat.
  const running = new Map<string, AttemptProgress>();
  const testReportsOf = moduleReports({
    reports,
    find: options.testMap?.reports ?? reportPaths,
    isFolder: options.testMap?.isFolder ?? folderAt,
  });
  const { namingFailing, namedTestsRead, mergedNaming } = createFailingNames({
    ...options,
    testReportsOf,
  });
  const uncovered = createUncoveredCheck({ ...options, platform, testReportsOf });

  /** What one run of `check` read on this platform (ADR 0076). */
  const readingIn = (check: Extract<PlannedCheck, { kind: 'run' }>, result: ExecResult) =>
    readingOn(check, result, checksRunUnsandboxed(platform));

  /** Runs one check in the worktree through the checks' process runner, its sandbox (ADR 0076). */
  const runCheck = (
    check: Extract<PlannedCheck, { kind: 'run' }>,
    worktree: TreeIn,
    deadlineAt: string,
    signal: AbortSignal,
    belowNormal = false,
  ): Promise<ExecResult> =>
    runLine(exec, check.command, {
      cwd: worktree.path,
      env,
      deadlineAt,
      now: clock,
      signal,
      belowNormal,
    });

  /**
   * The repository's setup running, or undefined when it has none: then nothing is awaited, so
   * the first check starts at once, before the engine could stop the attempt.
   */
  const prepare = (
    worktree: TreeIn,
    deadlineAt: string,
    signal: AbortSignal,
    belowNormal = false,
  ): Promise<GravityReading[]> | undefined => {
    const found = options.setup?.of(worktree.repo);
    if (options.setup === undefined || found === undefined) return undefined;
    const run = { cwd: worktree.path, env, deadlineAt, now: clock, signal, belowNormal };
    // Once the step needs nothing else before its checks (ADR 0140).
    return runSetup(options.setup.exec, setupRunOf(found, platform), run).then((read) => [read]);
  };

  /** Where the batch's change in `repo` starts: the base it merged, else its start (ADR 0164). */
  const baseOf = (batch: Batch, repo: string): string | undefined =>
    mergedBase(state(), batch.id) ?? batch.starts?.[repo.toLowerCase()]?.commit;

  const { proveRed } = createMappedProof({
    ...options,
    platform,
    reports,
    testReportsOf,
    readingIn,
    runCheck,
    prepare,
    baseOf,
  });

  /**
   * The checks `refs` of the tree in `worktree`, the repository's setup first: a check step's
   * attempt's, and the merged tree of an open pull request (ADR 0203).
   */
  const checkTree: CheckTree = async (refs, worktree, deadlineAt, signal, merged) => {
    const end = await checksOf(refs, worktree, deadlineAt, signal);
    return merged === undefined ? end : mergedNaming(end, worktree, merged, signal);
  };

  /**
   * The checks `refs` of the tree in `worktree`, as `checkTree` runs them, before any naming; below
   * normal priority for a scratch tree's test run (ADR 0413).
   */
  const checksOf = async (
    refs: readonly CheckRef[],
    worktree: TreeIn,
    deadlineAt: string,
    signal: AbortSignal,
    belowNormal = false,
  ): Promise<AttemptEnd> => {
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
      ? prepare(worktree, deadlineAt, signal, belowNormal)
      : undefined;
    const before = preparing === undefined ? [] : await preparing;
    if (!before.every(passed)) return { ending: settleReadings(before), readings: before };
    const readings: GravityReading[] = [...before];
    for (const check of planned) {
      if (check.kind === 'skip') {
        readings.push({ result: 'skipped', check: check.check });
        continue;
      }
      const ran = await runCheck(check, worktree, deadlineAt, signal, belowNormal);
      const reading = readingIn(check, ran);
      readings.push(reading);
      if (!passed(reading)) break;
    }
    return { ending: settleReadings(readings), readings };
  };

  /**
   * The test check in a scratch tree (ADR 0313): every report path of `modules` cleared, since a
   * report the commit holds must never stand for the run's, the setup and the test check run below
   * normal priority (ADR 0413), and each module's reports read where the map says. A TRX report is
   * left unread (#727).
   */
  const testRun: TestRun = async (tree, modules, deadlineAt, signal) => {
    const read = modules.filter(({ module }) => module.testReport.format !== 'trx');
    const patterns = read.map(({ module }) => module.testReport.path);
    const find = options.testMap?.reports ?? reportPaths;
    const unclear =
      patterns.map(unclearable).find((reason) => reason !== undefined) ??
      (await clearReportPaths(patterns, tree.path, find, reports.clear));
    if (unclear !== undefined) {
      return { kind: 'unrun', why: `the test reports cannot be cleared: ${unclear}` };
    }
    const end = await checksOf(['test'], tree, deadlineAt, signal, true);
    const readings = end.readings ?? [];
    const reading = readings.find((each) => each.check === 'test');
    if (reading === undefined) {
      const why = end.ending.kind === 'blocked' ? end.ending.summary : 'the test check did not run';
      const setup = readings.find((each) => !passed(each));
      return {
        kind: 'unrun',
        why: setup === undefined ? why : `the repository's setup did not pass: ${setup.result}`,
      };
    }
    const wrote: MappedReport[] = [];
    for (const { module } of read) {
      const found = testReportsOf(module, tree);
      if ('stuck' in found) return { kind: 'unrun', why: found.stuck };
      if ('failed' in found) return { kind: 'unrun', why: found.failed };
      wrote.push(...found.reports);
    }
    return { kind: 'ran', reading, reports: wrote };
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
    // A survey's check reads the map the survey proposed against one run (ADR 0298): none when the
    // survey found the map fresh, or kept by the Brewery.
    const survey = checks.surveys?.(recipe, stepId);
    if (survey !== undefined && surveyNeedsNoRun(batch, survey.of)) {
      return { ending: { kind: 'succeeded', output: null } };
    }
    // The test map matters to a step that runs the tests: a red proof, or a step with a test check.
    // Without maps nothing is awaited, so the first check starts at once, before the engine could
    // stop the attempt.
    const reads = options.testMap !== undefined && (of !== undefined || refs.includes('test'));
    const fresh = reads ? await manifests(batch, worktree, signal) : {};
    if ('end' in fresh) {
      return survey === undefined ? fresh.end : agreed(batch, ref, worktree, survey, fresh.end);
    }
    // A check step's test reading also reads the coverage of the change and the skips its tests
    // report (ADR 0274): the reports an earlier run left are cleared first, so none stands for
    // this run's or adds its hits to it.
    const maps =
      of === undefined && options.testMap !== undefined && refs.includes('test')
        ? await stepMapsOf(batch, worktree, signal, fresh.tip)
        : undefined;
    if (maps !== undefined) {
      for (const [report, path] of [
        ['a coverage report', coveragePath],
        ['a test report', testReportPath],
      ] as const) {
        const paths = pathsOf(maps, path);
        const why =
          paths.map(unclearable).find((reason) => reason !== undefined) ??
          (await clearReportPaths(
            paths,
            worktree.path,
            options.testMap?.reports ?? reportPaths,
            reports.clear,
          ));
        if (why !== undefined) {
          return blocked('environment', `${report} of the test map cannot be cleared: ${why}`);
        }
      }
    }
    const end =
      of !== undefined
        ? await proveRed(batch, ref, worktree, current.deadlineAt, of, signal)
        : await checkTree(refs, worktree, current.deadlineAt, signal);
    const judged = await afterRun(batch, worktree, end, fresh, maps, signal, survey !== undefined);
    if (survey !== undefined) return agreed(batch, ref, worktree, survey, judged);
    return maps === undefined ? judged : namedTestsRead(batch, judged, worktree, maps);
  };

  const { manifests, staleByRun } = createStaleMap({
    ...options,
    platform,
    testReportsOf,
    baseOf,
  });

  /**
   * `end` once the checks ran, judged by `afterTest`, with the test map recorded stale when it was
   * before the run or a passing run disagrees with it (ADR 0282).
   */
  const afterRun = async (
    batch: Batch,
    worktree: WorktreeRef,
    end: AttemptEnd,
    { tip, stale }: Fresh,
    read: StepMaps | undefined,
    signal: AbortSignal,
    surveying: boolean,
  ): Promise<AttemptEnd> => {
    const named = [...(stale?.named ?? [])];
    const kept = stale?.kept ?? options.testMap?.keptIn?.(worktree.repo) ?? 'repo';
    // A repository with no map has none to be stale by a run.
    const byRun =
      tip?.kind === 'map'
        ? (modules: readonly EffectiveModule[]) => named.push(...staleByRun(worktree, modules))
        : undefined;
    const judged = await afterTest(batch, worktree, end, read, signal, byRun, surveying);
    return withStale(judged, worktree.repo, kept, named);
  };

  /**
   * A check step's test maps, where the batch's change starts and at the worktree's commit, which
   * `tip` holds when the freshness read already read it.
   */
  const stepMapsOf = async (
    batch: Batch,
    worktree: WorktreeRef,
    signal: AbortSignal,
    tip?: MapRead,
  ): Promise<StepMaps | undefined> => {
    const { testMap } = options;
    if (testMap === undefined) return undefined;
    const { repo } = worktree;
    const base = baseOf(batch, repo);
    const before: MapRead =
      base === undefined ? { kind: 'none' } : await testMap.at(repo, base, signal);
    const after = tip ?? (await testMap.at(repo, worktree.commit, signal));
    return { base, before, after };
  };

  /**
   * `end`, or once the test check passed: Stuck on the environment for a module only the batch's
   * test map lists whose report path holds no report, since no confirmed line reaches it, or for a
   * check step, failed on a changed line no test ran (ADR 0274). A module the base's map lists is
   * taken as reached, as the base is taken as green. Once every module is reached, `reached` gets
   * the effective map's modules, for freshness by the run (ADR 0282).
   */
  const afterTest = async (
    batch: Batch,
    worktree: WorktreeRef,
    end: AttemptEnd,
    read: StepMaps | undefined,
    signal: AbortSignal,
    reached?: (modules: readonly EffectiveModule[]) => void,
    /** A survey's check, which sends a module no line reaches back to the survey (ADR 0298). */
    surveying = false,
  ): Promise<AttemptEnd> => {
    const { testMap } = options;
    const test = end.readings?.find(
      (reading): reading is Extract<GravityReading, { result: 'exited' }> =>
        reading.result === 'exited' && reading.check === 'test',
    );
    // Only a passing run says a module no report came from was not reached, or that the map is
    // stale by it: a failing one may have stopped before it, so its own verdict stands and goes
    // along onFail (ADR 0280).
    if (testMap === undefined || test === undefined) return end;
    if (test.exitCode !== 0)
      return read === undefined ? end : namingFailing(end, test, worktree, read);
    const { repo } = worktree;
    const ended = (ending: AttemptEnd['ending']): AttemptEnd => ({ ...end, ending });
    const stuck = (why: string): AttemptEnd => ended(blocked('environment', why).ending);
    const maps = read ?? (await stepMapsOf(batch, worktree, signal));
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
    const modules = stepModules(before, after.map);
    const find = testMap.reports ?? reportPaths;
    for (const { module, added } of modules) {
      if (!added) continue;
      const { name, testReport } = module;
      const found = find(testReport.path, worktree.path);
      if ('refused' in found) {
        return stuck(`the test report of module "${name}" cannot be looked for: ${found.refused}`);
      }
      if (found.paths.length > 0) continue;
      if (surveying) {
        const reason = `module "${name}" wrote no test report at ${testReport.path}`;
        return ended({ kind: 'failed', retryable: false, reason });
      }
      const why = [
        `module "${name}" of the test map is new in this batch, and no confirmed line reaches it:`,
        `the test check wrote no test report at ${testReport.path};`,
        `make "checks"."test" of ${repo} in foedrum.jsonc, now "${test.command}", also run its tests,`,
        `whatever the tests before them give (ADR 0023, ADR 0274).`,
        `The test check's output ended: ${test.tail}`,
      ].join(' ');
      return stuck(why);
    }
    reached?.(modules);
    // A red proof reads no coverage: the uncovered-line check is a check step's (ADR 0274).
    // A step another check already failed or blocked keeps that ending.
    if (read === undefined || base === undefined || end.ending.kind !== 'succeeded') return end;
    return uncovered(end, worktree, { base, before, after: after.map }, signal);
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
    testRun,
  };
}
