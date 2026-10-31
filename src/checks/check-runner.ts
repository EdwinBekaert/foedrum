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
import { parseJunit } from '../formats/junit.ts';
import { parseTap } from '../formats/tap.ts';
import { MAX_REPORT_BYTES } from '../formats/test-report.ts';
import { type BoundedRead, readOutDocFile } from '../platform/bounded-read.ts';
import { checksRunUnsandboxed } from '../platform/check-sandbox.ts';
import { pathInside } from '../platform/paths.ts';
import type { ExecProcess, ExecResult } from '../platform/processes.ts';
import { realPath } from '../platform/real-path.ts';
import { removeTree } from '../platform/remove.ts';
import type { RepositorySetup, TestReportConfig } from '../schemas/brewery-config.ts';
import {
  type GravityReading,
  MOST_STALE_PATHS,
  type StaleMap,
  type WorktreeRef,
} from '../schemas/events.ts';
import type { CheckRef } from '../schemas/recipe.ts';
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
import { readDiff, readTestFiles, stepCommits, stepTests } from './step-commits.ts';
import {
  type EffectiveModule,
  effectiveMap,
  type MapRead,
  manifestFreshness,
  type ReadManifestFreshness,
  type ReadTestMapAt,
  reportPaths,
  reportUnder,
  TEST_MAP_PATH,
  touchedPaths,
} from './test-map.ts';

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
    /** Where a repository's map is kept (ADR 0018); default in the repository. */
    keptIn?: (repo: string) => 'repo' | 'brewery';
    /** A map's manifests against a worktree's files (ADR 0282); default git's. */
    manifests?: ReadManifestFreshness;
    /** The paths among some globs that a range of commits changed, read in the clone; default git's. */
    touched?: ReturnType<typeof touchedPaths>;
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

/**
 * What a check step read of its test map before the run (ADR 0282): the map at its tip, and the
 * stale manifests it names without failing for them, with where the map is kept.
 */
interface Fresh {
  tip?: MapRead;
  stale?: { kept: StaleMap['kept']; named: readonly string[] };
}

/** The most of one stale path a reason or the event keeps. */
const STALE_PATH_LENGTH = 1_000;

/** Up to `MOST_STALE_PATHS` of `named`, with a count of the rest. */
const listOf = (named: readonly string[]): string => {
  const more = named.length - MOST_STALE_PATHS;
  return `${named.slice(0, MOST_STALE_PATHS).join(', ')}${more > 0 ? ` and ${more} more` : ''}`;
};

/** `end` with the test map of `repo` recorded stale by `named`, when it names any (ADR 0282). */
const withStale = (
  end: AttemptEnd,
  repo: string,
  kept: StaleMap['kept'],
  named: readonly string[],
): AttemptEnd =>
  named.length === 0
    ? end
    : {
        ...end,
        staleMap: {
          repo,
          kept,
          paths: named.slice(0, MOST_STALE_PATHS).map((path) => path.slice(0, STALE_PATH_LENGTH)),
          more: Math.max(0, named.length - MOST_STALE_PATHS),
        },
      };

