// The supervisor's thin shell (ADR 0021, ADR 0026): runs the tick on an interval. It reads the
// store, asks the core (supervisor.ts) for commands, has decide turn them into events, appends them,
// releases expired leases and retries the state branch's flush. The clock, timer and store are
// injected.

import { decide, type EngineCommand } from './decide.ts';
import type { EventStore } from './event-store.ts';
import { emptyState, fold, type State } from './fold.ts';
import type { Recipes } from './recipes.ts';
import { StateBranchStopError } from './state-branch.ts';
import type { FlushResult, StateBranch } from './state-branch-git.ts';
import { type FlushWatch, type ProgressSource, planTick, watchFlush } from './supervisor.ts';

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

const realTimer: Timer = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export const createSupervisor = (options: SupervisorOptions): Supervisor => {
  const {
    store,
    stateBranch,
    recipes,
    progress,
    clock,
    timer = realTimer,
    intervalMs = 5000,
    reminderMs = 2 * 24 * 3_600_000,
    flushDeadlineMs = 10 * 60_000,
    report = () => {},
  } = options;
  // The folded state, kept up to date with whatever was appended since the last tick.
  let state: State = emptyState;
  let lastId = 0;
  let watch: FlushWatch;

  const refresh = (): State => {
    const stored = store.eventsAfter(lastId);
    state = fold(
      stored.map(({ event }) => event),
      state,
    );
    lastId = stored.at(-1)?.id ?? lastId;
    return state;
  };

  const flush = async (now: Date): Promise<FlushResult> => {
    let result: FlushResult;
    try {
      result = await stateBranch.flush();
    } catch (error) {
      if (error instanceof StateBranchStopError) throw error;
      result = { kind: 'failed', reason: error instanceof Error ? error.message : String(error) };
    }
    if (result.kind === 'failed') report({ kind: 'flush_failed', reason: result.reason });
    const watched = watchFlush(watch, result.kind, now, flushDeadlineMs);
    watch = watched.watch;
    if (watched.overdueSince !== undefined) {
      report({ kind: 'flush_overdue', since: watched.overdueSince });
    }
    return result;
  };

  const tick = async (): Promise<TickReport> => {
    const now = clock();
    const { commands, releaseLeases } = planTick({
      state: refresh(),
      due: store.batchesPastDeadline(now),
      expiredLeases: store.expiredLeases(now),
      progress,
      recipes,
      now,
    });
    let appended = 0;
    if (commands.length > 0 || releaseLeases.length > 0) {
      store.withTransaction((tx) => {
        let current = state;
        for (const command of commands) {
          const decision = decide(current, command, { now, recipes, reminderMs });
          if (decision.kind === 'refused') {
            report({ kind: 'refused', command, reason: decision.reason });
            continue;
          }
          for (const event of decision.events) tx.append(event);
          appended += decision.events.length;
          current = fold(decision.events, current);
        }
        for (const key of releaseLeases) tx.releaseLease(key);
      });
    }
    return { appended, flush: await flush(now) };
  };

  let handle: unknown;
  let stopped = true;
  let finish: { resolve: () => void; reject: (error: unknown) => void } | undefined;

  const loop = async (): Promise<void> => {
    try {
      await tick();
    } catch (error) {
      if (error instanceof StateBranchStopError) {
        stopped = true;
        finish?.reject(error);
        return;
      }
      report({ kind: 'tick_failed', error });
    }
    // The next tick waits for this one, so ticks never overlap.
    if (!stopped) handle = timer.set(loop, intervalMs);
  };

  return {
    tick,
    run: () =>
      new Promise<void>((resolve, reject) => {
        finish = { resolve, reject };
        stopped = false;
        handle = timer.set(loop, intervalMs);
      }),
    stop: () => {
      stopped = true;
      timer.clear(handle);
      finish?.resolve();
    },
  };
};
