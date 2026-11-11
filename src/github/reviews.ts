// The reviews of an open pull request on GitHub (ADR 0382): the reviews, page after page, and the
// comments of one review, through conditional reads (ADR 0052). Everything it reads is a person's
// words, untrusted, checked field by field, read for secrets and cut as a record keeps it.

import type { PullRequestReviewReader, ReadReview } from '../engine/pr-reviews.ts';
import { findSecrets } from '../formats/secrets.ts';
import {
  MAX_REVIEW_PATH_LENGTH,
  MAX_REVIEW_TEXT_LENGTH,
  MOST_REVIEW_COMMENTS,
  pullRequestOf,
  type ReviewComment,
} from '../schemas/events.ts';
import { GitHubReview, GitHubReviewComment } from '../schemas/github.ts';
import { CommitSha } from '../schemas/store.ts';
import { checked, repoPath } from './answers.ts';
import { type GitHubReads, pageSize } from './reads.ts';

// Every control character but the tab and the line feed: a person's text never moves a terminal.
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it removes.
const CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

/** The start of `text`, at most `most` characters, never half a character. */
const startOf = (text: string, most: number): string => {
  const cut = text.slice(0, most);
  // A high surrogate cut from its pair is left out.
  return /[\uD800-\uDBFF]$/.test(cut) && cut.length < text.length ? cut.slice(0, -1) : cut;
};

/**
 * `text` as a record keeps it: its line ends as line feeds, each line that looks like a secret left
 * out for a fixed line (ADR 0088), read before the cut so the cut never hides half of one, and the
 * start of what is left.
 */
const keptText = (text: string): string => {
  const lines = startOf(text, 2 * MAX_REVIEW_TEXT_LENGTH)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => {
      const [secret] = findSecrets(line, () => false);
      return secret === undefined
        ? line.replace(CONTROLS, '')
        : `[left out: a line that looks like a secret (${secret.kind})]`;
    });
  return startOf(lines.join('\n'), MAX_REVIEW_TEXT_LENGTH);
};

/**
 * A file path on one line: each line break a space and every other control character left out, so
 * a path a review comment names cannot write a line of the route input's own (ADR 0382).
 */
const onOneLine = (path: string): string =>
  path.replace(/\r\n|[\n\r\u2028\u2029]/g, ' ').replace(CONTROLS, '');

/** GitHub's reviews through the cached `reads`. */
export const githubReviewReader = (reads: GitHubReads): PullRequestReviewReader => ({
  reviews: async (url, signal) => {
    const { repo, number } = pullRequestOf(url);
    const what = `the reviews of ${repo}#${number}`;
    const items = await reads.pages(
      `/repos/${repoPath(repo)}/pulls/${number}/reviews?per_page=${pageSize}`,
      what,
      signal,
    );
    const reviews = items.map((item): ReadReview => {
      const { id, user, state, body, commit_id } = checked(GitHubReview, item, what);
      const commit = CommitSha.safeParse(commit_id);
      return {
        id,
        // A deleted account has no login: its review counts for no one.
        ...(user === null ? {} : { by: user.login }),
        state,
        ...(commit.success ? { commit: commit.data } : {}),
        body: keptText(body ?? ''),
      };
    });
    // Oldest first, whatever order the pages give: a person's latest review is the one that counts.
    return reviews.sort((a, b) => a.id - b.id);
  },
  comments: async (url, review, signal) => {
    const { repo, number } = pullRequestOf(url);
    const what = `the comments of review ${review} of ${repo}#${number}`;
    const items = await reads.pages(
      `/repos/${repoPath(repo)}/pulls/${number}/reviews/${review}/comments?per_page=${pageSize}`,
      what,
      signal,
    );
    const comments = items.map((item): ReviewComment => {
      const { path, line, body } = checked(GitHubReviewComment, item, what);
      const said = keptText(body);
      return {
        path: onOneLine(startOf(path, MAX_REVIEW_PATH_LENGTH)) || '(no path)',
        // None on an outdated comment, or one on the whole file.
        ...(typeof line === 'number' && line > 0 ? { line } : {}),
        body: said.trim() === '' ? '(no text)' : said,
      };
    });
    const more = comments.length - MOST_REVIEW_COMMENTS;
    return { comments: comments.slice(0, MOST_REVIEW_COMMENTS), ...(more > 0 ? { more } : {}) };
  },
});
