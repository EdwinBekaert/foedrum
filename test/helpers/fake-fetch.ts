// A fake `fetch` for the GitHub client's tests: it answers each request with the next canned
// answer and records what it was asked. No network (ADR 0021).

export interface FetchRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  signal: AbortSignal | undefined;
}

/** A canned answer, or `hang`: never answers, and rejects once the request's signal aborts. */
export type Answer = { status: number; body?: unknown; headers?: Record<string, string> } | 'hang';

/** A `fetch` that answers each request with the next answer, recording what it was asked. */
export const fakeFetch = (answers: Answer[]) => {
  const requests: FetchRequest[] = [];
  const fetch = async (input: string | URL | Request, init: RequestInit = {}) => {
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    requests.push({
      method: init.method ?? 'GET',
      url: String(input),
      headers,
      body,
      signal: init.signal ?? undefined,
    });
    const answer = answers.shift();
    if (answer === undefined) throw new Error(`no answer for ${init.method} ${String(input)}`);
    if (answer === 'hang') {
      return new Promise<Response>((_, reject) => {
        if (init.signal?.aborted === true) reject(init.signal.reason);
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      });
    }
    return new Response(answer.body === undefined ? null : JSON.stringify(answer.body), {
      status: answer.status,
      headers: { 'content-type': 'application/json', ...answer.headers },
    });
  };
  return { fetch: fetch as typeof globalThis.fetch, requests };
};
