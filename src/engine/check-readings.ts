// What a batch's check steps read (ADR 0069): for the merge brief, a check step's latest success
// (ADR 0225), and for a brewer that asks for `checks`, the checks that ran on the commit its
// attempt starts at (ADR 0308).

import type { GravityReading } from '../schemas/events.ts';
import { startMergeOf } from './base-merge.ts';
import { type Batch, latestAttempt, type State } from './fold.ts';
import { checkOf, readingText } from './status-comment.ts';

/** `readings` with the repository's setup left out (ADR 0163): the run's, not the change's. */
const ofTheChange = (readings: readonly GravityReading[]): readonly GravityReading[] =>
  readings.filter((reading) => reading.result === 'skipped' || reading.setup !== true);

/** The readings of a check step's latest success, its repository's setup left out (ADR 0163). */
export const checkReadings = (
  batch: Batch,
  stepId: string,
): readonly GravityReading[] | undefined => {
  const step = batch.steps.get(stepId);
  const latest = step && latestAttempt(step);
  if (latest?.phase !== 'finished' || latest.outcome.kind !== 'succeeded') return undefined;
  const readings = ofTheChange(latest.readings ?? []);
  return readings.length === 0 ? undefined : readings;
};

/** The `checks` input of an attempt that starts at `commit`, and the text its brewer reads. */
export interface ChecksInput {
  commit: string;
  text: string;
}

/** How one check ended, in the words of the status comment (ADR 0304: failing tests named). */
const endedText = (reading: GravityReading): string => {
  if (reading.result === 'skipped') {
    return `${checkOf(reading)} was not run: the repository does not have it`;
  }
  if (reading.result === 'exited' && reading.exitCode === 0) return `${checkOf(reading)} passed`;
  return readingText(reading);
};

/**
 * The `checks` input of an attempt of `batch` that starts at `commit` (ADR 0308): each step whose
 * latest attempt finished on that same commit, with how each of its checks ended, its setup left
 * out. A check step commits nothing of its own, so the commit it checked is the merge of the base
 * it made at its start (ADR 0164), else the one its worktree started at. Undefined when none did,
 * or the attempt has no commit of its own (a Brewery order's, ADR 0301).
 */
export const checksInput = (
  state: State,
  batch: Batch,
  commit: string | undefined,
): ChecksInput | undefined => {
  if (commit === undefined) return undefined;
  const lines = [...batch.steps.values()].flatMap((step) => {
    const latest = latestAttempt(step);
    if (latest?.phase !== 'finished') return [];
    const ref = { batchId: batch.id, stepId: step.id, attempt: latest.attempt };
    const checked = startMergeOf(state, ref)?.merged ?? latest.worktree?.commit;
    if (checked !== commit) return [];
    const readings = ofTheChange(latest.readings ?? []);
    if (readings.length === 0) return [];
    return [`- Step ${step.id}:`, ...readings.map((reading) => `  - ${endedText(reading)}`)];
  });
  if (lines.length === 0) return undefined;
  return { commit, text: lines.join('\n') };
};
