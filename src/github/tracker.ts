// The intake's reads of GitHub (ADR 0050, ADR 0052): the open issues of a target repository and how
// a pull request of a batch stands, both through conditional reads, so a poll that finds nothing
// new costs no rate limit. Everything it reads is untrusted input, checked field by field.

import type { TargetTracker } from '../engine/intake.ts';
import type { PullRequestState, TargetIssue } from '../engine/issue-claims.ts';
import { Repo } from '../schemas/events.ts';
import { GitHubIssue, GitHubPullRequest } from '../schemas/github.ts';
import { assigneeLogins, checked, labelNames, refused, repoPath } from './answers.ts';
import { type GitHubReads, pageSize } from './reads.ts';

/** What the intake reads of an issue GitHub listed. */
const targetIssue = (body: unknown, what: string): TargetIssue => {
  const issue = checked(GitHubIssue, body, what);
  return {
    number: issue.number,
    state: issue.state,
    pullRequest: issue.pull_request !== undefined,
    labels: labelNames(issue.labels),
    milestone: issue.milestone?.title,
    assignees: assigneeLogins(issue.assignees),
    // A deleted account is nobody, so never an allow-listed author.
    author: issue.user?.login ?? '',
    created: '',
  };
};

// `owner/name` and the number of the pull request at `url`, a web URL such as a batch records.
const pullRequestOf = (url: string): { repo: string; number: number } => {
  const match = /^\/([^/]+\/[^/]+)\/pull\/([1-9]\d*)$/.exec(URL.parse(url)?.pathname ?? '');
  const [, repo = '', number] = match ?? [];
  if (!Repo.safeParse(repo).success) throw new Error(`${url} is not a pull request`);
  return { repo, number: Number(number) };
};

export const githubTargetTracker = (reads: GitHubReads): TargetTracker => ({
  issues: async (repo, filter, signal) => {
    const what = `the open issues of ${repo}`;
    const query = new URLSearchParams({
      state: 'open',
      sort: 'created',
      direction: 'asc',
      per_page: String(pageSize),
    });
    // GitHub's `labels` is a list split at commas, so a label with one cannot be named. The
    // milestone stays local: GitHub takes its number, not the title the filter names (ADR 0068).
    const labels = filter?.labels ?? [];
    if (labels.length > 0 && labels.every((label) => !label.includes(','))) {
      query.set('labels', labels.join(','));
    }
    const path = `/repos/${repoPath(repo)}/issues?${query}`;
    const items = await reads.pages(path, what, signal);
    return items.map((item) => targetIssue(item, what));
  },
  pullRequest: async (url, signal): Promise<PullRequestState> => {
    const { repo, number } = pullRequestOf(url);
    const what = `the pull request ${repo}#${number}`;
    const answer = await reads.get(`/repos/${repoPath(repo)}/pulls/${number}`, signal);
    if (answer.status !== 200) throw refused(answer.status, answer.body, what);
    const pull = checked(GitHubPullRequest, answer.body, what);
    if (pull.merged === true || (pull.merged_at ?? null) !== null) return 'merged';
    return pull.state;
  },
});
