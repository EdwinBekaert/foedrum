// node scripts/review-metrics.ts [--from <pr>] [--to <pr>] [--repo <owner/name>] (#673): reads the
// /brew-review summary comments of the merged pull requests from --from (default 1) to --to (default
// the newest) through gh's GraphQL API (src/github/client.ts: gh's own login, no token), and prints
// the findings by lens and severity, how they ended, and the rounds, in Markdown. Read-only: it
// posts, edits and minimizes nothing. The repository is origin's unless --repo names one. The
// decisions are scripts/review-metrics/core.ts.

import { parseArgs } from 'node:util';
import { createGitHubClient, type GitHubClient } from '../src/github/client.ts';
import { runGit } from '../src/workspace/git.ts';
import { aggregate, type Comment, formatMetrics, type PullRequest } from './review-metrics/core.ts';

export interface Deps {
  client: Pick<GitHubClient, 'graphql'>;
  /** origin's URL, or undefined when there is none. */
  origin: () => Promise<string | undefined>;
  out: (text: string) => void;
  err: (text: string) => void;
}

const USAGE =
  'usage: node scripts/review-metrics.ts [--from <pr>] [--to <pr>] [--repo <owner/name>]\n';

const NEWEST = `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) { pullRequests(last: 1) { nodes { number } } }
}`;

const COMMENTS = `query($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    issueOrPullRequest(number: $number) {
      __typename
      ... on PullRequest {
        merged
        comments(first: 100, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes { url body isMinimized }
        }
      }
    }
  }
}`;

// `https://github.com/owner/name(.git)`, `git@github.com:owner/name(.git)` or `ssh://…/owner/name`.
const repositoryOf = (url: string): string | undefined => {
  const found = /[/:]([^/:\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url.trim());
  return found === null ? undefined : `${found[1]}/${found[2]}`;
};

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};

type Read = PullRequest | 'not merged' | 'issue or missing';

/** Pull request `number` of `owner/name` and every page of its comments. */
const readPull = async (
  client: Deps['client'],
  owner: string,
  name: string,
  number: number,
): Promise<Read> => {
  const comments: Comment[] = [];
  let after: string | null = null;
  for (;;) {
    const { data, errors } = await client.graphql(COMMENTS, { owner, name, number, after });
    const found = record(record(record(data).repository).issueOrPullRequest);
    if (Object.keys(found).length === 0) {
      // GitHub answers a number that is neither an issue nor a pull request with null and an error.
      if (record(data).repository !== undefined && errors.length <= 1) return 'issue or missing';
      throw new Error(errors.map(({ message }) => message).join('; ') || 'no answer');
    }
    if (found.__typename !== 'PullRequest') return 'issue or missing';
    if (found.merged !== true) return 'not merged';
    const page = record(found.comments);
    const nodes = Array.isArray(page.nodes) ? page.nodes : [];
    for (const each of nodes.map(record)) {
      if (typeof each.url !== 'string' || typeof each.body !== 'string') {
        throw new Error('a comment without its url or body');
      }
      comments.push({ url: each.url, body: each.body, hidden: each.isMinimized === true });
    }
    const info = record(page.pageInfo);
    if (info.hasNextPage !== true || typeof info.endCursor !== 'string') break;
    after = info.endCursor;
  }
  return { number, comments };
};

const newest = async (client: Deps['client'], owner: string, name: string): Promise<number> => {
  const { data, errors } = await client.graphql(NEWEST, { owner, name });
  const nodes = record(record(record(data).repository).pullRequests).nodes;
  const number = Array.isArray(nodes) ? record(nodes[0]).number : undefined;
  if (typeof number !== 'number') {
    throw new Error(errors.map(({ message }) => message).join('; ') || 'no pull request');
  }
  return number;
};

const PR_NUMBER = /^[1-9]\d*$/;

export const run = async (args: readonly string[], deps: Deps): Promise<number> => {
  let values: { from?: string; to?: string; repo?: string };
  try {
    ({ values } = parseArgs({
      args: [...args],
      options: { from: { type: 'string' }, to: { type: 'string' }, repo: { type: 'string' } },
    }));
  } catch {
    deps.err(USAGE);
    return 2;
  }
  const { from = '1', to, repo } = values;
  if (
    !PR_NUMBER.test(from) ||
    (to !== undefined && (!PR_NUMBER.test(to) || Number(to) < Number(from))) ||
    (repo !== undefined && repositoryOf(`/${repo}`) !== repo)
  ) {
    deps.err(USAGE);
    return 2;
  }
  const origin = repo === undefined ? await deps.origin() : undefined;
  const full = repo ?? (origin === undefined ? undefined : repositoryOf(origin));
  if (full === undefined) {
    deps.err(`no origin to read the repository from: give --repo <owner/name>\n${USAGE}`);
    return 2;
  }
  const [owner = '', name = ''] = full.split('/');
  let at = Number(from);
  try {
    const last = to === undefined ? await newest(deps.client, owner, name) : Number(to);
    const pulls: PullRequest[] = [];
    let notMerged = 0;
    let other = 0;
    for (; at <= last; at += 1) {
      const read = await readPull(deps.client, owner, name, at);
      if (read === 'not merged') notMerged += 1;
      else if (read === 'issue or missing') other += 1;
      else pulls.push(read);
    }
    deps.out(
      `Merged pull requests #${from} to #${last} of ${full}: ${pulls.length} merged, ${notMerged} not merged, ${other} issues or missing.\n\n`,
    );
    deps.out(formatMetrics(aggregate(pulls)));
    return 0;
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    deps.err(`reading #${at} failed: ${error.message}\n`);
    return 1;
  }
};

if (import.meta.main) {
  process.exitCode = await run(process.argv.slice(2), {
    client: createGitHubClient(),
    origin: async () => {
      const { code, stdout } = await runGit(process.cwd(), ['remote', 'get-url', 'origin']);
      return code === 0 ? stdout.trim() : undefined;
    },
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
  });
}
