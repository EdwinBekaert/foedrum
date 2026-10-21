// The noPush guard, the shell (ADR 0106): around the brewer runner, it reads the refs of the target
// repository's remote before an attempt of a guarded step starts and after it ends, and fails the
// attempt when a ref the engine did not write changed. no-push.ts decides.

import type { AttemptRef } from '../engine/attempt-key.ts';
import type { BrewerRunner } from '../engine/brewer-runner.ts';
import type { State } from '../engine/fold.ts';
import type { RemoteWrites } from './remote-writes.ts';

export interface PushGuardOptions {
  runner: BrewerRunner;
  /** The folded state: the driver's, which has recorded the attempt's start and worktree. */
  state: () => State;
  /** Whether the brewer of attempt `ref`'s step has the noPush guard. */
  guarded: (ref: AttemptRef) => boolean;
  /**
   * The refs of `repo`'s remote as `ls-remote --refs` lists them, read outside the clone's
   * configuration (ADR 0096) and with a deadline; rejects when it cannot read them.
   */
  refs: (repo: string, signal: AbortSignal) => Promise<string>;
  /** The engine's own writes to the remotes. */
  writes: RemoteWrites;
  /** Refs the engine writes that guard themselves, such as the state branch (ADR 0024). */
  exempt?: (repo: string, ref: string) => boolean;
  /** Default the system clock. */
  clock?: () => Date;
}

export function guardPushes(_options: PushGuardOptions): BrewerRunner {
  throw new Error('not implemented');
}
