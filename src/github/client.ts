// A small GitHub client over the built-in fetch (ADR 0008): REST and GraphQL calls with the
// Brewery's token, each given up after its timeout or when the caller's signal aborts. It returns
// what GitHub answered, parsed but unchecked: every caller checks it, since it comes from outside.

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
}

/**
 * GitHub's rate limit holds requests until `until` (ADR 0052): the request that met it, and every
 * request of this client before then, fails with it without reaching GitHub.
 */
export class GitHubRateLimited extends Error {
  readonly until!: Date;
  constructor(_until: Date) {
    super('not implemented');
    throw new Error('not implemented');
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
    baseUrl = 'https://api.github.com',
    timeoutMs = 30_000,
    maxResponseBytes = 4 * 1024 * 1024,
  } = options;

  // The answer's text, given up once it passes `maxResponseBytes`: GitHub returns what anyone with
  // push access wrote, such as a claim commit's message, and nothing keeps that small.
  const readLimited = async (response: Response, what: string): Promise<string> => {
    const tooLong = () =>
      new Error(`GitHub's answer to ${what} is longer than ${maxResponseBytes} bytes`);
    if (Number(response.headers.get('content-length')) > maxResponseBytes) {
      await response.body?.cancel();
      throw tooLong();
    }
    if (response.body === null) return '';
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
    return Buffer.concat(chunks).toString('utf8');
  };

  const request = async (
    method: string,
    path: string,
    body: unknown,
    signal: AbortSignal | undefined,
  ): Promise<GitHubAnswer> => {
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
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'user-agent': 'foedrum',
          'x-github-api-version': '2022-11-28',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.any(signals),
      });
      return {
        status: response.status,
        body: parse(await readLimited(response, `${method} ${path}`)),
        get headers(): Headers {
          throw new Error('not implemented');
        },
      };
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    get baseUrl(): string {
      throw new Error('not implemented');
    },
    rest: (method, path, body, signal) => request(method, path, body, signal),
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
