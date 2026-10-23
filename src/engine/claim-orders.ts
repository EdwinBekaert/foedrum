// The Brewery issue that is the order of a claimed target-repository issue (ADR 0144). The driver
// opens it as an effect of the batch, so its number is what the ledger recorded for that effect;
// a batch that orders the issue again has the Brewery issue an earlier batch of it opened. Pure:
// everything here is read from the folded state.

import { aliasOf } from './batch-id.ts';
import { effectKey } from './effect-key.ts';
import type { Batch, State } from './fold.ts';
import { type ClaimOrder, orderEffects, same } from './issue-claims.ts';

// The Brewery issue the batch opened, as the ledger recorded it; a result that is no issue number
// never names one.
const openedBy = (state: State, batchId: string): number | undefined => {
  const result = state.effects.get(effectKey.encode({ batchId, effect: orderEffects.open }));
  return typeof result === 'number' && Number.isSafeInteger(result) && result > 0
    ? result
    : undefined;
};

// A person deleted the Brewery issue, as the batch's reopen or close found it.
const foundGone = (state: State, batchId: string, effect: string): boolean =>
  state.effects.get(effectKey.encode({ batchId, effect })) === 'gone';

/** The batch's own Brewery issue, given the one the batches before it left (`earlier`). */
const ownOrder = (state: State, batchId: string, earlier: number | undefined) =>
  openedBy(state, batchId) ??
  (foundGone(state, batchId, orderEffects.reopen) ? undefined : earlier);

/** The Brewery issue the batch leaves for the next batch of its issue. */
const leftBy = (state: State, batchId: string, earlier: number | undefined) =>
  foundGone(state, batchId, orderEffects.close) ? undefined : ownOrder(state, batchId, earlier);

/** The Brewery issue of the claimed batch `batchId`; none for a batch of a Brewery issue. */
export const claimOrderOf = (state: State, batchId: string): ClaimOrder => {
  const batch = state.batches.get(batchId);
  if (batch?.repo === undefined) return {};
  const { repo, issue } = batch;
  // The batches of the issue before this one, in the order they were ordered.
  let earlier: number | undefined;
  for (const other of state.batches.values()) {
    if (other.id === batchId) break;
    if (other.issue !== issue || other.repo === undefined || !same(other.repo, repo)) continue;
    earlier = leftBy(state, other.id, earlier);
  }
  const own = ownOrder(state, batchId, earlier);
  const gone = foundGone(state, batchId, orderEffects.reopen);
  return {
    ...(earlier === undefined ? {} : { earlier: { issue: earlier, ...(gone ? { gone } : {}) } }),
    ...(own === undefined ? {} : { issue: own }),
  };
};

/** The latest claimed batch whose order is the Brewery issue `issue`, or undefined. */
export const claimOfOrder = (state: State, issue: number): Batch | undefined => {
  // The Brewery issue each claimed issue has so far, by `<repo in lower case>#<issue>`: one pass.
  const orders = new Map<string, number | undefined>();
  let found: Batch | undefined;
  for (const batch of state.batches.values()) {
    if (batch.repo === undefined) continue;
    const key = `${batch.repo.toLowerCase()}#${batch.issue}`;
    const earlier = orders.get(key);
    if (ownOrder(state, batch.id, earlier) === issue) found = batch;
    orders.set(key, leftBy(state, batch.id, earlier));
  }
  return found;
};

/**
 * The Brewery issue that shows a batch's status comment and lane label: a Brewery issue's batch's
 * own, and a claimed batch's order once the ledger records it, never the target issue's number.
 */
export const breweryIssueOf = (state: State, batch: Batch): number | undefined =>
  batch.repo === undefined ? batch.issue : claimOrderOf(state, batch.id).issue;

/** Whether `batch` is the latest batch of the Brewery issue `issue`, the one that labels it. */
export const latestOf = (state: State, batch: Batch, issue: number): boolean => {
  if (batch.repo !== undefined) return claimOfOrder(state, issue)?.id === batch.id;
  return (state.orders.get(issue) ?? state.subOrders.get(issue))?.batchIds.at(-1) === batch.id;
};

/** A claimed batch's target issue as `<alias>#<n>`, or `owner/name#<n>` when its id has no alias. */
export const claimedName = (batch: Batch): string =>
  `${aliasOf(batch.id) ?? batch.repo}#${batch.issue}`;

/**
 * How `status` and `stuck` name a batch's issue: `#<n>` for a Brewery issue, `#<order> (<alias>#<n>)`
 * for a claimed one, and `<alias>#<n>` until its Brewery issue is opened.
 */
export const orderName = (state: State, batch: Batch): string => {
  if (batch.repo === undefined) return `#${batch.issue}`;
  const claimed = claimedName(batch);
  const { issue } = claimOrderOf(state, batch.id);
  return issue === undefined ? claimed : `#${issue} (${claimed})`;
};
