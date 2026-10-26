// The checks GitHub runs on an open pull request's head (ADR 0213): its head from the pull request,
// then the check runs and the commit statuses on that commit, each list page after page through
// conditional reads (ADR 0052). Everything it reads is untrusted input, checked field by field.

import type { PullRequestCheckReader, ReadCheck } from '../engine/pr-checks.ts';
import {
  type CheckConclusion,
  MAX_HEAD_CHECK_NAME_LENGTH,
  PullRequestUrl,
} from '../schemas/events.ts';
import { GitHubCheckRun, GitHubCommitStatus, GitHubPullRequestHead } from '../schemas/github.ts';
import { CommitSha } from '../schemas/store.ts';
import { checked, refused, repoPath } from './answers.ts';
import { type GitHubReads, pageSize } from './reads.ts';
import { pullRequestOf } from './tracker.ts';

/** The conclusions of a check run and the states of a commit status that Foedrum names. */
const known: ReadonlySet<string> = new Set<CheckConclusion>([
  'success',
  'neutral',
  'skipped',
  'failure',
  'cancelled',
  'timed_out',
  'action_required',
  'stale',
  'startup_failure',
  'error',
]);
const conclusionOf = (text: string | null | undefined): CheckConclusion =>
  text !== null && text !== undefined && known.has(text) ? (text as CheckConclusion) : 'unknown';

/** A check as the record keeps it: its name cut, empty named by its kind; a link only when https. */
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
    ...(PullRequestUrl.safeParse(url).success ? { url: url as string } : {}),
  };
};

export const githubCheckReader = (reads: GitHubReads): PullRequestCheckReader => ({
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
});
