// What a claimed issue's history says of it since its approval (ADR 0368): when each label was
// added and by whom, and each change of its title, from its events (REST, conditional, ADR 0052);
// each edit of its body, which only GraphQL tells; and when each comment was made and last changed.

import type { OrderActivity } from '../engine/order-changes.ts';
import type { GitHubClient } from './client.ts';
import type { GitHubReads } from './reads.ts';

/** Reads the activity of `repo#issue` the order check compares with its approval. */
export const githubOrderActivity =
  (_reads: GitHubReads, _client: Pick<GitHubClient, 'graphql'>) =>
  async (_repo: string, _issue: number, _signal?: AbortSignal): Promise<OrderActivity> => {
    throw new Error('not implemented');
  };
