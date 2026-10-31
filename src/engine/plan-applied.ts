// What the ledger holds of an approved plan applied as Brewery sub-issues (ADR 0285): the keys of
// its effects, and the issues opened so far, which the plan comment and the status comment show.

import { type PlanReport, planOf } from '../schemas/plan.ts';
import type { BatchEffectKey } from '../schemas/store.ts';
import { z } from '../schemas/zod.ts';
import { effectKey } from './effect-key.ts';
import type { Batch, State } from './fold.ts';

/** A sub-issue the ledger has for an approved plan's entry `id`. */
export interface OpenedSubIssue {
  id: string;
  number: number;
}

/** What the ledger keeps of an opened issue: its number, and the tracker's handle for links. */
export const OpenedIssue = z.strictObject({
  number: z.int().positive(),
  id: z.int().positive(),
});
export type OpenedIssue = z.infer<typeof OpenedIssue>;

/** The effect that opens the issue of entry `id`. */
export const issueKey = (batchId: string, id: string): BatchEffectKey => ({
  batchId,
  effect: `plan.${id}.issue`,
});
/** The effect that adds the issue of entry `id` under its order. */
export const parentKey = (batchId: string, id: string): BatchEffectKey => ({
  batchId,
  effect: `plan.${id}.parent`,
});
/** The effect that marks the issue of entry `id` blocked by that of entry `on`. */
export const linkKey = (batchId: string, id: string, on: string): BatchEffectKey => ({
  batchId,
  effect: `plan.${id}.blocked-by.${on}`,
});

/**
 * The plan an approval signed off: the out doc of the attempt it names, whose digest the guard
 * checked at approve (ADR 0281); undefined for a batch without an approval.
 */
export const approvedPlan = (
  batch: Batch,
): { stepId: string; attempt: number; plan: PlanReport } | undefined => {
  const { approval } = batch;
  if (approval === undefined) return undefined;
  const { stepId, attempt } = approval;
  const ended = batch.steps.get(stepId)?.attempts.get(attempt);
  if (ended?.phase !== 'finished' || ended.outcome.kind !== 'succeeded') return undefined;
  const plan = planOf(ended.outcome.output);
  return plan === undefined ? undefined : { stepId, attempt, plan };
};

/** The issue the ledger recorded for `key`, or undefined; throws for a result that is none. */
export const openedIssue = (state: State, key: BatchEffectKey): OpenedIssue | undefined => {
  const text = effectKey.encode(key);
  if (!state.effects.has(text)) return undefined;
  const read = OpenedIssue.safeParse(state.effects.get(text));
  if (!read.success) throw new Error(`The ledger's ${text} is not an opened issue`);
  return read.data;
};

/** The sub-issues the ledger has of the plan `batchId` approved, in the plan's order. */
export const openedSubIssues = (state: State, batchId: string): OpenedSubIssue[] => {
  const batch = state.batches.get(batchId);
  const approved = batch === undefined ? undefined : approvedPlan(batch);
  if (approved === undefined) return [];
  return approved.plan.subOrders.flatMap(({ id }) => {
    const opened = openedIssue(state, issueKey(batchId, id));
    return opened === undefined ? [] : [{ id, number: opened.number }];
  });
};

/** The numbers of every sub-issue of the plan `batchId` approved, once all are opened; else undefined. */
export const allSubIssues = (state: State, batchId: string): number[] | undefined => {
  const batch = state.batches.get(batchId);
  const approved = batch === undefined ? undefined : approvedPlan(batch);
  const opened = openedSubIssues(state, batchId);
  if (approved === undefined || opened.length < approved.plan.subOrders.length) return undefined;
  return opened.map(({ number }) => number);
};
