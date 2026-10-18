// A small GitHub client over the built-in fetch (ADR 0008): REST and GraphQL calls with the
// Brewery's token, each given up after its timeout or when the caller's signal aborts. It returns
// what GitHub answered, parsed but unchecked: every caller checks it, since it comes from outside.
// On GitHub's rate limit it pauses, and fails every request until the pause ends (ADR 0052).

import { GitHubError } from '../schemas/github.ts';

export interface GitHubClientOptions {
  /** A fine-grained personal access token (ADR 0008); it never appears in an error. */
  token: string;
  /** Default the global `fetch`. */
  fetch?: typeof globalThis.fetch;
  /** Default `https://api.github.com`. */
  baseUrl?: string;
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

export const createGitHubClient = (options: GitHubClientOptions): GitHubClient => {
  const {
    token,
    fetch = globalThis.fetch,
    timeoutMs = 30_000,
    maxResponseBytes = 4 * 1024 * 1024,
    now = Date.now,
  } = options;
  const baseUrl = options.baseUrl?.replace(/\/+$/, '') ?? 'https://api.github.com';

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

  // The answer's bytes, given up once they pass `maxResponseBytes`: GitHub returns what anyone with
  // push access wrote, such as a claim commit's message, and nothing keeps that small.
  const readLimited = async (response: Response, what: string): Promise<Buffer> => {
    const tooLong = () =>
      new Error(`GitHub's answer to ${what} is longer than ${maxResponseBytes} bytes`);
    if (Number(response.headers.get('content-length')) > maxResponseBytes) {
      await response.body?.cancel();
      throw tooLong();
    }
    if (response.body === null) return Buffer.alloc(0);
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxResponseBytes) {
        await reader.cancel();
        throw tooLong();
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  };

  const request = async (
    method: string,
    path: string,
    body: unknown,
    signal: AbortSignal | undefined,
    headers: Readonly<Record<string, string>> = {},
  ): Promise<GitHubAnswer> => {
    if (now() < pausedUntil) throw new GitHubRateLimited(new Date(pausedUntil));
    const timeout = new AbortController();
    const timer = setTimeout(
      () =>
        timeout.abort(new Error(`GitHub did not answer within ${timeoutMs} ms: ${method} ${path}`)),
      timeoutMs,
    );
    const signals = signal === undefined ? [timeout.signal] : [timeout.signal, signal];
    try {
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          ...headers,
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'user-agent': 'foedrum',
          'x-github-api-version': '2022-11-28',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.any(signals),
      });
      const text = await readLimited(response, `${method} ${path}`);
      const answer = {
        status: response.status,
        body: parse(text.toString('utf8')),
        bytes: text.byteLength,
        headers: response.headers,
      };
      if (limitedBy(answer)) throw new GitHubRateLimited(new Date(pausedUntil));
      return answer;
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    baseUrl,
    rest: request,
    graphql: async (query, variables, signal) => {
      const answer = await request('POST', '/graphql', { query, variables }, signal);
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
