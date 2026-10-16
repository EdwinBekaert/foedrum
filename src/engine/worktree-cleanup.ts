// The attempt worktree cleanup, wired into the engine (ADR 0029, ADR 0037): over every batch at a
// driver's start (crash repair), and over one batch once it has ended.

import type { Event } from '../schemas/events.ts';
import type { AttemptWorktrees, CleanReport } from '../workspace/attempt-worktrees-git.ts';
import type { Lease } from './event-store.ts';
import type { State } from './fold.ts';
import { laneStatus, worktreeClaims } from './worktree-claims.ts';

export interface WorktreeCleanupOptions {
  /** One manager per repository the Brewery's attempts write in. */
  worktrees: readonly Pick<AttemptWorktrees, 'root' | 'clean'>[];
  /** The folded state now. */
  state: () => State;
  /** The leases alive now (`EventStore.currentLeases`). */
  leases: () => readonly Lease[];
}

export interface WorktreeCleanup {
  /** Cleans every repository over every batch: at a driver's start, before new work. */
  repair(): Promise<CleanReport>;
  /** Cleans every repository over one batch, when it has ended; nothing for a live batch. */
  batchEnded(batchId: string): Promise<CleanReport>;
}

/** The batches these events end (on tap or cancelled), each once, in order. */
export const endedBatches = (events: readonly Event[]): string[] => [
  ...new Set(
    events.flatMap((event) =>
      event.type === 'batch.on_tap' || event.type === 'batch.cancelled' ? [event.batchId] : [],
    ),
  ),
];

/** Whether the batch has ended: on tap or cancelled. */
export const batchIsOver = (state: State, batchId: string): boolean => {
  const batch = state.batches.get(batchId);
  return batch !== undefined && laneStatus(batch.lane) === 'ended';
};

export const createWorktreeCleanup = (options: WorktreeCleanupOptions): WorktreeCleanup => {
  const { worktrees, state, leases } = options;
  // One repository after another, each with the claims of now. A repository whose facts cannot
  // be gathered is reported and the others go on; the next cleanup tries it again.
  const clean = async (scope: { batchId?: string }): Promise<CleanReport> => {
    const report: CleanReport = { done: [], kept: [], failed: [] };
    for (const manager of worktrees) {
      try {
        const done = await manager.clean(worktreeClaims(state(), leases()), scope);
        report.done.push(...done.done);
        report.kept.push(...done.kept);
        report.failed.push(...done.failed);
      } catch (error) {
        report.failed.push(`could not clean ${manager.root}: ${(error as Error).message}`);
      }
    }
    return report;
  };
  return {
    repair: () => clean({}),
    batchEnded: async (batchId) =>
      batchIsOver(state(), batchId) ? clean({ batchId }) : { done: [], kept: [], failed: [] },
  };
};
