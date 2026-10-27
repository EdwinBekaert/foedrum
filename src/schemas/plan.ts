// The plan out doc (ADR 0233): an order broken into sub-orders, one repository each, with what each
// touches, how they depend on each other, and the recipe each should run with.

import type { OutDocFrontmatter } from './out-doc.ts';
import { z } from './zod.ts';

/** The name of a plan's out doc schema (`output.schema`, ADR 0233). */
export const PLAN = 'plan';

/** A path a sub-order expects to change, `new` when it does not exist yet. */
export interface Touch {
  path: string;
  new?: true;
}

/** A sub-order of the plan waits for another's code or for its release. */
export interface PlanDependency {
  on: string;
  kind: 'code' | 'release';
}

/** One sub-order of a plan (ADR 0233). */
export interface PlannedSubOrder {
  id: string;
  title: string;
  repo: string;
  size: { lines: number; mechanism: string };
  doneWhen: string;
  touches: Touch[];
  dependencies: PlanDependency[];
  recipe: string;
  why: string;
  testFirst?: false;
  testFirstOff?: string;
  ready: boolean;
  refinement?: string;
}

/** Other cuts considered, and why this one. */
export interface PlanAlternatives {
  considered: { cut: string; whyNot: string }[];
  whyThis: string;
}

export type PlanOutDoc = OutDocFrontmatter & {
  subOrders?: PlannedSubOrder[];
  alternatives?: PlanAlternatives;
};

export const PlanOutDoc: z.ZodType<PlanOutDoc> = z.custom<PlanOutDoc>(() => {
  throw new Error('not implemented');
});

/** What a plan's out doc holds once it is done. */
export interface PlanReport {
  subOrders: readonly PlannedSubOrder[];
  alternatives?: PlanAlternatives;
}

/** The plan of an attempt's `output` when a `plan` brewer wrote it and was done; else undefined. */
export const planOf = (_output: unknown): PlanReport | undefined => {
  throw new Error('not implemented');
};
