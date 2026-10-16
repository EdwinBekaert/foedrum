// The attempt worktree cleanup, wired into the engine (ADR 0029, ADR 0037): over every batch at a
// driver's start (crash repair), and over one batch once it has ended.

import type { Event } from '../schemas/events.ts';
import type { AttemptWorktrees, CleanReport } from '../workspace/attempt-worktrees-git.ts';
import type { Lease } from './event-store.ts';
import type { State } from './fold.ts';

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
export const endedBatches = (_events: readonly Event[]): string[] => {
  throw new Error('not implemented');
};

export const createWorktreeCleanup = (_options: WorktreeCleanupOptions): WorktreeCleanup => ({
  repair: () => Promise.reject(new Error('not implemented')),
  batchEnded: () => Promise.reject(new Error('not implemented')),
});
