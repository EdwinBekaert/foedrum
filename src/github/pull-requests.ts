// The pull requests of the openPullRequest action on GitHub (ADR 0071): found by their head branch
// among the pull requests the Brewery's own login opened, and opened through the REST API; a later
// round reads and updates the body only (ADR 0227).

import { same } from '../engine/issue-claims.ts';
import type { PullRequestHost } from '../engine/pull-request-actions.ts';
import { pullRequestOf } from '../schemas/events.ts';
import {
  GitHubOpenedPullRequest,
  GitHubPullRequest,
  GitHubValidationErrors,
} from '../schemas/github.ts';
import { checked, refused, repoPath } from './answers.ts';
import type { GitHubClient } from './client.ts';
import { type GitHubReads, pageSize } from './reads.ts';

export interface GitHubPullRequestsOptions {
  client: GitHubClient;
  reads: GitHubReads;
  /** The login gh uses, read once when first needed (ADR 0073). */
  login: () => Promise<string>;
}

/** Whether GitHub's 422 says the repository does not support draft pull requests. */
const refusesDrafts = (body: unknown): boolean => {
  const read = GitHubValidationErrors.safeParse(body);
  return (
    read.success &&
    read.data.errors.some(({ message }) => /draft pull requests are not supported/i.test(message))
  );
};

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
    open: async (repo, { head, base, title, body, draft = false }, signal) => {
      const what = `opening a pull request from ${head} in ${repo}`;
      const ask = (asDraft: boolean) =>
        client.rest(
          'POST',
          `/repos/${repoPath(repo)}/pulls`,
          { title, head, base, body, maintainer_can_modify: false, draft: asDraft },
          signal,
        );
      let answer = await ask(draft);
      // A repository that cannot have drafts (a private one on GitHub Free) gets it ready: the
      // body already says a person reviews it first (ADR 0167).
      if (draft && answer.status === 422 && refusesDrafts(answer.body)) answer = await ask(false);
      if (answer.status !== 201) throw refused(answer.status, answer.body, what);
      return checked(GitHubOpenedPullRequest, answer.body, what).html_url;
    },
    body: async (url, signal) => {
      const { repo, number } = pullRequestOf(url);
      const what = `the pull request ${repo}#${number}`;
      const answer = await reads.get(`/repos/${repoPath(repo)}/pulls/${number}`, signal);
      if (answer.status !== 200) throw refused(answer.status, answer.body, what);
      // GitHub answers null for a pull request with no body.
      return checked(GitHubPullRequest, answer.body, what).body ?? '';
    },
    update: async (url, body, signal) => {
      const { repo, number } = pullRequestOf(url);
      const what = `updating the body of the pull request ${repo}#${number}`;
      const path = `/repos/${repoPath(repo)}/pulls/${number}`;
      const answer = await client.rest('PATCH', path, { body }, signal);
      if (answer.status !== 200) throw refused(answer.status, answer.body, what);
    },
  };
};
