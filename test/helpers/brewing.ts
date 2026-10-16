// A minimal driver for engine tests (ADR 0019): it starts every scheduled attempt on a brewer
// runner, keeps the lease of every attempt the runner reports, finishes attempts as they end, and
// runs the supervisor's ticks. With attempt worktrees, it gives each attempt its worktree and
// records it, and cleans a batch's worktrees once the batch has ended (ADR 0037). Everything goes
// through decide and an event store, with the clock the test controls.

import { type AttemptRef, attemptKey } from '../../src/engine/attempt-key.ts';
import type {
  AttemptEnd,
  AttemptLimits,
  BrewerRunner,
  RunningAttempt,
} from '../../src/engine/brewer-runner.ts';
import { type Command, decide } from '../../src/engine/decide.ts';
import type { DriverLock } from '../../src/engine/driver-lock.ts';
import { type DriverStart, startDriver } from '../../src/engine/driver-start.ts';
import type { EventStore, EventStoreTransaction } from '../../src/engine/event-store.ts';
import { type Batch, emptyState, fold, type State } from '../../src/engine/fold.ts';
import type { Recipes } from '../../src/engine/recipes.ts';
import { createSupervisor, type Notice } from '../../src/engine/supervisor-loop.ts';
import { createWorktreeCleanup, endedBatches } from '../../src/engine/worktree-cleanup.ts';
import type { Event } from '../../src/schemas/events.ts';
import { OutDocFrontmatter } from '../../src/schemas/out-doc.ts';
import type {
  AttemptWorktree,
  AttemptWorktrees,
  CleanReport,
} from '../../src/workspace/attempt-worktrees-git.ts';
import { fakeLock } from './fake-lock.ts';

export interface BrewingOptions {
  store: EventStore;
  runner: BrewerRunner;
  recipes: Recipes;
  clock: () => Date;
  /** The limits of each step's attempts; default an out doc `out.md` and no limits. */
  limits?: (stepId: string) => AttemptLimits;
  /** How long a lease lasts before the driver renews it; default 5 minutes. */
  leaseMs?: number;
  /** Default 2 days. */
  reminderMs?: number;
  /** Default 1 hour. */
  routingMs?: number;
  /** The driver's lock, which names its owner; default a fake one of driver-1, held. */
  lock?: DriverLock;
  /**
   * The attempt worktrees of the one repository the attempts write in, and the base new ones start
   * from; without them, attempts get no worktree and nothing is cleaned.
   */
  worktrees?: {
    repo: string;
    base: string;
    manager: Pick<AttemptWorktrees, 'root' | 'create' | 'clean'>;
  };
}

export const defaultLimits: AttemptLimits = {
  outDoc: { file: 'out.md', schema: OutDocFrontmatter },
};

