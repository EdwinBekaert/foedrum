// How the state machine asks a recipe where a batch goes next (architecture §4.3, ADR 0025).
// The state machine handles every outcome and blocker kind itself; a recipe only answers these
// questions, so recipe files (#52) can change without touching the lifecycle.

import type { Batch } from './fold.ts';

/** What follows a step that succeeded or was skipped. */
export type Continuation =
  | { kind: 'step'; stepId: string }
  /** The recipe is done: the batch goes on tap with these pull requests. */
  | { kind: 'done'; pullRequests: readonly string[] };

export interface Recipe {
  /** The step a batch starts with. */
  readonly firstStep: string;
  /** Whether the recipe has a step `stepId`. */
  has(stepId: string): boolean;
  /** How long an attempt at `stepId` may take, in milliseconds. */
  deadlineMs(stepId: string): number;
  /** What follows `stepId` in `batch` once it succeeded or was skipped. */
  after(batch: Batch, stepId: string): Continuation;
  /** Whether `stepId` gets another attempt after a failed or cancelled one (`maxAttempts`). */
  mayRetry(batch: Batch, stepId: string): boolean;
  /**
   * The step an `onFail` route (a failed check) or an `onBlocked: findings` route sends `batch`
   * back to, or `undefined` when `stepId` has no such route or its rounds are used up.
   */
  routeBack(batch: Batch, stepId: string, why: 'failed' | 'findings'): string | undefined;
}

export interface RecipeBook {
  /** The recipe called `name`, or `undefined` when the Brewery has none. */
  find(name: string): Recipe | undefined;
}
