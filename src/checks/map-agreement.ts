// The test map against the run (ADR 0282, ADR 0298): whether a survey's check needs a run, whether
// a survey's map agrees with one, and the map stale by its manifests before a check step's run or
// by what a passing run's reports say. No model.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AttemptRef } from '../engine/attempt-key.ts';
import type { AttemptEnd } from '../engine/brewer-runner.ts';
import type { Batch } from '../engine/fold.ts';
import { isAbsolutePath } from '../formats/coverage-report.ts';
import { foldsCase } from '../platform/paths.ts';
import { realPath } from '../platform/real-path.ts';
import { MOST_STALE_PATHS, type StaleMap, type WorktreeRef } from '../schemas/events.ts';
import { surveyOf } from '../schemas/out-doc.ts';
import type { CheckRunnerOptions } from './check-runner.ts';
import { blocked } from './gravity.ts';
import { coveragePath, type ModuleReports } from './module-reports.ts';
import { cut, testFileOf } from './red-proof.ts';
import { checkedTip } from './step-commits.ts';
import {
  areaOf,
  type EffectiveModule,
  type MapRead,
  manifestFreshness,
  moduleFolders,
  reportPaths,
  reportUnder,
  TEST_MAP_PATH,
  touchedPaths,
} from './test-map.ts';

/**
 * What a check step read of its test map before the run (ADR 0282): the map at its tip, and the
 * stale manifests it names without failing for them, with where the map is kept.
 */
export interface Fresh {
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
export const withStale = (
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

/** Whether the latest survey of step `of` found the map fresh, or kept by the Brewery. */
export const surveyNeedsNoRun = (batch: Batch, of: string): boolean => {
  const outputs = [...(batch.steps.get(of)?.attempts.values() ?? [])].flatMap((attempt) =>
    attempt.phase === 'finished' && attempt.outcome.kind === 'succeeded'
      ? [attempt.outcome.output]
      : [],
  );
  const map = surveyOf(outputs.at(-1))?.map;
  return map === 'fresh' || map === 'brewery';
};

/**
 * A survey's check's `end` (ADR 0298): a run that disagrees with the map the survey proposed (a
 * failure that is not retried, or a map the run left stale) fails back to the survey while its
 * route has rounds, and then sticks the batch on its environment, naming what disagreed: route
 * exhaustion alone would say the attempts ran out.
 */
export const agreed = (
  batch: Batch,
  ref: AttemptRef,
  worktree: WorktreeRef,
  survey: { of: string; maxRounds: number },
  end: AttemptEnd,
): AttemptEnd => {
  const { ending } = end;
  const why =
    ending.kind === 'failed' && !ending.retryable
      ? ending.reason
      : ending.kind === 'succeeded' && end.staleMap !== undefined
        ? `${end.staleMap.paths.join(', ')}${end.staleMap.more > 0 ? ` and ${end.staleMap.more} more` : ''}`
        : undefined;
  if (why === undefined) return end;
  const { staleMap: _named, ...rest } = end;
  const back = [...(batch.steps.get(survey.of)?.attempts.values() ?? [])].filter(
    (attempt) => attempt.route?.from === ref.stepId && attempt.route.why === 'failed',
  ).length;
  const { repo } = worktree;
  if (back < survey.maxRounds) {
    const reason = `the test map the survey proposed disagrees with a run of ${repo}: ${why} (ADR 0298)`;
    return { ...rest, ending: { kind: 'failed', retryable: false, reason } };
  }
  const summary = `no test map the survey proposed agrees with a run of ${repo}: ${why} (ADR 0298)`;
  return { ...rest, ending: blocked('environment', summary).ending };
};

/** What the stale map reads of a check step: its manifests before the run, and the run's reports. */
export interface StaleMapReads {
  manifests: (
    batch: Batch,
    worktree: WorktreeRef,
    signal: AbortSignal,
  ) => Promise<{ end: AttemptEnd } | Fresh>;
  staleByRun: (worktree: WorktreeRef, modules: readonly EffectiveModule[]) => string[];
}

/** What the stale map uses of the check runner. */
export interface StaleMapOptions
  extends Pick<CheckRunnerOptions, 'git' | 'clone' | 'testMap' | 'testReport'> {
  platform: NodeJS.Platform;
  testReportsOf: ModuleReports;
  /** Where the batch's change in the worktree's repository starts (ADR 0164, ADR 0452). */
  baseOf: (batch: Batch, worktree: WorktreeRef) => Promise<string | undefined>;
}

export function createStaleMap(options: StaleMapOptions): StaleMapReads {
  const { git, clone, platform, testReportsOf, baseOf } = options;

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
    // At the attempt's branch, which holds the base merge, as the manifests on disk do (ADR 0452).
    const tip = await testMap.at(repo, checkedTip(worktree), signal);
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
    const base = await baseOf(batch, worktree);
    if (kept === 'repo' && base !== undefined) {
      const touched = testMap.touched ?? touchedPaths(git, clone);
      const paths = [TEST_MAP_PATH, ...tip.map.derivedFrom.globs];
      const changed = await touched(repo, base, checkedTip(worktree), paths, signal);
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
   * Where a passing run disagrees with the effective map (ADR 0274, ADR 0282): a module the base
   * lists whose report path holds no report (one only the batch adds was looked for already), a
   * test a module's report places outside every module's areas, and the test report
   * `foedrum.jsonc` names written under no module's report path.
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
    const patterns = modules.flatMap(({ module }) => [
      module.testReport.path,
      ...coveragePath(module),
    ]);
    if (patterns.some((pattern) => reportUnder(written, pattern))) return named;
    const found = find(written, worktree.path);
    if ('paths' in found && found.paths.length > 0) {
      named.push(`${written} (a report outside the map)`);
    }
    return named;
  };

  /**
   * The files where the modules' reports place a test outside every module's areas, each named by
   * its first test (ADR 0282): an added module's report is there, as the unreached rule found. An absolute location is read under the worktree
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
    for (const { module } of modules) {
      // A TRX report's tests are left unread, as at the green check (#727).
      if (module.testReport.format === 'trx') continue;
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

  return { manifests, staleByRun };
}
