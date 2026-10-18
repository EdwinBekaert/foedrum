// The status comments of a Brewery's issues on GitHub (ADR 0072): found, read, made and edited as
// the Brewery's own identity (`login`, its token's). Reads are conditional (ADR 0052); a comment
// counts only when `login` made it, since markers are predictable (ADR 0033).

import type { StatusComments } from '../engine/status-comment.ts';
import type { GitHubClient } from './client.ts';
import type { GitHubReads } from './reads.ts';

export interface GitHubStatusCommentsOptions {
  client: GitHubClient;
  reads: GitHubReads;
  /** The GitHub login of the Brewery's token. */
  login: string;
}

export const githubStatusComments = (_options: GitHubStatusCommentsOptions): StatusComments => {
  throw new Error('not implemented');
};
