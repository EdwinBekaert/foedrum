// The record of a claim on a target-repository issue: the message of the commit that the claim
// ref points at (ADR 0043).

import { Repo } from './events.ts';
import { z } from './zod.ts';

/** Which Brewery claimed which issue, and when; no host or user names. */
export const ClaimRecord = z.strictObject({
  brewery: Repo,
  issue: z.int().positive(),
  claimedAt: z.iso.datetime(),
});
export type ClaimRecord = z.infer<typeof ClaimRecord>;
