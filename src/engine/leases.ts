// What a driver does with the leases its earlier run left when it starts again (ADR 0032).

import type { EventStore } from './event-store.ts';

/**
 * Sets the live leases of `owner` to expire at `now`: the processes of that owner's earlier run
 * died with it (architecture §5: no "maybe alive"), so the supervisor's next tick loses their
 * attempts. Leases of other owners stay as they are. Returns the attempt keys it expired.
 */
export const expireOwnLeases = (store: EventStore, owner: string, now: Date): string[] => {
  const left = store.currentLeases(now).filter((lease) => lease.owner === owner);
  if (left.length > 0) {
    store.withTransaction((tx) => {
      for (const lease of left) tx.putLease({ ...lease, expiresAt: now });
    });
  }
  return left.map((lease) => lease.attemptKey);
};
