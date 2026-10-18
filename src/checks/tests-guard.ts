// The testsUnchanged guard, the shell (ADR 0017, ADR 0078): around the brewer runner, once an
// attempt of a guarded step succeeded, it reads from git what the proven step committed and what
// the attempt changed, and fails the attempt when it changed or removed a test declaration or
// assertion. tests-unchanged.ts decides.

import type { AttemptRef } from '../engine/attempt-key.ts';
import type { BrewerRunner } from '../engine/brewer-runner.ts';
import type { State } from '../engine/fold.ts';
import type { Git } from '../workspace/git.ts';

export interface TestsGuardOptions {
  runner: BrewerRunner;
  /** The folded state: the driver's, which has recorded the attempt's start and worktree. */
  state: () => State;
  /**
   * The step whose tests attempt `ref` must keep: its recipe's red proof's, when its brewer has
   * the testsUnchanged guard; else undefined.
   */
  protects: (ref: AttemptRef) => string | undefined;
  git: Git;
}

export function guardTests(_options: TestsGuardOptions): BrewerRunner {
  throw new Error('not implemented');
}
