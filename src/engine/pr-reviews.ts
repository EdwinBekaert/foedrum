// The reviews of an open pull request that ask for changes (ADR 0382): each intake pass reads the
// reviews of the pull request a batch on tap follows, keeps each latest review of someone in the
// Brewery's `users` that approves, asks for changes or was dismissed, and records those that ask
// for changes and have not sent the batch back yet, with their comments. A review by anyone else,
// or by the Brewery's own login, is never recorded.

import type { ReviewComment } from '../schemas/events.ts';
import type { CommandLog } from './command-log.ts';

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

/** One pass: reads the reviews of every open pull request, and records what changed. */
export const recordReviews = async (
  _options: ReviewReadOptions,
  _signal: AbortSignal,
): Promise<void> => {
  throw new Error('not implemented');
};
