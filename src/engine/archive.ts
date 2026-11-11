// Which finished batches a cleanup shelves (ADR 0380): the store forgets them, and the next flush
// moves their folders to `archive/` on the state branch, for people only. Pure: everything is read
// from the folded state and the facts the driver gives.

import { type Batch, batchEnded, type State } from './fold.ts';

/** What the cleanup reads beside the fold: work that the events alone do not show. */
export interface ArchiveFacts {
  /** Whether an effect of `batchId` is still due, or one of its sources could not be read. */
  due(batchId: string): boolean;
  /** The batches with a live batch lease or attempt lease. */
  leased: ReadonlySet<string>;
  /** Whether the state branch lacks an event of `batchId`, or the store still keeps an out doc of it. */
  unpushed(batchId: string): boolean;
}

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
 * The batches a cleanup shelves now, in the order they were ordered: each ended, with no effect
 * due, no mark, no lease and nothing left to push, and every batch of its family (the order it
 * was split from and its sub-orders) too, since a live sub-order reads its order and its siblings.
 */
export const archivable = (state: State, facts: ArchiveFacts): Batch[] => {
  const finished = (batch: Batch): boolean =>
    batchEnded(batch) &&
    batch.failing === undefined &&
    !facts.leased.has(batch.id) &&
    !facts.due(batch.id) &&
    !facts.unpushed(batch.id);
  const families = new Map<string, Batch[]>();
  for (const batch of state.batches.values()) {
    const root = rootOf(state, batch);
    families.set(root, [...(families.get(root) ?? []), batch]);
  }
  const taken = new Set<string>();
  for (const family of families.values()) {
    if (family.every(finished)) for (const { id } of family) taken.add(id);
  }
  return [...state.batches.values()].filter(({ id }) => taken.has(id));
};
