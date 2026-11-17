// The red proof in a repository with a test map (ADR 0274): the test maps at the batch's base and
// at the proven tip, the effective map's modules, every report path cleared, the test check run
// once, and each module's reports judged by the checks that read no test name. A batch with no map
// is refused before its first step (ADR 0297). No model.

import type { AttemptRef } from '../engine/attempt-key.ts';
import type { AttemptEnd } from '../engine/brewer-runner.ts';
import type { Batch } from '../engine/fold.ts';
import { MAX_REPORT_BYTES } from '../formats/test-report.ts';
import type { DiffFile } from '../formats/unified-diff.ts';
import { lastLine } from '../platform/errors.ts';
import { foldsCase } from '../platform/paths.ts';
import type { ExecResult } from '../platform/processes.ts';
import { realPath } from '../platform/real-path.ts';
import type { GravityReading, WorktreeRef } from '../schemas/events.ts';
import type { GaugeReport } from '../schemas/out-doc.ts';
import type { TestMap } from '../schemas/test-map.ts';
import type { CheckRunnerOptions, TreeIn } from './check-runner.ts';
import {
  blocked,
  NO_CHECKS,
  type PlannedCheck,
  passed,
  planChecks,
  settleReadings,
  shortCommand,
  withFailing,
} from './gravity.ts';
import { coveragePath, type ModuleReports, type ReportFiles } from './module-reports.ts';
import { unreportedNames, unreportedRecord } from './named-tests.ts';
import { judgeMapped, type MappedReport, needsTestMap } from './red-proof.ts';
import { readDiff, stepCommits, stepTests } from './step-commits.ts';
import {
  clearReportPaths,
  type EffectiveModule,
  effectiveMap,
  type MapRead,
  reportPaths,
  unclearable,
} from './test-map.ts';

/** The test maps of a red proof's repository: none, or the base's and the batch's (ADR 0274). */
type Maps =
  | { kind: 'none' }
  | { kind: 'maps'; base?: { commit: string; map: TestMap }; batch?: TestMap };

/** A red proof of a check step: `proveRed` runs it for the step `of` proves. */
export interface MappedProof {
  proveRed: (
    batch: Batch,
    ref: AttemptRef,
    worktree: WorktreeRef,
    deadlineAt: string,
    of: string,
    signal: AbortSignal,
  ) => Promise<AttemptEnd>;
}

/** What a red proof uses of the check runner: its options and how it runs a check and the setup. */
export interface MappedProofOptions
  extends Pick<CheckRunnerOptions, 'repositoryChecks' | 'git' | 'clone' | 'testMap'> {
  platform: NodeJS.Platform;
  reports: ReportFiles;
  testReportsOf: ModuleReports;
  /** Where the batch's change in `repo` starts: the base it merged, else its start (ADR 0164). */
  baseOf: (batch: Batch, repo: string) => string | undefined;
  /** What one run of `check` read on this platform (ADR 0076). */
  readingIn: (check: Extract<PlannedCheck, { kind: 'run' }>, result: ExecResult) => GravityReading;
  /** Runs one check in the worktree through the checks' process runner, its sandbox (ADR 0076). */
  runCheck: (
    check: Extract<PlannedCheck, { kind: 'run' }>,
    worktree: TreeIn,
    deadlineAt: string,
    signal: AbortSignal,
  ) => Promise<ExecResult>;
  /** The repository's setup running, or undefined when it has none. */
  prepare: (
    worktree: TreeIn,
    deadlineAt: string,
    signal: AbortSignal,
  ) => Promise<GravityReading[]> | undefined;
}

export function createMappedProof(options: MappedProofOptions): MappedProof {
  const { git, clone, platform, reports, testReportsOf, readingIn, runCheck, prepare, baseOf } =
    options;

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
    const base = baseOf(batch, repo);
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
        return lastLine(result.stderr) ?? `git exited with ${result.code}`;
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
    named: GaugeReport | undefined,
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
    // Whether a module wrote nothing to read, so the run says nothing of the tests named (ADR 0342).
    let silent = false;
    for (const { module, added } of modules) {
      const { name, testReport } = module;
      const wrote = testReportsOf(module, worktree);
      if ('stuck' in wrote) return stuck(wrote.stuck);
      if ('failed' in wrote) return failed(wrote.failed);
      read.push(...wrote.reports);
      if (wrote.reports.length === 0) silent = true;
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
    // Only a count in the reason, which a route input and the status comment quote (ADR 0342).
    const missing = named === undefined || silent ? undefined : unreportedNames(named, read);
    const total = named === undefined ? 0 : named.tests.length + named.regressionTests.length;
    const verdict = judgeMapped({
      reports: read,
      unreported,
      diff,
      modules,
      root: worktree.path,
      ...(realRoot === worktree.path ? {} : { realRoot }),
      foldCase: foldsCase(platform),
      ...(missing === undefined || missing.length === 0
        ? {}
        : {
            namedHint: `the run reports no test named as ${missing.length} of the ${total} tests step ${of} named, so "${shortCommand(check.command)}" may not run them`,
          }),
    });
    // The reading names the failing tests the reports name: its tail may hold none (#779).
    const readingsNamed = [...before, withFailing(reading, read)];
    if (!verdict.proven) return { ...failed(verdict.why), readings: readingsNamed };
    return {
      ending: { kind: 'succeeded', output: null },
      readings: readingsNamed,
      ...(missing === undefined ? {} : { unreported: unreportedRecord(missing) }),
    };
  };

  /**
   * A red proof: the test check's reading, then the reports the test map's modules wrote, judged
   * against what step `of` committed (ADR 0274).
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
    // The red proof reads its modules' reports where the test map says, never a test's name
    // (ADR 0274); a batch with no map was refused before its first step (ADR 0297).
    const maps = await mapsOf(batch, worktree, signal);
    if ('ending' in maps) return maps;
    if (maps.kind === 'none') {
      const kept = options.testMap?.keptIn?.(worktree.repo) ?? 'repo';
      return blocked('environment', needsTestMap(recipe, worktree.repo, kept));
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
    const modules = await modulesOf(maps, worktree.repo, worktree.commit, signal);
    if ('ending' in modules) return modules;
    // The repository's setup once nothing else blocks the run, so the run finds what it
    // installed (ADR 0140).
    const preparing = prepare(worktree, deadlineAt, signal);
    const before = preparing === undefined ? [] : await preparing;
    if (!before.every(passed)) return { ending: settleReadings(before), readings: before };
    const named = stepTests(batch, of);
    return proveMapped(modules, worktree, deadlineAt, of, signal, check, before, diff.files, named);
  };

  return { proveRed };
}
