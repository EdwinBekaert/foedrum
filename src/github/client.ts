// A small GitHub client over `gh api` (ADR 0073): REST and GraphQL calls with gh's own login,
// each given up after its timeout or when the caller's signal aborts. Foedrum never holds a token.
// It returns what GitHub answered, parsed but unchecked: every caller checks it, since it comes
// from outside. On GitHub's rate limit it pauses, and fails every request until the pause ends
// (ADR 0052).

import type { ExecProcess } from '../platform/processes.ts';

export interface GitHubClientOptions {
  /** The process runner gh runs through; default the real one. Unit tests pass a fake (ADR 0021). */
  exec?: ExecProcess;
  /** gh's `--hostname`: `github.com` (the default), a GitHub Enterprise host or `github.localhost`. */
  hostname?: string;
  /** The environment gh runs in, without the GitHub token variables; default this process's. */
  env?: NodeJS.ProcessEnv;
  /** Default this process's platform; it decides how environment names compare. */
  platform?: NodeJS.Platform;
  /** Where gh runs; default this process's working directory. */
  cwd?: string;
  /** How long one request may take; default 30 s. */
  timeoutMs?: number;
  /** How long an answer may be; default 4 MiB, the process runner's output limit (ADR 0035). */
  maxResponseBytes?: number;
  /** The time in milliseconds, for the rate limit's pause; default `Date.now`. */
  now?: () => number;
}

/** What GitHub answered: its status, its body parsed but unchecked, and its headers. */
export interface GitHubAnswer {
  status: number;
  body: unknown;
  headers: Headers;
  /** How long the answer was, in bytes: what the reads count against their cache (ADR 0068). */
  bytes: number;
}

/**
 * GitHub's rate limit holds requests until `until` (ADR 0052): the request that met it, and every
 * request of this client before then, fails with it without reaching GitHub.
 */
export class GitHubRateLimited extends Error {
  readonly until: Date;
  constructor(until: Date) {
    super(`GitHub's rate limit holds requests until ${until.toISOString()}`);
    this.name = 'GitHubRateLimited';
    this.until = until;
  }
}

export interface GitHubClient {
  /** Where the API's paths start, without a trailing `/`. */
  readonly baseUrl: string;
  /**
   * `path` from the API's root, `/repos/...`; `body` as JSON, or `null` when there is none;
   * `headers` added to the request, such as `if-none-match`.
   */
  rest(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown,
    signal?: AbortSignal,
    headers?: Readonly<Record<string, string>>,
  ): Promise<GitHubAnswer>;
  /** A GraphQL request; an answer that is not 200 fails. */
  graphql(
    query: string,
    variables: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{ data: unknown; errors: readonly { message: string }[] }>;
}

/** The API root gh asks on `hostname`, without a trailing `/`. */
export const apiRootOf = (_hostname: string): string => {
  throw new Error('not implemented');
};

export const createGitHubClient = (_options: GitHubClientOptions = {}): GitHubClient => {
  throw new Error('not implemented');
};
