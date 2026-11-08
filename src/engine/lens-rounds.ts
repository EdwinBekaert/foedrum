// The rounds of a lens step (ADR 0191): each attempt of it that reviewed, in the order the batch ran
// them, with the dispositions the brewer its findings route brought back wrote. The attempt plan
// gives a later round the earlier ones from it.

import {
  type Disposition,
  dispositionsOf,
  type TastingFinding,
  tastingOf,
} from '../schemas/out-doc.ts';
import type { StepOutcome } from '../schemas/step-outcome.ts';
import { type Attempt, type Batch, onFindings } from './fold.ts';

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
  /** The step that wrote them, once it did. */
  by?: string;
}

/**
 * The rounds of `stepId` in `batch`, in the order they started, up to attempt `before` when given:
 * each attempt of it that reviewed (`reviewed`), with the dispositions of the attempt a findings
 * route brought back, or of a retry or an answered attempt that continued that one, that are its
 * own: those that name `stepId`, and those that name no step when the route was `stepId`'s. A
 * route of another step of its group carries its findings too (ADR 0349).
 */
export function lensRounds(batch: Batch, stepId: string, before?: number): LensRound[] {
  const rounds: LensRound[] = [];
  // Where on the path each round started, and each other step's latest attempt so far.
  const startedAt = new Map<LensRound, number>();
  const latestOf = new Map<string, number>();
  // The round each other step's latest attempt answers, the step whose route it came back by, and
  // whether that round tasted since the step's attempt before, while a retry or an answer
  // continues it.
  const answering = new Map<string, { round: LensRound; from: string; since: boolean }>();
  for (const [at, { stepId: on, attempt }] of (batch.path ?? []).entries()) {
    if (on === stepId && attempt === before) break;
    const ran = batch.steps.get(on)?.attempts.get(attempt);
    if (ran === undefined) continue;
    if (on === stepId) {
      if (ran.phase === 'finished' && reviewed(ran.outcome)) {
        const round = { attempt, ran, dispositions: [] };
        rounds.push(round);
        startedAt.set(round, at);
      }
      continue;
    }
    const { route } = ran;
    const latest = rounds.at(-1);
    if (route?.why === 'findings' && latest !== undefined) {
      const since = (startedAt.get(latest) ?? -1) > (latestOf.get(on) ?? -1);
      answering.set(on, { round: latest, from: route.from, since });
    } else if (ran.retry !== true && ran.answered !== true) {
      answering.delete(on);
    }
    latestOf.set(on, at);
    const answered = answering.get(on);
    if (answered !== undefined && ran.phase === 'finished' && ran.outcome.kind === 'succeeded') {
      const { round, from, since } = answered;
      const own = dispositionsOf(ran.outcome.output).filter(
        (found) => (found.step ?? from) === stepId,
      );
      // Another step's route answers only a round of this step that tasted since the brewer it
      // brought back last ran, one of its group's in that round, and only where it names it
      // (ADR 0349).
      if (from === stepId || (since && own.length > 0)) {
        round.dispositions = own;
        round.by = on;
      }
    }
  }
  return rounds;
}

/**
 * The findings a round of a Taster's step left: a success's from its out doc, a blocked round's
 * as `step.finished` recorded them (ADR 0221).
 */
export const roundFindings = (ran: LensRound['ran']): readonly TastingFinding[] =>
  ran.outcome.kind === 'succeeded'
    ? (tastingOf(ran.outcome.output)?.findings ?? [])
    : (ran.findings?.kept ?? []);

/**
 * Each of `findings` with the first of `dispositions` at its place not already taken, or none
 * (ADR 0191), as the merge brief pairs a disposition with its finding.
 */
export const withDispositions = <
  F extends { file?: string | undefined; line?: number | undefined },
>(
  findings: readonly F[],
  dispositions: readonly Disposition[],
): { finding: F; disposition?: Disposition }[] => {
  const left = [...dispositions];
  return findings.map((finding) => {
    const at = left.findIndex(({ file, line }) => file === finding.file && line === finding.line);
    const [disposition] = at < 0 ? [] : left.splice(at, 1);
    return disposition === undefined ? { finding } : { finding, disposition };
  });
};
