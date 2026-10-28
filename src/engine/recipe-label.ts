// The recipe label of a batch whose recipe a person chose by answering a step that chooses it
// (ADR 0232): `recipe:<name>` on its Brewery issue, or on the Brewery issue that is a claimed
// batch's order (ADR 0156), set once through the ledger as the driver's effect
// `[batchId, "recipe-label"]`, found on the issue before it is applied (ADR 0033), as the lane
// labels are (ADR 0154). A label added after routing routes only the issue's next batch (ADR 0068).

import type { BatchEffectKey } from '../schemas/store.ts';
import { breweryIssueOf } from './claim-orders.ts';
import type { DriverEffects } from './driver.ts';
import { effectKey } from './effect-key.ts';
import { same } from './issue-claims.ts';
import type { LaneLabelHost } from './lane-labels.ts';

export interface RecipeLabelEffectsOptions {
  /** The Brewery's repository, `owner/name`, where its issues are. */
  brewery: string;
  host: Omit<LaneLabelHost, 'removeLabel'>;
}

const keyOf = (batchId: string): BatchEffectKey => ({ batchId, effect: 'recipe-label' });

/** A recipe label that is due: the issue, and the label. */
interface DueLabel {
  issue: number;
  label: string;
}

/** The recipe label of every batch whose recipe an answer chose, for the driver. */
export const recipeLabelEffects = ({ brewery, host }: RecipeLabelEffectsOptions): DriverEffects => {
  // The label behind each key `due` gave; the driver asks `due` before it applies a key.
  const dues = new Map<string, DueLabel>();
  const dueFor = (key: string): DueLabel => {
    const due = dues.get(key);
    if (due === undefined) throw new Error(`No recipe label ${key} is due`);
    return due;
  };
  // GitHub's label names are case-insensitive.
  const shows = async (key: string, signal?: AbortSignal): Promise<boolean> => {
    const { issue, label } = dueFor(key);
    const on = await host.labels(brewery, issue, signal);
    return on.some((name) => same(name, label));
  };
  return {
    due: (state, batchId) => {
      const batch = state.batches.get(batchId);
      const recipe = batch?.recipe;
      if (batch === undefined || recipe?.source !== 'human' || recipe.askedBy === undefined) {
        return [];
      }
      const key = keyOf(batchId);
      const encoded = effectKey.encode(key);
      // Once: a later choice in the batch labels nothing more.
      if (state.effects.has(encoded)) return [];
      const issue = breweryIssueOf(state, batch);
      if (issue === undefined) return [];
      dues.set(encoded, { issue, label: `recipe:${recipe.name}` });
      return [key];
    },
    target: {
      find: async (key, signal) =>
        (await shows(key, signal)) ? { result: { label: dueFor(key).label } } : undefined,
      apply: async (key, signal) => {
        const { issue, label } = dueFor(key);
        if (!(await shows(key, signal))) {
          await host.createLabel(brewery, label, signal);
          await host.addLabel(brewery, issue, label, signal);
        }
        return { label };
      },
    },
  };
};
