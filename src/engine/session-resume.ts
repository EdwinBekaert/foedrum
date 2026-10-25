// Which session a retry or an answered attempt resumes (ADR 0117, ADR 0118): the one of the
// attempt before it, when claude started it and an attempt of it has a worktree to run in again.
// Pure: the driver recreates the worktree and records the start.

import type { WorktreeRef } from '../schemas/events.ts';
import type { AttemptRef } from './attempt-key.ts';
import type { Attempt, Batch, Step } from './fold.ts';

/** How attempt `ref` starts when its brewer resumes: in a session it continues, or fresh, and why. */
export type Resumption =
  | {
      kind: 'resume';
      /** The id of the session it continues. */
      session: string;
      /** The attempt that made the worktree the session ran in, and that worktree. */
      from: AttemptRef;
      worktree: WorktreeRef;
    }
  | { kind: 'fresh'; why: string };

/**
 * The attempt of `step` that made the worktree session `id` runs in, and that worktree: the one
 * of the attempts with that session id that recorded a worktree. A resumed session keeps its id,
 * and only the attempt that started it had a worktree of its own (ADR 0029).
 */
export function worktreeOf(
  step: Step,
  id: string,
): { attempt: number; worktree: WorktreeRef } | undefined {
  for (const attempt of step.attempts.values()) {
    if (attempt.phase === 'scheduled' || attempt.session?.id !== id) continue;
    const { worktree } = attempt;
    if (worktree !== undefined) return { attempt: attempt.attempt, worktree };
  }
  return undefined;
}

/**
 * The worktree `attempt` of `step` runs or ran in, and the attempt that made it: its own, or for a
 * resumed attempt the one whose session it continues (ADR 0117); none before it started.
 */
export function ranIn(
  step: Step,
  attempt: Attempt,
): { attempt: number; worktree: WorktreeRef } | undefined {
  if (attempt.phase === 'scheduled') return undefined;
  const { worktree, session } = attempt;
  if (worktree !== undefined) return { attempt: attempt.attempt, worktree };
  return session?.resumes === undefined ? undefined : worktreeOf(step, session.id);
}

/** The attempt of `step` before attempt `n`, if any. */
const attemptBefore = (step: Step, n: number): Attempt | undefined =>
  step.attempts.get(Math.max(...[...step.attempts.keys()].filter((each) => each < n)));

/**
 * Whether `ref` of `batch` is the retry of an attempt that ran out of its turns, by the mark on
 * that attempt's outcome: then `ref` resumes its session whatever the brewer's `retryMode`
 * (ADR 0175).
 */
export function afterOverrun(batch: Batch, ref: AttemptRef): boolean {
  const step = batch.steps.get(ref.stepId);
  return step?.attempts.get(ref.attempt)?.retry === true && overranBefore(step, ref.attempt);
}

/**
 * Whether `ref` of `batch` resumed the session of an attempt that ran out of its turns, as the
 * status comment says it (ADR 0175).
 */
export function resumedAfterOverrun(batch: Batch, ref: AttemptRef): boolean {
  const step = batch.steps.get(ref.stepId);
  const attempt = step?.attempts.get(ref.attempt);
  if (step === undefined || attempt === undefined || attempt.phase === 'scheduled') return false;
  return attempt.session?.resumes !== undefined && overranBefore(step, ref.attempt);
}

/** Whether the attempt of `step` before attempt `n` ran out of its turns, by its outcome's mark. */
const overranBefore = (step: Step, n: number): boolean => {
  const previous = attemptBefore(step, n);
  return (
    previous?.phase === 'finished' &&
    previous.outcome.kind === 'failed' &&
    previous.outcome.overran === 'turns'
  );
};

/**
 * How attempt `ref` of `batch` starts when its brewer resumes; undefined when it has no session to
 * resume: it is no retry and answers no questions, or the attempt before it ran no session. A
 * route comes after its step succeeded, and that session's branch holds the task tree, which a
 * failure resumed on it would move: so only a retry or an answered attempt resumes, and never one
 * after a success (ADR 0117, ADR 0118).
 */
export function resumeOf(batch: Batch, ref: AttemptRef): Resumption | undefined {
  const step = batch.steps.get(ref.stepId);
  const current = step?.attempts.get(ref.attempt);
  const resumable = current?.retry === true || current?.answered === true;
  if (step === undefined || !resumable) return undefined;
  const previous = attemptBefore(step, ref.attempt);
  if (previous === undefined || previous.phase === 'scheduled') return undefined;
  const { session } = previous;
  if (session === undefined) return undefined;
  const name = `${ref.stepId}#${previous.attempt}`;
  // Only a finish through its runner's end carries claude's report: its process is gone, and
  // claude started the session. A lost or abandoned attempt has none (ADR 0117).
  if (previous.phase !== 'finished' || previous.claude === undefined) {
    return { kind: 'fresh', why: `${name} has no session claude started` };
  }
  // A retry after a success (Stuck on a divergence, then retried): its commits would move the
  // task tree, which that session's branch holds (ADR 0066, ADR 0117).
  if (previous.outcome.kind === 'succeeded') {
    return { kind: 'fresh', why: `${name} succeeded, and its branch holds the task tree` };
  }
  const made = worktreeOf(step, session.id);
  if (made === undefined) {
    return { kind: 'fresh', why: `no attempt of session ${session.id} has a worktree` };
  }
  const from = { batchId: ref.batchId, stepId: ref.stepId, attempt: made.attempt };
  return { kind: 'resume', session: session.id, from, worktree: made.worktree };
}
