// The merge of the base before a batch's last check (ADR 0164): the base as the remote has it now,
// fetched as the push fetches it (ADR 0090), merged into the check attempt's worktree as a commit
// of its own, through the ledger, so the checks read the code the pull request will hold and a
// kill on either side of the merge never merges twice (I4).

import {
  type AttemptEffectKey,
  EffectKeyParts,
  MAX_CONFLICTS,
  MergeResult,
} from '../schemas/store.ts';
import type { AttemptRef } from './attempt-key.ts';
import type { Ending } from './decide.ts';
import type { EffectTarget } from './effects.ts';
import type { State } from './fold.ts';
import type { BranchPush } from './pull-request-actions.ts';

/** What a merge in a worktree came to: its commit, or the files it conflicts in, aborted. */
export type WorktreeMerged =
  | { kind: 'merged'; commit: string }
  | { kind: 'conflicts'; files: string[] };

/** git in an attempt's worktree. Every call stops when `signal` aborts. */
export interface WorktreeMerge {
  /** The commit the worktree's HEAD is at. */
  head(path: string, signal?: AbortSignal): Promise<string>;
  /** The parents of `commit`, full shas, in order. */
  parents(path: string, commit: string, signal?: AbortSignal): Promise<string[]>;
  /** Aborts a merge a killed run left in progress; nothing when none is. */
  abort(path: string, signal?: AbortSignal): Promise<void>;
  /**
   * Merges `commit` into HEAD as a commit of its own with `message`; on a conflict, the files it
   * conflicts in, with the merge aborted.
   */
  merge(
    path: string,
    commit: string,
    message: string,
    signal?: AbortSignal,
  ): Promise<WorktreeMerged>;
}

/** How a repository's check attempts merge its base. */
export interface BaseMerge {
  /** The branch the pull request goes into, as the remote names it (`main`). */
  base: string;
  /** The push's fetch of the base and its ancestor check (ADR 0090). */
  push: Pick<BranchPush, 'baseTip' | 'isAncestor'>;
  worktree: WorktreeMerge;
}

/** The ledger's key of the merge before attempt `ref`. */
const MERGE_BASE = 'merge_base';

export const baseMergeKey = (ref: AttemptRef): AttemptEffectKey => ({ ...ref, effect: MERGE_BASE });

/**
 * The merge into the worktree at `path`, which the attempt of `stepId` started at `start`: found
 * when HEAD is a merge of `start` and a commit of the base, which a run killed before it recorded
 * the merge made; a merge such a run left in progress is aborted, and found as nothing.
 */
export const baseMergeTarget = (
  { base, push, worktree }: BaseMerge,
  { path, start }: { path: string; start: string },
  stepId: string,
): EffectTarget => ({
  find: async (_key, signal) => {
    const head = await worktree.head(path, signal);
    // A merge in progress has not moved HEAD.
    if (head === start) {
      await worktree.abort(path, signal);
      return undefined;
    }
    const [first, second, ...more] = await worktree.parents(path, head, signal);
    if (first !== start || second === undefined || more.length > 0) {
      throw new Error(
        `The worktree ${path} moved from ${start} to ${head}, which is no merge of it`,
      );
    }
    return { result: { base: second, merged: head } satisfies MergeResult };
  },
  apply: async (_key, signal): Promise<MergeResult> => {
    const tip = await push.baseTip(base, signal);
    // Every commit of the base is in the attempt's start already: nothing to merge.
    if (await push.isAncestor(tip, start, signal)) return { base: tip };
    const merged = await worktree.merge(path, tip, `Merge ${base} before ${stepId}`, signal);
    switch (merged.kind) {
      case 'merged':
        return { base: tip, merged: merged.commit };
      case 'conflicts':
        return { base: tip, conflicts: merged.files.slice(0, MAX_CONFLICTS) };
      default:
        return merged satisfies never;
    }
  },
});

/**
 * How the attempt ends when its merge's `result` stops it: blocked on a divergence when it
 * conflicts, since another round would hit the same conflict; `undefined` when the attempt runs.
 */
export const mergeEnding = (result: unknown, base: string): Ending | undefined => {
  const parsed = MergeResult.safeParse(result);
  if (!parsed.success) {
    return {
      kind: 'failed',
      retryable: false,
      reason: 'the ledger holds a merge of the base that is not one the engine records',
    };
  }
  const { conflicts } = parsed.data;
  if (conflicts === undefined) return undefined;
  const summary = `conflicts with ${base} in ${conflicts.join(', ')}`;
  return { kind: 'blocked', blockerKind: 'divergence', summary };
};

/**
 * The base the latest merge of `batchId` brought in, when one made a commit: where the batch's own
 * change starts once its task tree holds that merge, so a review of the change never reads what
 * the base added while the batch brewed (ADR 0164). `undefined` when nothing was merged.
 */
export const mergedBase = (state: State, batchId: string): string | undefined => {
  let base: string | undefined;
  for (const [key, result] of state.effects) {
    const parts = EffectKeyParts.safeParse(JSON.parse(key));
    if (!parts.success || parts.data.length !== 4) continue;
    const [batch, , , effect] = parts.data;
    if (batch !== batchId || effect !== MERGE_BASE) continue;
    const merge = MergeResult.safeParse(result);
    if (merge.success && merge.data.merged !== undefined) base = merge.data.base;
  }
  return base;
};
