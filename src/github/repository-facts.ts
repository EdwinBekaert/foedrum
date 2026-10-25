// What `foedrum init` reads of a target repository through gh's own login (ADR 0073, ADR 0199):
// its default branch, and whether it is a Node repository with a lockfile.

import type { GitHubClient } from './client.ts';

/** What GitHub says of a target repository, on its default branch. */
export interface RepositoryFacts {
  /** Its default branch: the `base` attempts start from. */
  base: string;
  /** Its `package.json`, when it has one. */
  packageJson: string | undefined;
  /** Whether it has a `package-lock.json`. */
  lockfile: boolean;
}

/** What GitHub says of `repo` on its default branch. */
export const repositoryFacts = async (
  _client: GitHubClient,
  _repo: string,
): Promise<RepositoryFacts> => {
  throw new Error('not implemented');
};
