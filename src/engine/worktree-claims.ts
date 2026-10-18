// What the engine's state claims of the attempt worktrees (ADR 0029): which batches may still
// brew, and which attempts hold a live lease. The worktree manager removes nothing they claim.

import { PushResult } from '../schemas/store.ts';
import { type AttemptRef, attemptBranch, type Claims } from '../workspace/attempt-worktrees.ts';
import { attemptKey } from './attempt-key.ts';
import { effectKey } from './effect-key.ts';
import type { Lease } from './event-store.ts';
import type { Lane, State } from './fold.ts';
import { pushKey } from './pull-request.ts';
import { sameRepo, taskTreeStart } from './task-tree.ts';

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

// The out doc of every step of an ended batch whose brewer names one (ADR 0081). A live batch
// keeps its worktrees anyway.
const outDocsOf = (state: State, outDoc: OutDocOf): Map<string, string> => {
  const outDocs = new Map<string, string>();
  for (const batch of state.batches.values()) {
    if (laneStatus(batch.lane) !== 'ended') continue;
    for (const stepId of batch.steps.keys()) {
      const file = outDoc({ batchId: batch.id, stepId });
      if (file !== undefined) outDocs.set(`${batch.id}/${stepId}`, file);
    }
  }
  return outDocs;
};

// The branch of every ended batch's task tree that no push recorded, with the commit the batch
// started from: the worktree of its first attempt that succeeded was made there (ADR 0066). An
// attempt that failed before it may have started at a base that moved since. A rewound task tree
// is a commit, not a branch, so it names none (ADR 0084).
const unpushedOf = (state: State): Map<string, string> => {
  const unpushed = new Map<string, string>();
  for (const batch of state.batches.values()) {
    const { taskTree } = batch;
    if (laneStatus(batch.lane) !== 'ended' || taskTree?.kind !== 'attempt') continue;
    const branch = attemptBranch({ batchId: batch.id, ...taskTree });
    const pushed = PushResult.safeParse(state.effects.get(effectKey.encode(pushKey(batch.id))));
    // The revision the push of the openPullRequest action records (ADR 0071).
    const revision = taskTreeStart(batch, { repo: taskTree.repo, base: '' });
    if (pushed.success && pushed.data.from === revision) continue;
    const worktrees = [...batch.steps.values()].flatMap((step) =>
      [...step.attempts.values()].flatMap((attempt) =>
        attempt.phase === 'finished' &&
        attempt.outcome.kind === 'succeeded' &&
        attempt.worktree !== undefined
          ? [attempt.worktree]
          : [],
      ),
    );
    // A batch whose start cannot be found keeps its branch: no tip is ''.
    unpushed.set(
      branch,
      worktrees.find((worktree) => sameRepo(worktree.repo, taskTree.repo))?.commit ?? '',
    );
  }
  return unpushed;
};

/** The claims of the folded state and the leases alive now (`EventStore.currentLeases`). */
export const worktreeClaims = (
  state: State,
  leases: readonly Lease[],
  outDoc?: OutDocOf,
): Claims => ({
  batches: new Map([...state.batches].map(([id, batch]) => [id, laneStatus(batch.lane)])),
  // A lease under any other key holds no attempt the engine knows (ADR 0027).
  leased: leases.flatMap((lease): AttemptRef[] => {
    const ref = attemptKey.decode(lease.attemptKey);
    return ref === undefined ? [] : [ref];
  }),
  ...(outDoc === undefined ? {} : { outDocs: outDocsOf(state, outDoc) }),
  unpushed: unpushedOf(state),
});
