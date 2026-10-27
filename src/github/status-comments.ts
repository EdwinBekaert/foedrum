// The status comments of a Brewery's issues on GitHub (ADR 0072): found, read, made and edited as
// the Brewery's own identity (`login`, its token's). Reads are conditional (ADR 0052); a comment
// counts only when `login` made it, since markers are predictable (ADR 0033).

import { claimRef, same } from '../engine/issue-claims.ts';
import type { MergeBriefHost } from '../engine/merge-brief-post.ts';
import type { StatusComments } from '../engine/status-comment.ts';
import { GitHubComment } from '../schemas/github.ts';
import { checked, refused, repoPath } from './answers.ts';
import type { GitHubClient } from './client.ts';
import { type GitHubReads, pageSize } from './reads.ts';

export interface GitHubStatusCommentsOptions {
  client: GitHubClient;
  reads: GitHubReads;
  /** The GitHub login of the Brewery's token. */
  login: string;
}

// The API path of a comment by its id, checked before it becomes part of a URL.
const commentPath = (repo: string, comment: number): string => {
  if (!Number.isSafeInteger(comment) || comment < 1) {
    throw new Error(`A comment id must be a positive integer, got ${comment}`);
  }
  return `/repos/${repoPath(repo)}/issues/comments/${comment}`;
};

const issuePath = (repo: string, issue: number): string => {
  claimRef(issue);
  return `/repos/${repoPath(repo)}/issues/${issue}`;
};

/** The Brewery's own comments that a merge brief hides as outdated (ADR 0229). */
export type HiddenComments = Pick<MergeBriefHost, 'hidden' | 'hide'>;

export const githubStatusComments = (
  options: GitHubStatusCommentsOptions,
): StatusComments & HiddenComments => {
  const { client, reads, login } = options;
  // Markers are predictable: a comment by anyone else never counts.
  const ours = (comment: { user?: { login: string } | null | undefined }): boolean =>
    comment.user != null && same(comment.user.login, login);
  return {
    find: async (repo, issue, marker, signal) => {
      const what = `the comments of ${repo}#${issue}`;
      const path = `${issuePath(repo, issue)}/comments?per_page=${pageSize}`;
      for (const item of await reads.pages(path, what, signal)) {
        const comment = checked(GitHubComment, item, what);
        const body = comment.body ?? '';
        if (ours(comment) && body.endsWith(marker)) return { id: comment.id, body };
      }
      return undefined;
    },
    read: async (repo, comment, signal) => {
      const what = `the comment ${comment} of ${repo}`;
      const answer = await reads.get(commentPath(repo, comment), signal);
      if (answer.status === 404) return undefined;
      if (answer.status !== 200) throw refused(answer.status, answer.body, what);
      const found = checked(GitHubComment, answer.body, what);
      return ours(found) ? (found.body ?? '') : undefined;
    },
    create: async (repo, issue, body, signal) => {
      const what = `commenting on ${repo}#${issue}`;
      const answer = await client.rest(
        'POST',
        `${issuePath(repo, issue)}/comments`,
        { body },
        signal,
      );
      if (answer.status !== 201) throw refused(answer.status, answer.body, what);
      return checked(GitHubComment, answer.body, what).id;
    },
    edit: async (repo, comment, body, signal) => {
      const what = `editing the comment ${comment} of ${repo}`;
      const answer = await client.rest('PATCH', commentPath(repo, comment), { body }, signal);
      if (answer.status === 404) return 'gone';
      if (answer.status !== 200) throw refused(answer.status, answer.body, what);
      return 'edited';
    },
    hidden: async () => {
      throw new Error('not implemented');
    },
    hide: async () => {
      throw new Error('not implemented');
    },
  };
};
