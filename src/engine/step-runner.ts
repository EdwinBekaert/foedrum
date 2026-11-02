// The one runner a driver starts attempts on (ADR 0069): an attempt of a check step goes to the
// check runner, which runs the repository's commands, and every other attempt to the brewer
// runner. The driver stays the same for both.

import { messageOf } from '../platform/errors.ts';
import type { AttemptRef } from './attempt-key.ts';
import type { AttemptEnd, BrewerRunner, RunningAttempt } from './brewer-runner.ts';

export interface StepRunnerOptions {
  brewer: BrewerRunner;
  check: BrewerRunner;
  /** Whether `ref` is an attempt of a check step. */
  isCheck: (ref: AttemptRef) => boolean;
  /**
   * Why `ref` may not run, blocking it on the environment, or undefined when it may; a promise of
   * it when the answer needs a read, which the attempt waits for (ADR 0297).
   */
  refuse?: (ref: AttemptRef) => string | undefined | Promise<string | undefined>;
}

const refusal = (summary: string): AttemptEnd => ({
  ending: { kind: 'blocked', blockerKind: 'environment', summary },
});

export function stepRunner({ brewer, check, isCheck, refuse }: StepRunnerOptions): BrewerRunner {
  return {
    start: (attempt) => {
      const runner = isCheck(attempt.ref) ? check : brewer;
      const refused = refuse?.(attempt.ref);
      if (typeof refused === 'string')
        return { ended: Promise.resolve(refusal(refused)), stop: () => {} };
      if (refused === undefined) return runner.start(attempt);
      // Stopped while it reads: the attempt never starts.
      let stopped = false;
      let running: RunningAttempt | undefined;
      const ended = refused.then(
        (why): AttemptEnd | Promise<AttemptEnd> => {
          if (stopped) return { ending: { kind: 'cancelled' } };
          if (why !== undefined) return refusal(why);
          running = runner.start(attempt);
          return running.ended;
        },
        (error: unknown): AttemptEnd =>
          stopped
            ? { ending: { kind: 'cancelled' } }
            : refusal(`whether ${attempt.ref.stepId} may run cannot be read: ${messageOf(error)}`),
      );
      return {
        ended,
        stop: () => {
          stopped = true;
          running?.stop();
        },
      };
    },
    // Each runner knows only the attempts it runs.
    progress: (ref) => check.progress(ref) ?? brewer.progress(ref),
  };
}
