// Whether each target repository is public, as GitHub says (ADR 0300): a public pull request's
// sibling section names no repository it cannot tell is public. Read once for each repository,
// and again on each pass for one whose answer was not read, so a failed read heals.

import type { Visibility } from '../engine/sibling-pull-requests.ts';
import { GitHubRepositoryVisibility } from '../schemas/github.ts';
import { repoPath } from './answers.ts';
import type { GitHubClient } from './client.ts';

export interface RepositoryVisibilities {
  /** What GitHub said of `repo` at the last read: `unknown` before one, or when it failed. */
  of(repo: string): Visibility;
  /** Reads every repository whose visibility is still unknown. */
  read(signal?: AbortSignal): Promise<void>;
}

/**
 * What GitHub answers of `repo`: public only when it says so. A 404 is a repository the login
 * cannot see, so private for the run; any other failure is unknown, read again.
 */
const readVisibility = async (
  client: GitHubClient,
  repo: string,
  signal?: AbortSignal,
): Promise<Visibility> => {
  try {
    const answer = await client.rest('GET', `/repos/${repoPath(repo)}`, undefined, signal);
    if (answer.status === 404) return 'private';
    const parsed = GitHubRepositoryVisibility.safeParse(answer.body);
    if (answer.status !== 200 || !parsed.success) return 'unknown';
    const { private: isPrivate, visibility } = parsed.data;
    if (visibility === 'internal') return 'internal';
    return !isPrivate && (visibility === undefined || visibility === 'public')
      ? 'public'
      : 'private';
  } catch (error) {
    if (signal?.aborted === true) throw error;
    return 'unknown';
  }
};

/** The visibility of each of `repos`, read through `client`. */
export const repositoryVisibilities = (
  client: GitHubClient,
  repos: readonly string[],
): RepositoryVisibilities => {
  const known = new Map<string, Visibility>(repos.map((repo) => [repo.toLowerCase(), 'unknown']));
  return {
    of: (repo) => known.get(repo.toLowerCase()) ?? 'unknown',
    read: async (signal) => {
      // At once, so a slow answer holds up no other.
      const unread = repos.filter((repo) => known.get(repo.toLowerCase()) === 'unknown');
      await Promise.all(
        unread.map(async (repo) => {
          known.set(repo.toLowerCase(), await readVisibility(client, repo, signal));
        }),
      );
    },
  };
};
