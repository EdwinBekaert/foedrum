// What a lane label revision records in the ledger (ADR 0154, ADR 0316): the label it left on the
// issue, or null when it took the lane labels off.

import { z } from './zod.ts';

/**
 * The lane labels, in the order a batch moves through them: where the batch is, or the person's
 * action while it waits on them (ADR 0316).
 */
export const LaneLabelName = z.enum([
  'foedrum:ordered',
  'foedrum:brewing',
  'foedrum:conditioning',
  'foedrum:awaiting-approval',
  'foedrum:awaiting-answer',
  'foedrum:stuck',
  'foedrum:awaiting-merge',
  'foedrum:sub-orders',
]);
export type LaneLabelName = z.infer<typeof LaneLabelName>;

/** The lane labels an older Foedrum set, which a revision still takes off (ADR 0316). */
export const RetiredLaneLabel = z.enum(['foedrum:on-tap']);
export type RetiredLaneLabel = z.infer<typeof RetiredLaneLabel>;

export const LaneLabelRevision = z.strictObject({
  label: z.union([LaneLabelName, RetiredLaneLabel]).nullable(),
});
export type LaneLabelRevision = z.infer<typeof LaneLabelRevision>;
