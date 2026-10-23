// What a lane label revision records in the ledger (ADR 0154): the label it left on the issue, or
// null when it took the lane labels off.

import { z } from './zod.ts';

/** The labels of the lanes, in the order a batch moves through them. */
export const LaneLabelName = z.enum([
  'foedrum:ordered',
  'foedrum:brewing',
  'foedrum:conditioning',
  'foedrum:stuck',
  'foedrum:on-tap',
]);
export type LaneLabelName = z.infer<typeof LaneLabelName>;

export const LaneLabelRevision = z.strictObject({ label: LaneLabelName.nullable() });
export type LaneLabelRevision = z.infer<typeof LaneLabelRevision>;
