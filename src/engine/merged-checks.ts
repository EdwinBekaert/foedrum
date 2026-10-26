// The checks of an open pull request's merged tree (ADR 0203): the intake pass hands a clean
// merge-tree of a moved base on, and this run reads the batch's checks on the merged tree, one run
// at a time in the Cellar, beside the ticks and the pass. Nothing is recorded until a run ends, so
// a kill loses no run: the next pass finds the tip moved and hands it on again.

import type { GravityReading } from '../schemas/events.ts';
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
  _recipes: Recipes,
  _checks: StepChecks,
  _batch: Batch,
): MergedCheckStep | undefined => {
  throw new Error('not implemented');
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

export const createMergedChecks = (_options: MergedChecksOptions): MergedChecks => {
  throw new Error('not implemented');
};
