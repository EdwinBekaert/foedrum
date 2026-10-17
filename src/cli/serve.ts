// `foedrum serve`, the Cellar (ADR 0063): takes the driver lock `cellar`, opens the event store and
// the state branch, each repository's attempt worktrees and the driver with the real runner and
// the attempt plans, ticks the driver until Ctrl+C, and closes it all again. The machine comes in
// through `ServeShell`; serve-main.ts gives it the real one.

import type { ClaudeAttemptPlan } from '../brewers/claude-runner.ts';
import type { AttemptStart, BrewerRunner } from '../engine/brewer-runner.ts';
import type { DriverNotice } from '../engine/driver.ts';
import type { DriverLock } from '../engine/driver-lock.ts';
import type { EventStore } from '../engine/event-store.ts';
import type { StateBranch } from '../engine/state-branch-git.ts';
import type { AttemptWorktrees } from '../workspace/attempt-worktrees-git.ts';
import type { ServeRepository, ServeSetup } from './serve-config.ts';

/** What serve needs from the machine. */
export interface ServeShell {
  /** Prints one line. */
  out: (line: string) => void;
  /** Aborts on Ctrl+C: serve stops after the tick underway. */
  signal: AbortSignal;
  clock: () => Date;
  /** Waits `ms`, or less once `signal` aborts. */
  wait: (ms: number, signal: AbortSignal) => Promise<void>;
  lock: (workRoot: string, options: { brewery: string; owner: string }) => DriverLock;
  /** Opens the event store at `path`, making it when missing. */
  openStore: (path: string) => EventStore;
  stateBranch: (store: EventStore, setup: ServeSetup) => Pick<StateBranch, 'start' | 'flush'>;
  /** The attempt worktrees of a repository, making its managed clone first. */
  worktrees: (
    repository: ServeRepository,
    setup: ServeSetup,
  ) => Promise<Pick<AttemptWorktrees, 'root' | 'create' | 'clean'>>;
  /** The brewer runner: `claudeBrewerRunner` with `claude` and the plans. */
  runner: (
    claude: string,
    plan: (start: AttemptStart) => Promise<ClaudeAttemptPlan>,
  ) => BrewerRunner;
  /** Default the global `fetch`. */
  fetch?: typeof globalThis.fetch;
  /** How long between ticks; default 5 s, the supervisor's interval (ADR 0027). */
  intervalMs?: number;
}

/** A driver's notice as one line. */
export const formatNotice = (_notice: DriverNotice): string => {
  throw new Error('not implemented');
};

/** Runs the Cellar until `shell.signal` aborts; the exit code: 0 stopped, 1 failed. */
export const runServe = async (_setup: ServeSetup, _shell: ServeShell): Promise<number> => {
  throw new Error('not implemented');
};
