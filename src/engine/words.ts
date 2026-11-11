// Words that every text a person reads shares (ADR 0379): where a command came from, an attempt of
// a step, and why a step could not go on.

import type { Surface } from '../schemas/events.ts';
import type { BlockerKind } from '../schemas/out-doc.ts';

/** Where a person's command came from, in words. */
export const surfaceText: Record<Surface, string> = {
  plugin: 'from Claude Code',
  terminal: 'from a terminal',
  comment: 'in a comment',
  dashboard: 'from the dashboard',
};

/** A try of a step, short, as a path, a table or a receipt names it: `plan`, then `plan (try 2)`. */
export const tryName = (stepId: string, attempt: number): string =>
  attempt === 1 ? stepId : `${stepId} (try ${attempt})`;

/**
 * Attempt `attempt` of step `stepId`, as a person reads it: `step plan` for its first try, `step plan
 * (try 2)` for a later one.
 */
export const attemptName = (stepId: string, attempt: number): string =>
  `step ${tryName(stepId, attempt)}`;

/** What a blocked step's blocker kind means to a person. */
export const blockerText: Record<BlockerKind, string> = {
  findings: 'the review found problems that are still open',
  environment: 'something it needs outside the change is missing',
  divergence: 'the work went a way the recipe did not expect',
};
