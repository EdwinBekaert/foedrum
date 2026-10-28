// The merge of the base before a batch's last check (ADR 0164): the base as the remote has it now,
// fetched as the push fetches it (ADR 0090), merged into the check attempt's worktree as a commit
// of its own, through the ledger, so the checks read the code the pull request will hold and a
// kill on either side of the merge never merges twice (I4).

import type { ScheduleRoute } from '../schemas/events.ts';
import {
  type AttemptEffectKey,
  EffectKeyParts,
  type KeptFile,
  MAX_CONFLICTS,
  MergeResult,
} from '../schemas/store.ts';
import type { AttemptRef } from './attempt-key.ts';
import type { Ending } from './decide.ts';
import { effectKey } from './effect-key.ts';
import type { EffectTarget } from './effects.ts';
import type { Attempt, Batch, State, Step } from './fold.ts';
import type { BranchPush } from './pull-request-actions.ts';
import { ranIn } from './session-resume.ts';

/**
 * What a merge in a worktree came to: its commit, or the files it conflicts in, aborted, or kept
 * in progress with the files it left unmerged (ADR 0244).
 */
export type WorktreeMerged =
  | { kind: 'merged'; commit: string }
  | { kind: 'conflicts'; files: string[] }
  | { kind: 'kept'; files: KeptFile[] };

/** A merge in progress in a worktree: the commit it merges, and the files still unmerged. */
export interface PendingMerge {
  tip: string;
  files: KeptFile[];
}

