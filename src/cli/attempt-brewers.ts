// What the driver and its runners ask about an attempt's brewer, found in the recipe the attempt
// was scheduled under, which the batch may have left since, as its plan does (ADR 0309, ADR 0310).

import type { AttemptRef } from '../engine/attempt-key.ts';
import type { State } from '../engine/fold.ts';
import type { StepBrewers } from '../engine/recipe-files.ts';
import type { ModelFamily } from '../engine/usage-window.ts';
import type { ModelsConfig } from '../schemas/models.ts';

export interface AttemptBrewersOptions {
  state: () => State;
  /** The brewers of the recipes' steps (`loadRecipes`). */
  brewers: StepBrewers;
  models: ModelsConfig;
}

export interface AttemptBrewers {
  /** Whether the attempt's brewer only reads (ADR 0301). */
  reads(ref: AttemptRef): boolean;
  /** The family of the model the attempt's brewer runs on, which says what usage window holds it (ADR 0215). */
  family(ref: AttemptRef): ModelFamily | undefined;
  /** Whether the attempt's retry or answer continues its session (ADR 0117, ADR 0118, ADR 0222). */
  resumes(ref: AttemptRef): boolean;
  /** Whether the attempt's brewer writes a survey (ADR 0298). */
  surveys(ref: AttemptRef): boolean;
  /** Whether the attempt's brewer has guard `guard`. */
  guarded(ref: AttemptRef, guard: string): boolean;
}

export const attemptBrewers = (_options: AttemptBrewersOptions): AttemptBrewers => {
  const notImplemented = (): never => {
    throw new Error('not implemented');
  };
  return {
    reads: notImplemented,
    family: notImplemented,
    resumes: notImplemented,
    surveys: notImplemented,
    guarded: notImplemented,
  };
};
