// Conditional reads of GitHub (ADR 0008, ADR 0052): every GET carries the ETag of the answer it got
// before, and a 304 answers that same body again without counting against the rate limit. A list
// is read page by page along GitHub's `Link` header, each page conditional on its own.

import { GitHubPage } from '../schemas/github.ts';
import { checked, refused } from './answers.ts';
import type { GitHubAnswer, GitHubClient } from './client.ts';

export interface GitHubReadsOptions {
  /** How many answers the cache keeps; the least recently used goes first. Default 256. */
  maxEntries?: number;
  /** How many pages one list may have; more fails the read. Default 500 (5,000 items). */
  maxPages?: number;
  /** How many bytes of answers the cache keeps; the least recently used goes first. Default 64 MiB. */
  maxBytes?: number;
  /** How many bytes the pages of one list may have; more fails the read. Default 32 MiB. */
  maxListBytes?: number;
}

/**
 * How many items a list asks for per page. Anyone who can open an issue or comment on a public
 * repository can write a body of 65,536 characters, up to 6 bytes each in JSON, so a page of 10
 * stays under the client's 4 MiB answer limit, and long bodies cannot stop a read (ADR 0052).
 */
export const pageSize = 10;

export interface GitHubReads {
  /** A GET of `path`, conditional on the answer before; a 304 answers that one as 200. */
  get(path: string, signal?: AbortSignal): Promise<GitHubAnswer>;
  /** Every item of the list at `path`, page after page; `what` names it in an error. */
  pages(path: string, what: string, signal?: AbortSignal): Promise<unknown[]>;
}

/** The URL of the `next` relation in a `Link` header, or undefined when there is none. */
const nextPage = (link: string | null): string | undefined => {
  for (const [, url, rel] of link?.matchAll(/<([^>]*)>\s*;\s*rel="([^"]*)"/g) ?? []) {
    if (rel?.split(/\s+/).includes('next')) return url;
  }
  return undefined;
};

const positive = (value: number, name: string): number => {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive whole number, got ${value}`);
  }
  return value;
};

export const createGitHubReads = (
  client: GitHubClient,
  options: GitHubReadsOptions = {},
): GitHubReads => {
  const maxEntries = positive(options.maxEntries ?? 256, 'maxEntries');
  const maxPages = positive(options.maxPages ?? 500, 'maxPages');
  // The last answer with an ETag of each path, least recently used first.
  const cache = new Map<string, { etag: string; answer: GitHubAnswer }>();

  const get: GitHubReads['get'] = async (path, signal) => {
    const cached = cache.get(path);
    const headers = cached === undefined ? {} : { 'if-none-match': cached.etag };
    const answer = await client.rest('GET', path, undefined, signal, headers);
    cache.delete(path);
    if (answer.status === 304) {
      if (cached === undefined)
        throw new Error(`GitHub answered 304 to ${path}, which named no ETag`);
      cache.set(path, cached);
      return cached.answer;
    }
    const etag = answer.headers.get('etag');
    if (answer.status === 200 && etag !== null) {
      cache.set(path, { etag, answer });
      for (const oldest of cache.keys()) {
        if (cache.size <= maxEntries) break;
        cache.delete(oldest);
      }
    }
    return answer;
  };

  return {
    get,
    pages: async (path, what, signal) => {
      const items: unknown[] = [];
      for (let next: string | undefined = path, page = 1; next !== undefined; page++) {
        if (page > maxPages) throw new Error(`${what} has more than ${maxPages} pages`);
        const answer = await get(next, signal);
        if (answer.status !== 200) throw refused(answer.status, answer.body, what);
        items.push(...checked(GitHubPage, answer.body, what));
        const url = nextPage(answer.headers.get('link'));
        // The token goes with every request: never to a page off the API.
        if (url !== undefined && !url.startsWith(`${client.baseUrl}/`)) {
          throw new Error(`The next page of ${what} is not on ${client.baseUrl}: ${url}`);
        }
        next = url?.slice(client.baseUrl.length);
      }
      return items;
    },
  };
};