/** git in an attempt's worktree. Every call stops when `signal` aborts. */
export interface WorktreeMerge {
  /** The commit the worktree's HEAD is at. */
  head(path: string, signal?: AbortSignal): Promise<string>;
  /** The parents of `commit`, full shas, in order. */
  parents(path: string, commit: string, signal?: AbortSignal): Promise<string[]>;
  /** Aborts a merge a killed run left in progress; nothing when none is. */
  abort(path: string, signal?: AbortSignal): Promise<void>;
  /** The merge in progress in the worktree, with the files still unmerged; none when none is. */
  pending(path: string, signal?: AbortSignal): Promise<PendingMerge | undefined>;
  /**
   * Merges `commit` into HEAD as a commit of its own with `message`; on a conflict, the files it
   * conflicts in, with the merge aborted, or with `keep` the merge left in progress with the
   * files it left unmerged (ADR 0244).
   */
  merge(
    path: string,
    commit: string,
    message: string,
    signal?: AbortSignal,
    keep?: boolean,
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

/** The ledger's effect name of the merge before a check attempt (ADR 0164). */
const MERGE_BASE = 'merge_base';

export const baseMergeKey = (ref: AttemptRef): AttemptEffectKey => ({ ...ref, effect: MERGE_BASE });

/** The files a kept merge left unmerged, as the ledger names them: at most `MAX_CONFLICTS`. */
const keptOf = (files: readonly KeptFile[]): NonNullable<MergeResult['kept']> => ({
  files: files.slice(0, MAX_CONFLICTS),
  more: Math.max(0, files.length - MAX_CONFLICTS),
});

/**
 * The merge into the worktree at `path`, which the attempt of `stepId` started at `start`: found
 * when HEAD is a merge of `start` and a commit of the base, which a run killed before it recorded
 * the merge made; a merge such a run left in progress is aborted, and found as nothing. With
 * `keep`, at the start of a routed fix (ADR 0244), a conflict is left in progress for the brewer,
 * and a merge in progress is kept and found with the files still unmerged, never aborted; a HEAD
 * that moved past `start` otherwise, as a resumed worktree's may, is merged into again from HEAD.
 */
export const baseMergeTarget = (
  { base, push, worktree }: BaseMerge,
  { path, start }: { path: string; start: string },
  stepId: string,
  keep = false,
): EffectTarget => ({
  find: async (_key, signal) => {
    if (keep) {
      const pending = await worktree.pending(path, signal);
      if (pending !== undefined) {
        return { result: { base: pending.tip, kept: keptOf(pending.files) } satisfies MergeResult };
      }
    }
    const head = await worktree.head(path, signal);
    // A merge in progress has not moved HEAD.
    if (head === start) {
      if (!keep) await worktree.abort(path, signal);
      return undefined;
    }
    const [first, second, ...more] = await worktree.parents(path, head, signal);
    if (first !== start || second === undefined || more.length > 0) {
      if (keep) return undefined;
      throw new Error(
        `The worktree ${path} moved from ${start} to ${head}, which is no merge of it`,
      );
    }
    return { result: { base: second, merged: head } satisfies MergeResult };
  },
  apply: async (_key, signal): Promise<MergeResult> => {
    const tip = await push.baseTip(base, signal);
    // Every commit of the base is in the attempt's start, or in a resumed worktree's HEAD, already:
    // nothing to merge.
    const into = keep ? await worktree.head(path, signal) : start;
    if (await push.isAncestor(tip, into, signal)) return { base: tip };
    const message = `Merge ${base} before ${stepId}`;
    const merged = await worktree.merge(path, tip, message, signal, keep);
    switch (merged.kind) {
      case 'merged':
        return { base: tip, merged: merged.commit };
      case 'conflicts':
        return { base: tip, conflicts: merged.files.slice(0, MAX_CONFLICTS) };
      case 'kept':
        return { base: tip, kept: keptOf(merged.files) };
      default:
        return merged satisfies never;
    }
  },
});

/**
 * The route that makes attempt `ref` of `batch` merge the base at its start: a `pull_request`
 * route with a cause, a failing check on the pull request's merged tree (ADR 0226) or its conflict
 * with the base (ADR 0244), of it or of the attempt it retries or answers.
 */
export const mergeRouteOf = (
  batch: Batch,
  ref: AttemptRef,
): Extract<ScheduleRoute, { why: 'pull_request' }> | undefined => {
  const attempts = batch.steps.get(ref.stepId)?.attempts;
  let attempt = attempts?.get(ref.attempt);
  // A retry, or an answer that starts fresh, starts as the attempt before it did (ADR 0117,
  // ADR 0118).
  while (attempt?.retry === true || attempt?.answered === true) {
    attempt = attempts?.get(attempt.attempt - 1);
  }
  const route = attempt?.route;
  return route?.why === 'pull_request' && route.cause !== undefined ? route : undefined;
};

/** Whether attempt `ref` of `batch` merges the base at its start, keeping a conflict (ADR 0244). */
export const routedMerge = (batch: Batch, ref: AttemptRef): boolean =>
  mergeRouteOf(batch, ref) !== undefined;

/** What the ledger recorded of the merge at the start of attempt `ref`, when it is one it records. */
export const startMergeOf = (state: State, ref: AttemptRef): MergeResult | undefined => {
  const parsed = MergeResult.safeParse(state.effects.get(effectKey.encode(baseMergeKey(ref))));
  return parsed.success ? parsed.data : undefined;
};

/**
 * Why a `done` of an attempt whose start merge kept a conflict (`result`) fails (ADR 0244): the
 * merge is still in progress in the worktree at `path`, or its HEAD does not hold the tip, the
 * merge aborted; `undefined` once the brewer concluded it, or when the merge kept none.
 */
export const unconcludedMerge = async (
  { base, push, worktree }: BaseMerge,
  path: string,
  result: MergeResult | undefined,
  signal?: AbortSignal,
): Promise<string | undefined> => {
  if (result?.kept === undefined) return undefined;
  const merging = `the merge of ${base} at ${result.base}`;
  const pending = await worktree.pending(path, signal);
  if (pending !== undefined) {
    if (pending.files.length === 0)
      return `${merging} is resolved but not committed: git commit it`;
    // Named as the ledger names them: at most MAX_CONFLICTS, and how many more.
    const { files: named, more } = keptOf(pending.files);
    const files = `${named.map((file) => file.path).join(', ')}${more > 0 ? ` and ${more} more` : ''}`;
    return `${merging} is still in progress, with ${files} unmerged: resolve each file, git add it and git commit the merge`;
  }
  const head = await worktree.head(path, signal);
  if (await push.isAncestor(result.base, head, signal)) return undefined;
  return `${merging} is not in the worktree's HEAD: conclude it with git commit, never abort it`;
};

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
 * Whether a success in the worktree attempt `number` of `step` ran in concluded what it did there:
 * of that attempt, or of any that resumed its session in that worktree (ADR 0244, ADR 0117). A
 * worktree is named by the attempt that made it, which every resume of its session runs in.
 */
const concludedIn = (step: Step | undefined, number: number): boolean => {
  const recorded = step?.attempts.get(number);
  if (step === undefined || recorded === undefined) return false;
  const worktreeOf = (attempt: Attempt): number => ranIn(step, attempt)?.attempt ?? attempt.attempt;
  return [...step.attempts.values()].some(
    (attempt) =>
      attempt.phase === 'finished' &&
      attempt.outcome.kind === 'succeeded' &&
      worktreeOf(attempt) === worktreeOf(recorded),
  );
};

/**
 * The base the latest merge of `batchId` brought in, when one made a commit: where the batch's own
 * change starts once its task tree holds that merge, so a review of the change never reads what
 * the base added while the batch brewed (ADR 0164). `undefined` when nothing was merged.
 */
export const mergedBase = (state: State, batchId: string): string | undefined =>
  mergeResults(state, batchId)
    .filter(
      ({ stepId, attempt, merge }) =>
        merge.merged !== undefined ||
        // A kept merge counts once a success in its worktree concluded it (ADR 0244).
        (merge.kept !== undefined &&
          concludedIn(state.batches.get(batchId)?.steps.get(stepId), attempt)),
    )
    .at(-1)?.merge.base;

/**
 * The merges the ledger recorded before the attempts of `batchId`, in the order it recorded them,
 * each with its attempt; a result that is no merge is passed over.
 */
export const mergeResults = (
  state: State,
  batchId: string,
): { stepId: string; attempt: number; merge: MergeResult }[] => {
  const merges: { stepId: string; attempt: number; merge: MergeResult }[] = [];
  for (const [key, result] of state.effects) {
    const parts = EffectKeyParts.safeParse(JSON.parse(key));
    if (!parts.success || parts.data.length !== 4) continue;
    const [batch, stepId, attempt, effect] = parts.data;
    if (batch !== batchId || effect !== MERGE_BASE) continue;
    const merge = MergeResult.safeParse(result);
    if (merge.success) merges.push({ stepId, attempt, merge: merge.data });
  }
  return merges;
};
