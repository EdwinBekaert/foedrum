// The lane label of a batch of a Brewery issue (#406, ADR 0154): one `foedrum:<lane>` label at a
// time on its issue, or on the Brewery issue that is a claimed batch's order (ADR 0155), set
// through the ledger as the driver's effects, `[batchId, "label.<n>"]`, as the status comment's
// revisions are (ADR 0072): due when the lane's label is not the one the latest revision left,
// found on the issue before it is applied (ADR 0033).

import { LaneLabelName, LaneLabelRevision } from '../schemas/lane-label.ts';
import type { BatchEffectKey } from '../schemas/store.ts';
import type { IssueMarks } from './claim-effects.ts';
import { breweryIssueOf, latestOf } from './claim-orders.ts';
import type { DriverEffects } from './driver.ts';
import { effectKey, numberedEffects } from './effect-key.ts';
import type { Lane } from './fold.ts';
import { same } from './issue-claims.ts';

/** The labels of the lanes, in the order a batch moves through them. */
export const laneLabels = LaneLabelName.options;

/** The labels of an issue on the code host, as the Brewery's own identity sets them. */
export interface LaneLabelHost extends Pick<IssueMarks, 'labels' | 'addLabel' | 'removeLabel'> {
  /** Makes the label in the repository; nothing when it is there already. */
  createLabel(repo: string, label: string, signal?: AbortSignal): Promise<void>;
}

/** The label of `lane`; none for a cancelled batch. */
export const laneLabel = (lane: Lane): LaneLabelName | undefined => {
  switch (lane.kind) {
    case 'ordered':
      return 'foedrum:ordered';
    case 'brewing':
      return 'foedrum:brewing';
    case 'conditioning':
      return 'foedrum:conditioning';
    case 'stuck':
      return 'foedrum:stuck';
    case 'on_tap':
      return 'foedrum:on-tap';
    case 'cancelled':
      return undefined;
    default:
      return lane satisfies never;
  }
};

const revisionKey = (batchId: string, revision: number): BatchEffectKey => ({
  batchId,
  effect: `label.${revision}`,
});

/** A revision of a lane label that is due: the issue, and the label it leaves, or none. */
interface DueLabel {
  issue: number;
  label: LaneLabelName | null;
}

export interface LaneLabelEffectsOptions {
  /** The Brewery's repository, `owner/name`, where its issues are. */
  brewery: string;
  host: LaneLabelHost;
}

/**
 * The lane label of every batch of a Brewery issue, for the driver: a revision whenever its lane's
 * label changes. A claimed batch's label is on the Brewery issue that is its order, once that is
 * recorded (ADR 0155); its target issue keeps only `foedrum:claimed`.
 */
export const laneLabelEffects = (options: LaneLabelEffectsOptions): DriverEffects => {
  const { brewery, host } = options;
  // The revision behind each key `due` gave; the driver asks `due` before it applies a key.
  const dues = new Map<string, DueLabel>();
  const dueFor = (key: string): DueLabel => {
    const due = dues.get(key);
    if (due === undefined) throw new Error(`No lane label revision ${key} is due`);
    return due;
  };
  // GitHub's label names are case-insensitive.
  const has = (on: readonly string[], label: string): boolean =>
    on.some((name) => same(name, label));
  // The lane labels on the issue that are not `label`: the ones to take off.
  const others = (on: readonly string[], label: LaneLabelName | null): string[] =>
    on.filter((name) => has(laneLabels, name) && (label === null || !same(name, label)));
  return {
    due: (state, batchId) => {
      const batch = state.batches.get(batchId);
      if (batch === undefined) return [];
      const issue = breweryIssueOf(state, batch);
      // An issue ordered again shows its latest batch: an older one never touches its labels.
      if (issue === undefined || !latestOf(state, batch, issue)) return [];
      const revisions = numberedEffects(
        state,
        (n) => revisionKey(batchId, n),
        LaneLabelRevision,
        "a lane label's revision",
      );
      const revision = revisions.length + 1;
      const previous = revisions.at(-1);
      const label = laneLabel(batch.lane) ?? null;
      // Nothing to show, or shown already; a batch cancelled before its first label has none.
      if (previous === undefined ? label === null : previous.label === label) return [];
      const key = revisionKey(batchId, revision);
      dues.set(effectKey.encode(key), { issue, label });
      return [key];
    },
    target: {
      find: async (key, signal) => {
        const { issue, label } = dueFor(key);
        const on = await host.labels(brewery, issue, signal);
        const shown = (label === null || has(on, label)) && others(on, label).length === 0;
        return shown ? { result: { label } } : undefined;
      },
      apply: async (key, signal) => {
        const { issue, label } = dueFor(key);
        const on = await host.labels(brewery, issue, signal);
        if (label !== null && !has(on, label)) {
          await host.createLabel(brewery, label, signal);
          await host.addLabel(brewery, issue, label, signal);
        }
        for (const name of others(on, label)) await host.removeLabel(brewery, issue, name, signal);
        return { label };
      },
    },
  };
};
