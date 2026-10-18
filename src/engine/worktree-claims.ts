// What the engine's state claims of the attempt worktrees (ADR 0029): which batches may still
// brew, and which attempts hold a live lease. The worktree manager removes nothing they claim.

import type { AttemptRef, Claims } from '../workspace/attempt-worktrees.ts';
import { attemptKey } from './attempt-key.ts';
import type { Lease } from './event-store.ts';
import type { Lane, State } from './fold.ts';

/**
 * Whether a batch in this lane may still brew. A Stuck batch stays live: a human may take over or
 * resume it.
 */
export const laneStatus = (lane: Lane): 'live' | 'ended' => {
  switch (lane.kind) {
    case 'ordered':
    case 'brewing':
    case 'conditioning':
    case 'stuck':
      return 'live';
    case 'on_tap':
    case 'cancelled':
      return 'ended';
    default: {
      const unknown: never = lane;
      throw new Error(`Unknown lane ${JSON.stringify(unknown)}`);
    }
  }
};

/** The out doc of a step's brewer, or undefined when it has none or it cannot be found. */
export type OutDocOf = (step: { batchId: string; stepId: string }) => string | undefined;

/** The claims of the folded state and the leases alive now (`EventStore.currentLeases`). */
export const worktreeClaims = (
  state: State,
  leases: readonly Lease[],
  _outDoc?: OutDocOf,
): Claims => ({
  batches: new Map([...state.batches].map(([id, batch]) => [id, laneStatus(batch.lane)])),
  // A lease under any other key holds no attempt the engine knows (ADR 0027).
  leased: leases.flatMap((lease): AttemptRef[] => {
    const ref = attemptKey.decode(lease.attemptKey);
    return ref === undefined ? [] : [ref];
  }),
});
