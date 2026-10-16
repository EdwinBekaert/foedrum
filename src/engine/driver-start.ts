// What a driver does when it starts on a store, before it takes new work (ADR 0033, ADR 0037).

import type { CleanReport } from '../workspace/attempt-worktrees-git.ts';
import type { DriverLock } from './driver-lock.ts';
import type { EventStore } from './event-store.ts';
import type { WorktreeCleanup } from './worktree-cleanup.ts';

export interface DriverStartOptions {
  store: EventStore;
  /** The driver's lock (`lockDriver`), held for as long as the driver runs; it names the owner. */
  lock: DriverLock;
  now: Date;
  cleanup: WorktreeCleanup;
}

export interface DriverStart {
  /** The attempt keys of the leases its earlier run left, now expired. */
  expired: string[];
  /** What the crash repair of the attempt worktrees did. */
  repair: CleanReport;
}

/**
 * Expires the leases of the driver's earlier run, then repairs the attempt worktrees with the
 * claims that are left. Throws, changing nothing, when the lock is not held.
 */
export const startDriver = async (_options: DriverStartOptions): Promise<DriverStart> => {
  throw new Error('not implemented');
};
