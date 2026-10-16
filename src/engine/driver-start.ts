// What a driver does when it starts on a store, before it takes new work (ADR 0033, ADR 0037).

import type { CleanReport } from '../workspace/attempt-worktrees-git.ts';
import type { DriverLock } from './driver-lock.ts';
import type { EventStore } from './event-store.ts';
import { expireOwnLeases } from './leases.ts';
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
export const startDriver = async (options: DriverStartOptions): Promise<DriverStart> => {
  const { store, lock, now, cleanup } = options;
  // Only the holder of the driver's lock may expire its owner's leases: a second process with the
  // same owner would otherwise expire the live leases of the first (ADR 0037).
  if (!lock.held) {
    throw new Error(`The leases of ${lock.owner} expire only under its driver lock ${lock.path}`);
  }
  // First the leases: the attempts of the earlier run died with it, so they claim no worktree.
  const expired = expireOwnLeases(store, lock.owner, now);
  return { expired, repair: await cleanup.repair() };
};
