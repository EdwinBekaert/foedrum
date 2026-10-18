// What a revision of a status comment records in the ledger (ADR 0072): the comment it made or
// edited, and the digest of the text it showed. Never the text: the ledger is kept for good.

import { z } from './zod.ts';

export const StatusRevision = z.strictObject({
  comment: z.int().positive(),
  /** The first 16 hex digits of the SHA-256 of the text. */
  digest: z.string().regex(/^[0-9a-f]{16}$/),
});
export type StatusRevision = z.infer<typeof StatusRevision>;
