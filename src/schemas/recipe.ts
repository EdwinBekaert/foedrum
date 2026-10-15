// Recipes: brewers, checks and actions in order, with loops (brewers-and-recipes §3).

import { z } from './zod.ts';

const notImplemented = (): never => {
  throw new Error('not implemented');
};
const stub = () => z.unknown().transform(notImplemented);

export const Step = stub();
export type Step = z.infer<typeof Step>;

export type StepKind =
  | 'brewer'
  | 'session'
  | 'check'
  | 'parallel'
  | 'loop'
  | 'gate'
  | 'action'
  | 'fanOut';

export function stepKind(_step: Step): StepKind {
  return notImplemented();
}

export function stepId(_step: Step): string {
  return notImplemented();
}

export const Recipe = stub();
export const DefaultRecipe = stub();
