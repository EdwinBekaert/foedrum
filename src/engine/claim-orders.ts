// The Brewery issue that is the order of a claimed target-repository issue (ADR 0144). The driver
// opens it as an effect of the batch, so its number is what the ledger recorded for that effect;
// a batch that orders the issue again has the Brewery issue an earlier batch of it opened. Pure:
// everything here is read from the folded state.

import { aliasOf } from './batch-id.ts';
import { effectKey } from './effect-key.ts';
import type { Batch, State } from './fold.ts';
import { type ClaimOrder, orderEffects, same } from './issue-claims.ts';

const applied = (state: State, batchId: string, effect: string): boolean =>
  state.effects.has(effectKey.encode({ batchId, effect }));

// The Brewery issue the batch opened, as the ledger recorded it; a result that is no issue number
// never names one.
const openedBy = (state: State, batchId: string): number | undefined => {
  const result = state.effects.get(effectKey.encode({ batchId, effect: orderEffects.open }));
  return typeof result === 'number' && Number.isSafeInteger(result) && result > 0
    ? result
    : undefined;
};

/** The Brewery issue of the claimed batch `batchId`; none for a batch of a Brewery issue. */
export const claimOrderOf = (state: State, batchId: string): ClaimOrder => {
  const batch = state.batches.get(batchId);
  if (batch?.repo === undefined) return {};
  const { repo, issue } = batch;
  // The batches of the issue before this one, in the order they were ordered.
  let earlier: { issue: number; closed: boolean } | undefined;
  for (const other of state.batches.values()) {
    if (other.id === batchId) break;
    if (other.issue !== issue || other.repo === undefined || !same(other.repo, repo)) continue;
    const opened = openedBy(state, other.id);
    if (opened !== undefined) earlier = { issue: opened, closed: false };
    if (earlier === undefined) continue;
    if (applied(state, other.id, orderEffects.reopen)) earlier = { ...earlier, closed: false };
    if (applied(state, other.id, orderEffects.close)) earlier = { ...earlier, closed: true };
  }
  const own = openedBy(state, batchId) ?? earlier?.issue;
  return {
    ...(earlier === undefined ? {} : { earlier }),
    ...(own === undefined ? {} : { issue: own }),
  };
};

/** The latest claimed batch whose order is the Brewery issue `issue`, or undefined. */
export const claimOfOrder = (state: State, issue: number): Batch | undefined => {
  // The Brewery issue each claimed issue has so far, by `<repo in lower case>#<issue>`: one pass.
  const orders = new Map<string, number>();
  let found: Batch | undefined;
  for (const batch of state.batches.values()) {
    if (batch.repo === undefined) continue;
    const key = `${batch.repo.toLowerCase()}#${batch.issue}`;
    const own = openedBy(state, batch.id) ?? orders.get(key);
    if (own === undefined) continue;
    orders.set(key, own);
    if (own === issue) found = batch;
  }
  return found;
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
