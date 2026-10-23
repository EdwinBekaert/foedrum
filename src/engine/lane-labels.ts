// The lane label of a batch of a Brewery issue (#406, ADR 0154): one `foedrum:<lane>` label at a
// time on its issue, set through the ledger as the driver's effects, `[batchId, "label.<n>"]`, as
// the status comment's revisions are (ADR 0072).

import type { IssueMarks } from './claim-effects.ts';
import type { DriverEffects } from './driver.ts';
import type { Lane } from './fold.ts';

/** The labels of the lanes, in the order a batch moves through them. */
export const laneLabels = [
  'foedrum:ordered',
  'foedrum:brewing',
  'foedrum:conditioning',
  'foedrum:stuck',
  'foedrum:on-tap',
] as const;

/** The labels of an issue on the code host, as the Brewery's own identity sets them. */
export interface LaneLabelHost extends Pick<IssueMarks, 'labels' | 'addLabel' | 'removeLabel'> {
  /** Makes the label in the repository; nothing when it is there already. */
  createLabel(repo: string, label: string, signal?: AbortSignal): Promise<void>;
}

/** The label of `lane`; none for a cancelled batch. */
export const laneLabel = (_lane: Lane): string | undefined => {
  throw new Error('not implemented');
};

export interface LaneLabelEffectsOptions {
  /** The Brewery's repository, `owner/name`, where its issues are. */
  brewery: string;
  host: LaneLabelHost;
}

/** The lane label of every batch of a Brewery issue, for the driver. */
export const laneLabelEffects = (_options: LaneLabelEffectsOptions): DriverEffects => {
  throw new Error('not implemented');
};
