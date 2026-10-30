// node scripts/review-metrics.ts [--from <pr>] [--to <pr>] [--repo <owner/name>] (#673): reads the
// /brew-review summary comments of the merged pull requests from --from (default 1) to --to (default
// the newest) through gh's GraphQL API (src/github/client.ts: gh's own login, no token), and prints
// the findings by lens and severity, how they ended, and the rounds, in Markdown. Read-only: it
// posts, edits and minimizes nothing. The repository is origin's unless --repo names one. The
// decisions are scripts/review-metrics/core.ts.

import type { GitHubClient } from '../src/github/client.ts';

export interface Deps {
  client: Pick<GitHubClient, 'graphql'>;
  /** origin's URL, or undefined when there is none. */
  origin: () => Promise<string | undefined>;
  out: (text: string) => void;
  err: (text: string) => void;
}

export const run = async (_args: readonly string[], _deps: Deps): Promise<number> => {
  throw new Error('not implemented');
};
