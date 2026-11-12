// The Brewery's rack issues on GitHub (ADR 0387): those labelled recipe:rack, open or closed,
// through conditional reads (ADR 0052), and the opening of the next one with its label. Everything
// it reads is untrusted input, checked field by field.

import { RACK_LABEL, type RackIssues } from '../engine/rack-schedule.ts';
import { GitHubIssue, GitHubListedIssue } from '../schemas/github.ts';
import { checked, refused, repoPath } from './answers.ts';
import type { GitHubClient } from './client.ts';
import { type GitHubReads, pageSize } from './reads.ts';

export const githubRackIssues = (
  reads: GitHubReads,
  client: GitHubClient,
  brewery: string,
): RackIssues => {
  const root = `/repos/${repoPath(brewery)}/issues`;
  return {
    list: async (signal) => {
      const what = `the issues labelled ${RACK_LABEL} in ${brewery}`;
      const query = new URLSearchParams({
        labels: RACK_LABEL,
        state: 'all',
        per_page: String(pageSize),
      });
      const items = await reads.pages(`${root}?${query}`, what, signal);
      return items
        .map((item) => checked(GitHubListedIssue, item, what))
        .filter((issue) => issue.pull_request === undefined)
        .map((issue) => ({ state: issue.state, created: issue.created_at }));
    },
    open: async (title, body, signal) => {
      const what = `opening the rack issue in ${brewery}`;
      const answer = await client.rest('POST', root, { title, body, labels: [RACK_LABEL] }, signal);
      if (answer.status !== 201) throw refused(answer.status, answer.body, what);
      return checked(GitHubIssue, answer.body, what).number;
    },
  };
};
