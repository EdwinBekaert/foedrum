// The check runner (ADR 0069): runs the attempts of check steps, the gravity readings. For an attempt
// the driver started, it runs the step's checks one after another in the attempt's worktree through
// the platform shell and the process runner, which kills the whole tree at the step's deadline or
// when the engine stops the attempt; the first check that does not pass ends the step. No model.
// A red proof runs the test check and judges its structured reports, never the exit code: in a
// repository with a test map, each module's report by checks that read no test name (ADR 0274);
// in one without, the test report against the tests the proven step committed (ADR 0078).

import { existsSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
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
  isAbsolutePath,
  mergeReports,
  type ReadCoverage,
} from '../formats/coverage-report.ts';
import { parseJunit } from '../formats/junit.ts';
import { parseTap } from '../formats/tap.ts';
import { MAX_REPORT_BYTES } from '../formats/test-report.ts';
import type { DiffFile } from '../formats/unified-diff.ts';
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
  MOST_STALE_PATHS,
  type StaleMap,
  type WorktreeRef,
} from '../schemas/events.ts';
import type { CheckRef } from '../schemas/recipe.ts';
import type { TestMap, TestMapModule } from '../schemas/test-map.ts';
import type { Git } from '../workspace/git.ts';
import {
  type PlannedCheck,
  passed,
  planChecks,
  type RepositoryChecks,
  settleReadings,
} from './gravity.ts';
import {
  cut,
  judgeMapped,
  judgeRed,
  type MappedReport,
  needsTestReport,
  skipInAddedLines,
  testFileOf,
} from './red-proof.ts';
import { checksEnv, readingOn, runLine, runSetup, setupRunOf } from './setup.ts';
import { readDiff, readFilesAt, readTestFiles, stepCommits, stepTests } from './step-commits.ts';
import {
  areaOf,
  clearReportPaths,
  type EffectiveModule,
  effectiveMap,
  type MapRead,
  manifestFreshness,
  moduleFolders,
  type ReadManifestFreshness,
  type ReadTestMapAt,
  reportPaths,
  reportUnder,
  TEST_MAP_PATH,
  touchedPaths,
  unclearable,
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

/** The test maps of a red proof's repository: none, or the base's and the batch's (ADR 0274). */
type Maps =
  | { kind: 'none' }
  | { kind: 'maps'; base?: { commit: string; map: TestMap }; batch?: TestMap };

/** Whether `path` is a folder: a path that cannot be read is none. */
const folderAt = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
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

/** The report paths `of` gives each module either map lists, each once (ADR 0274). */
const pathsOf = (
  { before, after }: StepMaps,
  of: (module: TestMapModule) => string[],
): string[] => [
  ...new Set(
    [before, after].flatMap((read) => (read.kind === 'map' ? read.map.modules.flatMap(of) : [])),
  ),
];

/** A module's coverage report path, when it has a coverage tool. */
const coveragePath = ({ coverage }: TestMapModule): string[] =>
  coverage === 'none' ? [] : [coverage.path];

/** A module's test report path, when Foedrum reads its format: it reads no TRX yet. */
const testReportPath = ({ testReport }: TestMapModule): string[] =>
  testReport.format === 'trx' ? [] : [testReport.path];

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
        `module "${trx.module.name}" of the test map writes a TRX test report, which Foedrum does not read yet: make its tests write JUnit XML to a file and name that file in the test map (ADR 0274)`,
      );
    }
    return modules;
  };

  /**
   * The test reports `module` wrote where the test map says, after a run in `worktree`: why the
   * step is Stuck on its environment when its pattern is refused or names a folder, or why it
   * failed when a report cannot be read or is not of its format (ADR 0274).
   */
  const testReportsOf = (
    module: TestMapModule,
    worktree: WorktreeRef,
  ): { reports: MappedReport[] } | { stuck: string } | { failed: string } => {
    const find = options.testMap?.reports ?? reportPaths;
    const isFolder = options.testMap?.isFolder ?? folderAt;
    const { name, testReport } = module;
    const found = find(testReport.path, worktree.path);
    if ('refused' in found) {
      return {
        stuck: `the test report of module "${name}" cannot be looked for: ${found.refused}`,
      };
    }
    const read: MappedReport[] = [];
    for (const file of found.paths) {
      const shown = relative(worktree.path, file).split(sep).join('/');
      // A test report is a file: a folder is no report a brewer could fix by committing.
      if (isFolder(file)) {
        const extension = testReport.format === 'tap' ? 'tap' : 'xml';
        return {
          stuck: `the test report pattern ${testReport.path} of module "${name}" names a folder, ${shown}: name the report file in the test map, such as ${shown}/<file>.${extension} (ADR 0274)`,
        };
      }
      const text = reports.read(file, worktree.path);
      if (text.kind === 'missing') continue;
      if (text.kind === 'unread') {
        return {
          failed: `the test report ${shown} of module "${name}" cannot be read: ${text.reason}`,
        };
      }
      const parsed = testReport.format === 'tap' ? parseTap(text.text) : parseJunit(text.text);
      if (!parsed.readable) {
        const format = testReport.format === 'tap' ? 'TAP' : 'JUnit XML';
        return {
          failed: `the test report ${shown} of module "${name}" is not ${format}: ${parsed.reason}`,
        };
      }
      read.push({ ...parsed.report, module: name });
    }
    return { reports: read };
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
      ...coveragePath(module),
    ]);
    // A report an earlier run left must never stand for this run's, nor merge its hits into it.
    const unclear =
      patterns.map(unclearable).find((reason) => reason !== undefined) ??
      (await clearReportPaths(patterns, worktree.path, find, reports.clear));
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
    const read: MappedReport[] = [];
    const unreported: string[] = [];
    for (const { module, added } of modules) {
      const { name, testReport } = module;
      const wrote = testReportsOf(module, worktree);
      if ('stuck' in wrote) return stuck(wrote.stuck);
      if ('failed' in wrote) return failed(wrote.failed);
      read.push(...wrote.reports);
      // A module the batch added that wrote nothing may be one no confirmed line reaches (ADR 0280).
      if (added) continue;
      if (wrote.reports.length === 0)
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
    // The check's sandbox starts the run in the worktree's real path, where its runner writes
    // absolute paths when a link leads to the worktree (macOS's /tmp, a junction).
    const realRoot = (options.testMap?.realPath ?? realPath)(worktree.path);
    const verdict = judgeMapped({
      reports: read,
      unreported,
      diff,
      modules,
      root: worktree.path,
      ...(realRoot === worktree.path ? {} : { realRoot }),
      foldCase: foldsCase(platform),
    });
    if (!verdict.proven) return failed(verdict.why);
    return { ending: { kind: 'succeeded', output: null }, readings };
  };

  /**
   * A red proof: the test check's reading, then the reports it wrote, judged against what step
   * `of` committed; by the test map's modules where the repository has one (ADR 0274), else by
   * the names its tests declare (ADR 0078).
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
    // The test map matters to a step that runs the tests: a red proof, or a step with a test check.
    // Without maps nothing is awaited, so the first check starts at once, before the engine could
    // stop the attempt.
    const reads = options.testMap !== undefined && (of !== undefined || refs.includes('test'));
    const fresh = reads ? await manifests(batch, worktree, signal) : {};
    if ('end' in fresh) return fresh.end;
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
    return afterRun(batch, worktree, end, fresh, maps, signal);
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
  ): Promise<AttemptEnd> => {
    const named = [...(stale?.named ?? [])];
    const kept = stale?.kept ?? options.testMap?.keptIn?.(worktree.repo) ?? 'repo';
    // A repository with no map has none to be stale by a run.
    const byRun =
      tip?.kind === 'map'
        ? (modules: readonly EffectiveModule[]) => named.push(...staleByRun(worktree, modules))
        : undefined;
    const judged = await afterTest(batch, worktree, end, read, signal, byRun);
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
  ): Promise<AttemptEnd> => {
    const { testMap } = options;
    const test = end.readings?.find(
      (reading): reading is Extract<GravityReading, { result: 'exited' }> =>
        reading.result === 'exited' && reading.check === 'test',
    );
    // Only a passing run says a module no report came from was not reached, or that the map is
    // stale by it: a failing one may have stopped before it, so its own verdict stands and goes
    // along onFail (ADR 0280).
    if (testMap === undefined || test === undefined || test.exitCode !== 0) return end;
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
    reached?.(modules);
    // A red proof reads no coverage: the uncovered-line check is a check step's (ADR 0274).
    // A step another check already failed or blocked keeps that ending.
    if (read === undefined || base === undefined || end.ending.kind !== 'succeeded') return end;
    return uncovered(end, worktree, { base, before, after: after.map }, signal);
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
    named.push(...testsOutside(worktree, modules));
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

  /**
   * The files where the reports of the modules the base lists place a test outside every module's
   * areas, each named by its first test (ADR 0282). An absolute location is read under the worktree
   * or its real path; a relative one from the root, else from a folder of its own module's globs,
   * where a runner such as pytest writes from, wherever the file is. A location that names no file
   * of the worktree, and a report that cannot be read, say nothing of the map.
   */
  const testsOutside = (worktree: WorktreeRef, modules: readonly EffectiveModule[]): string[] => {
    const exists = options.testMap?.exists ?? existsSync;
    const real = (options.testMap?.realPath ?? realPath)(worktree.path);
    const roots = real === worktree.path ? [worktree.path] : [worktree.path, real];
    const foldCase = foldsCase(platform);
    const outside = new Map<string, string>();
    for (const { module, added } of modules) {
      // A TRX report's tests are left unread, as at the green check (#727).
      if (added || module.testReport.format === 'trx') continue;
      const wrote = testReportsOf(module, worktree);
      if (!('reports' in wrote)) continue;
      const folders = ['', ...moduleFolders(module).map((folder) => `${folder}/`)];
      for (const test of wrote.reports.flatMap(({ tests }) => tests)) {
        const file = testFileOf(test, roots);
        if (!test.leaf || file === undefined) continue;
        const path = isAbsolutePath(test.location?.file ?? '')
          ? file
          : folders
              .map((folder) => `${folder}${file}`)
              .find((each) => exists(join(worktree.path, each)));
        if (path === undefined) continue;
        const key = foldCase ? path.toLowerCase() : path;
        if (outside.has(key) || areaOf(modules, path, foldCase) !== undefined) continue;
        outside.set(key, `test ${cut(test.name)} at ${path} outside the map`);
      }
    }
    return [...outside.values()];
  };

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
