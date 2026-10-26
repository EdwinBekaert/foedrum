// The checks GitHub runs on an open pull request's head (ADR 0213): its head from the pull request,
// then the check runs and the commit statuses on that commit, each list page after page through
// conditional reads (ADR 0052). Everything it reads is untrusted input, checked field by field.

import type { PullRequestCheckReader } from '../engine/pr-checks.ts';
import type { GitHubReads } from './reads.ts';

export const githubCheckReader = (_reads: GitHubReads): PullRequestCheckReader => ({
  head: async () => {
    throw new Error('not implemented');
  },
  checks: async () => {
    throw new Error('not implemented');
  },
});
