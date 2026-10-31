// The Brewery's sub-issues and "blocked by" links on GitHub (#723), through the REST calls spike
// #18 recorded (docs/design/intake/trackers.md).

import type { SubIssues } from '../engine/sub-issues.ts';
import type { GitHubClient } from './client.ts';

export interface GitHubSubIssuesOptions {
  client: GitHubClient;
  /** The Brewery's repository, `owner/name`. */
  brewery: string;
  /** The GitHub login gh uses (ADR 0073): only the issues it opened are found. */
  login: string;
}

const notImplemented = (): never => {
  throw new Error('not implemented');
};

export const githubSubIssues = (_options: GitHubSubIssuesOptions): SubIssues => ({
  findIssue: async () => notImplemented(),
  openIssue: async () => notImplemented(),
  subIssues: async () => notImplemented(),
  addSubIssue: async () => notImplemented(),
  blockedBy: async () => notImplemented(),
  addBlockedBy: async () => notImplemented(),
});
