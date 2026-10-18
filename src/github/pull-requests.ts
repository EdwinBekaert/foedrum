// The pull requests of the openPullRequest action on GitHub (ADR 0071): found by their head branch
// among the pull requests the Brewery's own login opened, and opened through the REST API.

import type { PullRequestHost } from '../engine/pull-request-actions.ts';
import type { GitHubClient } from './client.ts';
import type { GitHubReads } from './reads.ts';

export interface GitHubPullRequestsOptions {
  client: GitHubClient;
  reads: GitHubReads;
  /** The login of the Brewery's token, read once when first needed. */
  login: () => Promise<string>;
}

export const githubPullRequests = (_options: GitHubPullRequestsOptions): PullRequestHost => {
  throw new Error('not implemented');
};
