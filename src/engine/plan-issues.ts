// An approved plan as Brewery sub-issues (ADR 0285): the driver's effects that open each sub-order's
// issue, add it under its order and link it to what blocks it, each through the ledger, and the
// `order.decomposed` that follows the last of them.

import type { DriverEffects } from './driver.ts';
import type { State } from './fold.ts';
import type { SubIssues } from './sub-issues.ts';

export interface PlanIssueEffectsOptions {
  /** The Brewery's issues and their links. */
  subIssues: SubIssues;
  /** How long one effect may take; the driver's default when left out (`DriverEffects`). */
  deadlineMs?: number;
}

/** A sub-issue the ledger has for an approved plan's entry `id`. */
export interface OpenedSubIssue {
  id: string;
  number: number;
}

const notImplemented = (): never => {
  throw new Error('not implemented');
};

export const planIssueEffects = (_options: PlanIssueEffectsOptions): DriverEffects =>
  notImplemented();

export const openedSubIssues = (_state: State, _batchId: string): OpenedSubIssue[] =>
  notImplemented();
