// The recipe label of a batch whose recipe a person chose, by answering a step that chooses it
// (ADR 0232) or by foedrum recipe (ADR 0240): `recipe:<name>` on its Brewery issue, or on the
// Brewery issue that is a claimed batch's order (ADR 0156), set once per recipe through the ledger
// as the driver's effect `[batchId, "recipe-label:<name>"]`, found on the issue before it is applied
// (ADR 0033), as the lane labels are (ADR 0154): the issue's other recipe labels come off, so its
// next order has one to route by. A label added after routing routes only the issue's next batch
// (ADR 0068).

import type { BatchEffectKey } from '../schemas/store.ts';
import { breweryIssueOf } from './claim-orders.ts';
import type { DriverEffects } from './driver.ts';
import { effectKey } from './effect-key.ts';
import { same } from './issue-claims.ts';
import type { LaneLabelHost } from './lane-labels.ts';

export interface RecipeLabelEffectsOptions {
  /** The Brewery's repository, `owner/name`, where its issues are. */
  brewery: string;
  host: LaneLabelHost;
}

/** The recipe that asks which recipe brews an issue (ADR 0232): never one to route an order by. */
export const MASH_IN = 'mash-in';

const keyOf = (batchId: string, recipe: string): BatchEffectKey => ({
  batchId,
  effect: `recipe-label:${recipe}`,
});

/** The label a recipe label's recorded result names, or undefined. */
const labelOf = (result: unknown): string | undefined =>
  typeof result === 'object' &&
  result !== null &&
  'label' in result &&
  typeof result.label === 'string'
    ? result.label
    : undefined;

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
  // The issue's labels: whether it shows the due one, and its other recipe labels, to take off.
  // GitHub's label names are case-insensitive.
  const read = async (key: string, signal?: AbortSignal) => {
    const { issue, label } = dueFor(key);
    const on = await host.labels(brewery, issue, signal);
    const others = on.filter((name) => /^recipe:/i.test(name) && !same(name, label));
    return { shown: on.some((name) => same(name, label)), others };
  };
  return {
    due: (state, batchId) => {
      const batch = state.batches.get(batchId);
      const recipe = batch?.recipe;
      if (batch === undefined || recipe?.source !== 'human' || recipe.name === MASH_IN) return [];
      const key = keyOf(batchId, recipe.name);
      const encoded = effectKey.encode(key);
      // Once per recipe: a later choice of another recipe in the batch labels the issue again.
      if (state.effects.has(encoded)) return [];
      // An older Foedrum labelled the batch once, under `recipe-label`, with the label it recorded.
      const older = state.effects.get(effectKey.encode({ batchId, effect: 'recipe-label' }));
      if (labelOf(older) === `recipe:${recipe.name}`) return [];
      const issue = breweryIssueOf(state, batch);
      if (issue === undefined) return [];
      dues.set(encoded, { issue, label: `recipe:${recipe.name}` });
      return [key];
    },
    target: {
      find: async (key, signal) => {
        const { shown, others } = await read(key, signal);
        return shown && others.length === 0 ? { result: { label: dueFor(key).label } } : undefined;
      },
      apply: async (key, signal) => {
        const { issue, label } = dueFor(key);
        const { shown, others } = await read(key, signal);
        if (!shown) {
          await host.createLabel(brewery, label, signal);
          await host.addLabel(brewery, issue, label, signal);
        }
        for (const name of others) await host.removeLabel(brewery, issue, name, signal);
        return { label };
      },
    },
  };
};
