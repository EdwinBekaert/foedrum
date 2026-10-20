// npm run demo's code host (ADR 0097): the tests' fake GitHub API (test/helpers/fake-github-api.ts)
// behind the tests' fake gh (test/helpers/fake-gh.ts), in the Cellar's process. Every request that
// changes something is kept in a journal and played again when the next process opens it, so the
// pull requests and comments outlive a Cellar killed mid-attempt, as GitHub's would.

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ExecProcess } from '../../src/platform/processes.ts';
import { errorCode } from '../../src/platform/remove.ts';
import { ghOver } from '../../test/helpers/fake-gh.ts';
import { type FakeApiPull, fakeGitHubApi } from '../../test/helpers/fake-github-api.ts';
import { BREWERY, LOGIN, ORDER } from './core.ts';

/** Where the code host keeps its writes: one JSON line each. */
export interface Journal {
  lines(): string[];
  append(line: string): void;
}

export interface CodeHost {
  /** gh, answered in process (serve's `gh` seam, ADR 0073). */
  exec: ExecProcess;
  fetch: typeof globalThis.fetch;
  pulls(): readonly FakeApiPull[];
  /** The comments on `repo#issue`. */
  comments(repo: string, issue: number): readonly { author: string; body: string }[];
}

/** A write the code host was asked for, as its journal keeps it. */
interface Write {
  method: string;
  url: string;
  body?: string;
}

/** The code host, with every write in `journal` made again first. */
export const codeHost = async (journal: Journal): Promise<CodeHost> => {
  // A copy: the fake changes an issue's labels and assignees in place.
  const order = { ...ORDER, labels: [...ORDER.labels] };
  const api = fakeGitHubApi({ login: LOGIN, issues: { [BREWERY]: [order] } });
  for (const line of journal.lines()) {
    const { method, url, body } = JSON.parse(line) as Write;
    await api.fetch(url, { method, ...(body === undefined ? {} : { body }) });
  }
  const fetch: typeof globalThis.fetch = async (input, init = {}) => {
    const response = await api.fetch(input, init);
    const method = init.method ?? 'GET';
    // Only what changes something: the reads are answered again from the writes.
    if (method !== 'GET' && method !== 'HEAD') {
      const write: Write = {
        method,
        url: String(input),
        ...(typeof init.body === 'string' ? { body: init.body } : {}),
      };
      journal.append(JSON.stringify(write));
    }
    return response;
  };
  return {
    exec: ghOver(fetch).exec,
    fetch,
    pulls: () => api.pulls,
    comments: (repo, issue) =>
      (api.comments.get(`${repo.toLowerCase()}#${issue}`) ?? []).map(({ author, body }) => ({
        author,
        body,
      })),
  };
};

/** A journal in the file `path`, made when missing. */
export const fileJournal = (path: string): Journal => ({
  lines: () => {
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return [];
      throw error;
    }
    return text.split(/\r?\n/).filter((line) => line !== '');
  },
  // Appended before the answer goes back: a write the Cellar saw is never lost with it.
  append: (line) => {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${line}\n`);
  },
});
