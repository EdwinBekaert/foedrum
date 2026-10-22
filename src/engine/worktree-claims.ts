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

// The worktree of every attempt of a batch that recorded one, in the order of its steps, with
// its branch, built from the attempt (ADR 0037).
const worktreesOf = (batch: Batch) =>
  [...batch.steps.values()].flatMap((step) =>
    [...step.attempts.values()].flatMap((attempt) =>
      attempt.phase !== 'scheduled' && attempt.worktree !== undefined
        ? [
            {
              repo: attempt.worktree.repo,
              commit: attempt.worktree.commit,
              branch: attemptBranch({
                batchId: batch.id,
                stepId: step.id,
                attempt: attempt.attempt,
              }),
            },
          ]
        : [],
    ),
  );

// The branches that hold a batch's task tree in a repository, with its revision: the task tree's
// attempt's branch, or for a rewind the branch of the last attempt made at its commit. When none
// was (the tip of a step an action step came after, or a failed attempt's work), only git can tell
// which branch holds the commit, so every attempt branch of the repository is named (ADR 0101).
const taskTreeBranchesOf = (
  batch: Batch,
  taskTree: TaskTree,
): { repo: string; branches: string[]; revision: string } | undefined => {
  switch (taskTree.kind) {
    case 'attempt': {
      const branch = attemptBranch({ batchId: batch.id, ...taskTree });
      const revision = taskTreeStart(batch, { repo: taskTree.repo, base: '' });
      return { repo: taskTree.repo, branches: [branch], revision };
    }
    case 'rewound': {
      // A rewind of a Brewery order names one commit per repository; its attempts wrote in one.
      const worktrees = worktreesOf(batch);
      for (const [repo, commit] of Object.entries(taskTree.shas)) {
        const inRepo = worktrees.filter((worktree) => sameRepo(worktree.repo, repo));
        if (inRepo.length === 0) continue;
        const made = inRepo.findLast((worktree) => worktree.commit === commit);
        const branches = made === undefined ? inRepo.map(({ branch }) => branch) : [made.branch];
        return { repo, branches, revision: commit };
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
// started from (`Batch.starts`): the worktree of its first attempt that succeeded was made there
// (ADR 0066). An attempt that failed before it may have started at a base that moved since. A
// rewound task tree is a commit, held by attempt branches (ADR 0101).
const unpushedOf = (state: State): Map<string, string> => {
  const unpushed = new Map<string, string>();
  for (const batch of state.batches.values()) {
    const { taskTree } = batch;
    if (laneStatus(batch.lane) !== 'ended' || taskTree === undefined) continue;
    const held = taskTreeBranchesOf(batch, taskTree);
    if (held === undefined) continue;
    const pushed = PushResult.safeParse(state.effects.get(effectKey.encode(pushKey(batch.id))));
    // The revision the push of the openPullRequest action records (ADR 0071). A push the secret
    // scan refused left nothing on the remote (ADR 0079).
    if (pushed.success && pushed.data.from === held.revision && pushed.data.refused === undefined) {
      continue;
    }
    // In the order of the events, which the steps do not follow after a recipe change (#309).
    const startedAt = batch.starts?.[held.repo.toLowerCase()];
    // A rewind to the batch's start holds no commit past it. With no attempt that succeeded, the
    // start is its first attempt's, which a base that moved since can only make keep more.
    if (taskTree.kind === 'rewound' && held.revision === startedAt?.commit) {
      continue;
    }
    const start = startedAt?.succeeded === true ? startedAt.commit : undefined;
    // A batch whose start cannot be found keeps its branch: no tip is ''.
    for (const branch of held.branches) unpushed.set(branch, start ?? '');
  }
  return unpushed;
};

// A leased attempt and every attempt whose session it continues, back through `session.resumes`:
// a resumed attempt runs in the worktree of the attempt that started its session, and has none of
// its own (ADR 0029). A session that kept its id when resumed names each attempt it ran in.
const continuedBy = (state: State, ref: AttemptRef): AttemptRef[] => {
  const batch = state.batches.get(ref.batchId);
  if (batch === undefined) return [ref];
  const sessions = [...batch.steps.values()].flatMap((step) =>
    [...step.attempts.values()].flatMap((attempt) => {
      if (attempt.phase === 'scheduled' || attempt.session === undefined) return [];
      const of = { batchId: batch.id, stepId: step.id, attempt: attempt.attempt };
      return [{ key: attemptKey.encode(of), ref: of, session: attempt.session }];
    }),
  );
  const claimed = new Map([[attemptKey.encode(ref), ref]]);
  const followed = new Set<string>();
  const pending = [sessions.find(({ key }) => claimed.has(key))?.session.resumes];
  while (pending.length > 0) {
    const id = pending.pop();
    if (id === undefined || followed.has(id)) continue;
    followed.add(id);
    for (const continued of sessions) {
      if (continued.session.id !== id || claimed.has(continued.key)) continue;
      claimed.set(continued.key, continued.ref);
      pending.push(continued.session.resumes);
    }
  }
  return [...claimed.values()];
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
    return ref === undefined ? [] : continuedBy(state, ref);
  }),
  ...(outDoc === undefined ? {} : { outDocs: outDocsOf(state, outDoc) }),
  unpushed: unpushedOf(state),
});
