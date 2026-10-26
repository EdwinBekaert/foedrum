// What `foedrum init` does on GitHub through gh's own login (ADR 0073, ADR 0207): whether the
// Brewery's repository is there, creating it under the login or an organization, and the intake
// label of a target repository.

import type { GitHubClient } from './client.ts';

/** Whether GitHub has `repo`. */
export const repositoryExists = async (_client: GitHubClient, _repo: string): Promise<boolean> => {
  throw new Error('not implemented');
};

/** Creates `repo`, empty: under the login when it is the owner, else under the organization. */
export const createRepository = async (
  _client: GitHubClient,
  _repo: string,
  _login: string,
  _isPrivate: boolean,
): Promise<void> => {
  throw new Error('not implemented');
};

/** Whether `repo` has the label `label`. */
export const labelExists = async (
  _client: GitHubClient,
  _repo: string,
  _label: string,
): Promise<boolean> => {
  throw new Error('not implemented');
};

/** Creates the label `label` in `repo`; one made in the meantime counts as made. */
export const createLabel = async (
  _client: GitHubClient,
  _repo: string,
  _label: string,
  _description: string,
): Promise<void> => {
  throw new Error('not implemented');
};
