// The tests a Gauger named that a test run's reports hold under no name, as the status comment and
// the merge brief say it (ADR 0342).

import type { UnreportedTests } from '../schemas/events.ts';
import type { Batch } from './fold.ts';

/**
 * What the batch's latest run whose reports were read says of the tests its Gauger named, with its
 * step: a later attempt that read none leaves it, and one whose reports hold them all takes it off.
 * `ids` keeps to those steps: a merge brief is about its head, so never about a recipe the batch
 * left (ADR 0327).
 */
export const unreportedOf = (
  batch: Batch,
  ids?: readonly string[],
): { stepId: string; unreported: UnreportedTests } | undefined => {
  for (const { stepId, attempt } of [...(batch.path ?? [])].reverse()) {
    if (ids !== undefined && !ids.includes(stepId)) continue;
    const ran = batch.steps.get(stepId)?.attempts.get(attempt);
    if (ran?.phase !== 'finished' || ran.unreported === undefined) continue;
    return ran.unreported.tests.length === 0 ? undefined : { stepId, unreported: ran.unreported };
  }
  return undefined;
};

/**
 * The line that says it, each name told by `told`. Never that the test did not run: a report cannot
 * show that, and a name can miss a test that ran.
 */
export const unreportedLine = (
  { tests, more }: UnreportedTests,
  told: (name: string) => string,
): string => {
  const rest = more > 0 ? ` and ${more} more` : '';
  return `Not proven: the test run reports no test named: ${tests.map(told).join(', ')}${rest}`;
};
