// The check runner (ADR 0069): runs the attempts of check steps, the gravity readings. For an attempt
// the driver started, it runs the step's checks one after another in the attempt's worktree through
// the platform shell and the process runner, which kills the whole tree at the step's deadline or
// when the engine stops the attempt; the first check that does not pass ends the step. No model.
// A red proof runs the test check and judges the structured test report against the tests the
// proven step committed, never the exit code (ADR 0078).

import { basename, dirname, join, relative, sep } from 'node:path';
import { type AttemptRef, attemptKey } from '../engine/attempt-key.ts';
import { mergedBase } from '../engine/base-merge.ts';
import type { Env } from '../engine/brewer-env.ts';
import type { AttemptEnd, BrewerRunner } from '../engine/brewer-runner.ts';
import type { Batch, State } from '../engine/fold.ts';
import type { StepChecks } from '../engine/recipe-files.ts';
import type { AttemptProgress } from '../engine/supervisor.ts';
import { parseJunit } from '../formats/junit.ts';
import { parseTap } from '../formats/tap.ts';
import { MAX_REPORT_BYTES, type TestReport } from '../formats/test-report.ts';
import type { DiffFile } from '../formats/unified-diff.ts';
import { type BoundedRead, readOutDocFile } from '../platform/bounded-read.ts';
import { checksRunUnsandboxed } from '../platform/check-sandbox.ts';
import { foldsCase, pathInside } from '../platform/paths.ts';
import type { ExecProcess, ExecResult } from '../platform/processes.ts';
import { realPath } from '../platform/real-path.ts';
import { removeTree } from '../platform/remove.ts';
import type { RepositorySetup, TestReportConfig } from '../schemas/brewery-config.ts';
import type { GravityReading, WorktreeRef } from '../schemas/events.ts';
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
import { judgeMapped, judgeRed, needsTestReport } from './red-proof.ts';
import { checksEnv, readingOn, runLine, runSetup, setupRunOf } from './setup.ts';
import { readDiff, readTestFiles, stepCommits, stepTests } from './step-commits.ts';
import {
  clearReportPaths,
  type EffectiveModule,
  effectiveMap,
  type MapRead,
  type ReadTestMapAt,
  reportPaths,
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

/** The test maps of a red proof's repository: none, or the base's and the batch's (ADR 0274). */
type Maps =
  | { kind: 'none' }
  | { kind: 'maps'; base?: { commit: string; map: TestMap }; batch?: TestMap };

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
   * The test maps of a red proof's repository at the batch's base and at the proven tip (ADR 0274),
   * or how the step ends: Stuck when the base's map cannot be read, failed for its onFail route
   * when the batch's own map cannot be, as after any test check.
   */
  const mapsOf = async (
    batch: Batch,
    worktree: WorktreeRef,
    signal: AbortSignal,
  ): Promise<Maps | AttemptEnd> => {
    const { testMap } = options;
    if (testMap === undefined) return { kind: 'none' };
    const { repo } = worktree;
    // Where the batch's change starts: the base it merged, else its start (ADR 0164).
    const base = mergedBase(state(), batch.id) ?? batch.starts?.[repo.toLowerCase()]?.commit;
    const before: MapRead =
      base === undefined ? { kind: 'none' } : await testMap.at(repo, base, signal);
    if (before.kind === 'unreadable') {
      const why = `the test map of ${repo} at ${base} cannot be read: ${before.reason}`;
      return blocked('environment', why);
    }
    const after = await testMap.at(repo, worktree.commit, signal);
    if (after.kind === 'unreadable') {
      const reason = `the test map of ${repo} at ${worktree.commit} cannot be read: ${after.reason}`;
      return { ending: { kind: 'failed', retryable: false, reason } };
    }
    if (before.kind === 'none' && after.kind === 'none') return { kind: 'none' };
    return {
      kind: 'maps',
      ...(before.kind === 'map' && base !== undefined
        ? { base: { commit: base, map: before.map } }
        : {}),
      ...(after.kind === 'map' ? { batch: after.map } : {}),
    };
  };

  /**
   * The modules of the effective map (ADR 0274): a base module drops out only when the batch
   * deleted every file the base had under its areas, so git lists the base's files only when the
   * batch deleted one. A TRX report, which Foedrum does not read, sticks the step before its run.
   */
  const modulesOf = async (
    maps: Extract<Maps, { kind: 'maps' }>,
    repo: string,
    tip: string,
    signal: AbortSignal,
  ): Promise<EffectiveModule[] | AttemptEnd> => {
    const files = { atBase: [] as string[], deleted: [] as string[] };
    if (maps.base !== undefined) {
      const { commit } = maps.base;
      const list = async (args: string[]): Promise<string[] | string> => {
        const options = { maxOutputBytes: MAX_REPORT_BYTES, signal };
        const result = await git(clone(repo), args, options);
        if (result.code === 0) return result.stdout.split('\0').filter((path) => path !== '');
        const last = result.stderr.trim().split(/\r?\n/).at(-1);
        return last === undefined || last === '' ? `git exited with ${result.code}` : last;
      };
      const deleted = await list([
        'diff',
        '--name-only',
        '-z',
        '--no-renames',
        '--diff-filter=D',
        commit,
        tip,
      ]);
      if (typeof deleted === 'string') {
        return blocked(
          'environment',
          `the files deleted since ${commit} cannot be read: ${deleted}`,
        );
      }
      if (deleted.length > 0) {
        const atBase = await list(['ls-tree', '-r', '-z', '--name-only', commit]);
        if (typeof atBase === 'string') {
          return blocked('environment', `the files at ${commit} cannot be read: ${atBase}`);
        }
        files.atBase = atBase;
        files.deleted = deleted;
      }
    }
    const modules = effectiveMap(maps.base?.map, maps.batch, files, foldsCase(platform));
    const trx = modules.find(({ module }) => module.testReport.format === 'trx');
    if (trx !== undefined) {
      return blocked(
        'environment',
        `module "${trx.module.name}" of the test map writes a TRX test report, which Foedrum does not read yet: make its tests write JUnit XML (such as with JunitXml.TestLogger) and name that in the test map (ADR 0274)`,
      );
    }
    return modules;
  };

  /**
   * A red proof in a repository with a test map (ADR 0274): every report path of the map cleared,
   * the confirmed test line run once, and each module's report read where the map says, judged by
   * the five checks that read no test's name. A module the base lists that wrote no report is a
   * load error; one only the batch lists is left to the unreached rule after a passing run.
   */
  const proveMapped = async (
    modules: readonly EffectiveModule[],
    worktree: WorktreeRef,
    deadlineAt: string,
    of: string,
    signal: AbortSignal,
    check: Extract<PlannedCheck, { kind: 'run' }>,
    before: GravityReading[],
    diff: readonly DiffFile[],
  ): Promise<AttemptEnd> => {
    const find = options.testMap?.reports ?? reportPaths;
    const patterns = modules.flatMap(({ module }) => [
      module.testReport.path,
      ...(module.coverage === 'none' ? [] : [module.coverage.path]),
    ]);
    // A report an earlier run left must never stand for this run's, nor merge its hits into it.
    const unclear = await clearReportPaths(patterns, worktree.path, find, reports.clear);
    if (unclear !== undefined) {
      return blocked('environment', `the reports of the test map cannot be cleared: ${unclear}`);
    }
    const reading = readingIn(check, await runCheck(check, worktree, deadlineAt, signal));
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
    const stuck = (why: string): AttemptEnd => ({ ...blocked('environment', why), readings });
    const read: TestReport[] = [];
    const unreported: string[] = [];
    for (const { module, added } of modules) {
      const { name, testReport } = module;
      const found = find(testReport.path, worktree.path);
      if ('refused' in found) {
        return stuck(`the test report of module "${name}" cannot be looked for: ${found.refused}`);
      }
      let wrote = 0;
      for (const file of found.paths) {
        const shown = relative(worktree.path, file).split(sep).join('/');
        const text = reports.read(file, worktree.path);
        if (text.kind === 'missing') continue;
        if (text.kind === 'unread') {
          return failed(
            `the test report ${shown} of module "${name}" cannot be read: ${text.reason}`,
          );
        }
        const parsed = testReport.format === 'tap' ? parseTap(text.text) : parseJunit(text.text);
        if (!parsed.readable) {
          const format = testReport.format === 'tap' ? 'TAP' : 'JUnit XML';
          return failed(
            `the test report ${shown} of module "${name}" is not ${format}: ${parsed.reason}`,
          );
        }
        read.push(parsed.report);
        wrote++;
      }
      // A module the batch added that wrote nothing may be one no confirmed line reaches (ADR 0280).
      if (added) continue;
      if (wrote === 0)
        unreported.push(`module "${name}" wrote no test report at ${testReport.path}`);
      if (module.coverage === 'none') continue;
      const coverage = find(module.coverage.path, worktree.path);
      if ('refused' in coverage) {
        return stuck(
          `the coverage report of module "${name}" cannot be looked for: ${coverage.refused}`,
        );
      }
      if (coverage.paths.length === 0) {
        unreported.push(`module "${name}" wrote no coverage report at ${module.coverage.path}`);
      }
    }
    const verdict = judgeMapped({
      reports: read,
      unreported,
      diff,
      modules,
      root: worktree.path,
      foldCase: foldsCase(platform),
    });
    if (!verdict.proven) return failed(verdict.why);
    return { ending: { kind: 'succeeded', output: null }, readings };
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
    // A repository with a test map proves red from its modules' reports, reading no test names;
    // one without proves it from foedrum.jsonc's test report, by name, until #708 (ADR 0274).
    const maps = await mapsOf(batch, worktree, signal);
    if ('ending' in maps) return maps;
    const report = options.testReport(worktree.repo);
    if (maps.kind === 'none' && report === undefined) {
      return blocked('environment', needsTestReport(recipe, worktree.repo));
    }
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
    const modules =
      maps.kind === 'maps' ? await modulesOf(maps, worktree.repo, worktree.commit, signal) : [];
    if ('ending' in modules) return modules;
    // The repository's setup once nothing else blocks the run, so the run finds what it
    // installed (ADR 0140).
    const preparing = prepare(worktree, deadlineAt, signal);
    const before = preparing === undefined ? [] : await preparing;
    if (!before.every(passed)) return { ending: settleReadings(before), readings: before };
    if (maps.kind === 'maps' || report === undefined) {
      return proveMapped(modules, worktree, deadlineAt, of, signal, check, before, diff.files);
    }
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
    const end =
      of !== undefined
        ? await proveRed(batch, ref, worktree, current.deadlineAt, of, signal)
        : await checkTree(refs, worktree, current.deadlineAt, signal);
    return unreached(batch, worktree, end, signal);
  };

  /**
   * `end`, or once the test check ran, Stuck on the environment for a module only the batch's test
   * map lists whose report path holds no report: no confirmed line reaches it (ADR 0274). A module
   * the base's map lists is taken as reached, as the base is taken as green.
   */
  const unreached = async (
    batch: Batch,
    worktree: WorktreeRef,
    end: AttemptEnd,
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
    // Where the batch's change starts: the base it merged, else its start (ADR 0164).
    const base = mergedBase(state(), batch.id) ?? batch.starts?.[repo.toLowerCase()]?.commit;
    const before: MapRead =
      base === undefined ? { kind: 'none' } : await testMap.at(repo, base, signal);
    if (before.kind === 'unreadable') {
      return stuck(`the test map of ${repo} at ${base} cannot be read: ${before.reason}`);
    }
    const after = await testMap.at(repo, worktree.commit, signal);
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
    return end;
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
