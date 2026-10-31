// How the state machine asks a recipe where a batch goes next (architecture §4.3, ADR 0025).
// The state machine handles every outcome and blocker kind itself; a recipe only answers these
// questions, so recipe files (#52) can change without touching the lifecycle.

import type { ScheduleRoute } from '../schemas/events.ts';
import type { ChosenBy } from '../schemas/recipe.ts';
import type { Batch } from './fold.ts';

/** Why a route sends a batch back: a failed check, findings, or its pull request (ADR 0219). */
export type RouteWhy = ScheduleRoute['why'];

/** A person's choice that schedules a step of its own (ADR 0286). */
export type ChosenOption = ChosenBy;

/** An action step the engine runs itself, never a brewer (brewers-and-recipes §1, ADR 0071). */
export type RecipeAction = 'openPullRequest';

/** What follows a step that succeeded or was skipped. */
export type Continuation =
  | { kind: 'step'; stepId: string }
  /**
   * The recipe is done: the batch goes on tap with these pull requests, and with the one its step
   * `opens` opened, when the recipe has an openPullRequest step that the batch did not skip by its
   * `when` (ADR 0071).
   */
  | { kind: 'done'; pullRequests: readonly string[]; opens?: string };

/**
 * When a running attempt counts as stalled: no file write or commit for `turns` turns or for
 * `minutes` minutes, whichever comes first (brewers-and-recipes §1).
 */
export interface Stall {
  turns?: number | undefined;
  minutes?: number | undefined;
}

export interface Recipe {
  /** How many of its batches may brew at once (ADR 0217); absent when it has no limit of its own. */
  readonly concurrency?: number;
  /** The step a batch starts with. */
  readonly firstStep: string;
  /**
   * Its step ids in the order the recipe lists them, a parallel group's children in its place: what
   * the status comment shows (ADR 0072, ADR 0168).
   */
  readonly steps: readonly string[];
  /** Whether the recipe has a step `stepId`: a parallel group, or a child of one, too. */
  has(stepId: string): boolean;
  /**
   * The children of `stepId`, in the recipe's order, when it is a parallel group, whose attempts
   * run side by side (ADR 0168); `undefined` for any other step.
   */
  children(stepId: string): readonly string[] | undefined;
  /** The parallel group `stepId` is a child of, or `undefined` when it is none's (ADR 0168). */
  group(stepId: string): string | undefined;
  /**
   * Whether `stepId` is an interactive brewer step: its attempts run as a person's session, which
   * only a driver with a terminal opens (ADR 0222).
   */
  interactive(stepId: string): boolean;
  /**
   * Whether the answer to the question of `stepId` chooses the batch's recipe (`chooses: "recipe"`,
   * ADR 0232).
   */
  choosesRecipe(stepId: string): boolean;
  /**
   * The step a person's `option` schedules (`chosenBy`, ADR 0286), or `undefined` when the recipe
   * has none; no step continues to it.
   */
  chosen(option: ChosenOption): string | undefined;
  /** The action `stepId` is, which the engine runs itself; `undefined` for any other step. */
  action(stepId: string): RecipeAction | undefined;
  /**
   * Whether an attempt at `stepId` merges the base into its worktree before it runs: the recipe's
   * last check step that expects to pass, when an openPullRequest step follows it (ADR 0164).
   */
  mergesBase(stepId: string): boolean;
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
   * The step an `onFail` route (a failed check), an `onBlocked: findings` route or an
   * `onPullRequestFail` route (ADR 0219) sends `batch` back to, or `undefined` when `stepId` has no
   * such route or its rounds are used up.
   */
  loopBack(batch: Batch, stepId: string, why: RouteWhy): string | undefined;
  /** The step the `why` route of `stepId` goes back to, whatever its rounds; `undefined` without one. */
  routesTo(stepId: string, why: RouteWhy): string | undefined;
  /**
   * How many rounds the `why` route of `stepId` has sent `batch` back, or `undefined` when the step
   * has no such route (ADR 0064, ADR 0192).
   */
  rounds(batch: Batch, stepId: string, why: RouteWhy): number | undefined;
  /** How many rounds the `why` route of `stepId` may take, or `undefined` without one (ADR 0226). */
  maxRounds(stepId: string, why: RouteWhy): number | undefined;
}

export interface Recipes {
  /** The recipe called `name`, or `undefined` when the Brewery has none. */
  find(name: string): Recipe | undefined;
}
