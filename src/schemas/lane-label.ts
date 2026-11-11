// What a lane label revision records in the ledger (ADR 0154, ADR 0316): the label it left on the
// issue, or null when it took the lane labels off.

import { z } from './zod.ts';

/**
 * The state labels: what a batch is to a person, and while it waits for them, for what (ADR 0379).
 */
export const LaneLabelName = z.enum([
  'foedrum:queued',
  'foedrum:running',
  'foedrum:approve-plan',
  'foedrum:answer',
  'foedrum:review-and-merge',
  'foedrum:open-session',
  'foedrum:choose-recipe',
  'foedrum:look-at-failure',
]);
export type LaneLabelName = z.infer<typeof LaneLabelName>;

/** The labels an older Foedrum set, which a revision still takes off (ADR 0316, ADR 0379). */
export const RetiredLaneLabel = z.enum([
  'foedrum:on-tap',
  'foedrum:ordered',
  'foedrum:brewing',
  'foedrum:conditioning',
  'foedrum:awaiting-approval',
  'foedrum:awaiting-answer',
  'foedrum:stuck',
  'foedrum:awaiting-merge',
  'foedrum:sub-orders',
]);
export type RetiredLaneLabel = z.infer<typeof RetiredLaneLabel>;

export const LaneLabelRevision = z.strictObject({
  label: z.union([LaneLabelName, RetiredLaneLabel]).nullable(),
});
export type LaneLabelRevision = z.infer<typeof LaneLabelRevision>;
