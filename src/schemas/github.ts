// What Foedrum reads of GitHub's answers: only the fields it uses, checked, since they come from
// outside the process (ADR 0033). Unknown fields are ignored; GitHub adds them freely.

import { CommitSha } from './store.ts';
import { z } from './zod.ts';

/** `POST /repos/{owner}/{repo}/git/commits` and `GET .../git/commits/{sha}`. */
export const GitCommit = z.object({ sha: CommitSha, message: z.string().optional() });

/** `GET /repos/{owner}/{repo}/git/ref/{ref}`: one ref, never the list a partial name gives. */
export const GitRef = z.object({
  ref: z.string(),
  object: z.object({ type: z.string(), sha: CommitSha }),
});

/** A REST error's body. */
export const GitHubError = z.object({ message: z.string() });

/** The GraphQL answer to `repository(owner, name) { id }`. */
export const RepositoryId = z.object({ repository: z.object({ id: z.string().min(1) }) });

const Account = z.object({ login: z.string() });

/** One item of `GET /repos/{owner}/{repo}/issues`, or `GET .../issues/{n}`. */
export const GitHubIssue = z.object({
  number: z.number().int().positive(),
  state: z.enum(['open', 'closed']),
  /** null for an account that was deleted since. */
  user: Account.nullable(),
  labels: z.array(z.union([z.string(), z.object({ name: z.string() })])),
  milestone: z.object({ title: z.string() }).nullable().optional(),
  assignees: z.array(Account).nullable().optional(),
  /** Present when the item is a pull request: GitHub lists them among the issues. */
  pull_request: z.unknown().optional(),
});

/** `GET /repos/{owner}/{repo}/pulls/{n}`. */
export const GitHubPullRequest = z.object({
  state: z.enum(['open', 'closed']),
  merged: z.boolean().optional(),
  merged_at: z.string().nullable().optional(),
});

/** One item of `GET .../issues/{n}/comments`, or the answer to `POST` there. */
export const GitHubComment = z.object({
  id: z.number().int().positive(),
  /** null for an account that was deleted since. */
  user: Account.nullable().optional(),
  body: z.string().optional(),
});
