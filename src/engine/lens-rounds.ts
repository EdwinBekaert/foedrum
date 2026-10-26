// The rounds of a lens step (ADR 0191): each attempt of it that reviewed, in the order the batch ran
// them, with the dispositions the brewer its findings route brought back wrote. The attempt plan
// gives a later round the earlier ones from it.

import { type Disposition, dispositionsOf } from '../schemas/out-doc.ts';
import type { StepOutcome } from '../schemas/step-outcome.ts';
import { onFindings } from './decide.ts';
import type { Attempt, Batch } from './fold.ts';

/**
 * An outcome of a review (ADR 0196): a success with a Taster's verdict, or blocked by findings
 * (`onFindings`).
 */
export const reviewed = (outcome: StepOutcome): boolean => {
  switch (outcome.kind) {
    case 'succeeded': {
      const { output } = outcome;
      const verdict =
        typeof output === 'object' && output !== null && !Array.isArray(output)
          ? output.verdict
          : undefined;
      return verdict === 'approve' || verdict === 'changes';
    }
    case 'failed':
      return onFindings(outcome);
    case 'needs_input':
    case 'cancelled':
      return false;
    default: {
      const unhandled: never = outcome;
      throw new Error(`Unhandled outcome ${JSON.stringify(unhandled)}`);
    }
  }
};

/** One round of a lens step: its attempt, and the dispositions of what its findings brought back. */
export interface LensRound {
  attempt: number;
  ran: Extract<Attempt, { phase: 'finished' }>;
  dispositions: readonly Disposition[];
}

/**
 * The rounds of `stepId` in `batch`, in the order they started, up to attempt `before` when given:
 * each attempt of it that reviewed (`reviewed`), with the dispositions of the attempt its findings
 * route brought back, or of a retry or an answered attempt that continued that one; a route of
 * another step is never its own.
 */
export function lensRounds(batch: Batch, stepId: string, before?: number): LensRound[] {
  const rounds: LensRound[] = [];
  // The round each other step's latest attempt answers, while a retry or an answer continues it.
  const answering = new Map<string, LensRound>();
  for (const { stepId: on, attempt } of batch.path ?? []) {
    if (on === stepId && attempt === before) break;
    const ran = batch.steps.get(on)?.attempts.get(attempt);
    if (ran === undefined) continue;
    if (on === stepId) {
      if (ran.phase === 'finished' && reviewed(ran.outcome)) {
        rounds.push({ attempt, ran, dispositions: [] });
      }
      continue;
    }
    const { route } = ran;
    const latest = rounds.at(-1);
    if (route?.from === stepId && route.why === 'findings' && latest !== undefined) {
      answering.set(on, latest);
    } else if (ran.retry !== true && ran.answered !== true) {
      answering.delete(on);
    }
    const answered = answering.get(on);
    if (answered !== undefined && ran.phase === 'finished' && ran.outcome.kind === 'succeeded') {
      answered.dispositions = dispositionsOf(ran.outcome.output);
    }
  }
  return rounds;
}
