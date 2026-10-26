// The checks GitHub runs on an open pull request's head (ADR 0213): each intake pass reads the head
// of every open pull request of a batch on tap that its ledger opened, and every check on it, and
// records when it began to wait for them and, once they have all finished, how each one finished.
// There is no deadline: the engine waits as long as they run, and the status comment says so.

import { type CheckConclusion, type HeadCheck, MAX_HEAD_CHECKS } from '../schemas/events.ts';
import type { CommandLog } from './command-log.ts';
import type { RecordedEvent } from './decide.ts';
import { sameHeadChecks } from './fold.ts';
import { openOf } from './pull-request.ts';

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
const kept = (checks: readonly HeadCheck[]): { checks: HeadCheck[]; more?: number } => {
  const failed = checks.filter(({ conclusion }) => !checkPassed(conclusion));
  const passed = checks.filter(({ conclusion }) => checkPassed(conclusion));
  const more = checks.length - MAX_HEAD_CHECKS;
  return {
    checks: [...failed, ...passed].slice(0, MAX_HEAD_CHECKS),
    ...(more > 0 ? { more } : {}),
  };
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
    const finished: HeadCheck[] = [];
    for (const { conclusion, ...check } of read) {
      if (conclusion !== undefined) finished.push({ ...check, conclusion });
    }
    // No check at all is finished only on a pass after one that recorded this head: the
    // repository's workflows may not have registered theirs yet.
    if (finished.length === read.length && (read.length > 0 || before !== undefined)) {
      const checks = kept(finished);
      if (before?.kind === 'finished' && sameHeadChecks(before, checks)) continue;
      record({
        type: 'pull_request.checks_finished',
        batchId,
        pullRequest: open.url,
        head,
        ...checks,
      });
    } else if (before?.kind !== 'pending') {
      const since = clock().toISOString();
      record({ type: 'pull_request.checks_pending', batchId, pullRequest: open.url, head, since });
    }
  }
};
