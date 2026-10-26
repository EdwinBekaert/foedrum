// What `foedrum init` does on GitHub through gh's own login (ADR 0073, ADR 0207): whether the
// Brewery's repository is there, creating it under the login or an organization, and the intake
// label of a target repository.

import { GitHubValidationError } from '../schemas/github.ts';
import { refused, repoPath } from './answers.ts';
import type { GitHubClient } from './client.ts';

/** The colour Foedrum's marks give a label they create. */
export const LABEL_COLOR = 'ededed';

/** Whether GitHub has what `path` names: 404 is no, 200 yes, any other answer refuses `what`. */
const found = async (client: GitHubClient, path: string, what: string): Promise<boolean> => {
  const answer = await client.rest('GET', path);
  if (answer.status === 404) return false;
  if (answer.status !== 200) throw refused(answer.status, answer.body, what);
  return true;
};

/** Whether GitHub has `repo`. */
export const repositoryExists = async (client: GitHubClient, repo: string): Promise<boolean> =>
  found(client, `/repos/${repoPath(repo)}`, `the repository ${repo}`);

/** Creates `repo`, empty: under the login when it is the owner, else under the organization. */
export const createRepository = async (
  client: GitHubClient,
  repo: string,
  login: string,
  isPrivate: boolean,
): Promise<void> => {
  const [owner = '', name = ''] = repoPath(repo).split('/');
  const path = owner.toLowerCase() === login.toLowerCase() ? '/user/repos' : `/orgs/${owner}/repos`;
  const answer = await client.rest('POST', path, {
    name,
    private: isPrivate,
  });
  if (answer.status !== 201) {
    throw refused(answer.status, answer.body, `creating the repository ${repo}`);
  }
};

/** Whether `repo` has the label `label`. */
export const labelExists = async (
  client: GitHubClient,
  repo: string,
  label: string,
): Promise<boolean> =>
  found(
    client,
    `/repos/${repoPath(repo)}/labels/${encodeURIComponent(label)}`,
    `the label ${label} of ${repo}`,
  );

/** Creates the label `label` in `repo`; one made in the meantime counts as made. */
export const createLabel = async (
  client: GitHubClient,
  repo: string,
  label: string,
  description: string,
): Promise<void> => {
  const answer = await client.rest('POST', `/repos/${repoPath(repo)}/labels`, {
    name: label,
    description,
    color: LABEL_COLOR,
  });
  if (answer.status === 201) return;
  const error = GitHubValidationError.safeParse(answer.body);
  if (
    answer.status === 422 &&
    error.success &&
    error.data.errors.some(({ code }) => code === 'already_exists')
  ) {
    return;
  }
  throw refused(answer.status, answer.body, `creating the label ${label} in ${repo}`);
};
