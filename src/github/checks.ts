// The checks GitHub runs on an open pull request's head (ADR 0213): its head from the pull request,
// then the check runs and the commit statuses on that commit, each list page after page through
// conditional reads (ADR 0052), and a failed Actions job's log, read once as text (ADR 0228).
// Everything it reads is untrusted input, checked field by field.

import { jobLogExcerpt } from '../checks/job-log.ts';
import type { PullRequestCheckReader, ReadCheck } from '../engine/pr-checks.ts';
import { findSecrets } from '../formats/secrets.ts';
import {
  CheckConclusion,
  HeadCheck,
  MAX_HEAD_CHECK_NAME_LENGTH,
  MAX_LOG_UNREAD_LENGTH,
  pullRequestOf,
} from '../schemas/events.ts';
import { GitHubCheckRun, GitHubCommitStatus, GitHubPullRequestHead } from '../schemas/github.ts';
import { CommitSha } from '../schemas/store.ts';
import { checked, refused, repoPath } from './answers.ts';
import { type GitHubClient, GitHubRateLimited, type GitHubTextAnswer } from './client.ts';
import { type GitHubReads, pageSize } from './reads.ts';

/** A check run's conclusion or a commit status's state as Foedrum names it; `unknown` otherwise. */
const conclusionOf = (text: string | null | undefined): CheckConclusion => {
  const parsed = CheckConclusion.safeParse(text);
  return parsed.success ? parsed.data : 'unknown';
};

/** The start of `text`, at most `most` characters, never half a character. */
const startOf = (text: string, most: number): string => {
  const cut = text.slice(0, most);
  // A high surrogate cut from its pair is left out.
  return /[\uD800-\uDBFF]$/.test(cut) && cut.length < text.length ? cut.slice(0, -1) : cut;
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
  job?: number,
): ReadCheck => {
  const cut = startOf(name, MAX_HEAD_CHECK_NAME_LENGTH);
  return {
    name: cut === '' ? kind : cut,
    kind,
    ...(conclusion === undefined ? {} : { conclusion }),
    ...(HeadCheck.shape.url.unwrap().safeParse(url).success ? { url: url as string } : {}),
    ...(job === undefined ? {} : { job }),
  };
};

/** The most of a job's log it reads, in bytes: a test suite's job prints about a megabyte. */
const MAX_LOG_BYTES = 32 * 1024 * 1024;

/** Why a job's log could not be read, from the error its read failed with: one line, never a secret. */
const failedBecause = (error: unknown): string => {
  const said = (error instanceof Error ? error.message : String(error)).split(/\r?\n/)[0]?.trim();
  if (said === undefined || said === '') return 'its read failed';
  if (findSecrets(said, () => false).length > 0) {
    return 'its read failed with an error that looks like a secret';
  }
  return startOf(said, MAX_LOG_UNREAD_LENGTH);
};

/** Why a job's log GitHub answered `status` to could not be read. */
const refusedBecause = (status: number): string => {
  switch (status) {
    case 404:
      return 'GitHub has no log of it (404)';
    case 410:
      return 'it has expired (410)';
    case 403:
      return "gh's login may not read it (403)";
    default:
      return `GitHub answered ${status}`;
  }
};

/** GitHub's checks through the cached `reads`, and a job's log through `client` (ADR 0228). */
export const githubCheckReader = (
  reads: GitHubReads,
  client: GitHubClient,
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
        // Only a check run of GitHub Actions is a job, whose id is its own.
        const job =
          run.app?.slug === 'github-actions' && Number.isSafeInteger(run.id) && (run.id ?? 0) > 0
            ? run.id
            : undefined;
        return readCheck(run.name, 'check_run', conclusion, run.html_url, job);
      }),
      ...statuses.map((item) => {
        const status = checked(GitHubCommitStatus, item, statusesOf);
        const conclusion = status.state === 'pending' ? undefined : conclusionOf(status.state);
        return readCheck(status.context, 'status', conclusion, status.target_url);
      }),
    ];
  },
  log: async (url, job, signal) => {
    const { repo } = pullRequestOf(url);
    let answer: GitHubTextAnswer;
    try {
      // Not through the cached reads: a log is read once, and would fill the cache (ADR 0068).
      answer = await client.text(
        `/repos/${repoPath(repo)}/actions/jobs/${job}/logs`,
        MAX_LOG_BYTES,
        signal,
      );
    } catch (error) {
      // GitHub's rate limit ends, so the pass reads the log again after it; a stopped read too.
      if (error instanceof GitHubRateLimited || signal?.aborted === true) throw error;
      return { unread: failedBecause(error) };
    }
    if (answer.status !== 200) return { unread: refusedBecause(answer.status) };
    // What gh printed of a log it refused for its escape sequences, or a log with nothing in it.
    if (answer.text.trim() === '') return { unread: 'it came back empty' };
    return { excerpt: jobLogExcerpt(answer.text) };
  },
});