export const createBrewing = (options: BrewingOptions) => {
  const {
    store,
    runner,
    recipes,
    clock,
    limits = () => defaultLimits,
    leaseMs = 5 * 60_000,
    reminderMs = 2 * 24 * 3_600_000,
    routingMs = 3_600_000,
    lock = fakeLock(),
    worktrees,
  } = options;
  const refusals: string[] = [];
  const notices: Notice[] = [];
  const runs = new Map<string, { ref: AttemptRef; run: RunningAttempt }>();
  const ended: { ref: AttemptRef; end: AttemptEnd }[] = [];
  const errors: unknown[] = [];
  const supervisor = createSupervisor({
    store,
    stateBranch: { flush: async () => ({ kind: 'unchanged' }) },
    recipes,
    progress: runner,
    clock,
    timer: { set: () => 0, clear: () => {} },
    reminderMs,
    routingMs,
    report: (notice) => notices.push(notice),
  });

  const events = (): Event[] => store.eventsAfter(0).map(({ event }) => event);
  // The folded state, kept up to date with whatever was appended since it was last read.
  let folded = { state: emptyState, lastId: 0 };
  const state = (): State => {
    const stored = store.eventsAfter(folded.lastId);
    folded = {
      state: fold(
        stored.map(({ event }) => event),
        folded.state,
      ),
      lastId: stored.at(-1)?.id ?? folded.lastId,
    };
    return folded.state;
  };

  const cleanup = createWorktreeCleanup({
    worktrees: worktrees === undefined ? [] : [worktrees.manager],
    state,
    leases: () => store.currentLeases(clock()),
  });
  // Ended batches whose worktrees drive() cleans next, and what each cleanup did.
  const toClean = new Set<string>();
  const cleanups: CleanReport[] = [];
  const isOver = (batchId: string): boolean => {
    const lane = state().batches.get(batchId)?.lane.kind;
    return lane === 'on_tap' || lane === 'cancelled';
  };

  /** Decides `command` and appends its events with `also`'s writes; false when it is refused. */
  const command = (cmd: Command, also: (tx: EventStoreTransaction) => void = () => {}) => {
    const decision = decide(state(), cmd, { now: clock(), recipes, reminderMs, routingMs });
    if (decision.kind === 'refused') {
      refusals.push(decision.reason);
      return false;
    }
    store.withTransaction((tx) => {
      for (const event of decision.events) tx.append(event);
      also(tx);
    });
    if (worktrees !== undefined) {
      for (const batchId of endedBatches(decision.events)) toClean.add(batchId);
    }
    return true;
  };

  const { owner } = lock;
  const lease = (tx: EventStoreTransaction, key: string): void =>
    tx.putLease({
      attemptKey: key,
      owner,
      expiresAt: new Date(clock().getTime() + leaseMs),
    });

  /**
   * Records the start of an attempt under its lease, with the worktree it was given; false when it
   * cannot start. An attempt whose worktree cannot be made fails retryably: whatever is in the way
   * stays, and the next attempt has names of its own (ADR 0029).
   */
  const startAttempt = async (ref: AttemptRef, key: string): Promise<boolean> => {
    const started = { type: 'step.started', ...ref } as const;
    if (worktrees === undefined) {
      return command({ kind: 'record', event: started }, (tx) => lease(tx, key));
    }
    // The lease first: only the holder of an attempt's lease may make its worktree.
    store.withTransaction((tx) => lease(tx, key));
    let made: AttemptWorktree;
    try {
      made = await worktrees.manager.create(ref, worktrees.base);
    } catch (error) {
      const reason = `the attempt could not get its worktree: ${(error as Error).message}`;
      const ending = { kind: 'failed', retryable: true, reason } as const;
      if (command({ kind: 'record', event: started })) {
        command({ kind: 'finish', ...ref, ending });
      }
      store.withTransaction((tx) => tx.releaseLease(key));
      return false;
    }
    const worktree = { repo: worktrees.repo, ...made };
    if (command({ kind: 'record', event: { ...started, worktree } })) return true;
    store.withTransaction((tx) => tx.releaseLease(key));
    return false;
  };

  /**
   * Starts the scheduled attempts, finishes the ended ones and cleans the worktrees of batches that
   * ended, until nothing moves.
   */
  const drive = async (): Promise<void> => {
    for (;;) {
      let moved = false;
      for (const batch of state().batches.values()) {
        if (batch.lane.kind !== 'brewing') continue;
        for (const [stepId, step] of batch.steps) {
          const latest = step.attempts.get(Math.max(...step.attempts.keys()));
          if (latest?.phase !== 'scheduled' || latest.abandoned === true) continue;
          const ref = { batchId: batch.id, stepId, attempt: latest.attempt };
          const key = attemptKey.encode(ref);
          moved = true;
          if (!(await startAttempt(ref, key))) continue;
          const run = runner.start({ ref, limits: limits(stepId) });
          runs.set(key, { ref, run });
          run.ended.then(
            (end) => ended.push({ ref, end }),
            (error: unknown) => errors.push(error),
          );
        }
      }
      // Let the runs that ended settle their promises.
      await new Promise((resolve) => setImmediate(resolve));
      if (errors.length > 0) throw errors[0];
      for (const { ref, end } of ended.splice(0)) {
        const key = attemptKey.encode(ref);
        runs.delete(key);
        // An attempt that ended holds its lease no longer, also when Stuck abandoned it and its
        // finish is refused: a step runs one attempt at a time, so a second live lease of a step
        // is an attempt that no longer runs (I2).
        if (!command({ kind: 'finish', ...ref, ...end }, (tx) => tx.releaseLease(key))) {
          store.withTransaction((tx) => tx.releaseLease(key));
        }
        // An attempt of an ended batch held its worktree until now.
        if (worktrees !== undefined && isOver(ref.batchId)) toClean.add(ref.batchId);
        moved = true;
      }
      for (const batchId of [...toClean]) {
        toClean.delete(batchId);
        cleanups.push(await cleanup.batchEnded(batchId));
      }
      if (!moved) return;
    }
  };

  /**
   * Renews the leases of the attempts the runner reports, runs a supervisor tick, stops the
   * processes of attempts that Stuck abandoned (ADR 0027) or whose batch has ended, and drives on.
   */
  const tick = async (): Promise<void> => {
    store.withTransaction((tx) => {
      for (const [key, { ref }] of runs) {
        if (runner.progress(ref) !== undefined) lease(tx, key);
      }
    });
    await supervisor.tick();
    const current = state();
    for (const { ref, run } of runs.values()) {
      const attempt = current.batches
        .get(ref.batchId)
        ?.steps.get(ref.stepId)
        ?.attempts.get(ref.attempt);
      if (attempt === undefined || attempt.phase === 'finished') continue;
      if (attempt.abandoned === true || isOver(ref.batchId)) run.stop();
    }
    await drive();
  };

  const batch = (batchId: string): Batch => {
    const found = state().batches.get(batchId);
    if (found === undefined) throw new Error(`No batch ${batchId}`);
    return found;
  };

  /**
   * Takes over from an earlier run of this driver on the same store: the leases that run left
   * expire now, so the supervisor's next tick loses their attempts (ADR 0033), and the attempt
   * worktrees are repaired with the claims that are left (ADR 0037).
   */
  const start = (): Promise<DriverStart> => startDriver({ store, lock, now: clock(), cleanup });

  return { start, command, drive, tick, events, state, batch, refusals, notices, cleanups };
};
