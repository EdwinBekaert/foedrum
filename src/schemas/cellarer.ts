// What a job of the Cellarer recorded (ADR 0380): the ledger's result of its one effect, which is
// its attempt's output, read by the status comment.

import { z } from './zod.ts';

export const CellarerOutput = z.discriminatedUnion('cellarer', [
  z.strictObject({ cellarer: z.literal('shelve'), batches: z.array(z.string()) }),
  z.strictObject({
    cellarer: z.literal('sweep'),
    removed: z.array(z.string()),
    failed: z.array(z.strictObject({ name: z.string(), error: z.string() })),
  }),
  z.strictObject({ cellarer: z.literal('expire'), before: z.string() }),
]);
export type CellarerOutput = z.infer<typeof CellarerOutput>;
