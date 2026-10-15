// The supervisor's thin shell (ADR 0021, ADR 0026): runs the tick on an interval. It reads the
// store, asks the core (supervisor.ts) for commands, has decide turn them into events, appends them,
// releases expired leases and retries the state branch's flush. The clock, timer and store are
// injected.

import type { EngineCommand } from './decide.ts';
import type { EventStore } from './event-store.ts';
import type { Recipes } from './recipes.ts';
import type { FlushResult, StateBranch } from './state-branch-git.ts';
import type { ProgressSource } from './supervisor.ts';

/** What the supervisor reports instead of failing: it keeps running. */
export type Notice =
  /** decide refused a command of the tick; the core and decide disagree, which is a bug. */
  | { kind: 'refused'; command: EngineCommand; reason: string }
  /** The flush of the state branch failed; the next tick retries it. */
  | { kind: 'flush_failed'; reason: string }
  /** The flushes have failed since `since`, for longer than the flush deadline (ADR 0024). */
  | { kind: 'flush_overdue'; since: Date }
  /** A tick threw; the next tick runs anyway. */
  | { kind: 'tick_failed'; error: unknown };

/** Schedules `fn` once after `ms`. The fake in tests awaits what `fn` returns. */
export interface Timer {
  set(fn: () => Promise<void>, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface SupervisorOptions {
  store: EventStore;
  stateBranch: Pick<StateBranch, 'flush'>;
  recipes: Recipes;
  progress: ProgressSource;
  clock: () => Date;
  /** Default `setTimeout`. */
  timer?: Timer;
  /** Time between ticks; default 5 s. */
  intervalMs?: number;
  /** Time between Conditioning and Stuck reminders; default 2 days (architecture §4.3). */
  reminderMs?: number;
  /** How long flushes may fail before the supervisor reports it; default 10 minutes. */
  flushDeadlineMs?: number;
  report?: (notice: Notice) => void;
}

export interface TickReport {
  /** The events the tick appended. */
  appended: number;
  flush: FlushResult;
}

export interface Supervisor {
  /** Runs one tick. Rejects with `StateBranchStopError` when the engine must stop. */
  tick(): Promise<TickReport>;
  /**
   * Runs a tick every interval until `stop`, which resolves it, or a `StateBranchStopError`,
   * which rejects it. Any other error is reported, and the next tick runs.
   */
  run(): Promise<void>;
  stop(): void;
}

export const createSupervisor = (_options: SupervisorOptions): Supervisor => {
  throw new Error('not implemented');
};
