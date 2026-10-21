// What the engine's state claims of the attempt worktrees (ADR 0029): which batches may still
// brew, and which attempts hold a live lease. The worktree manager removes nothing they claim.

import { PushResult } from '../schemas/store.ts';
import { type AttemptRef, attemptBranch, type Claims } from '../workspace/attempt-worktrees.ts';
import { attemptKey } from './attempt-key.ts';
import { effectKey } from './effect-key.ts';
import type { Lease } from './event-store.ts';
import type { Batch, Lane, State, TaskTree } from './fold.ts';
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

// The worktree of every attempt of a batch that recorded one, with whether the attempt succeeded.
const worktreesOf = (batch: Batch) =>
  [...batch.steps.values()].flatMap((step) =>
    [...step.attempts.values()].flatMap((attempt) =>
      attempt.phase !== 'scheduled' && attempt.worktree !== undefined
        ? [
            {
              ...attempt.worktree,
              succeeded: attempt.phase === 'finished' && attempt.outcome.kind === 'succeeded',
            },
          ]
        : [],
    ),
  );

// The branch that holds a batch's task tree in a repository, with its revision: the task tree's
// attempt's branch, or for a rewind the branch of the latest attempt made at its commit (ADR 0084).
const taskTreeBranchOf = (
  batch: Batch,
  taskTree: TaskTree,
): { repo: string; branch: string; revision: string } | undefined => {
  switch (taskTree.kind) {
    case 'attempt': {
      const branch = attemptBranch({ batchId: batch.id, ...taskTree });
      const revision = taskTreeStart(batch, { repo: taskTree.repo, base: '' });
      return { repo: taskTree.repo, branch, revision };
    }
    case 'rewound': {
      // A rewind of a Brewery order names one commit per repository; its attempts wrote in one.
      for (const [repo, commit] of Object.entries(taskTree.shas)) {
        const made = worktreesOf(batch).findLast(
          (worktree) =>
            sameRepo(worktree.repo, repo) && worktree.commit.toLowerCase() === commit.toLowerCase(),
        );
        if (made !== undefined) return { repo, branch: made.branch, revision: commit };
      }
      return undefined;
    }
    default: {
      const unknown: never = taskTree;
      throw new Error(`Unknown task tree ${JSON.stringify(unknown)}`);
    }
  }
};

// The branch of every ended batch's task tree that no push recorded, with the commit the batch
// started from: the worktree of its first attempt that succeeded was made there (ADR 0066). An
// attempt that failed before it may have started at a base that moved since. A rewound task tree
// is a commit; the branch of the latest attempt made at it holds it (#255).
const unpushedOf = (state: State): Map<string, string> => {
  const unpushed = new Map<string, string>();
  for (const batch of state.batches.values()) {
    const { taskTree } = batch;
    if (laneStatus(batch.lane) !== 'ended' || taskTree === undefined) continue;
    const held = taskTreeBranchOf(batch, taskTree);
    if (held === undefined) continue;
    const pushed = PushResult.safeParse(state.effects.get(effectKey.encode(pushKey(batch.id))));
    // The revision the push of the openPullRequest action records (ADR 0071). A push the secret
    // scan refused left nothing on the remote (ADR 0079).
    if (pushed.success && pushed.data.from === held.revision && pushed.data.refused === undefined) {
      continue;
    }
    const made = worktreesOf(batch).filter((worktree) => sameRepo(worktree.repo, held.repo));
    const start = made.find((worktree) => worktree.succeeded)?.commit;
    // A rewind to the batch's start holds no commit past it. With no attempt that succeeded, the
    // start is its first attempt's, which a base that moved since can only make keep more.
    const startedAt = start ?? made[0]?.commit;
    if (taskTree.kind === 'rewound' && held.revision.toLowerCase() === startedAt?.toLowerCase()) {
      continue;
    }
    // A batch whose start cannot be found keeps its branch: no tip is ''.
    unpushed.set(held.branch, start ?? '');
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
