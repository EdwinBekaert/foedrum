// The checks GitHub runs on an open pull request's head (ADR 0213): each intake pass reads the head
// of every open pull request of a batch on tap that its ledger opened, and every check on it, and
// records when it began to wait for them and, once they have all finished, how each one finished.
// There is no deadline: the engine waits as long as they run, and the status comment says so.

import type { CheckConclusion, HeadCheck } from '../schemas/events.ts';
import type { CommandLog } from './command-log.ts';

/** A check on a pull request's head as the code host has it now; no `conclusion` while it runs. */
export type ReadCheck = Omit<HeadCheck, 'conclusion'> & { conclusion?: CheckConclusion };

/** What the pass reads of an open pull request's checks; GitHub's is `githubCheckReader`. */
export interface PullRequestCheckReader {
  /** The full sha of the commit the pull request at `url` heads now. */
  head(url: string, signal?: AbortSignal): Promise<string>;
  /** Every check on `head` in the repository of the pull request at `url`, page after page. */
  checks(url: string, head: string, signal?: AbortSignal): Promise<readonly ReadCheck[]>;
}

export interface CheckReadOptions {
  log: CommandLog;
  reader: PullRequestCheckReader;
  clock: () => Date;
  /** What it could not do: a head or checks it could not read, a refused record. */
  failed: (what: string, error: unknown) => void;
}

/** Whether a check that finished with `conclusion` passed (ADR 0213). */
export const checkPassed = (_conclusion: CheckConclusion): boolean => {
  throw new Error('not implemented');
};

/** One pass: reads the checks on the head of every open pull request, and records what changed. */
export const recordChecks = async (
  _options: CheckReadOptions,
  _signal: AbortSignal,
): Promise<void> => {
  throw new Error('not implemented');
};
