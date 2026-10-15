// What the engine's state claims of the attempt worktrees (ADR 0029): which batches may still
// brew, and which attempts hold a live lease. The worktree manager removes nothing they claim.

import type { Claims } from '../workspace/attempt-worktrees.ts';
import type { Lease } from './event-store.ts';
import type { State } from './fold.ts';

/** The claims of the folded state and the leases alive now (`EventStore.currentLeases`). */
export const worktreeClaims = (_state: State, _leases: readonly Lease[]): Claims => {
  throw new Error('not implemented');
};
