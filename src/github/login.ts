// The GitHub login gh uses (ADR 0068, ADR 0073): the claims' assignee and the author the marks
// look for in comments (ADR 0043). Read once when `foedrum serve` starts.

import { GitHubUser } from '../schemas/github.ts';
import { checked, refused } from './answers.ts';
import type { GitHubClient } from './client.ts';

export const githubLogin = async (client: GitHubClient, signal?: AbortSignal): Promise<string> => {
  const what = 'the login gh uses';
  const answer = await client.rest('GET', '/user', undefined, signal);
  if (answer.status !== 200) throw refused(answer.status, answer.body, what);
  return checked(GitHubUser, answer.body, what).login;
};
