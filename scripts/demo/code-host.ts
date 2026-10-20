// npm run demo's code host (ADR 0097): the tests' fake GitHub API (test/helpers/fake-github-api.ts)
// behind the tests' fake gh (test/helpers/fake-gh.ts), in the Cellar's process. Every request that
// changes something is kept in a journal and played again when the next process opens it, so the
// pull requests and comments outlive a Cellar killed mid-attempt, as GitHub's would.

import type { ExecProcess } from '../../src/platform/processes.ts';
import type { FakeApiPull } from '../../test/helpers/fake-github-api.ts';

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

/** The code host, with every write in `journal` made again first. */
export const codeHost = async (_journal: Journal): Promise<CodeHost> => {
  throw new Error('not implemented');
};

/** A journal in the file `path`, made when missing. */
export const fileJournal = (_path: string): Journal => {
  throw new Error('not implemented');
};
