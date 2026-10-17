// How the state machine asks a recipe where a batch goes next (architecture §4.3, ADR 0025).
// The state machine handles every outcome and blocker kind itself; a recipe only answers these
// questions, so recipe files (#52) can change without touching the lifecycle.

import type { Batch } from './fold.ts';

/** What follows a step that succeeded or was skipped. */
export type Continuation =
  | { kind: 'step'; stepId: string }
  /** The recipe is done: the batch goes on tap with these pull requests. */
  | { kind: 'done'; pullRequests: readonly string[] };

/**
 * When a running attempt counts as stalled: no file write or commit for `turns` turns or for
 * `minutes` minutes, whichever comes first (brewers-and-recipes §1).
 */
export interface Stall {
  turns?: number | undefined;
  minutes?: number | undefined;
}

export interface Recipe {
  /** The step a batch starts with. */
  readonly firstStep: string;
  /** Whether the recipe has a step `stepId`. */
  has(stepId: string): boolean;
  /** How long an attempt at `stepId` may take, in milliseconds. */
  deadlineMs(stepId: string): number;
  /** When an attempt at `stepId` stalls, or `undefined` when it has no stall limit. */
  stall(stepId: string): Stall | undefined;
  /**
   * The `when` of `stepId` that is false for `batch`, so the batch skips the step when it reaches
   * it, or `undefined` when the step runs (ADR 0064).
   */
  skip(batch: Batch, stepId: string): string | undefined;
  /** What follows `stepId` in `batch` once it succeeded or was skipped. */
  after(batch: Batch, stepId: string): Continuation;
  /** Whether `stepId` gets another attempt after a failed or cancelled one (`maxAttempts`). */
  mayRetry(batch: Batch, stepId: string): boolean;
  /**
   * The step an `onFail` route (a failed check) or an `onBlocked: findings` route sends `batch`
   * back to, or `undefined` when `stepId` has no such route or its rounds are used up.
   */
  loopBack(batch: Batch, stepId: string, why: 'failed' | 'findings'): string | undefined;
}

export interface Recipes {
  /** The recipe called `name`, or `undefined` when the Brewery has none. */
  find(name: string): Recipe | undefined;
}
