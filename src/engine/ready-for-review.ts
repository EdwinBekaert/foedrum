// A brewed pull request is a draft until its merge brief is posted, and ready for review exactly
// while that brief is current (ADR 0350): marked ready once the brief is current, and turned back
// to a draft once it is not (a new head outdated it, or a re-run of its head no longer passes),
// while the pull request is still the batch's (`openOf`). Each mark through the ledger, the `k`th
// of brief `n` as `[batch, "brief.<n>.ready.<k>"]` or `[batch, "brief.<n>.draft.<k>"]`, found on
// the code host before it is applied (ADR 0033).

import type { MergeBriefDraft, MergeBriefReady } from '../schemas/status-comment.ts';
import type { BatchEffectKey } from '../schemas/store.ts';
import type { DriverEffects } from './driver.ts';
import { effectKey } from './effect-key.ts';
import type { State } from './fold.ts';
import { briefNow, latestBrief } from './merge-brief.ts';
import { someoneElsePushed } from './pull-request.ts';

/** The draft state of a pull request on the code host, by its URL. */
export interface PullRequestDrafts {
  /** Whether the pull request is a draft. */
  isDraft(url: string, signal?: AbortSignal): Promise<boolean>;
  /** Marks it ready for review. */
  markReady(url: string, signal?: AbortSignal): Promise<void>;
  /** Turns it back into a draft; `draftless` when its repository cannot have drafts. */
  markDraft(url: string, signal?: AbortSignal): Promise<'draft' | 'draftless'>;
}

export interface ReadyForReviewEffectsOptions {
  host: PullRequestDrafts;
}

/** The `k`th mark of the pull request of the `n`th merge brief of `batchId`, ready or a draft. */
const markKey = (batchId: string, n: number, to: 'ready' | 'draft', k: number): BatchEffectKey => ({
  batchId,
  effect: `brief.${n}.${to}.${k}`,
});

/** How many marks of brief `n` of `batchId` to `to` the ledger recorded, numbered from 1. */
const marks = (state: State, batchId: string, n: number, to: 'ready' | 'draft'): number => {
  let k = 0;
  while (state.effects.has(effectKey.encode(markKey(batchId, n, to, k + 1)))) k++;
  return k;
};

/** What a due key does to which pull request. */
interface DueDraftState {
  pullRequest: string;
  to: 'ready' | 'draft';
}

/**
 * The draft state of each batch's pull request, for the driver: ready for review while its latest
 * merge brief is current, a draft again once it is not, after a mark that made it ready. Never once
 * someone else pushed to it, nor for a brief a later one replaced, whose pull request the later one
 * marks.
 */
export const readyForReviewEffects = (options: ReadyForReviewEffectsOptions): DriverEffects => {
  const { host } = options;
  // The pull request behind each key `due` gave; the driver asks `due` before it applies a key.
  const dues = new Map<string, DueDraftState>();
  const dueFor = (key: string): DueDraftState => {
    const due = dues.get(key);
    if (due === undefined) throw new Error(`No draft state ${key} is due`);
    return due;
  };
  const due = (key: BatchEffectKey, pullRequest: string, to: DueDraftState['to']) => {
    dues.set(effectKey.encode(key), { pullRequest, to });
    return [key];
  };
  return {
    due: (state, batchId) => {
      const batch = state.batches.get(batchId);
      if (batch === undefined) return [];
      const { next, latest } = latestBrief(state, batchId);
      const n = next - 1;
      if (latest === undefined) return [];
      // Ready on the code host while it has one more mark to ready than to a draft.
      const ready = marks(state, batchId, n, 'ready');
      const drafted = marks(state, batchId, n, 'draft');
      if (briefNow(state, batch) !== undefined) {
        return ready > drafted
          ? []
          : due(markKey(batchId, n, 'ready', ready + 1), latest.pullRequest, 'ready');
      }
      // Whatever the batch's lane: a batch sent back, Stuck or cancelled leaves a brief behind.
      const { pullRequest } = latest;
      if (
        ready > drafted &&
        batch.pullRequestEnds?.[pullRequest] === undefined &&
        !someoneElsePushed(state, batch, pullRequest)
      ) {
        return due(markKey(batchId, n, 'draft', drafted + 1), latest.pullRequest, 'draft');
      }
      return [];
    },
    target: {
      find: async (key, signal) => {
        const { pullRequest, to } = dueFor(key);
        const draft = await host.isDraft(pullRequest, signal);
        if (to === 'ready') return draft ? undefined : { result: { ready: true } };
        return draft ? { result: { draft: true } } : undefined;
      },
      apply: async (key, signal): Promise<MergeBriefReady | MergeBriefDraft> => {
        const { pullRequest, to } = dueFor(key);
        if (to === 'ready') {
          await host.markReady(pullRequest, signal);
          return { ready: true };
        }
        return (await host.markDraft(pullRequest, signal)) === 'draft'
          ? { draft: true }
          : { draftless: true };
      },
    },
  };
};
