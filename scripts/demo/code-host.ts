// npm run demo's code host (ADR 0097): the tests' fake GitHub API (test/helpers/fake-github-api.ts)
// behind the tests' fake gh (test/helpers/fake-gh.ts), in the Cellar's process. Every request that
// changes something is kept in a journal and played again when the next process opens it, so the
// pull requests and comments outlive a Cellar killed mid-attempt, as GitHub's would.

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { errorCode } from '../../src/platform/errors.ts';
import type { ExecProcess } from '../../src/platform/processes.ts';
import { ghOver } from '../../test/helpers/fake-gh.ts';
import {
  type FakeApiIssue,
  type FakeApiMerge,
  type FakeApiPull,
  type FakeApiRelease,
  type FakeApiVisibility,
  fakeGitHubApi,
} from '../../test/helpers/fake-github-api.ts';
import { BREW_ORDER, BREWERY, LOGIN, MASH_ORDER, ORDER } from './core.ts';

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
  /** Merges the pull request `repo#number`, as a person would; kept in the journal. */
  merge(repo: string, number: number, merged: FakeApiMerge): void;
  /** Releases `repo`, as its CI would on a merge; kept in the journal. */
  release(repo: string, release: FakeApiRelease): void;
}

/** What the code host starts with: the issues of each repository, and who can read which. */
export interface CodeHostSetup {
  issues: Record<string, FakeApiIssue[]>;
  visibilities?: Record<string, FakeApiVisibility>;
}

/**
 * A write the code host was asked for, as its journal keeps it: a request, or a merge or a release
 * the demo made as a person and a repository's CI would.
 */
type Write =
  | { method: string; url: string; body?: string }
  | { merge: { repo: string; number: number; merged: FakeApiMerge } }
  | { release: { repo: string; release: FakeApiRelease } };

/** The code host, with every write in `journal` made again first. */
export const codeHost = async (
  journal: Journal,
  setup: CodeHostSetup = { issues: { [BREWERY]: [ORDER, BREW_ORDER, MASH_ORDER] } },
): Promise<CodeHost> => {
  // Copies: the fake changes an issue's labels and assignees in place.
  const issues = Object.fromEntries(
    Object.entries(setup.issues).map(([repo, listed]) => [
      repo,
      listed.map((each) => ({ ...each, labels: [...each.labels] })),
    ]),
  );
  const api = fakeGitHubApi({
    login: LOGIN,
    issues,
    ...(setup.visibilities === undefined ? {} : { visibilities: setup.visibilities }),
  });
  for (const line of journal.lines()) {
    const write = JSON.parse(line) as Write;
    if ('merge' in write) api.merge(write.merge.repo, write.merge.number, write.merge.merged);
    else if ('release' in write) api.release(write.release.repo, write.release.release);
    else {
      const { method, url, body } = write;
      await api.fetch(url, { method, ...(body === undefined ? {} : { body }) });
    }
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
    // Kept once made: a merge the fake refuses is never played again.
    merge: (repo, number, merged) => {
      api.merge(repo, number, merged);
      journal.append(JSON.stringify({ merge: { repo, number, merged } } satisfies Write));
    },
    release: (repo, release) => {
      api.release(repo, release);
      journal.append(JSON.stringify({ release: { repo, release } } satisfies Write));
    },
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
