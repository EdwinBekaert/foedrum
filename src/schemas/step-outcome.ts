// Step outcome, the single contract every step ends with (architecture §4.2, ADR 0005).

import { z } from './zod.ts';

export const NonEmpty = z.string().regex(/\S/, 'Must not be empty');

/** A question a brewer cannot answer itself (ADR 0006): options, a recommendation, why it blocks. */
export const Question = z
  .strictObject({
    q: NonEmpty,
    options: z.array(NonEmpty).min(2),
    recommended: NonEmpty,
    whyBlocking: NonEmpty,
  })
  .refine((question) => question.options.includes(question.recommended), {
    message: 'Must be one of the options',
    path: ['recommended'],
  });
export type Question = z.infer<typeof Question>;

export const StepOutcome = z.discriminatedUnion('kind', [
  // JSON, because outcomes are stored in the event log.
  z.strictObject({ kind: z.literal('succeeded'), output: z.json() }),
  z.strictObject({
    kind: z.literal('failed'),
    retryable: z.boolean(),
    reason: NonEmpty,
    // The run went past its turn budget, and its retry resumes its session (ADR 0175).
    overran: z.literal('turns').optional(),
  }),
  z.strictObject({ kind: z.literal('needs_input'), questions: z.array(Question).min(1) }),
  z.strictObject({ kind: z.literal('cancelled') }),
]);
export type StepOutcome = z.infer<typeof StepOutcome>;
