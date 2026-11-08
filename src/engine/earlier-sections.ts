// What a Cellarman's fix round reads of the pull request's sections its earlier attempts wrote
// (ADR 0167, ADR 0227, ADR 0353), so that it returns them updated for the batch's whole change.

import { type PullRequestSections, pullRequestSectionsOf } from '../schemas/out-doc.ts';
import type { Batch } from './fold.ts';

/** The `earlier-sections` input of an attempt, and the text its brewer reads. */
export interface EarlierSectionsInput {
  /** The attempt of the step whose sections the text holds. */
  attempt: number;
  text: string;
}

/** The sections as Markdown, a heading for each one the attempt wrote. */
const textOf = ({ howItWorks, seeIt, beforeAfter }: PullRequestSections): string =>
  [
    ...(howItWorks === undefined ? [] : [`## How it works\n\n${howItWorks}`]),
    ...(seeIt === undefined ? [] : [`## See it\n\n${seeIt}`]),
    ...(beforeAfter.length === 0
      ? []
      : [
          `## Before and after\n\n${beforeAfter
            .map(({ case: each, before, after }) => `- ${each}: before: ${before}; after: ${after}`)
            .join('\n')}`,
        ]),
  ].join('\n\n');

/**
 * The sections of the latest attempt of `stepId` in `batch` before attempt `before` that succeeded
 * and wrote any, with that attempt's number: what the pull request shows (ADR 0353). Undefined
 * when none did.
 */
export const latestSections = (
  batch: Batch,
  stepId: string,
  before = Number.POSITIVE_INFINITY,
): { attempt: number; sections: PullRequestSections } | undefined => {
  const attempts = [...(batch.steps.get(stepId)?.attempts.values() ?? [])];
  for (const each of attempts.reverse()) {
    if (each.attempt >= before || each.phase !== 'finished' || each.outcome.kind !== 'succeeded') {
      continue;
    }
    const sections = pullRequestSectionsOf(each.outcome.output);
    if (sections !== undefined) return { attempt: each.attempt, sections };
  }
  return undefined;
};

/**
 * The `earlier-sections` input of attempt `attempt` of `stepId` in `batch`: the sections of the
 * latest attempt of that step before it that succeeded and wrote any. Undefined when none did.
 */
export const earlierSectionsInput = (
  batch: Batch,
  stepId: string,
  attempt: number,
): EarlierSectionsInput | undefined => {
  const earlier = latestSections(batch, stepId, attempt);
  return earlier === undefined
    ? undefined
    : { attempt: earlier.attempt, text: textOf(earlier.sections) };
};
