// The marks of a claimed issue on GitHub (ADR 0043, ADR 0050): its assignee, its label and the
// Brewery's comments, as the Brewery's own identity (`login`, its token's) sees and makes them.
// Reads are conditional (ADR 0052); a comment counts only when `login` made it.

import type { IssueMarks } from '../engine/claim-effects.ts';
import type { GitHubClient } from './client.ts';
import type { GitHubReads } from './reads.ts';

export interface GitHubIssueMarksOptions {
  client: GitHubClient;
  reads: GitHubReads;
  /** The GitHub login of the Brewery's token. */
  login: string;
}

export const githubIssueMarks = (_options: GitHubIssueMarksOptions): IssueMarks => {
  throw new Error('not implemented');
};
