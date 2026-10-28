// The recipe label of a batch whose recipe a person chose by answering a step that chooses it
// (ADR 0232): `recipe:<name>` on its Brewery issue, set once through the ledger as the driver's
// effect `[batchId, "recipe-label"]`, found on the issue before it is applied (ADR 0033).

import type { DriverEffects } from './driver.ts';
import type { LaneLabelHost } from './lane-labels.ts';

export interface RecipeLabelEffectsOptions {
  /** The Brewery's repository, `owner/name`, where its issues are. */
  brewery: string;
  host: Omit<LaneLabelHost, 'removeLabel'>;
}

/** The recipe label of every batch whose recipe an answer chose, for the driver. */
export const recipeLabelEffects = (_options: RecipeLabelEffectsOptions): DriverEffects => {
  throw new Error('not implemented');
};
