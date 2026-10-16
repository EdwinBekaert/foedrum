// What a driver does with the leases its earlier run left when it starts again (ADR 0032).

import type { EventStore } from './event-store.ts';

/**
 * Sets the live leases of `owner` to expire at `now`: the processes of that owner's earlier run
 * died with it (architecture §5: no "maybe alive"), so the supervisor's next tick loses their
 * attempts. Leases of other owners stay as they are. Returns the attempt keys it expired.
 */
export const expireOwnLeases = (_store: EventStore, _owner: string, _now: Date): string[] => {
  throw new Error('not implemented');
};
