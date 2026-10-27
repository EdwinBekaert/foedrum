// The checks GitHub runs on an open pull request's head (ADR 0213): each intake pass reads the head
// of every open pull request of a batch on tap that its ledger opened, and every check on it, and
// records when it began to wait for them and, once they have all finished, how each one finished.
// There is no deadline: the engine waits as long as they run, and the status comment says so.
// A record with failed checks keeps the end of each failed Actions job's log (ADR 0228).

import {
  type CheckConclusion,
  type CheckLog,
  type HeadCheck,
  MAX_HEAD_CHECKS,
  MOST_FAILED_CHECKS,
} from '../schemas/events.ts';
import type { CommandLog } from './command-log.ts';
import type { RecordedEvent } from './decide.ts';
import { sameHeadChecks } from './fold.ts';
import { openOf } from './pull-request.ts';

/**
 * A check on a pull request's head as the code host has it now; no `conclusion` while it runs;
 * `job`: the id of the GitHub Actions job it is, whose log the reader can read (ADR 0228).
 */
export type ReadCheck = Omit<HeadCheck, 'conclusion' | 'log'> & {
  conclusion?: CheckConclusion;
  job?: number;
};

/** What the pass reads of an open pull request's checks; GitHub's is `githubCheckReader`. */
export interface PullRequestCheckReader {
  /** The full sha of the commit the pull request at `url` heads now. */
  head(url: string, signal?: AbortSignal): Promise<string>;
  /** Every check on `head` in the repository of the pull request at `url`, page after page. */
  checks(url: string, head: string, signal?: AbortSignal): Promise<readonly ReadCheck[]>;
  /**
   * The log of the Actions job `job` in the repository of the pull request at `url` (ADR 0228): its
   * excerpt, or why it could not be read; it throws only for a read to try on a later pass.
   */
  log(url: string, job: number, signal?: AbortSignal): Promise<CheckLog>;
}

export interface CheckReadOptions {
  log: CommandLog;
  reader: PullRequestCheckReader;
  clock: () => Date;
  /** What it could not do: a head or checks it could not read, a refused record. */
  failed: (what: string, error: unknown) => void;
}

/** Whether a check that finished with `conclusion` passed (ADR 0213). */
export const checkPassed = (conclusion: CheckConclusion): boolean => {
  switch (conclusion) {
    case 'success':
    case 'neutral':
    case 'skipped':
      return true;
    case 'failure':
    case 'cancelled':
    case 'timed_out':
    case 'action_required':
    case 'stale':
    case 'startup_failure':
    case 'error':
    case 'unknown':
      return false;
    default: {
      const unhandled: never = conclusion;
      throw new Error(`Unhandled conclusion ${JSON.stringify(unhandled)}`);
    }
  }
};

/** The checks a record keeps: the failed first, then the rest, each in the order read. */
const kept = <T extends HeadCheck>(checks: readonly T[]): { checks: T[]; more?: number } => {
  const failed = checks.filter(({ conclusion }) => !checkPassed(conclusion));
  const passed = checks.filter(({ conclusion }) => checkPassed(conclusion));
  const more = checks.length - MAX_HEAD_CHECKS;
  return {
    checks: [...failed, ...passed].slice(0, MAX_HEAD_CHECKS),
    ...(more > 0 ? { more } : {}),
  };
};

/** A finished check as read, with the job whose log a record may keep. */
type FinishedCheck = HeadCheck & { job?: number };

/**
 * How long the log reads of one record may take: well inside a pass's deadline, so a record with
 * slow logs is written all the same and the next pass skips it as unchanged (ADR 0228).
 */
const LOG_READS_MS = 60_000;

/** Why a failed job's log was not read once the record's time for its logs was up. */
const LATE = 'it was not read within the minute a record gives its logs';

/**
 * `checks` as a record keeps them, each of the first `MOST_FAILED_CHECKS` failed Actions jobs with
 * its log (ADR 0228), read one at a time until `LOG_READS_MS` is up. Undefined for no record on
 * this pass: given up, or a read the reader says to try again, which it reports.
 */
const withLogs = async (
  { reader, clock, failed }: CheckReadOptions,
  url: string,
  checks: readonly FinishedCheck[],
  signal: AbortSignal,
): Promise<HeadCheck[] | undefined> => {
  const until = clock().getTime() + LOG_READS_MS;
  const recorded: HeadCheck[] = [];
  let read = 0;
  for (const { job, ...check } of checks) {
    if (job === undefined || checkPassed(check.conclusion) || read >= MOST_FAILED_CHECKS) {
      recorded.push(check);
      continue;
    }
    read++;
    if (clock().getTime() >= until) {
      recorded.push({ ...check, log: { unread: LATE } });
      continue;
    }
    let log: CheckLog;
    try {
      log = await reader.log(url, job, signal);
    } catch (error) {
      if (!signal.aborted) failed(`reading the job logs of ${url}`, error);
      return undefined;
    }
    if (signal.aborted) return undefined;
    recorded.push({ ...check, log });
  }
  return recorded;
};

/** One pass: reads the checks on the head of every open pull request, and records what changed. */
export const recordChecks = async (
  options: CheckReadOptions,
  signal: AbortSignal,
): Promise<void> => {
  const { log, reader, clock, failed } = options;
  const record = (
    event: Extract<
      RecordedEvent,
      { type: 'pull_request.checks_pending' | 'pull_request.checks_finished' }
    >,
  ): void => {
    const decision = log.issue({ kind: 'record', event }, clock());
    if (decision.kind === 'refused') {
      failed(`recording the checks of ${event.pullRequest}`, new Error(decision.reason));
    }
  };
  for (const batchId of [...log.state().batches.keys()]) {
    if (signal.aborted) return;
    // Each batch as the log has it now: other writers append beside the pass (ADR 0044).
    const state = log.state();
    const batch = state.batches.get(batchId);
    const open = batch === undefined ? undefined : openOf(state, batch);
    if (batch === undefined || open === undefined) continue;
    const latest = batch.pullRequestChecks?.[open.url];
    let head: string;
    let read: readonly ReadCheck[];
    try {
      head = await reader.head(open.url, signal);
      // Every pass reads them again: a re-run, or a check that registered late, changes them.
      read = await reader.checks(open.url, head, signal);
    } catch (error) {
      failed(`reading the checks of ${open.url}`, error);
      continue;
    }
    // A pass given up at its deadline records nothing more.
    if (signal.aborted) return;
    // The latest record, when it is of this head: a record of another never counts for it.
    const before = latest?.head === head ? latest : undefined;
    const finished: FinishedCheck[] = [];
    for (const { conclusion, ...check } of read) {
      if (conclusion !== undefined) finished.push({ ...check, conclusion });
    }
    // No check at all is finished only on a pass after one that recorded this head: the
    // repository's workflows may not have registered theirs yet.
    if (finished.length === read.length && (read.length > 0 || before !== undefined)) {
      const checks = kept(finished);
      if (before?.kind === 'finished' && sameHeadChecks(before, checks)) continue;
      // Only a record about to be written reads a log, so an unchanged one never reads it again.
      const logged = await withLogs(options, open.url, checks.checks, signal);
      if (signal.aborted) return;
      if (logged === undefined) continue;
      record({
        type: 'pull_request.checks_finished',
        batchId,
        pullRequest: open.url,
        head,
        ...checks,
        checks: logged,
      });
    } else if (before?.kind !== 'pending') {
      const since = clock().toISOString();
      record({ type: 'pull_request.checks_pending', batchId, pullRequest: open.url, head, since });
    }
  }
};
