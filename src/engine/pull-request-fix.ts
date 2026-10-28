// What sends a batch on tap back to a fix step: the latest base check of its open pull request's
// head, the commit of its latest push, conflicted (ADR 0244) or failed on the merged tree
// (ADR 0226), else the latest record
// of the checks on that head finished with a check that failed (ADR 0219). Pure: the supervisor
// reads it to issue the command, and decide reads it again to act on it.

import type { GravityReading, HeadCheck } from '../schemas/events.ts';
import type { FixCause } from './decide.ts';
import { type BaseCheck, type Batch, baseChecksOn, orderKey, type State } from './fold.ts';
import { orderOfBatch } from './pauses.ts';
import { checkPassed } from './pr-checks.ts';
import { openOf } from './pull-request.ts';
import type { Recipe } from './recipes.ts';

/** An open pull request whose checks failed on the head the batch pushed, with the failed ones. */
export interface FailedPullRequest {
  pullRequest: string;
  head: string;
  failed: readonly HeadCheck[];
}

/**
 * The open pull request of `batch` whose latest record of checks finished with a failure on the
 * commit of the batch's latest push; `undefined` while they run or passed, for a head someone else
 * pushed, and once the pull request ended or its branch moved.
 */
export const failedPullRequest = (state: State, batch: Batch): FailedPullRequest | undefined => {
  const open = openOf(state, batch);
  if (open === undefined) return undefined;
  const latest = batch.pullRequestChecks?.[open.url];
  if (latest?.kind !== 'finished' || latest.head !== open.head) return undefined;
  // A person's skip left this head as it is.
  const left = batch.pullRequestLeft;
  if (left?.pullRequest === open.url && left.head === open.head) return undefined;
  // A record keeps the failed checks first, so the checks it left out never hide a failure.
  const failed = latest.checks.filter(({ conclusion }) => !checkPassed(conclusion));
  return failed.length === 0 ? undefined : { pullRequest: open.url, head: open.head, failed };
};

/**
 * The first problem of the open pull request of `batch` on the head of its latest push (ADR 0226):
 * its latest base check of that head conflicted (ADR 0244) or failed on the merged tree, else its
 * checks failed on the head. A check either conflicts or runs the merged tree, never both.
 */
export type PullRequestProblem =
  | ({ kind: 'checks' } & FailedPullRequest)
  | {
      kind: 'merged_check';
      pullRequest: string;
      head: string;
      check: BaseCheck & { failed: GravityReading };
    }
  | {
      kind: 'conflict';
      pullRequest: string;
      head: string;
      check: BaseCheck & { conflicts: readonly string[] };
    };

export const pullRequestProblem = (state: State, batch: Batch): PullRequestProblem | undefined => {
  const open = openOf(state, batch);
  if (open === undefined) return undefined;
  // A person's skip left this head as it is, whatever was wrong with it.
  const left = batch.pullRequestLeft;
  if (left?.pullRequest === open.url && left.head === open.head) return undefined;
  // Only a check that names this head: one without a head may be of an older one.
  const latest = baseChecksOn(batch, open.url, open.head).at(-1);
  if (latest?.head === open.head && latest.conflicts !== undefined) {
    const check = { ...latest, conflicts: latest.conflicts };
    return { kind: 'conflict', pullRequest: open.url, head: open.head, check };
  }
  if (latest?.head === open.head && latest.failed !== undefined) {
    const check = { ...latest, failed: latest.failed };
    return { kind: 'merged_check', pullRequest: open.url, head: open.head, check };
  }
  const failed = failedPullRequest(state, batch);
  return failed === undefined ? undefined : { kind: 'checks', ...failed };
};

/** The cause a fix command names for `problem`. */
export const causeOf = (problem: PullRequestProblem): FixCause =>
  problem.kind === 'checks' ? { kind: 'checks' } : { kind: problem.kind, tip: problem.check.tip };

/** The pull requests whose failure has sent `batch` back to brew a fix, each once (ADR 0219). */
export const sentBackFrom = (batch: Batch): ReadonlySet<string> => {
  const pullRequests = new Set<string>();
  for (const step of batch.steps.values()) {
    for (const { route } of step.attempts.values()) {
      if (route?.why === 'pull_request') pullRequests.add(route.pullRequest);
    }
  }
  return pullRequests;
};

/**
 * Whether a person's pause holds the order of `batch` or the whole Brewery (ADR 0202). `pauseOf`
 * passes over a batch on tap, which runs nothing; this is the pause of the fix it would start.
 */
export const fixHeld = (state: State, batch: Batch): boolean =>
  state.pauses.all !== undefined || state.pauses.orders.has(orderKey(orderOfBatch(state, batch)));

/** The step of `recipe` that opens the pull request, when it has an onPullRequestFail route. */
export const pullRequestRoute = (recipe: Recipe): string | undefined => {
  const from = recipe.steps.find((stepId) => recipe.action(stepId) === 'openPullRequest');
  if (from === undefined) return undefined;
  return recipe.routesTo(from, 'pull_request') === undefined ? undefined : from;
};
