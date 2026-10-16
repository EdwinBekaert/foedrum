// A small GitHub client over fetch (ADR 0008).

export interface GitHubClientOptions {
  token: string;
  fetch?: typeof globalThis.fetch;
  baseUrl?: string;
  timeoutMs?: number;
}

export interface GitHubClient {
  rest(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<{ status: number; body: unknown }>;
  graphql(
    query: string,
    variables: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{ data: unknown; errors: readonly { message: string }[] }>;
}

export const createGitHubClient = (_options: GitHubClientOptions): GitHubClient => {
  throw new Error('not implemented');
};
