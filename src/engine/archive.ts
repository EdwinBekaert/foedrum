// The archive of finished batches (ADR 0380): which batches a cleanup may move to `archive/` on the
// state branch, and the event that records each, which keeps what later batches of its issue still
// read. Pure: everything is read from the folded state and the facts the driver gives.

import type { ArchivedEnd, Event, OrderRef } from '../schemas/events.ts';
import { breweryIssueLeftBy } from './claim-orders.ts';
import { type ArchivedBatch, type Batch, batchEnded, type State } from './fold.ts';
import { same } from './issue-claims.ts';
import { shownPlanComment } from './plan-comment.ts';

/** What the cleanup reads beside the fold: work that the events alone do not show. */
export interface ArchiveFacts {
  /** Whether an effect of `batchId` is still due, or one of its sources could not be read. */
  due(batchId: string): boolean;
  /** The batches with a live batch lease or attempt lease. */
  leased: ReadonlySet<string>;
}

type Archived = Extract<Event, { type: 'batch.archived' }>;

/** The batch at the top of `batch`'s family: the order it was split from, or itself. */
const rootOf = (state: State, batch: Batch): string => {
  let id = batch.id;
  for (let parent = batch.parentBatchId; parent !== undefined; ) {
    id = parent;
    parent = state.batches.get(parent)?.parentBatchId;
  }
  return id;
};

/**
 * The batches a cleanup archives now, in the order they were ordered: each ended, with no effect
 * due, no mark and no lease, and every batch of its family (the order it was split from and its
 * sub-orders) too, since a live sub-order reads its order and its siblings; and every earlier
 * batch of its issue too.
 */
export const archivable = (state: State, facts: ArchiveFacts): Batch[] => {
  const finished = (batch: Batch): boolean =>
    batchEnded(batch) &&
    batch.failing === undefined &&
    !facts.leased.has(batch.id) &&
    !facts.due(batch.id);
  const families = new Map<string, Batch[]>();
  for (const batch of state.batches.values()) {
    const root = rootOf(state, batch);
    families.set(root, [...(families.get(root) ?? []), batch]);
  }
  let taken = new Set<string>();
  for (const family of families.values()) {
    if (family.every(finished)) for (const { id } of family) taken.add(id);
  }
  // A batch goes only once every earlier one of its issue goes, so the index, which later batches
  // read by its last entry for the issue, keeps the order they were ordered in; a family a hold
  // splits stays whole. Each round takes away, so it ends.
  for (;;) {
    const held = new Set<string>();
    const kept = new Set<string>();
    for (const batch of state.batches.values()) {
      const issue = `${batch.repo?.toLowerCase() ?? ''}#${batch.issue}`;
      if (held.has(issue) || !taken.has(batch.id)) held.add(issue);
      else kept.add(batch.id);
    }
    for (const family of families.values()) {
      if (!family.every(({ id }) => kept.has(id))) for (const { id } of family) kept.delete(id);
    }
    if (kept.size === taken.size) break;
    taken = kept;
  }
  return [...state.batches.values()].filter(({ id }) => taken.has(id));
};

/** How `batch`, which ended, ended. */
const endOf = ({ lane, pullRequestEnds }: Batch): ArchivedEnd => {
  if (lane.kind === 'cancelled') return 'cancelled';
  if (lane.kind !== 'on_tap') throw new Error(`a batch ${lane.kind} has not ended`);
  if (lane.pullRequests.length === 0) return 'issue_closed';
  return lane.pullRequests.every((url) => pullRequestEnds?.[url] === 'merged')
    ? 'merged'
    : 'closed';
};

/**
 * The archived batches of an order, in the order they were archived: by the Brewery issue that was
 * their order, or by their own order (`<alias>#<n>` of a claimed issue).
 */
export const archivedOfOrder = (
  state: State,
  by: { breweryIssue: number } | { order: OrderRef },
): ArchivedBatch[] =>
  [...state.archived.values()].filter((archived) =>
    'breweryIssue' in by
      ? archived.breweryIssue === by.breweryIssue
      : archived.order.issue === by.order.issue &&
        (archived.order.repo === undefined
          ? by.order.repo === undefined
          : by.order.repo !== undefined && same(archived.order.repo, by.order.repo)),
  );

/** The event that archives `batch`, with what later batches of its issue read of it. */
export const archivedOf = (state: State, batch: Batch): Archived => {
  const breweryIssue = breweryIssueLeftBy(state, batch);
  const planComment = shownPlanComment(state, batch);
  return {
    type: 'batch.archived',
    batchId: batch.id,
    order: { issue: batch.issue, ...(batch.repo === undefined ? {} : { repo: batch.repo }) },
    ...(breweryIssue === undefined ? {} : { breweryIssue }),
    ...(planComment === undefined ? {} : { planComment }),
    ended: endOf(batch),
  };
};
