// What the driver and its runners ask about an attempt's brewer, found in the recipe the attempt
// was scheduled under, which the batch may have left since, as its plan does (ADR 0309, ADR 0310).

import { familyOfBrewer } from '../brewers/attempt-plan.ts';
import type { AttemptRef } from '../engine/attempt-key.ts';
import { attemptRecipeOf, type State } from '../engine/fold.ts';
import type { StepBrewers } from '../engine/recipe-files.ts';
import type { ModelFamily } from '../engine/usage-window.ts';
import type { BrewerFrontmatter } from '../schemas/brewer.ts';
import type { ModelsConfig } from '../schemas/models.ts';
import { MUTANTS, SURVEY } from '../schemas/out-doc.ts';

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
  /** Whether the attempt's brewer proposes mutants, which the engine runs (ADR 0313). */
  mutates(ref: AttemptRef): boolean;
  /** Whether the attempt's brewer has guard `guard`. */
  guarded(ref: AttemptRef, guard: BrewerFrontmatter['guards'][number]): boolean;
}

export const attemptBrewers = ({
  state,
  brewers,
  models,
}: AttemptBrewersOptions): AttemptBrewers => {
  // In its batch's recipe for an attempt that recorded none (ADR 0309).
  const brewerOf = (ref: AttemptRef) => {
    const recipe = attemptRecipeOf(state(), ref);
    return recipe === undefined ? undefined : brewers.find(recipe, ref.stepId);
  };
  return {
    reads: (ref) => brewerOf(ref)?.brewer.access === 'read',
    family: (ref) => {
      const found = brewerOf(ref);
      return found && familyOfBrewer(models, found.brewer);
    },
    // An interactive step's session opens anew, with the whole prompt (ADR 0222).
    resumes: (ref) => {
      const found = brewerOf(ref);
      return found?.interactive === undefined && found?.brewer.retryMode === 'resume';
    },
    surveys: (ref) => brewerOf(ref)?.brewer.output.schema === SURVEY,
    mutates: (ref) => brewerOf(ref)?.brewer.output.schema === MUTANTS,
    guarded: (ref, guard) => brewerOf(ref)?.brewer.guards.includes(guard) ?? false,
  };
};
