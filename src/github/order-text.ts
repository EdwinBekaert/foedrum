// The order's text (ADR 0063): the body of the batch's issue, untrusted, through the conditional
// GitHub reads (ADR 0052).

import type { GitHubReads } from './reads.ts';

/** An order's issue: a Brewery issue, or a claimed issue of the target repository `repo`. */
export interface OrderIssue {
  issue: number;
  repo?: string;
}

/** Reads the body of an order's issue in its repository, or in `brewery` for a Brewery issue. */
export const githubOrderText =
  (_reads: GitHubReads, _brewery: string) =>
  (_order: OrderIssue, _signal?: AbortSignal): Promise<string> => {
    throw new Error('not implemented');
  };
