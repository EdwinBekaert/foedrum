// The one runner a driver starts attempts on (ADR 0069): an attempt of a check step goes to the
// check runner, which runs the repository's commands, and every other attempt to the brewer
// runner. The driver stays the same for both.

import type { AttemptRef } from './attempt-key.ts';
import type { BrewerRunner } from './brewer-runner.ts';

export interface StepRunnerOptions {
  brewer: BrewerRunner;
  check: BrewerRunner;
  /** Whether `ref` is an attempt of a check step. */
  isCheck: (ref: AttemptRef) => boolean;
}

export function stepRunner(_options: StepRunnerOptions): BrewerRunner {
  throw new Error('not implemented');
}
