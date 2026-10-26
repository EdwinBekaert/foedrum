// Conditional reads of GitHub (ADR 0008, ADR 0052): every GET carries the ETag of the answer it got
// before, and a 304 answers that same body again without counting against the rate limit. A list
// is read page by page along GitHub's `Link` header, each page conditional on its own.

import { GitHubPage, GitHubWrappedPage } from '../schemas/github.ts';
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

const MiB = 1024 * 1024;

export interface GitHubReads {
  /** A GET of `path`, conditional on the answer before; a 304 answers that one as 200. */
  get(path: string, signal?: AbortSignal): Promise<GitHubAnswer>;
  /**
   * Every item of the list at `path`, page after page; `what` names it in an error. With `field`,
   * each page is an object that holds its items under that name, as GitHub's check runs.
   */
  pages(path: string, what: string, signal?: AbortSignal, field?: string): Promise<unknown[]>;
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
  const maxBytes = positive(options.maxBytes ?? 64 * MiB, 'maxBytes');
  const maxListBytes = positive(options.maxListBytes ?? 32 * MiB, 'maxListBytes');
  // The last answer with an ETag of each path, least recently used first, and their bytes.
  const cache = new Map<string, { etag: string; answer: GitHubAnswer }>();
  let cached = 0;
  const forget = (path: string): void => {
    cached -= cache.get(path)?.answer.bytes ?? 0;
    cache.delete(path);
  };

  const get: GitHubReads['get'] = async (path, signal) => {
    const before = cache.get(path);
    const headers = before === undefined ? {} : { 'if-none-match': before.etag };
    const answer = await client.rest('GET', path, undefined, signal, headers);
    forget(path);
    if (answer.status === 304 && before === undefined) {
      throw new Error(`GitHub answered 304 to ${path}, which named no ETag`);
    }
    const etag = answer.headers.get('etag');
    const kept =
      answer.status === 304
        ? before
        : answer.status === 200 && etag !== null
          ? { etag, answer }
          : undefined;
    // An answer longer than the whole cache is never kept.
    if (kept !== undefined && kept.answer.bytes <= maxBytes) {
      cache.set(path, kept);
      cached += kept.answer.bytes;
      for (const oldest of cache.keys()) {
        if (cache.size <= maxEntries && cached <= maxBytes) break;
        forget(oldest);
      }
    }
    return kept?.answer ?? answer;
  };

  return {
    get,
    pages: async (path, what, signal, field) => {
      const items: unknown[] = [];
      let bytes = 0;
      for (let next: string | undefined = path, page = 1; next !== undefined; page++) {
        if (page > maxPages) throw new Error(`${what} has more than ${maxPages} pages`);
        const answer = await get(next, signal);
        if (answer.status !== 200) throw refused(answer.status, answer.body, what);
        bytes += answer.bytes;
        if (bytes > maxListBytes) throw new Error(`${what} is longer than ${maxListBytes} bytes`);
        const list =
          field === undefined ? answer.body : checked(GitHubWrappedPage, answer.body, what)[field];
        items.push(...checked(GitHubPage, list, what));
        const url = nextPage(answer.headers.get('link'));
        // gh's login goes with every request: never to a page off the API.
        if (url !== undefined && !url.startsWith(`${client.baseUrl}/`)) {
          throw new Error(`The next page of ${what} is not on ${client.baseUrl}: ${url}`);
        }
        next = url?.slice(client.baseUrl.length);
      }
      return items;
    },
  };
};
