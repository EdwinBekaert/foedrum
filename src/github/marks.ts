// The marks of a claimed issue on GitHub (ADR 0043, ADR 0050): its assignee, its label and the
// Brewery's comments, as the Brewery's own identity (`login`, its token's) sees and makes them.
// Reads are conditional (ADR 0052); a comment counts only when `login` made it.

import type { IssueMarks } from '../engine/claim-effects.ts';
import { claimRef, same } from '../engine/issue-claims.ts';
import { GitHubComment, GitHubError, GitHubIssue } from '../schemas/github.ts';
import { assigneeLogins, checked, labelNames, refused, repoPath } from './answers.ts';
import type { GitHubAnswer, GitHubClient } from './client.ts';
import type { GitHubReads } from './reads.ts';

export interface GitHubIssueMarksOptions {
  client: GitHubClient;
  reads: GitHubReads;
  /** The GitHub login of the Brewery's token. */
  login: string;
}

// The API path of the issue, checked before it becomes part of a URL.
const issuePath = (repo: string, issue: number): string => {
  claimRef(issue);
  return `/repos/${repoPath(repo)}/issues/${issue}`;
};

// The answer when its status is `status`, else the refusal naming `what`.
const expect = (answer: GitHubAnswer, status: number, what: string): GitHubAnswer => {
  if (answer.status !== status) throw refused(answer.status, answer.body, what);
  return answer;
};

export const githubIssueMarks = (options: GitHubIssueMarksOptions): IssueMarks => {
  const { client, reads, login } = options;
  const read = async (repo: string, issue: number, signal?: AbortSignal) => {
    const what = `the issue ${repo}#${issue}`;
    const answer = expect(await reads.get(issuePath(repo, issue), signal), 200, what);
    return checked(GitHubIssue, answer.body, what);
  };
  return {
    assignees: async (repo, issue, signal) =>
      assigneeLogins((await read(repo, issue, signal)).assignees),
    assign: async (repo, issue, assignee, signal) => {
      const what = `assigning ${assignee} to ${repo}#${issue}`;
      const path = `${issuePath(repo, issue)}/assignees`;
      const answer = expect(
        await client.rest('POST', path, { assignees: [assignee] }, signal),
        201,
        what,
      );
      // GitHub drops an assignee without access to the repository, and answers 201 all the same.
      const { assignees } = checked(GitHubIssue, answer.body, what);
      if (!(assignees ?? []).some((account) => same(account.login, assignee))) {
        throw new Error(
          `GitHub did not assign ${assignee} to ${repo}#${issue}: the user may lack access to it`,
        );
      }
    },
    labels: async (repo, issue, signal) => labelNames((await read(repo, issue, signal)).labels),
    addLabel: async (repo, issue, label, signal) => {
      const path = `${issuePath(repo, issue)}/labels`;
      const answer = await client.rest('POST', path, { labels: [label] }, signal);
      expect(answer, 200, `labelling ${repo}#${issue} ${label}`);
    },
    removeLabel: async (repo, issue, label, signal) => {
      const path = `${issuePath(repo, issue)}/labels/${encodeURIComponent(label)}`;
      const answer = await client.rest('DELETE', path, undefined, signal);
      // Not on the issue: removed already.
      const error = GitHubError.safeParse(answer.body);
      if (answer.status === 404 && error.success && error.data.message === 'Label does not exist')
        return;
      expect(answer, 200, `removing the label ${label} from ${repo}#${issue}`);
    },
    findComment: async (repo, issue, marker, signal) => {
      const what = `the comments of ${repo}#${issue}`;
      const path = `${issuePath(repo, issue)}/comments?per_page=100`;
      for (const item of await reads.pages(path, what, signal)) {
        const comment = checked(GitHubComment, item, what);
        // Keys are predictable: a comment by anyone else never counts.
        const author = comment.user?.login;
        if (author !== undefined && same(author, login) && comment.body?.includes(marker) === true)
          return comment.id;
      }
      return undefined;
    },
    comment: async (repo, issue, body, signal) => {
      const what = `commenting on ${repo}#${issue}`;
      const path = `${issuePath(repo, issue)}/comments`;
      const answer = expect(await client.rest('POST', path, { body }, signal), 201, what);
      return checked(GitHubComment, answer.body, what).id;
    },
  };
};
