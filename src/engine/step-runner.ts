// The one runner a driver starts attempts on (ADR 0069): an attempt of a check step goes to the
// check runner, which runs the repository's commands, and every other attempt to the brewer
// runner. The driver stays the same for both.

import type { AttemptRef } from './attempt-key.ts';
import type { AttemptEnd, BrewerRunner } from './brewer-runner.ts';

export interface StepRunnerOptions {
  brewer: BrewerRunner;
  check: BrewerRunner;
  /** Whether `ref` is an attempt of a check step. */
  isCheck: (ref: AttemptRef) => boolean;
  /** Why `ref` may not run, blocking it on the environment, or undefined when it may. */
  refuse?: (ref: AttemptRef) => string | undefined;
}

export function stepRunner({ brewer, check, isCheck, refuse }: StepRunnerOptions): BrewerRunner {
  return {
    start: (attempt) => {
      const refused = refuse?.(attempt.ref);
      if (refused !== undefined) {
        const end: AttemptEnd = {
          ending: { kind: 'blocked', blockerKind: 'environment', summary: refused },
        };
        return { ended: Promise.resolve(end), stop: () => {} };
      }
      return (isCheck(attempt.ref) ? check : brewer).start(attempt);
    },
    // Each runner knows only the attempts it runs.
    progress: (ref) => check.progress(ref) ?? brewer.progress(ref),
  };
}
