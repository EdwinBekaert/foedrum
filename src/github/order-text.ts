// The order's text (ADR 0063): the body of the batch's issue and its comments, a maintainer's by
// association (ADR 0333) or, on a claimed issue, every one its approval approved (ADR 0373),
// untrusted, through the conditional GitHub reads (ADR 0052); its title, which the batch's pull
// request takes (ADR 0071); and its labels, which `foedrum brew` routes by (ADR 0123).

import { isMarkedComment } from '../engine/claim-effects.ts';
import { same } from '../engine/issue-claims.ts';
import { type Approval, approves } from '../engine/order-changes.ts';
import { GitHubActivityComment, GitHubIssue, GitHubOrderComment } from '../schemas/github.ts';
import type { z } from '../schemas/zod.ts';
import { checked, GitHubRefusal, refused, repoPath } from './answers.ts';
import { type GitHubReads, pageSize } from './reads.ts';

/** An order's issue: a Brewery issue, or a claimed issue of the target repository `repo`. */
export interface OrderIssue {
  issue: number;
  repo?: string;
  /**
   * For a claimed issue, its approval (ADR 0373), null when it has none: its comments are those it
   * approved, whoever wrote them. Without it, a maintainer's by association (ADR 0333).
   */
  approved?: Approval | null;
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

/** Who decides an order's scope in its repository (ADR 0276); the text stays untrusted. */
const MAINTAINERS: ReadonlySet<string> = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

/** A comment on an order's issue that reaches its brewers (ADR 0333, ADR 0373), untrusted. */
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
 * Reads the comments on an order's issues that reach its brewers, each in its repository, or in
 * `brewery` for a Brewery issue, oldest first across them: on an issue with `approved`, every one
 * last changed when its approval approved it, whoever wrote it (ADR 0373); on any other, its
 * maintainers' (ADR 0333). Foedrum's own, as `login`, stay out.
 */
export const githubOrderComments =
  (reads: GitHubReads, brewery: string, login: string) =>
  async (issues: readonly OrderIssue[], signal?: AbortSignal): Promise<OrderComment[]> => {
    const found: OrderComment[] = [];
    for (const { issue, repo = brewery, approved } of issues) {
      const what = `the comments of ${repo}#${issue}`;
      const path = `/repos/${repoPath(repo)}/issues/${issue}/comments?per_page=${pageSize}`;
      let items: unknown[];
      try {
        items = await reads.pages(path, what, signal);
      } catch (error) {
        // A person deleted the issue, with its comments: a batch brews on (ADR 0144).
        if (error instanceof GitHubRefusal && error.deleted) continue;
        throw error;
      }
      for (const item of items) {
        const comment = checked(GitHubOrderComment, item, what);
        if (approved === undefined) {
          if (!MAINTAINERS.has(comment.author_association)) continue;
        } else {
          // Approved as it last changed: an edit since asks the engineer first (ADR 0368).
          const { updated_at } = checked(GitHubActivityComment, item, what);
          if (!approves(approved ?? undefined, updated_at)) continue;
        }
        // Foedrum posts as gh's login, which reads as a maintainer; a marker alone proves nothing,
        // since anyone can write one (ADR 0033).
        const by = comment.user?.login;
        if (by !== undefined && same(by, login) && isMarkedComment(comment.body)) continue;
        found.push({
          repo,
          issue,
          id: comment.id,
          ...(by === undefined ? {} : { by }),
          association: comment.author_association,
          at: comment.created_at,
          text: comment.body,
        });
      }
    }
    return found.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id - b.id);
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
