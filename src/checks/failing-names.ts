// The failing tests a check's test reading names, and the tests the Gauger named that a passing
// run's reports hold none of (#779, ADR 0307, ADR 0342): read from the reports of the effective
// map's modules. No model.

import type { AttemptEnd } from '../engine/brewer-runner.ts';
import type { Batch } from '../engine/fold.ts';
import type { GravityReading } from '../schemas/events.ts';
import type { CheckRunnerOptions, MergedCommits, TreeIn } from './check-runner.ts';
import { settleReadings, withFailing } from './gravity.ts';
import { type ModuleReports, type StepMaps, stepModules } from './module-reports.ts';
import { unreportedNames, unreportedRecord } from './named-tests.ts';
import type { MappedReport } from './red-proof.ts';
import { stepTests } from './step-commits.ts';

/** The failing and the unreported tests a check step's or a merged tree's reports name. */
export interface FailingNames {
  namingFailing: (
    end: AttemptEnd,
    test: GravityReading,
    worktree: TreeIn,
    maps: StepMaps,
  ) => AttemptEnd;
  namedTestsRead: (batch: Batch, end: AttemptEnd, worktree: TreeIn, maps: StepMaps) => AttemptEnd;
  mergedNaming: (
    end: AttemptEnd,
    worktree: TreeIn,
    merged: MergedCommits,
    signal: AbortSignal,
  ) => Promise<AttemptEnd>;
}

/** What the naming uses of the check runner. */
export interface FailingNamesOptions extends Pick<CheckRunnerOptions, 'checks' | 'testMap'> {
  testReportsOf: ModuleReports;
}

export function createFailingNames(options: FailingNamesOptions): FailingNames {
  const { checks, testReportsOf } = options;

  /**
   * `end` with its failed `test` reading naming the failing tests the reports of the effective
   * map's modules name (#779): a check step cleared them before its run, so they are its own. A map
   * or a report that cannot be read names none; a TRX report's tests are left unread (#727).
   */
  const namingFailing = (
    end: AttemptEnd,
    test: GravityReading,
    worktree: TreeIn,
    { before, after }: StepMaps,
  ): AttemptEnd => {
    if (after.kind !== 'map') return end;
    const modules = stepModules(before, after.map);
    const reports = modules.flatMap(({ module }) => {
      if (module.testReport.format === 'trx') return [];
      const wrote = testReportsOf(module, worktree);
      return 'reports' in wrote ? wrote.reports : [];
    });
    const readings = end.readings?.map((each) =>
      each === test ? withFailing(each, reports) : each,
    );
    // Settled again, so the reason names the tests too (ADR 0307).
    return readings === undefined ? end : { ...end, readings, ending: settleReadings(readings) };
  };

  /**
   * `end` of a check step with what its passing test run's reports say of the tests the Gauger named
   * (ADR 0342), when every module's reports were read: a failing run may have stopped before one
   * (ADR 0280), and a module with a report that is unread, or none, says nothing of a name.
   */
  const namedTestsRead = (
    batch: Batch,
    end: AttemptEnd,
    worktree: TreeIn,
    { before, after }: StepMaps,
  ): AttemptEnd => {
    const proven = checks.redProof(batch.recipe?.name ?? '')?.of;
    const named = proven === undefined ? undefined : stepTests(batch, proven);
    const passing = end.readings?.some(
      (reading) =>
        reading.check === 'test' && reading.result === 'exited' && reading.exitCode === 0,
    );
    if (named === undefined || passing !== true || after.kind !== 'map') return end;
    const modules = stepModules(before, after.map);
    const read: MappedReport[] = [];
    for (const { module } of modules) {
      if (module.testReport.format === 'trx') return end;
      const wrote = testReportsOf(module, worktree);
      if (!('reports' in wrote) || wrote.reports.length === 0) return end;
      read.push(...wrote.reports);
    }
    const missing = unreportedNames(named, read);
    return missing === undefined ? end : { ...end, unreported: unreportedRecord(missing) };
  };

  /**
   * `end` of the checks on an open pull request's merged tree with its failed test reading naming
   * the failing tests (ADR 0307): the effective map of the base's map at `tip` and the batch's at
   * `head`, as a check step reads it. The merged tree's worktree is fresh, so its reports are this
   * run's with nothing cleared. A map or a report that cannot be read names none: the check only
   * tells the fix step, and never waits on the map.
   */
  const mergedNaming = async (
    end: AttemptEnd,
    worktree: TreeIn,
    { head, tip }: MergedCommits,
    signal: AbortSignal,
  ): Promise<AttemptEnd> => {
    const { testMap } = options;
    const test = end.readings?.find(
      (reading) =>
        reading.result === 'exited' && reading.check === 'test' && reading.exitCode !== 0,
    );
    if (testMap === undefined || test === undefined) return end;
    const before = await testMap.at(worktree.repo, tip, signal);
    const after = await testMap.at(worktree.repo, head, signal);
    return namingFailing(end, test, worktree, { base: tip, before, after });
  };

  return { namingFailing, namedTestsRead, mergedNaming };
}
