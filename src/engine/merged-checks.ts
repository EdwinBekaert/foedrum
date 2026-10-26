// The checks of an open pull request's merged tree (ADR 0203): the intake pass hands a clean
// merge-tree of a moved base on, and this run reads the batch's checks on the merged tree, one run
// at a time in the Cellar, beside the ticks and the pass. Nothing is recorded until a run ends, so
// a kill loses no run: the next pass finds the tip moved and hands it on again.

import { type GravityReading, MAX_UNCHECKED_LENGTH } from '../schemas/events.ts';
import type { CheckRef } from '../schemas/recipe.ts';
import type { CommandLog } from './command-log.ts';
import type { Batch } from './fold.ts';
import type { StepChecks } from './recipe-files.ts';
import type { Recipes } from './recipes.ts';

/** A pull request whose base moved to `tip` and merges cleanly with it, due for its checks. */
export interface MergedCheckDue {
  batchId: string;
  pullRequest: string;
  /** The base branch, as the remote names it. */
  branch: string;
  tip: string;
  /** The commit Foedrum pushed. */
  head: string;
}

/** How a run on the merged tree ended. */
export type MergedCheckEnd =
  | { kind: 'passed' }
  | { kind: 'failed'; reading: GravityReading }
  /** The checks did not run: the merged tree could not be made, or the checks not found. */
  | { kind: 'unchecked'; why: string }
  /** The engine's stop ended it: nothing is recorded. */
  | { kind: 'stopped' };

/** The checks a batch's merged tree is read with: its recipe's step that merges the base. */
export interface MergedCheckStep {
  stepId: string;
  refs: readonly CheckRef[];
  deadlineMs: number;
}

/** The most a run may take, so ADR 0130's floor of an hour holds for what it leaves (ADR 0203). */
export const MOST_RUN_MS = 55 * 60_000;

/**
 * The check step of `batch`'s recipe whose checks the merged tree is read with, the one that
 * merges the base before it runs (ADR 0164); `undefined` when it has none.
 */
export const mergedCheckStep = (
  recipes: Recipes,
  checks: StepChecks,
  batch: Batch,
): MergedCheckStep | undefined => {
  const name = batch.recipe?.name;
  const recipe = name === undefined ? undefined : recipes.find(name);
  const stepId = recipe?.steps.find((id) => recipe.mergesBase(id));
  if (name === undefined || recipe === undefined || stepId === undefined) return undefined;
  const refs = checks.find(name, stepId);
  if (refs === undefined || refs.length === 0) return undefined;
  return { stepId, refs, deadlineMs: Math.min(recipe.deadlineMs(stepId), MOST_RUN_MS) };
};

export interface MergedChecksOptions {
  log: CommandLog;
  clock: () => Date;
  /** Reads the checks on the merged tree of `due`; ends `stopped` once `signal` aborts. */
  run: (due: MergedCheckDue, signal: AbortSignal) => Promise<MergedCheckEnd>;
  /** What it could not do: a run that threw, a refused record. */
  failed: (what: string, error: unknown) => void;
}

export interface MergedChecks {
  /** Queues `due`, at its newest tip once per pull request. */
  due(due: MergedCheckDue): void;
  /** Starts the next run when none is underway; never waits for it. */
  poll(signal: AbortSignal): void;
  /** Ends when no run is underway. */
  settled(): Promise<void>;
}

/** Whether `due` is still to run: its pull request open on tap, and no check recorded at its tip. */
const stillDue = (log: CommandLog, due: MergedCheckDue): boolean => {
  const batch = log.state().batches.get(due.batchId);
  if (batch?.lane.kind !== 'on_tap' || !batch.lane.pullRequests.includes(due.pullRequest)) {
    return false;
  }
  if (batch.pullRequestEnds?.[due.pullRequest] !== undefined) return false;
  const latest = batch.baseChecks?.filter((check) => check.pullRequest === due.pullRequest).at(-1);
  return latest?.tip !== due.tip;
};

/** A reason as the log keeps it: its first line, at most MAX_UNCHECKED_LENGTH characters. */
const reasonOf = (why: string): string => {
  const line = why.split(/\r?\n/).find((each) => each.trim() !== '') ?? 'the run failed';
  return line.trim().slice(0, MAX_UNCHECKED_LENGTH);
};

export const createMergedChecks = (options: MergedChecksOptions): MergedChecks => {
  const { log, clock, run, failed } = options;
  // The due runs by pull request, in the order they came; each at its newest tip.
  const queue = new Map<string, MergedCheckDue>();
  let running: { due: MergedCheckDue; ended: Promise<void> } | undefined;

  const record = (due: MergedCheckDue, found: { failed?: GravityReading; unchecked?: string }) => {
    const event = {
      type: 'pull_request.base_checked',
      batchId: due.batchId,
      pullRequest: due.pullRequest,
      branch: due.branch,
      tip: due.tip,
      ...found,
    } as const;
    const decision = log.issue({ kind: 'record', event }, clock());
    if (decision.kind === 'refused') {
      failed(`recording the checks of ${due.pullRequest}`, new Error(decision.reason));
    }
  };

  const runOne = async (due: MergedCheckDue, signal: AbortSignal): Promise<void> => {
    let end: MergedCheckEnd;
    try {
      end = await run(due, signal);
    } catch (error) {
      if (signal.aborted) return;
      failed(`checking the merged tree of ${due.pullRequest} at ${due.tip}`, error);
      end = { kind: 'unchecked', why: error instanceof Error ? error.message : String(error) };
    }
    switch (end.kind) {
      case 'stopped':
        return;
      case 'passed':
        return record(due, {});
      case 'failed':
        return record(due, { failed: end.reading });
      case 'unchecked':
        return record(due, { unchecked: reasonOf(end.why) });
      default: {
        const unhandled: never = end;
        throw new Error(`Unhandled end ${JSON.stringify(unhandled)}`);
      }
    }
  };

  return {
    due: (due) => {
      // The run underway reads this tip already.
      if (running?.due.pullRequest === due.pullRequest && running.due.tip === due.tip) return;
      queue.set(due.pullRequest, due);
    },
    poll: (signal) => {
      if (running !== undefined || signal.aborted) return;
      for (const [pullRequest, due] of queue) {
        queue.delete(pullRequest);
        if (!stillDue(log, due)) continue;
        const ended = runOne(due, signal)
          .catch((error: unknown) => failed(`checking the merged tree of ${pullRequest}`, error))
          .finally(() => {
            running = undefined;
          });
        running = { due, ended };
        return;
      }
    },
    settled: async () => {
      await running?.ended;
    },
  };
};
