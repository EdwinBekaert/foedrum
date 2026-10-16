// The supervisor's thin shell (ADR 0021, ADR 0027): runs the tick on an interval. It reads the
// store, asks the core (supervisor.ts) for commands, has the command log decide and append them,
// releases expired leases and retries the state branch's flush. The clock, timer and store are
// injected.

import { attemptKey } from './attempt-key.ts';
import { createCommandLog, defaultReminderMs, defaultRoutingMs } from './command-log.ts';
import type { EngineCommand } from './decide.ts';
import type { EventStore } from './event-store.ts';
import type { Recipes } from './recipes.ts';
import { StateBranchStopError } from './state-branch.ts';
import type { FlushResult, StateBranch } from './state-branch-git.ts';
import { type FlushWatch, type ProgressSource, planTick, watchFlush } from './supervisor.ts';

/** What the supervisor reports instead of failing: it keeps running. */
export type Notice =
  /**
   * decide refused a command of the tick: another writer changed the batch after the tick read the
   * store, or the core and decide disagree, which is a bug.
   */
  | { kind: 'refused'; command: EngineCommand; reason: string }
  /** Deciding or appending a command threw; the tick goes on with the other commands. */
  | { kind: 'command_failed'; command: EngineCommand; error: unknown }
  /** The flush of the state branch failed; the next tick retries it. */
  | { kind: 'flush_failed'; reason: string }
  /** The flushes have failed since `since`, for longer than the flush deadline (ADR 0024 as amended by ADR 0027). */
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
  /** How long an Ordered batch may wait to be routed; default 1 hour (ADR 0032). */
  routingMs?: number;
  /** How long flushes may fail before the supervisor reports it; default 10 minutes. */
  flushDeadlineMs?: number;
  report?: (notice: Notice) => void;
  /**
   * Whether the supervisor acts on a batch now: a driver's own batches and the free ones, never one
   * another driver holds (ADR 0019). Default every batch.
   */
  acts?: (batchId: string) => boolean;
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
    reminderMs = defaultReminderMs,
    routingMs = defaultRoutingMs,
    flushDeadlineMs = 10 * 60_000,
    report: reportTo = () => {},
    acts = () => true,
  } = options;
  // A report that throws must not stop the supervisor: deadlines and reminders still need it.
  const report = (notice: Notice): void => {
    try {
      reportTo(notice);
    } catch {}
  };
  // Every command is decided against the events committed when it is appended, also those another
  // writer appended after the tick read the store.
  const log = createCommandLog({ store, recipes, reminderMs, routingMs });
  let watch: FlushWatch;

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

  /** Decides `command` and appends its events in a transaction of its own. */
  const apply = (command: EngineCommand, now: Date): number => {
    try {
      const decision = log.issue(command, now);
      if (decision.kind === 'refused') {
        report({ kind: 'refused', command, reason: decision.reason });
        return 0;
      }
      return decision.events.length;
    } catch (error) {
      // One broken command must not keep the other batches from their deadlines (I5).
      report({ kind: 'command_failed', command, error });
      return 0;
    }
  };

  // One tick at a time, whoever starts it: a tick waits for the one in flight.
  let inFlight: Promise<unknown> = Promise.resolve();
  const tick = (): Promise<TickReport> => {
    const next = inFlight.then(tickNow, tickNow);
    inFlight = next.catch(() => {});
    return next;
  };

  const tickNow = async (): Promise<TickReport> => {
    const now = clock();
    let appended = 0;
    let failure: { error: unknown } | undefined;
    try {
      // Another driver's batches are its own supervisor's: their deadlines and leases stay as they are.
      const { commands, releaseLeases } = planTick({
        state: log.state(),
        due: store.batchesPastDeadline(now).filter(({ batchId }) => acts(batchId)),
        expiredLeases: store.expiredLeases(now).filter((lease) => {
          const ref = attemptKey.decode(lease.attemptKey);
          return ref === undefined || acts(ref.batchId);
        }),
        progress,
        recipes,
        now,
      });
      for (const command of commands) {
        if (acts(command.batchId)) appended += apply(command, now);
      }
      if (releaseLeases.length > 0) {
        store.withTransaction((tx) => {
          for (const key of releaseLeases) tx.releaseLease(key);
        });
      }
    } catch (error) {
      failure = { error };
    }
    // Unpushed events never wait for a tick that works (ADR 0024).
    const flushed = await flush(now);
    if (failure !== undefined) throw failure.error;
    return { appended, flush: flushed };
  };

  let handle: unknown;
  let stopped = true;
  // Each run has its own number, so a tick of an earlier run never schedules another.
  let current = 0;
  let finish: { resolve: () => void; reject: (error: unknown) => void } | undefined;

  const loopOf = (run: number) => {
    const loop = async (): Promise<void> => {
      try {
        await tick();
      } catch (error) {
        if (error instanceof StateBranchStopError) {
          if (run === current) {
            stopped = true;
            finish?.reject(error);
          }
          return;
        }
        report({ kind: 'tick_failed', error });
      }
      // The next tick waits for this one, so ticks never overlap.
      if (!stopped && run === current) handle = timer.set(loop, intervalMs);
    };
    return loop;
  };

  return {
    tick,
    run: () =>
      new Promise<void>((resolve, reject) => {
        // A new run replaces the one before; that one's promise settles, never left waiting.
        finish?.resolve();
        finish = { resolve, reject };
        stopped = false;
        handle = timer.set(loopOf(++current), intervalMs);
      }),
    stop: () => {
      stopped = true;
      timer.clear(handle);
      finish?.resolve();
    },
  };
};
