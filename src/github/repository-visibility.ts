// Whether each target repository is public, as GitHub says (ADR 0300): a public pull request's
// sibling section names no repository it cannot tell is public. Read once for each repository,
// and again on each pass for one whose answer was not read, so a failed read heals.

import type { Visibility } from '../engine/sibling-pull-requests.ts';
import type { GitHubClient } from './client.ts';

export interface RepositoryVisibilities {
  /** What GitHub said of `repo` at the last read: `unknown` before one, or when it failed. */
  of(repo: string): Visibility;
  /** Reads every repository whose visibility is still unknown. */
  read(signal?: AbortSignal): Promise<void>;
}

/** The visibility of each of `repos`, read through `client`. */
export const repositoryVisibilities = (
  _client: GitHubClient,
  _repos: readonly string[],
): RepositoryVisibilities => {
  throw new Error('not implemented');
};
