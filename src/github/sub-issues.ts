// The Brewery's sub-issues and "blocked by" links on GitHub (#723), through the REST calls spike
// #18 recorded (docs/design/intake/trackers.md): every call under the API version it tried them
// with, and the other issue named by its REST id, never its number. An add is not idempotent: a
// repeat answers 422, which is a refusal here like any other; the caller reads the list.

import { same } from '../engine/issue-claims.ts';
import type { BreweryIssue, SubIssues } from '../engine/sub-issues.ts';
import { GitHubIssueWithId } from '../schemas/github.ts';
import { checked, refused, repoPath } from './answers.ts';
import type { GitHubAnswer, GitHubClient } from './client.ts';
import { createGitHubReads, pageSize } from './reads.ts';

/** The API version spike #18 tried these calls under (trackers.md). */
export const SUB_ISSUES_API_VERSION = '2026-03-10';

export interface GitHubSubIssuesOptions {
  client: GitHubClient;
  /** The Brewery's repository, `owner/name`. */
  brewery: string;
  /** The GitHub login gh uses (ADR 0073): only the issues it opened are found. */
  login: string;
}

// The answer when its status is `status`, else the refusal naming `what`.
const expect = (answer: GitHubAnswer, status: number, what: string): GitHubAnswer => {
  if (answer.status !== status) throw refused(answer.status, answer.body, what);
  return answer;
};

const breweryIssue = (body: unknown, what: string): BreweryIssue => {
  const { number, id } = checked(GitHubIssueWithId, body, what);
  return { number, id };
};

export const githubSubIssues = (options: GitHubSubIssuesOptions): SubIssues => {
  const { brewery, login } = options;
  // Every request under the version, reads too, with a conditional cache of their own (ADR 0052).
  const client: GitHubClient = {
    ...options.client,
    rest: (method, path, body, signal, headers) =>
      options.client.rest(method, path, body, signal, {
        ...headers,
        'x-github-api-version': SUB_ISSUES_API_VERSION,
      }),
  };
  const reads = createGitHubReads(client);
  const root = `/repos/${repoPath(brewery)}/issues`;
  const issuePath = (issue: number): string => {
    if (!Number.isSafeInteger(issue) || issue < 1) {
      throw new Error(`An issue number is a positive integer, got ${issue}`);
    }
    return `${root}/${issue}`;
  };
  const list = async (path: string, what: string, signal?: AbortSignal) =>
    (await reads.pages(`${path}?per_page=${pageSize}`, what, signal)).map((item) =>
      breweryIssue(item, what),
    );
  const add = async (path: string, body: unknown, what: string, signal?: AbortSignal) => {
    expect(await client.rest('POST', path, body, signal), 201, what);
  };
  return {
    // The issues its own login opened, closed ones too: a sub-issue is found once a merge closed it.
    findIssue: async (marker, signal) => {
      const what = `the issues ${login} opened in ${brewery}`;
      const query = `state=all&creator=${encodeURIComponent(login)}&per_page=${pageSize}`;
      for (const item of await reads.pages(`${root}?${query}`, what, signal)) {
        const issue = checked(GitHubIssueWithId, item, what);
        const author = issue.user?.login;
        if (issue.pull_request !== undefined || author === undefined || !same(author, login))
          continue;
        if (issue.body?.includes(marker) === true) return { number: issue.number, id: issue.id };
      }
      return undefined;
    },
    openIssue: async (title, body, labels, signal) => {
      const what = `opening an issue in ${brewery}`;
      const answer = await client.rest('POST', root, { title, body, labels: [...labels] }, signal);
      return breweryIssue(expect(answer, 201, what).body, what);
    },
    subIssues: async (parent, signal) =>
      list(`${issuePath(parent)}/sub_issues`, `the sub-issues of ${brewery}#${parent}`, signal),
    addSubIssue: async (parent, childId, signal) =>
      add(
        `${issuePath(parent)}/sub_issues`,
        { sub_issue_id: childId },
        `adding the issue with id ${childId} as a sub-issue of ${brewery}#${parent}`,
        signal,
      ),
    blockedBy: async (issue, signal) =>
      list(
        `${issuePath(issue)}/dependencies/blocked_by`,
        `the issues ${brewery}#${issue} is blocked by`,
        signal,
      ),
    addBlockedBy: async (issue, blockerId, signal) =>
      add(
        `${issuePath(issue)}/dependencies/blocked_by`,
        { issue_id: blockerId },
        `marking ${brewery}#${issue} blocked by the issue with id ${blockerId}`,
        signal,
      ),
  };
};
