// A brewed pull request is a draft until its merge brief is posted, and ready for review while
// that brief is current (ADR 0350): marked ready once the brief is posted, and turned back to a
// draft once a new head outdates it, while the pull request is still the batch's (`openOf`). Each
// through the ledger, `[batch, "brief.<n>.ready"]` and `[batch, "brief.<n>.draft"]`, found on the
// code host before it is applied (ADR 0033).

import type { MergeBriefDraft, MergeBriefReady } from '../schemas/status-comment.ts';
import type { BatchEffectKey } from '../schemas/store.ts';
import type { DriverEffects } from './driver.ts';
import { effectKey } from './effect-key.ts';
import type { State } from './fold.ts';
import { briefNow, isHidden, latestBrief, outdatedBriefs } from './merge-brief.ts';
import { openOf } from './pull-request.ts';

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

/** The effect that marks the pull request of the `n`th merge brief of `batchId` ready. */
const readyKey = (batchId: string, n: number): BatchEffectKey => ({
  batchId,
  effect: `brief.${n}.ready`,
});

/** The effect that turns the pull request of the `n`th merge brief of `batchId` back to a draft. */
const draftKey = (batchId: string, n: number): BatchEffectKey => ({
  batchId,
  effect: `brief.${n}.draft`,
});

const recorded = (state: State, key: BatchEffectKey): boolean =>
  state.effects.has(effectKey.encode(key));

/** What a due key does to which pull request. */
interface DueDraftState {
  pullRequest: string;
  to: 'ready' | 'draft';
}

/**
 * The draft state of each batch's pull request, for the driver: ready for review once its current
 * merge brief is posted, a draft again once a new head outdated the latest brief it was marked
 * ready for. Never once someone else pushed to it, nor for a brief a later one of the same head
 * replaced, whose pull request the later one keeps ready.
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
  // A key the ledger recorded is done: its pull request is left to whoever changes it since.
  const due = (state: State, key: BatchEffectKey, pullRequest: string, to: DueDraftState['to']) => {
    if (recorded(state, key)) return [];
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
      if (briefNow(state, batch) !== undefined) {
        return due(state, readyKey(batchId, n), latest.pullRequest, 'ready');
      }
      const outdated =
        isHidden(state, batchId, n) || outdatedBriefs(state, batch).some((brief) => brief.n === n);
      if (
        outdated &&
        recorded(state, readyKey(batchId, n)) &&
        openOf(state, batch)?.url === latest.pullRequest
      ) {
        return due(state, draftKey(batchId, n), latest.pullRequest, 'draft');
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
