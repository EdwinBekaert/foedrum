// Events of a batch that brewed, pushed and opened its pull request (ADR 0071), and the records of
// the checks on its head (ADR 0213): what a failing pull request sends back (ADR 0219).

import type { Event, HeadCheck } from '../../src/schemas/events.ts';

export const OPEN = 'open-pull-request';
export const fixPullRequest = 'https://github.com/acme/api/pull/12';
export const firstHead = 'c'.repeat(40);
export const secondHead = 'd'.repeat(40);
export const failedCheck: HeadCheck = {
  name: 'ci / test',
  kind: 'check_run',
  conclusion: 'failure',
  url: 'https://github.com/acme/api/actions/runs/1/job/2',
};
export const passedCheck: HeadCheck = {
  name: 'ci / lint',
  kind: 'check_run',
  conclusion: 'success',
};

/** The push key of `round`: `push` for the first, `push.<n>` after (ADR 0219). */
export const pushKeyText = (batchId: string, round = 1): string =>
  JSON.stringify([batchId, round === 1 ? 'push' : `push.${round}`]);

export const branchOf = (batchId: string): string => `foedrum/acme/brewery/${batchId}/acme.api`;

/** The effect that records the push of `round` at `commit`. */
export const pushed = (
  batchId: string,
  commit: string,
  round = 1,
  more: Record<string, unknown> = {},
): Event => ({
  type: 'effect.applied',
  key: pushKeyText(batchId, round),
  result: { branch: branchOf(batchId), commit, from: `refs/heads/${commit}`, ...more },
});

const step = (
  batchId: string,
  stepId: string,
  attempt: number,
  output: unknown = null,
): Event[] => [
  { type: 'step.started', batchId, stepId, attempt },
  {
    type: 'step.finished',
    batchId,
    stepId,
    attempt,
    outcome: { kind: 'succeeded', output: output as null },
  },
];

/**
 * Batch `batchId` of `recipe` (`plan`, then the openPullRequest step) brewed, pushed `head` and
 * opened its pull request, and is On tap with it.
 */
export const openedOnTap = (
  batchId = 'b1',
  recipe = 'ale',
  head = firstHead,
  pullRequest = fixPullRequest,
): Event[] => [
  {
    type: 'batch.ordered',
    batchId,
    order: { issue: 100 },
    routeBy: '2026-12-31T00:00:00.000Z',
  },
  { type: 'batch.recipe_chosen', batchId, recipe, reason: 'label', source: 'label' },
  {
    type: 'step.scheduled',
    batchId,
    stepId: 'plan',
    attempt: 1,
    deadlineAt: '2026-10-15T11:00:00.000Z',
  },
  ...step(batchId, 'plan', 1),
  {
    type: 'step.scheduled',
    batchId,
    stepId: OPEN,
    attempt: 1,
    deadlineAt: '2026-10-15T11:00:00.000Z',
  },
  pushed(batchId, head),
  { type: 'effect.applied', key: JSON.stringify([batchId, 'pull_request']), result: pullRequest },
  ...step(batchId, OPEN, 1, { pullRequest }),
  { type: 'batch.on_tap', batchId, pullRequests: [pullRequest] },
];

/** The record that every check on `head` finished, with `checks`. */
export const checksFinished = (
  batchId: string,
  head: string,
  checks: readonly HeadCheck[] = [failedCheck, passedCheck],
  pullRequest = fixPullRequest,
): Event => ({
  type: 'pull_request.checks_finished',
  batchId,
  pullRequest,
  head,
  checks: [...checks],
});

/** The record that a check on `head` still runs. */
export const checksPending = (
  batchId: string,
  head: string,
  pullRequest = fixPullRequest,
): Event => ({
  type: 'pull_request.checks_pending',
  batchId,
  pullRequest,
  head,
  since: '2026-10-15T10:00:00.000Z',
});

/**
 * A fix round of batch `batchId` sent back from `head`: `plan` again along the route, then the
 * action, which pushes `next` as round `round`, and On tap again.
 */
export const fixRound = (
  batchId: string,
  head: string,
  next: string,
  round = 2,
  pullRequest = fixPullRequest,
): Event[] => [
  {
    type: 'step.scheduled',
    batchId,
    stepId: 'plan',
    attempt: round,
    deadlineAt: '2026-10-15T11:00:00.000Z',
    route: { from: OPEN, why: 'pull_request', pullRequest, head },
  },
  ...step(batchId, 'plan', round),
  {
    type: 'step.scheduled',
    batchId,
    stepId: OPEN,
    attempt: round,
    deadlineAt: '2026-10-15T11:00:00.000Z',
  },
  pushed(batchId, next, round),
  ...step(batchId, OPEN, round, { pullRequest }),
  { type: 'batch.on_tap', batchId, pullRequests: [pullRequest] },
];
