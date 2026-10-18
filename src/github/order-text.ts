// The order's text (ADR 0063): the body of the batch's issue, untrusted, through the conditional
// GitHub reads (ADR 0052); and its title, which the batch's pull request takes (ADR 0071).

import { GitHubIssue } from '../schemas/github.ts';
import type { z } from '../schemas/zod.ts';
import { checked, refused, repoPath } from './answers.ts';
import type { GitHubReads } from './reads.ts';

/** An order's issue: a Brewery issue, or a claimed issue of the target repository `repo`. */
export interface OrderIssue {
  issue: number;
  repo?: string;
}

/** Reads an order's issue in its repository, or in `brewery` for a Brewery issue. */
const readIssue = async (
  reads: GitHubReads,
  brewery: string,
  { issue, repo = brewery }: OrderIssue,
  signal?: AbortSignal,
): Promise<z.infer<typeof GitHubIssue>> => {
  const what = `the issue ${repo}#${issue}`;
  const answer = await reads.get(`/repos/${repoPath(repo)}/issues/${issue}`, signal);
  if (answer.status !== 200) throw refused(answer.status, answer.body, what);
  const found = checked(GitHubIssue, answer.body, what);
  if (found.number !== issue) throw new Error(`GitHub answered issue #${found.number} to ${what}`);
  return found;
};

/** Reads the title of an order's issue in its repository, or in `brewery` for a Brewery issue. */
export const githubOrderTitle =
  (reads: GitHubReads, brewery: string) =>
  async (order: OrderIssue, signal?: AbortSignal): Promise<string> =>
    (await readIssue(reads, brewery, order, signal)).title ?? '';

/** Reads the body of an order's issue in its repository, or in `brewery` for a Brewery issue. */
export const githubOrderText =
  (reads: GitHubReads, brewery: string) =>
  async (order: OrderIssue, signal?: AbortSignal): Promise<string> =>
    (await readIssue(reads, brewery, order, signal)).body ?? '';
