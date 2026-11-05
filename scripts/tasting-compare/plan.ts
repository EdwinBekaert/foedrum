// The decisions of node scripts/tasting-compare.ts --plan (#804, ADR 0323): the setups and their
// recipes, the seeded plan and its key, how a run's Taster attempts are scored against it, and the
// one table, on the diff mode's sums and rule (core.ts). Nothing here starts a process.

import type { Event } from '../../src/schemas/events.ts';
import type { Scripted } from '../../test/helpers/nip-fixture.ts';
import type { RunRecord, RunScore, SetupSummary } from './core.ts';

/** The setups that run, and their lenses. */
export const PLAN_SETUPS = {
  'plan-apart-7': { lenses: [] as readonly string[] },
  'plan-together-7': { lenses: [] as readonly string[] },
  'plan-together-mash': { lenses: [] as readonly string[] },
} as const;
export type PlanSetupName = keyof typeof PLAN_SETUPS;
export type PlanRunRecord = RunRecord<PlanSetupName>;
export type PlanShown = PlanSetupName | 'plan-apart-mash';

/** The step the scripted plan is written by. */
export const PLAN_STEP = 'plan';

/** One planted mistake: its lens, the sub-orders at fault, the field it is in, and what it is. */
export interface Mistake {
  id: string;
  lens: string;
  subOrders: readonly string[];
  field: string;
  what: string;
}
export interface PlanKey {
  mistakes: readonly Mistake[];
}

export const planRecipeText = (_setup: PlanSetupName): string => {
  throw new Error('not implemented');
};
export const readPlanKey = (_text: string): PlanKey => {
  throw new Error('not implemented');
};
export const readSeededPlan = (_text: string): Scripted => {
  throw new Error('not implemented');
};
export const subOrderOfWhy = (_why: string): string | undefined => {
  throw new Error('not implemented');
};
export const planRecordOf = (
  _events: readonly { event: Event }[],
  _setup: PlanSetupName,
): Pick<PlanRunRecord, 'ended' | 'attempts'> => {
  throw new Error('not implemented');
};
export const planRunFailure = (_record: PlanRunRecord): string | undefined => {
  throw new Error('not implemented');
};
export const scorePlanRun = (_record: PlanRunRecord, _key: PlanKey): RunScore => {
  throw new Error('not implemented');
};
export const summarizePlan = (
  _records: readonly PlanRunRecord[],
  _key: PlanKey,
): SetupSummary<PlanShown>[] => {
  throw new Error('not implemented');
};
export const nextPlanRun = (
  _records: readonly PlanRunRecord[],
  _runs: number,
): { setup: PlanSetupName; run: number; retry: boolean } | undefined => {
  throw new Error('not implemented');
};
export const planTableMarkdown = (
  _summaries: readonly SetupSummary<PlanShown>[],
  _key: PlanKey,
): string => {
  throw new Error('not implemented');
};
export const scriptedPlanTastings = (
  _setup: PlanSetupName,
  _key: PlanKey,
): Record<string, readonly Scripted[]> => {
  throw new Error('not implemented');
};
