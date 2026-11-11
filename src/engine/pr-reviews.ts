// The reviews of an open pull request that ask for changes (ADR 0382): each intake pass reads the
// reviews of the pull request a batch on tap follows, keeps each latest review of someone in the
// Brewery's `users` that approves, asks for changes or was dismissed, and records those that ask
// for changes and have not sent the batch back yet, with their comments. A review by anyone else,
// or by the Brewery's own login, is never recorded.

import { type AskedReview, MOST_REVIEWS, type ReviewComment } from '../schemas/events.ts';
import type { CommandLog } from './command-log.ts';
import type { Batch } from './fold.ts';
import { same } from './issue-claims.ts';
import { openOf } from './pull-request.ts';

/**
 * A review of a pull request as the code host has it now: its id, its author's login (none for a
 * deleted account), its state as GitHub names it, the commit it reviewed and its body, read for
 * secrets and cut as a record keeps it.
 */
export interface ReadReview {
  id: number;
  by?: string;
  state: string;
  commit?: string;
  body: string;
}

/** What the pass reads of an open pull request's reviews; GitHub's is `githubReviewReader`. */
export interface PullRequestReviewReader {
  /** Every review of the pull request at `url`, oldest first, page after page. */
  reviews(url: string, signal?: AbortSignal): Promise<readonly ReadReview[]>;
  /** The comments of review `review`, as many as a record keeps, and how many more. */
  comments(
    url: string,
    review: number,
    signal?: AbortSignal,
  ): Promise<{ comments: readonly ReviewComment[]; more?: number }>;
}

export interface ReviewReadOptions {
  log: CommandLog;
  reader: PullRequestReviewReader;
  clock: () => Date;
  /** The Brewery's `users`: only their reviews count (ADR 0359, ADR 0382). */
  users: readonly string[];
  /** The Brewery's own login, whose review never counts. */
  self: string;
  /** What it could not do: reviews it could not read, a refused record. */
  failed: (what: string, error: unknown) => void;
}

// The states that change where a person stands on GitHub; a comment or a pending review does not.
const STANDING = new Set(['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED']);

/**
 * The reviews of `reviews` that ask for changes, oldest first: of each person in `users` but
 * `self`, compared ignoring case, their latest review that approves, asks for changes or was
 * dismissed, when it asks for changes, as GitHub tells where a reviewer stands.
 */
export const askingReviews = (
  reviews: readonly ReadReview[],
  users: readonly string[],
  self: string,
): ReadReview[] => {
  const latest = new Map<string, ReadReview>();
  for (const review of [...reviews].sort((a, b) => a.id - b.id)) {
    const { by } = review;
    if (by === undefined || same(by, self) || !users.some((user) => same(user, by))) continue;
    if (STANDING.has(review.state)) latest.set(by.toLowerCase(), review);
  }
  return [...latest.values()]
    .filter(({ state }) => state === 'CHANGES_REQUESTED')
    .sort((a, b) => a.id - b.id);
};

/** The ids of the reviews that have sent `batch` back from its pull request `url` (ADR 0382). */
export const actedOn = (batch: Batch, url: string): ReadonlySet<number> => {
  const ids = new Set<number>();
  for (const step of batch.steps.values()) {
    for (const { route } of step.attempts.values()) {
      if (route?.why !== 'pull_request' || route.pullRequest !== url) continue;
      for (const id of route.reviews ?? []) ids.add(id);
    }
  }
  return ids;
};

/**
 * The recorded reviews of the open pull request `url` of `batch` that ask for changes and have
 * not sent it back, and how many more the record left out.
 */
export const askedOf = (
  batch: Batch,
  url: string,
): { reviews: readonly AskedReview[]; more: number } => {
  const record = batch.pullRequestReviews?.[url];
  const acted = actedOn(batch, url);
  return {
    reviews: (record?.reviews ?? []).filter(({ id }) => !acted.has(id)),
    more: record?.more ?? 0,
  };
};

const idsOf = (reviews: readonly { id: number }[]): string => reviews.map(({ id }) => id).join(',');

/**
 * One pass: reads the reviews of the open pull request of every batch on tap that follows one,
 * and records those that ask for changes when they changed, with the comments of each review it
 * did not record before.
 */
export const recordReviews = async (
  options: ReviewReadOptions,
  signal: AbortSignal,
): Promise<void> => {
  const { log, reader, clock, users, self, failed } = options;
  for (const batchId of [...log.state().batches.keys()]) {
    if (signal.aborted) return;
    // Each batch as the log has it now: other writers append beside the pass (ADR 0044).
    const state = log.state();
    const batch = state.batches.get(batchId);
    const open = batch === undefined ? undefined : openOf(state, batch);
    if (batch === undefined || open === undefined) continue;
    let read: readonly ReadReview[];
    try {
      read = await reader.reviews(open.url, signal);
    } catch (error) {
      failed(`reading the reviews of ${open.url}`, error);
      continue;
    }
    if (signal.aborted) return;
    const acted = actedOn(batch, open.url);
    const asking = askingReviews(read, users, self).filter(({ id }) => !acted.has(id));
    const shown = asking.slice(0, MOST_REVIEWS);
    const more = asking.length - shown.length;
    const latest = batch.pullRequestReviews?.[open.url];
    const unchanged =
      latest === undefined
        ? shown.length === 0
        : idsOf(latest.reviews) === idsOf(shown) && (latest.more ?? 0) === more;
    if (unchanged) continue;
    // A review keeps the text it was recorded with: its comments are read once.
    const known = new Map((latest?.reviews ?? []).map((review) => [review.id, review]));
    const reviews: AskedReview[] = [];
    try {
      for (const { id, by = '', commit, body } of shown) {
        const kept = known.get(id);
        if (kept !== undefined) {
          reviews.push(kept);
          continue;
        }
        const { comments, more: left } = await reader.comments(open.url, id, signal);
        reviews.push({
          id,
          by,
          ...(commit === undefined ? {} : { commit }),
          body,
          comments: [...comments],
          ...(left === undefined || left === 0 ? {} : { more: left }),
        });
      }
    } catch (error) {
      failed(`reading the review comments of ${open.url}`, error);
      continue;
    }
    if (signal.aborted) return;
    const event = {
      type: 'pull_request.reviews_read',
      batchId,
      pullRequest: open.url,
      reviews,
      ...(more > 0 ? { more } : {}),
    } as const;
    const decision = log.issue({ kind: 'record', event }, clock());
    if (decision.kind === 'refused') {
      failed(`recording the reviews of ${open.url}`, new Error(decision.reason));
    }
  }
};
