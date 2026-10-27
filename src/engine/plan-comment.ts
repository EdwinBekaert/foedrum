// The plan comment of an order (ADR 0233): the latest succeeded plan of its batch as a table and a
// graph on the order's issue, its edits as revisions in the ledger, `[batchId, "plan.<n>"]`, each
// found by its marker on the Brewery's own comment before it is applied (ADR 0033).

import type { IsCommit } from '../formats/secrets.ts';
import type { PlanReport } from '../schemas/plan.ts';
import type { DriverEffects } from './driver.ts';
import type { StatusComments } from './status-comment.ts';

/**
 * The plan comment's text for the plan `stepId` of `batchId` wrote, without its marker: every text
 * the brewer wrote one escaped line, left out when it looks like a secret.
 */
export const renderPlan = (
  _batchId: string,
  _stepId: string,
  _plan: PlanReport,
  _isCommit: IsCommit = () => false,
): string => {
  throw new Error('not implemented');
};

export interface PlanEffectsOptions {
  /** The Brewery's repository, `owner/name`, where its issues are. */
  brewery: string;
  comments: StatusComments;
}

/**
 * The plan comment of every order whose batch has a succeeded plan, for the driver: a revision
 * whenever its text changed, edited in place, a later batch of the order editing the same comment.
 */
export const planEffects = (_options: PlanEffectsOptions): DriverEffects => {
  throw new Error('not implemented');
};
