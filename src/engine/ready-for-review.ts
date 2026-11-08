// A brewed pull request is a draft until its merge brief is posted, and ready for review while
// that brief is current (ADR 0350): marked ready once the brief is posted, and turned back to a
// draft once a new head outdates it, while the pull request is still the batch's (`openOf`).

import type { DriverEffects } from './driver.ts';

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

export const readyForReviewEffects = (_options: ReadyForReviewEffectsOptions): DriverEffects => {
  throw new Error('not implemented');
};
