// Step outcome (architecture §4.2, ADR 0005). Stub: not implemented yet.

import { z } from './zod.ts';

export const Question = z.never();
export type Question = z.infer<typeof Question>;

export const StepOutcome = z.never();
export type StepOutcome = z.infer<typeof StepOutcome>;
