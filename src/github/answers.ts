// What every GitHub caller does with a repository it names and an answer it gets: the repository
// checked before it becomes part of a URL, an answer checked against the fields it uses, and a
// refusal named by its status and GitHub's message, never by a credential.

import { Repo } from '../schemas/events.ts';
import { GitHubError, type GitHubIssue } from '../schemas/github.ts';
import type { z } from '../schemas/zod.ts';

/** `owner/name` as path segments; checked first, since it becomes part of a URL. */
export const repoPath = (repo: string): string => {
  if (!Repo.safeParse(repo).success)
    throw new Error(`The repository must be owner/name, got ${repo}`);
  return repo.split('/').map(encodeURIComponent).join('/');
};

/** `body` as `schema` says it is, or an error that names `what`. */
export const checked = <T>(schema: z.ZodType<T>, body: unknown, what: string): T => {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new Error(`GitHub's answer to ${what} is not what it should be`);
  return parsed.data;
};

/** The names of an issue's labels, which GitHub gives as names or as objects. */
export const labelNames = (labels: z.infer<typeof GitHubIssue>['labels']): string[] =>
  labels.map((label) => (typeof label === 'string' ? label : label.name));

/** The logins of an issue's assignees, none when GitHub gives null. */
export const assigneeLogins = (assignees: z.infer<typeof GitHubIssue>['assignees']): string[] =>
  (assignees ?? []).map(({ login }) => login);

/**
 * The error for an answer `what` did not expect: its status, and GitHub's message when it has one.
 */
export const refused = (status: number, body: unknown, what: string): Error => {
  const parsed = GitHubError.safeParse(body);
  const said = parsed.success ? `: ${parsed.data.message}` : '';
  return new Error(`GitHub answered ${status} to ${what}${said}`);
};
