// One run of the checks on an open pull request's merged tree, for `foedrum serve` (ADR 0203): the
// checks of the batch's recipe's step that merges the base, read by the check runner in a worktree
// of the merged tree, as a check step's attempt reads its own.

import type { CheckTree } from '../checks/check-runner.ts';
import { passed } from '../checks/gravity.ts';
import type { AttemptEnd } from '../engine/brewer-runner.ts';
import type { CommandLog } from '../engine/command-log.ts';
import { repositoryOf } from '../engine/driver.ts';
import {
  type MergedCheckDue,
  type MergedCheckEnd,
  mergedCheckStep,
} from '../engine/merged-checks.ts';
import type { MergedTree } from '../workspace/merge-tree-git.ts';
import type { ServeRepository, ServeSetup } from './serve-config.ts';

export interface MergedCheckRunOptions {
  setup: Pick<ServeSetup, 'recipes' | 'checks' | 'repositories'>;
  log: CommandLog;
  /** A worktree of a repository's merged tree. */
  tree: (repository: ServeRepository) => MergedTree;
  checkTree: CheckTree;
  clock: () => Date;
}

/** How a run ended, from what the check runner read: the first reading that did not pass. */
const mergedCheckEnd = (
  { ending, readings = [] }: AttemptEnd,
  signal: AbortSignal,
): MergedCheckEnd => {
  if (signal.aborted || ending.kind === 'cancelled') return { kind: 'stopped' };
  const decisive = readings.find((reading) => !passed(reading));
  if (decisive !== undefined) return { kind: 'failed', reading: decisive };
  switch (ending.kind) {
    case 'succeeded':
      return { kind: 'passed' };
    case 'blocked':
      return { kind: 'unchecked', why: ending.summary };
    case 'failed':
      return { kind: 'unchecked', why: ending.reason };
    default:
      return { kind: 'unchecked', why: `the checks ended ${ending.kind}` };
  }
};

/** The run `createMergedChecks` calls for each due pull request. */
export const mergedCheckRun =
  ({ setup, log, tree, checkTree, clock }: MergedCheckRunOptions) =>
  async (due: MergedCheckDue, signal: AbortSignal): Promise<MergedCheckEnd> => {
    const state = log.state();
    const batch = state.batches.get(due.batchId);
    const step =
      batch === undefined ? undefined : mergedCheckStep(setup.recipes, setup.checks, batch);
    if (batch === undefined || step === undefined) {
      return {
        kind: 'unchecked',
        why: `batch ${due.batchId} has no check step that merges its base`,
      };
    }
    const repository = repositoryOf(state, batch.id, setup.repositories);
    const deadlineAt = new Date(clock().getTime() + step.deadlineMs).toISOString();
    const end = await tree(repository)(
      due.head,
      due.tip,
      (path) => checkTree(step.refs, { repo: repository.repo, path }, deadlineAt, signal),
      signal,
    );
    return mergedCheckEnd(end, signal);
  };
