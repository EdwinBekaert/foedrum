// A small GitHub client over `gh api` (ADR 0073): REST and GraphQL calls with gh's own login,
// each given up after its timeout or when the caller's signal aborts. Foedrum never holds a token.
// It returns what GitHub answered, parsed but unchecked: every caller checks it, since it comes
// from outside. On GitHub's rate limit it pauses, and fails every request until the pause ends
// (ADR 0052).

import { envNameKey, withoutGitHubTokens } from '../platform/env.ts';
import { type ExecProcess, execProcess } from '../platform/processes.ts';
import { GitHubError } from '../schemas/github.ts';

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

/** What GitHub answered as text: its status, its body as gh printed it, and its headers. */
export interface GitHubTextAnswer {
  status: number;
  text: string;
  headers: Headers;
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
  /**
   * `GET path` with its answer kept as text, never parsed, escape sequences and all, up to
   * `maxBytes`, which also bounds gh's output: a job's log (ADR 0228).
   */
  text(path: string, maxBytes: number, signal?: AbortSignal): Promise<GitHubTextAnswer>;
  /** A GraphQL request; an answer that is not 200 fails. */
  graphql(
    query: string,
    variables: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{ data: unknown; errors: readonly { message: string }[] }>;
}

// Parses an answer's body, which may be empty or not JSON at all.
const parse = (text: string): unknown => {
  if (text === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

const minuteMs = 60_000;
/** The longest pause a secondary limit without headers doubles up to. */
const mostDoublingMs = 15 * minuteMs;
/** The longest pause of all, whatever a header says: GitHub's primary limit resets every hour. */
const mostPauseMs = 60 * minuteMs;

// A header that holds a whole number, such as a reset in epoch seconds; undefined for anything
// else.
const wholeNumber = (text: string | null): number | undefined =>
  text !== null && /^\d+$/.test(text.trim()) ? Number(text.trim()) : undefined;

const messagesOf = (errors: unknown): { message: string }[] =>
  Array.isArray(errors)
    ? errors.map((error: unknown) => ({
        message:
          typeof error === 'object' && error !== null && 'message' in error
            ? String(error.message)
            : JSON.stringify(error),
      }))
    : [];

/**
 * The API root gh asks on `hostname`, without a trailing `/`: where a next page's link must point
 * (ADR 0052). `github.localhost` is gh's development host, served over http.
 */
const apiRootOf = (hostname: string): string => {
  switch (hostname) {
    case 'github.com':
      return 'https://api.github.com';
    case 'github.localhost':
      return 'http://api.github.localhost';
    default:
      return `https://${hostname}/api/v3`;
  }
};

/** Room for the status line and the headers, above an answer's own limit. */
const HEADER_BYTES = 64 * 1024;

/** gh's name for the host's GraphQL endpoint, which is not under the REST API's root everywhere. */
const GRAPHQL = 'graphql';

const STATUS_LINE = /^HTTP\/\d+(?:\.\d+)? (\d{3})(?: .*)?$/;

/**
 * What `gh api --include` printed: a status line, header lines up to an empty one, then the body.
 * `undefined` when it printed no status line, so gh failed before GitHub answered.
 */
const parseInclude = (
  stdout: string,
): { status: number; headers: Headers; body: string } | undefined => {
  const lines = stdout.split('\n');
  const status = STATUS_LINE.exec(lines[0]?.replace(/\r$/, '') ?? '');
  if (status === null) return undefined;
  const headers = new Headers();
  let at = 1;
  for (; at < lines.length; at++) {
    const line = lines[at]?.replace(/\r$/, '') ?? '';
    if (line === '') break;
    const colon = line.indexOf(':');
    try {
      if (colon > 0) headers.append(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
    } catch {
      // A header no request could carry says nothing the client reads.
    }
  }
  return { status: Number(status[1]), headers, body: lines.slice(at + 1).join('\n') };
};

// gh's environment: no token variable, which gh would prefer to its own login (ADR 0073), and no
// debug output; it never prompts or looks for updates, and prints no colours.
const ghEnvironment = (env: NodeJS.ProcessEnv, platform: NodeJS.Platform): NodeJS.ProcessEnv => {
  const key = envNameKey(platform);
  const debug = new Set(['GH_DEBUG', 'DEBUG'].map(key));
  const kept = Object.entries(withoutGitHubTokens(env, platform)).filter(
    ([name]) => !debug.has(key(name)),
  );
  return {
    ...Object.fromEntries(kept),
    GH_PROMPT_DISABLED: '1',
    GH_NO_UPDATE_NOTIFIER: '1',
    NO_COLOR: '1',
  };
};

const firstLineOf = (text: string): string | undefined =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line !== '');

export const createGitHubClient = (options: GitHubClientOptions = {}): GitHubClient => {
  const {
    exec = execProcess,
    hostname = 'github.com',
    platform = process.platform,
    cwd = process.cwd(),
    timeoutMs = 30_000,
    maxResponseBytes = 4 * 1024 * 1024,
    now = Date.now,
  } = options;
  const baseUrl = apiRootOf(hostname);
  const env = ghEnvironment(options.env ?? process.env, platform);

  // Requests wait for GitHub's rate limit until `pausedUntil`; `secondaries` counts the secondary
  // limits without headers in a row, whose pause doubles.
  let pausedUntil = 0;
  let secondaries = 0;
  const pause = (until: number): void => {
    pausedUntil = Math.max(pausedUntil, Math.min(until, now() + mostPauseMs));
  };

  /**
   * Pauses for GitHub's rate limit when `answer` calls for it, as GitHub's documentation says: a
   * retry-after first, then the reset of a used-up limit, else a minute that doubles while the
   * limit repeats. True when the answer is a refusal for the limit.
   */
  const limitedBy = (answer: GitHubAnswer): boolean => {
    const { status, body, headers } = answer;
    const at = now();
    const reset = wholeNumber(headers.get('x-ratelimit-reset'));
    const usedUp = headers.get('x-ratelimit-remaining')?.trim() === '0' && reset !== undefined;
    const retryAfter = wholeNumber(headers.get('retry-after'));
    const error = GitHubError.safeParse(body);
    const limited =
      status === 429 ||
      (status === 403 &&
        (usedUp ||
          retryAfter !== undefined ||
          (error.success && /rate limit/i.test(error.data.message))));
    if (!limited) {
      secondaries = 0;
      // The last request the limit allowed: the next one would be refused.
      if (usedUp) pause(reset * 1000);
      return false;
    }
    if (retryAfter !== undefined) pause(at + retryAfter * 1000);
    else if (usedUp) pause(reset * 1000);
    else {
      pause(at + Math.min(minuteMs * 2 ** secondaries, mostDoublingMs));
      secondaries++;
    }
    return true;
  };

  // One request through `gh api --include`, with an argument array and no shell; a body goes on
  // stdin. gh exits 1 on a status of 300 or more after printing the answer, so a 304 or a 404 is
  // an answer like a 200; without a status line, gh failed before GitHub answered (ADR 0073).
  // `limit` bounds the answer; `escapes` lets gh print one with terminal escape sequences, which
  // it refuses since 2.97.0 (ADR 0228).
  const exchange = async (
    method: string,
    endpoint: string,
    body: unknown,
    signal: AbortSignal | undefined,
    headers: Readonly<Record<string, string>>,
    limit: number,
    escapes: boolean,
  ): Promise<GitHubTextAnswer> => {
    const what = `${method} ${endpoint}`;
    // Never an option of gh's: a path starts with `/`, and GraphQL is gh's name for its endpoint.
    if (endpoint !== GRAPHQL && !endpoint.startsWith('/')) {
      throw new Error(`A GitHub API path starts with /: ${JSON.stringify(endpoint)}`);
    }
    if (now() < pausedUntil) throw new GitHubRateLimited(new Date(pausedUntil));
    const sent = {
      ...headers,
      accept: 'application/vnd.github+json',
      'user-agent': 'foedrum',
      // A caller's own wins: the sub-issue calls were tried under 2026-03-10 only (#723).
      'x-github-api-version': headers['x-github-api-version'] ?? '2022-11-28',
    };
    const args = [
      'api',
      '--include',
      ...(escapes ? ['--allow-escape-sequences'] : []),
      '--hostname',
      hostname,
      '--method',
      method,
      ...Object.entries(sent).flatMap(([name, value]) => ['-H', `${name}: ${value}`]),
      endpoint,
      ...(body === undefined ? [] : ['--input', '-']),
    ];
    const tooLong = () => new Error(`GitHub's answer to ${what} is longer than ${limit} bytes`);
    const ran = await exec('gh', args, {
      cwd,
      env,
      timeoutMs,
      signal,
      maxOutputBytes: limit + HEADER_BYTES,
      ...(body === undefined ? {} : { stdin: JSON.stringify(body) }),
    });
    switch (ran.killed) {
      case undefined:
        break;
      case 'timed-out':
        throw new Error(`GitHub did not answer within ${timeoutMs} ms: ${what}`);
      case 'too-much-output':
        throw tooLong();
      case 'stopped':
        throw signal?.reason ?? new Error(`${what} was stopped`);
      default: {
        const unknown: never = ran.killed;
        throw new Error(`unknown kill ${String(unknown)}`);
      }
    }
    const printed = ran.exitCode === 0 || ran.exitCode === 1 ? parseInclude(ran.stdout) : undefined;
    if (printed === undefined) {
      const said = firstLineOf(ran.stderr) ?? `gh exited with ${ran.exitCode}`;
      // gh's exit code for a host it has no login for.
      const login = ran.exitCode === 4 ? `; run gh auth login --hostname ${hostname}` : '';
      throw new Error(`gh could not ask GitHub for ${what}: ${said}${login}`);
    }
    if (Buffer.byteLength(printed.body) > limit) throw tooLong();
    return { status: printed.status, text: printed.body, headers: printed.headers };
  };

  const request = async (
    method: string,
    endpoint: string,
    body: unknown,
    signal: AbortSignal | undefined,
    headers: Readonly<Record<string, string>> = {},
  ): Promise<GitHubAnswer> => {
    const {
      status,
      text,
      headers: received,
    } = await exchange(method, endpoint, body, signal, headers, maxResponseBytes, false);
    const answer = { status, body: parse(text), bytes: Buffer.byteLength(text), headers: received };
    if (limitedBy(answer)) throw new GitHubRateLimited(new Date(pausedUntil));
    return answer;
  };

  return {
    baseUrl,
    rest: request,
    text: async (path, maxBytes, signal) => {
      const answer = await exchange('GET', path, undefined, signal, {}, maxBytes, true);
      // A refusal is GitHub's JSON, which says whether it is the rate limit; a log never is.
      const body = answer.status === 200 ? null : parse(answer.text);
      const { status, headers } = answer;
      if (limitedBy({ status, body, headers, bytes: 0 })) {
        throw new GitHubRateLimited(new Date(pausedUntil));
      }
      return answer;
    },
    graphql: async (query, variables, signal) => {
      const answer = await request('POST', GRAPHQL, { query, variables }, signal);
      if (answer.status !== 200)
        throw new Error(`GitHub answered ${answer.status} to a GraphQL request`);
      const parsed = (
        typeof answer.body === 'object' && answer.body !== null ? answer.body : {}
      ) as {
        data?: unknown;
        errors?: unknown;
      };
      return { data: parsed.data ?? null, errors: messagesOf(parsed.errors) };
    },
  };
};
