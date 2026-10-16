// The commands of the command layer (ADR 0019): one schema each, the input its handler takes,
// whichever surface it came from. doctor, status, stuck and replay are read-only (ADR 0030); the
// others change state, and parse untrusted input into the engine's human commands (ADR 0025).

import { PathSafeId } from './ids.ts';
import { NonEmpty } from './step-outcome.ts';
import { z } from './zod.ts';

export const DoctorCommand = z.strictObject({ command: z.literal('doctor') });
export type DoctorCommand = z.infer<typeof DoctorCommand>;

export const StatusCommand = z.strictObject({ command: z.literal('status') });
export type StatusCommand = z.infer<typeof StatusCommand>;

export const StuckCommand = z.strictObject({ command: z.literal('stuck') });
export type StuckCommand = z.infer<typeof StuckCommand>;

export const ReplayCommand = z.strictObject({ command: z.literal('replay'), batch: PathSafeId });
export type ReplayCommand = z.infer<typeof ReplayCommand>;

export const RetryCommand = z.strictObject({ command: z.literal('retry'), batch: PathSafeId });
export type RetryCommand = z.infer<typeof RetryCommand>;

export const SkipCommand = z.strictObject({ command: z.literal('skip'), batch: PathSafeId });
export type SkipCommand = z.infer<typeof SkipCommand>;

export const CancelCommand = z.strictObject({ command: z.literal('cancel'), batch: PathSafeId });
export type CancelCommand = z.infer<typeof CancelCommand>;

// A stub until the terminal parses answers: every parse throws.
export const AnswerCommand = z.unknown().transform((): never => {
  throw new Error('not implemented');
});
export type AnswerCommand = z.infer<typeof AnswerCommand>;

export const RecipeCommand = z.strictObject({
  command: z.literal('recipe'),
  batch: PathSafeId,
  recipe: PathSafeId,
  reason: NonEmpty,
});
export type RecipeCommand = z.infer<typeof RecipeCommand>;

// A stub until the terminal parses commits: every parse throws.
export const RewindCommand = z.unknown().transform((): never => {
  throw new Error('not implemented');
});
export type RewindCommand = z.infer<typeof RewindCommand>;
