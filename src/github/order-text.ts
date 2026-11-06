// The order's text (ADR 0063): the body of the batch's issue, untrusted, through the conditional
// GitHub reads (ADR 0052); its title, which the batch's pull request takes (ADR 0071); and its
// labels, which `foedrum brew` routes by (ADR 0123).

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

/** A comment of a maintainer of its repository on an order's issue (ADR 0333), untrusted. */
export interface OrderComment {
  repo: string;
  issue: number;
  id: number;
  /** Its author's login; absent for an account that was deleted since. */
  by?: string;
  /** How its author stands to `repo`, as GitHub says. */
  association: string;
  /** When it was made. */
  at: string;
  text: string;
}

/**
 * Reads the maintainers' comments on an order's issues, each in its repository, or in `brewery` for
 * a Brewery issue, oldest first across them; Foedrum's own, as `login`, stay out (ADR 0333).
 */
export const githubOrderComments =
  (_reads: GitHubReads, _brewery: string, _login: string) =>
  async (_issues: readonly OrderIssue[], _signal?: AbortSignal): Promise<OrderComment[]> => {
    throw new Error('not implemented');
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

/**
 * Reads the label names of an order's issue in its repository, or in `brewery` for a Brewery
 * issue: `foedrum brew` routes by them as the intake does (ADR 0123).
 */
export const githubOrderLabels =
  (reads: GitHubReads, brewery: string) =>
  async (order: OrderIssue, signal?: AbortSignal): Promise<string[]> =>
    (await readIssue(reads, brewery, order, signal)).labels.map((label) =>
      typeof label === 'string' ? label : label.name,
    );
