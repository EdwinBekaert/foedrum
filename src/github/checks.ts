// The checks GitHub runs on an open pull request's head (ADR 0213): its head from the pull request,
// then the check runs and the commit statuses on that commit, each list page after page through
// conditional reads (ADR 0052). Everything it reads is untrusted input, checked field by field.

import type { PullRequestCheckReader, ReadCheck } from '../engine/pr-checks.ts';
import { CheckConclusion, HeadCheck, MAX_HEAD_CHECK_NAME_LENGTH } from '../schemas/events.ts';
import { GitHubCheckRun, GitHubCommitStatus, GitHubPullRequestHead } from '../schemas/github.ts';
import { CommitSha } from '../schemas/store.ts';
import { checked, refused, repoPath } from './answers.ts';
import type { GitHubClient } from './client.ts';
import { type GitHubReads, pageSize } from './reads.ts';
import { pullRequestOf } from './tracker.ts';

/** A check run's conclusion or a commit status's state as Foedrum names it; `unknown` otherwise. */
const conclusionOf = (text: string | null | undefined): CheckConclusion => {
  const parsed = CheckConclusion.safeParse(text);
  return parsed.success ? parsed.data : 'unknown';
};

/**
 * A check as the record keeps it: its name cut, empty named by its kind; a link only when it is
 * https and no longer than a record keeps.
 */
const readCheck = (
  name: string,
  kind: ReadCheck['kind'],
  conclusion: CheckConclusion | undefined,
  url: string | null | undefined,
): ReadCheck => {
  let cut = name.slice(0, MAX_HEAD_CHECK_NAME_LENGTH);
  // Never half a character: a high surrogate cut from its pair is left out.
  if (/[\uD800-\uDBFF]$/.test(cut) && cut.length < name.length) cut = cut.slice(0, -1);
  return {
    name: cut === '' ? kind : cut,
    kind,
    ...(conclusion === undefined ? {} : { conclusion }),
    ...(HeadCheck.shape.url.unwrap().safeParse(url).success ? { url: url as string } : {}),
  };
};

/** GitHub's checks through the cached `reads`, and a job's log through `client` (ADR 0228). */
export const githubCheckReader = (
  reads: GitHubReads,
  _client: GitHubClient,
): PullRequestCheckReader => ({
  head: async (url, signal) => {
    const { repo, number } = pullRequestOf(url);
    const what = `the pull request ${repo}#${number}`;
    const answer = await reads.get(`/repos/${repoPath(repo)}/pulls/${number}`, signal);
    if (answer.status !== 200) throw refused(answer.status, answer.body, what);
    return checked(GitHubPullRequestHead, answer.body, what).head.sha;
  },
  checks: async (url, head, signal) => {
    const { repo } = pullRequestOf(url);
    if (!CommitSha.safeParse(head).success) throw new Error(`${head} is no full commit sha`);
    const commit = `/repos/${repoPath(repo)}/commits/${head}`;
    const runsOf = `the check runs on ${head} in ${repo}`;
    const runs = await reads.pages(
      `${commit}/check-runs?per_page=${pageSize}`,
      runsOf,
      signal,
      'check_runs',
    );
    const statusesOf = `the commit statuses on ${head} in ${repo}`;
    const statuses = await reads.pages(
      `${commit}/status?per_page=${pageSize}`,
      statusesOf,
      signal,
      'statuses',
    );
    return [
      ...runs.map((item) => {
        const run = checked(GitHubCheckRun, item, runsOf);
        const conclusion = run.status === 'completed' ? conclusionOf(run.conclusion) : undefined;
        return readCheck(run.name, 'check_run', conclusion, run.html_url);
      }),
      ...statuses.map((item) => {
        const status = checked(GitHubCommitStatus, item, statusesOf);
        const conclusion = status.state === 'pending' ? undefined : conclusionOf(status.state);
        return readCheck(status.context, 'status', conclusion, status.target_url);
      }),
    ];
  },
  log: async () => {
    throw new Error('not implemented');
  },
});
