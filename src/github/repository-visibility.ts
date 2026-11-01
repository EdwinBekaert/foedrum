// Who can read each target repository, as GitHub says (ADR 0300): a sibling section names a
// repository only where the pull request's readers can read it too. Read once for each repository,
// and again after each tick for one whose answer was not read, so a failed read heals.

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

/** A visibility as read: `unseen` is a repository the login cannot see, unknown but not read again. */
type Read = Visibility | 'unseen';

/**
 * What GitHub answers of `repo`: public only when it says so. A 404 is a repository the login
 * cannot see, which another read would not change; any other failure is unknown, read again.
 */
const readVisibility = async (
  client: GitHubClient,
  repo: string,
  signal?: AbortSignal,
): Promise<Read> => {
  try {
    const answer = await client.rest('GET', `/repos/${repoPath(repo)}`, undefined, signal);
    if (answer.status === 404) return 'unseen';
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
  const known = new Map<string, Read>(repos.map((repo) => [repo.toLowerCase(), 'unknown']));
  return {
    of: (repo) => {
      const read = known.get(repo.toLowerCase()) ?? 'unknown';
      return read === 'unseen' ? 'unknown' : read;
    },
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
