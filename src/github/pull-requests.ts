// The pull requests of the openPullRequest action on GitHub (ADR 0071): found by their head branch
// among the pull requests the Brewery's own login opened, and opened through the REST API.

import { same } from '../engine/issue-claims.ts';
import type { PullRequestHost } from '../engine/pull-request-actions.ts';
import { GitHubOpenedPullRequest } from '../schemas/github.ts';
import { checked, refused, repoPath } from './answers.ts';
import type { GitHubClient } from './client.ts';
import { type GitHubReads, pageSize } from './reads.ts';

export interface GitHubPullRequestsOptions {
  client: GitHubClient;
  reads: GitHubReads;
  /** The login of the Brewery's token, read once when first needed. */
  login: () => Promise<string>;
}

export const githubPullRequests = (options: GitHubPullRequestsOptions): PullRequestHost => {
  const { client, reads } = options;
  let login: Promise<string> | undefined;
  const ours = (): Promise<string> => {
    // A login that could not be read is asked again next time.
    login ??= options.login().catch((error: unknown) => {
      login = undefined;
      throw error;
    });
    return login;
  };
  return {
    find: async (repo, head, signal) => {
      const [owner] = repo.split('/');
      const query = new URLSearchParams({
        state: 'all',
        head: `${owner}:${head}`,
        per_page: String(pageSize),
      });
      const what = `the pull requests from ${head} in ${repo}`;
      const items = await reads.pages(`/repos/${repoPath(repo)}/pulls?${query}`, what, signal);
      const me = await ours();
      for (const item of items) {
        const found = checked(GitHubOpenedPullRequest, item, what);
        // Only the Brewery's own, from the repository itself: a fork's branch can have any name.
        if (
          found.user !== null &&
          same(found.user.login, me) &&
          found.head.ref === head &&
          found.head.repo !== null &&
          same(found.head.repo.full_name, repo)
        ) {
          return found.html_url;
        }
      }
      return undefined;
    },
    open: async (repo, { head, base, title, body }, signal) => {
      const what = `opening a pull request from ${head} in ${repo}`;
      const answer = await client.rest(
        'POST',
        `/repos/${repoPath(repo)}/pulls`,
        { title, head, base, body, maintainer_can_modify: false },
        signal,
      );
      if (answer.status !== 201) throw refused(answer.status, answer.body, what);
      return checked(GitHubOpenedPullRequest, answer.body, what).html_url;
    },
  };
};