// None of a repository's checks: what a step of literal commands plans against.
const NO_CHECKS: RepositoryChecks = {
  build: null,
  typecheck: null,
  lint: null,
  format: null,
  test: null,
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
    // The test map matters to a step that runs the tests: a red proof, or a step with a test check.
    const fresh =
      of !== undefined || refs.includes('test') ? await manifests(batch, worktree, signal) : {};
    if ('end' in fresh) return fresh.end;
    const end =
      of !== undefined
        ? await proveRed(batch, ref, worktree, current.deadlineAt, of, signal)
        : await checkTree(refs, worktree, current.deadlineAt, signal);
    return afterRun(batch, worktree, end, fresh, signal);
  };

  /** Where the batch's change in `repo` starts: the base it merged, else its start (ADR 0164). */
  const baseOf = (batch: Batch, repo: string): string | undefined =>
    mergedBase(state(), batch.id) ?? batch.starts?.[repo.toLowerCase()]?.commit;

  /**
   * The test map at the step's tip and how it compares with its manifests before the run (ADR 0282):
   * a map in the repository that the batch's change left stale, by touching it or a manifest its
   * globs match, fails the step back along its onFail route, so its brewer updates the map in its
   * change (ADR 0274). A map the batch did not make stale, or the Brewery's, which a batch cannot
   * change, is only named.
   */
  const manifests = async (
    batch: Batch,
    worktree: WorktreeRef,
    signal: AbortSignal,
  ): Promise<{ end: AttemptEnd } | Fresh> => {
    const { testMap } = options;
    if (testMap === undefined) return {};
    const { repo } = worktree;
    const tip = await testMap.at(repo, worktree.commit, signal);
    if (tip.kind !== 'map') return { tip };
    const read = testMap.manifests ?? manifestFreshness(git);
    const found = await read(worktree.path, tip.map, signal);
    if (found.kind === 'fresh') return { tip };
    if (found.kind === 'unread') {
      const why = `the manifests of the test map of ${repo} cannot be listed: ${found.reason}`;
      return { end: blocked('environment', why) };
    }
    const named = [
      ...found.added.map((path) => `${path} (added)`),
      ...found.removed.map((path) => `${path} (removed)`),
    ];
    const kept = testMap.keptIn?.(repo) ?? 'repo';
    const base = baseOf(batch, repo);
    if (kept === 'repo' && base !== undefined) {
      const touched = testMap.touched ?? touchedPaths(git, clone);
      const paths = [TEST_MAP_PATH, ...tip.map.derivedFrom.globs];
      const changed = await touched(repo, base, worktree.commit, paths, signal);
      if ('unread' in changed) {
        const why = `the files the change of ${repo} touched cannot be read: ${changed.unread}`;
        return { end: blocked('environment', why) };
      }
      if (changed.paths.length > 0) {
        const reason = [
          `the test map of ${repo} is stale: its derivedFrom.globs match ${listOf(named)};`,
          `update ${TEST_MAP_PATH} in this change (ADR 0274, ADR 0282)`,
        ].join(' ');
        return { end: { ending: { kind: 'failed', retryable: false, reason } } };
      }
    }
    return { tip, stale: { kept, named } };
  };

  /**
   * `end`, once the test check ran and passed: Stuck for a module no confirmed line reaches, else
   * with the test map recorded stale when it was before the run or the run disagrees with it.
   */
  const afterRun = async (
    batch: Batch,
    worktree: WorktreeRef,
    end: AttemptEnd,
    { tip, stale }: Fresh,
    signal: AbortSignal,
  ): Promise<AttemptEnd> => {
    const { testMap } = options;
    const test = end.readings?.find(
      (reading): reading is Extract<GravityReading, { result: 'exited' }> =>
        reading.result === 'exited' && reading.check === 'test',
    );
    const named = [...(stale?.named ?? [])];
    const kept = stale?.kept ?? testMap?.keptIn?.(worktree.repo) ?? 'repo';
    // Only a passing run says a module no report came from was not reached, or that the map is
    // stale by it: a failing one may have stopped before it, so its own verdict stands and goes
    // along onFail (ADR 0280).
    // A repository with no map has none to be stale (ADR 0282).
    if (testMap !== undefined && tip !== undefined && tip.kind !== 'none' && test?.exitCode === 0) {
      const judged = await unreached(batch, worktree, end, tip, test, signal);
      if ('end' in judged) return withStale(judged.end, worktree.repo, kept, named);
      named.push(...staleByRun(worktree, judged.modules));
    }
    return withStale(end, worktree.repo, kept, named);
  };

  /**
   * Stuck on the environment for a module only the batch's test map lists whose report path holds
   * no report: no confirmed line reaches it (ADR 0274), or else the modules of the effective map.
   * A module the base's map lists is taken as reached, as the base is taken as green.
   */
  const unreached = async (
    batch: Batch,
    worktree: WorktreeRef,
    end: AttemptEnd,
    after: MapRead,
    test: Extract<GravityReading, { result: 'exited' }>,
    signal: AbortSignal,
  ): Promise<{ end: AttemptEnd } | { modules: EffectiveModule[] }> => {
    const testMap = options.testMap;
    if (testMap === undefined || after.kind === 'none') return { modules: [] };
    const { repo } = worktree;
    const ended = (ending: AttemptEnd['ending']) => ({ end: { ...end, ending } });
    const stuck = (why: string) => ended(blocked('environment', why).ending);
    const base = baseOf(batch, repo);
    const before: MapRead =
      base === undefined ? { kind: 'none' } : await testMap.at(repo, base, signal);
    if (before.kind === 'unreadable') {
      return stuck(`the test map of ${repo} at ${base} cannot be read: ${before.reason}`);
    }
    // The batch's own map: the same tree reads the same, so the step's onFail route sends it back
    // to the brewer that broke it.
    if (after.kind === 'unreadable') {
      const reason = `the test map of ${repo} at ${worktree.commit} cannot be read: ${after.reason}`;
      return ended({ kind: 'failed', retryable: false, reason });
    }
    const modules = effectiveMap(
      before.kind === 'map' ? before.map : undefined,
      after.map,
      { atBase: [], deleted: [] },
      false,
    );
    const find = testMap.reports ?? reportPaths;
    for (const { module, added } of modules) {
      if (!added) continue;
      const { name, testReport } = module;
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
    return { modules };
  };

  /**
   * Where a passing run disagrees with the effective map (ADR 0274, ADR 0282): a module the base
   * lists whose report path holds no report, and the test report `foedrum.jsonc` names written
   * under no module's report path. A module only the batch adds was looked for already.
   */
  const staleByRun = (worktree: WorktreeRef, modules: readonly EffectiveModule[]): string[] => {
    const find = options.testMap?.reports ?? reportPaths;
    const holds = (pattern: string) => {
      const found = find(pattern, worktree.path);
      // A pattern that cannot be looked for says nothing of the run.
      return 'refused' in found || found.paths.length > 0;
    };
    const named = modules
      .filter(({ module, added }) => !added && !holds(module.testReport.path))
      .map(({ module }) => `${module.testReport.path} (no report of module "${module.name}")`);
    const written = options.testReport(worktree.repo)?.path;
    if (written === undefined) return named;
    const patterns = modules.flatMap(({ module: { testReport, coverage } }) => [
      testReport.path,
      ...(coverage === 'none' ? [] : [coverage.path]),
    ]);
    if (patterns.some((pattern) => reportUnder(written, pattern))) return named;
    const found = find(written, worktree.path);
    if ('paths' in found && found.paths.length > 0) {
      named.push(`${written} (a report outside the map)`);
    }
    return named;
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
