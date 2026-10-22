// Which session a retry resumes (ADR 0117): the one of the attempt before it, when claude started
// it and an attempt of it has a worktree to run in again. Pure: the driver recreates the worktree
// and records the start.

import type { WorktreeRef } from '../schemas/events.ts';
import type { AttemptRef } from './attempt-key.ts';
import type { Batch, Step } from './fold.ts';

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
 * of the attempts with that session id that recorded a worktree.
 */
export function worktreeOf(
  _step: Step,
  _id: string,
): { attempt: number; worktree: WorktreeRef } | undefined {
  throw new Error('not implemented');
}

/**
 * How attempt `ref` of `batch` starts when its brewer resumes; undefined when it has no session to
 * resume: it is no retry, or the attempt before it ran no session. A route comes after its step
 * succeeded, and that session's branch holds the task tree, which a failure resumed on it would
 * move: so only a retry resumes (ADR 0117).
 */
export function resumeOf(_batch: Batch, _ref: AttemptRef): Resumption | undefined {
  throw new Error('not implemented');
}
