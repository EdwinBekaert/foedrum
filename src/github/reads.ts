// Conditional reads of GitHub (ADR 0008, ADR 0052): every GET carries the ETag of the answer it got
// before, and a 304 answers that same body again without counting against the rate limit. A list
// is read page by page along GitHub's `Link` header, each page conditional on its own.

import type { GitHubAnswer, GitHubClient } from './client.ts';

export interface GitHubReadsOptions {
  /** How many answers the cache keeps; the least recently used goes first. Default 256. */
  maxEntries?: number;
  /** How many pages one list may have; more fails the read. Default 50 (5,000 items). */
  maxPages?: number;
}

export interface GitHubReads {
  /** A GET of `path`, conditional on the answer before; a 304 answers that one as 200. */
  get(path: string, signal?: AbortSignal): Promise<GitHubAnswer>;
  /** Every item of the list at `path`, page after page; `what` names it in an error. */
  pages(path: string, what: string, signal?: AbortSignal): Promise<unknown[]>;
}

export const createGitHubReads = (
  _client: GitHubClient,
  _options: GitHubReadsOptions = {},
): GitHubReads => {
  throw new Error('not implemented');
};
