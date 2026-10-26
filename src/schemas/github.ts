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

/** One page of a REST list: its items are checked by whoever reads them. */
export const GitHubPage = z.array(z.unknown());

/** One page of a REST list GitHub wraps in an object, such as `{ check_runs: [...] }`. */
export const GitHubWrappedPage = z.record(z.string(), z.unknown());

/** A REST error's body. */
export const GitHubError = z.object({ message: z.string() });

/** GitHub's 422 answer, with a code for each thing it refused (`already_exists`, `invalid`). */
export const GitHubValidationError = z.object({
  errors: z.array(z.object({ code: z.string() })),
});

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
  /** The order's title, which a pull request takes (ADR 0071). */
  title: z.string().optional(),
  /** The order's text; null when the issue has none. */
  body: z.string().nullable().optional(),
});

/** One item of the intake's listing: with its creation time, its arrival in the queue (ADR 0208). */
export const GitHubListedIssue = GitHubIssue.extend({
  created_at: z.iso.datetime({ offset: true }),
});

/** `GET /repos/{owner}/{repo}/pulls/{n}`. */
export const GitHubPullRequest = z.object({
  state: z.enum(['open', 'closed']),
  merged: z.boolean().optional(),
  merged_at: z.string().nullable().optional(),
});

/** The head of `GET /repos/{owner}/{repo}/pulls/{n}` (ADR 0213). */
export const GitHubPullRequestHead = z.object({ head: z.object({ sha: CommitSha }) });

/** One item of `GET /repos/{owner}/{repo}/commits/{sha}/check-runs` (ADR 0213). */
export const GitHubCheckRun = z.object({
  name: z.string(),
  status: z.string(),
  conclusion: z.string().nullable().optional(),
  html_url: z.string().nullable().optional(),
});

/** One item of the `statuses` of `GET /repos/{owner}/{repo}/commits/{sha}/status` (ADR 0213). */
export const GitHubCommitStatus = z.object({
  context: z.string(),
  state: z.string(),
  target_url: z.string().nullable().optional(),
});

/** One item of `GET /repos/{owner}/{repo}/pulls`, or the answer to `POST` there (ADR 0071). */
export const GitHubOpenedPullRequest = z.object({
  html_url: z.string(),
  /** null for an account that was deleted since. */
  user: Account.nullable(),
  /** `repo` is null when the head's repository was deleted. */
  head: z.object({ ref: z.string(), repo: z.object({ full_name: z.string() }).nullable() }),
});

/** GitHub's 422 answer with the errors it found in a request, each with its message. */
export const GitHubValidationErrors = z.object({
  errors: z.array(z.object({ message: z.string() })),
});

/** One item of `GET .../issues/{n}/comments`, or the answer to `POST` there. */
export const GitHubComment = z.object({
  id: z.number().int().positive(),
  /** null for an account that was deleted since. */
  user: Account.nullable().optional(),
  body: z.string().optional(),
});

/** `GET /user`: the account gh is logged in as (ADR 0073). */
export const GitHubUser = z.object({ login: z.string().min(1) });

/** A repository, as far as `foedrum init` reads it (ADR 0199). */
export const GitHubRepository = z.object({ default_branch: z.string().min(1) });

/** A file's contents, base64 up to GitHub's 1 MB; a larger file comes with `encoding: none`. */
export const GitHubFileContents = z.object({ encoding: z.string(), content: z.string() });
