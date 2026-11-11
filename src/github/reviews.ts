// The reviews of an open pull request on GitHub (ADR 0382): the reviews, page after page, and the
// comments of one review, through conditional reads (ADR 0052). Everything it reads is a person's
// words, untrusted, checked field by field, read for secrets and cut as a record keeps it.

import type { PullRequestReviewReader } from '../engine/pr-reviews.ts';
import type { GitHubReads } from './reads.ts';

/** GitHub's reviews through the cached `reads`. */
export const githubReviewReader = (_reads: GitHubReads): PullRequestReviewReader => ({
  reviews: async () => {
    throw new Error('not implemented');
  },
  comments: async () => {
    throw new Error('not implemented');
  },
});
