// What `foedrum init` reads of a target repository through gh's own login (ADR 0073, ADR 0199):
// its default branch, and whether it is a Node repository with a lockfile.

import { GitHubFileContents, GitHubRepository } from '../schemas/github.ts';
import { checked, refused, repoPath } from './answers.ts';
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

/**
 * The file at `path` on `ref`, or `undefined` where there is none; a file GitHub gives without its
 * content (over 1 MB) is `''`, there but unread.
 */
const fileAt = async (
  client: GitHubClient,
  repo: string,
  path: string,
  ref: string,
): Promise<string | undefined> => {
  const what = `${path} of ${repo}`;
  const answer = await client.rest(
    'GET',
    `/repos/${repoPath(repo)}/contents/${path}?ref=${encodeURIComponent(ref)}`,
  );
  if (answer.status === 404) return undefined;
  if (answer.status !== 200) throw refused(answer.status, answer.body, what);
  const { encoding, content } = checked(GitHubFileContents, answer.body, what);
  return encoding === 'base64' ? Buffer.from(content, 'base64').toString('utf8') : '';
};

/** What GitHub says of `repo` on its default branch. */
export const repositoryFacts = async (
  client: GitHubClient,
  repo: string,
): Promise<RepositoryFacts> => {
  const what = `the repository ${repo}`;
  const answer = await client.rest('GET', `/repos/${repoPath(repo)}`);
  if (answer.status !== 200) throw refused(answer.status, answer.body, what);
  const base = checked(GitHubRepository, answer.body, what).default_branch;
  const packageJson = await fileAt(client, repo, 'package.json', base);
  const lockfile = (await fileAt(client, repo, 'package-lock.json', base)) !== undefined;
  return { base, packageJson, lockfile };
};
