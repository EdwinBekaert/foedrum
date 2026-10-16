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
  maxResponseBytes?: number;
}

export interface GitHubClient {
  /** `path` from the API's root, `/repos/...`; `body` as JSON, or `null` when there is none. */
  rest(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<{ status: number; body: unknown }>;
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
  } = options;

  const request = async (
    method: string,
    path: string,
    body: unknown,
    signal: AbortSignal | undefined,
  ): Promise<{ status: number; body: unknown }> => {
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
      return { status: response.status, body: parse(await response.text()) };
    } finally {
      clearTimeout(timer);
    }
  };

  return {
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
