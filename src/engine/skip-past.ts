// The steps a person's skip went past that did not pass (ADR 0345), which the pull request's body and
// the status comment say by these words, as the merge brief does (ADR 0225).

import { type Attempt, type Batch, latestAttempt, onFindings } from './fold.ts';

/** A step a skip went past, with its attempt, or none when it never ran. */
export interface PastBySkip {
  stepId: string;
  attempt?: Attempt;
}

/**
 * The steps `batch`'s skips went past, in the order they were, that have not run since: a skip's
 * group goes on without its other children, and a step before it may run again after it.
 */
export const pastBySkip = (batch: Batch): PastBySkip[] =>
  [...(batch.skips ?? [])].flatMap(([stepId, attempt]) => {
    const step = batch.steps.get(stepId);
    const latest = step && latestAttempt(step);
    if (latest?.attempt !== attempt) return [];
    return [latest === undefined ? { stepId } : { stepId, attempt: latest }];
  });

/** How an attempt that did not succeed ended, in words: Stuck abandons those still running. */
export const endedText = (attempt: Attempt): string => {
  if (attempt.phase !== 'finished') {
    return attempt.abandoned === true ? 'was stopped' : 'did not finish';
  }
  switch (attempt.outcome.kind) {
    case 'succeeded':
      return 'succeeded';
    case 'failed':
      return 'failed';
    case 'needs_input':
      return 'asked for input';
    case 'cancelled':
      return 'was stopped';
    default:
      return attempt.outcome satisfies never;
  }
};

/** Whether `attempt` is one a blocking step ended by its findings (ADR 0161). */
export const blockedByFindings = (attempt: Attempt | undefined): boolean =>
  attempt?.phase === 'finished' && onFindings(attempt.outcome);

/** What a skip left of a step, on one line, true of a draft and of a ready pull request alike. */
export const pastLine = ({ stepId, attempt }: PastBySkip): string => {
  const step = `\`${stepId}\``;
  if (attempt === undefined) return `${step} did not run, and a person's skip went past it`;
  return blockedByFindings(attempt)
    ? `${step} is left open by a skip: its attempt ${attempt.attempt} was blocked by its findings`
    : `${step} did not pass: its attempt ${attempt.attempt} ${endedText(attempt)}, and a person's skip went past it`;
};
